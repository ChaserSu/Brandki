import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DeckFile, ImportedDeck, MergeStrategy, ProgressFile, SettingsFile } from './types'
import * as fsa from './fsa'
import { parsePackage, buildBackup } from './apkg'
import { mergeProgress, diffDecks } from './merge'
import { applyGrade, getState, markMastered, newProgress, normalizeProgress, DEFAULT_BATCH_SIZE, type Grade } from './srs'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Folder = any

interface StoreValue {
  supported: boolean
  status: 'loading' | 'ready'
  settings: SettingsFile
  deck: DeckFile | null
  progress: ProgressFile
  mediaUrls: Record<string, string>
  reseedSample: () => Promise<void>
  importFile: (file: File, strategy: MergeStrategy) => Promise<{ added: number; updated: number; removed: number }>
  resetProgress: () => Promise<void>
  exportBackup: () => Promise<void>
  patchProgress: (mutator: (p: ProgressFile) => void) => Promise<void>
  updateSettings: (patch: Partial<SettingsFile>) => Promise<void>
  batchSetStatus: (cardIds: string[], status: Grade | 'mastered') => Promise<void>
}

const StoreContext = createContext<StoreValue | null>(null)

const DEFAULT_SETTINGS: SettingsFile = {
  version: 1,
  deckId: null,
  seeded: false,
  welcomed: false,
  batchSize: DEFAULT_BATCH_SIZE,
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const supported = fsa.isFileSystemSupported()
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')
  const [settings, setSettings] = useState<SettingsFile>(DEFAULT_SETTINGS)
  const [deck, setDeck] = useState<DeckFile | null>(null)
  const [progress, setProgress] = useState<ProgressFile>(newProgress())
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const rootRef = useRef<Folder | null>(null)
  const saveTimer = useRef<number | null>(null)

  const revokeMedia = useCallback((urls: Record<string, string>) => {
    for (const u of Object.values(urls)) URL.revokeObjectURL(u)
  }, [])

  const loadDeckMedia = useCallback(async (root: Folder, deckId: string): Promise<Record<string, string>> => {
    const files = await fsa.listFiles(root, ['library', deckId, 'media'])
    const urls: Record<string, string> = {}
    for (const name of files) {
      const blob = await fsa.readBlob(root, ['library', deckId, 'media', name])
      if (blob) urls[name] = URL.createObjectURL(blob)
    }
    return urls
  }, [])

  const loadAll = useCallback(
    async (root: Folder, s: SettingsFile) => {
      if (s.deckId) {
        const d = await fsa.readJSON<DeckFile>(root, ['library', s.deckId, 'deck.json'])
        const p = normalizeProgress(await fsa.readJSON<ProgressFile>(root, ['progress.json']))
        if (d) {
          const urls = await loadDeckMedia(root, s.deckId)
          setMediaUrls((prev) => {
            revokeMedia(prev)
            return urls
          })
          setDeck(d)
          setProgress(p)
          return
        }
      }
      setDeck(null)
      setProgress(newProgress())
    },
    [loadDeckMedia, revokeMedia],
  )

  /** 首次启动：自动导入内置示例牌组到本地存档 */
  const seedIfNeeded = useCallback(
    async (root: Folder, s: SettingsFile) => {
      if (s.deckId || s.seeded) return s
      const resp = await fetch(import.meta.env.BASE_URL + 'sample.apkg')
      const imported = await parsePackage(await resp.arrayBuffer())
      await writeImport(root, imported, newProgress())
      const next: SettingsFile = { ...s, deckId: imported.deck.id, seeded: true }
      await fsa.writeJSON(root, ['settings.json'], next)
      return next
    },
    [],
  )

  const init = useCallback(async () => {
    if (!supported) return
    const root = await fsa.getRoot()
    rootRef.current = root
    await fsa.ensureStructure(root)
    let s = { ...DEFAULT_SETTINGS, ...((await fsa.readJSON<SettingsFile>(root, ['settings.json'])) ?? {}) }
    s = await seedIfNeeded(root, s)
    setSettings(s)
    await loadAll(root, s)
    setStatus('ready')
  }, [supported, seedIfNeeded, loadAll])

  useEffect(() => {
    void init()
  }, [init])

  const scheduleProgressSave = useCallback((p: ProgressFile) => {
    const root = rootRef.current
    if (!root) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void fsa.writeJSON(root, ['progress.json'], p)
    }, 400)
  }, [])

  const patchProgress = useCallback(
    async (mutator: (p: ProgressFile) => void) => {
      const next: ProgressFile = structuredClone(progress)
      mutator(next)
      setProgress(next)
      scheduleProgressSave(next)
    },
    [progress, scheduleProgressSave],
  )

  const reseedSample = useCallback(async () => {
    const root = rootRef.current
    if (!root) return
    const resp = await fetch(import.meta.env.BASE_URL + 'sample.apkg')
    const imported = await parsePackage(await resp.arrayBuffer())
    await writeImport(root, imported, newProgress())
    const s: SettingsFile = { ...settings, deckId: imported.deck.id, seeded: true }
    await fsa.writeJSON(root, ['settings.json'], s)
    setSettings(s)
    await loadAll(root, s)
  }, [settings, loadAll])

  const importFile = useCallback(
    async (file: File, strategy: MergeStrategy) => {
      const root = rootRef.current
      if (!root) throw new Error('本地存档不可用')
      const imported = await parsePackage(await file.arrayBuffer())
      const oldIds = new Set(deck?.cards.map((c) => c.id) ?? [])
      const newIds = new Set(imported.deck.cards.map((c) => c.id))
      const merged = mergeProgress({
        old: progress,
        incoming: imported.progress,
        oldCardIds: oldIds,
        newCardIds: newIds,
        strategy,
      })
      await writeImport(root, imported, merged)
      const s: SettingsFile = { ...settings, deckId: imported.deck.id, seeded: true }
      await fsa.writeJSON(root, ['settings.json'], s)
      setSettings(s)
      await loadAll(root, s)
      return diffDecks(oldIds, newIds, imported.progress)
    },
    [deck, progress, settings, loadAll],
  )

  const resetProgress = useCallback(async () => {
    const empty = newProgress()
    setProgress(empty)
    const root = rootRef.current
    if (root) await fsa.writeJSON(root, ['progress.json'], empty)
  }, [])

  const updateSettings = useCallback(
    async (patch: Partial<SettingsFile>) => {
      const root = rootRef.current
      const next = { ...settings, ...patch }
      setSettings(next)
      if (root) await fsa.writeJSON(root, ['settings.json'], next)
    },
    [settings],
  )

  /** 牌库批量操作：把选中卡片一次性评为某档，或标记/取消完全掌握 */
  const batchSetStatus = useCallback(
    async (cardIds: string[], status: Grade | 'mastered') => {
      const root = rootRef.current
      const next: ProgressFile = structuredClone(normalizeProgress(progress))
      const now = new Date()
      const cardById = new Map((deck?.cards ?? []).map((c) => [c.id, c]))
      for (const id of cardIds) {
        if (status === 'mastered') {
          markMastered(next, id, now)
          continue
        }
        const card = cardById.get(id)
        if (!card) continue
        const prev = getState(next, id)
        const { next: nextCard, log } = applyGrade(id, prev, status, now)
        next.states[id] = nextCard
        delete next.mastered[id]
        if (!next.logs.some((l) => l.id === log.id)) next.logs.push(log)
      }
      setProgress(next)
      if (root) await fsa.writeJSON(root, ['progress.json'], next)
    },
    [deck, progress],
  )

  const exportBackup = useCallback(async () => {
    const root = rootRef.current
    if (!root || !deck) return
    const media = new Map<string, Uint8Array>()
    const files = await fsa.listFiles(root, ['library', deck.id, 'media'])
    for (const name of files) {
      const blob = await fsa.readBlob(root, ['library', deck.id, 'media', name])
      if (blob) media.set(name, new Uint8Array(await blob.arrayBuffer()))
    }
    const blob = await buildBackup(deck, media, progress)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `brandki-backup-${new Date().toISOString().slice(0, 10)}.brandki.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [deck, progress])

  const value = useMemo<StoreValue>(
    () => ({
      supported,
      status,
      settings,
      deck,
      progress,
      mediaUrls,
      reseedSample,
      importFile,
      resetProgress,
      exportBackup,
      patchProgress,
      updateSettings,
      batchSetStatus,
    }),
    [
      supported,
      status,
      settings,
      deck,
      progress,
      mediaUrls,
      reseedSample,
      importFile,
      resetProgress,
      exportBackup,
      patchProgress,
      updateSettings,
      batchSetStatus,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

/** 把导入的牌组写入本地存档 */
async function writeImport(root: Folder, imported: ImportedDeck, merged: ProgressFile) {
  await fsa.writeJSON(root, ['library', imported.deck.id, 'deck.json'], imported.deck)
  for (const [name, bytes] of imported.media) {
    await fsa.writeBlob(
      root,
      ['library', imported.deck.id, 'media', name],
      new Blob([bytes as unknown as BlobPart]),
    )
  }
  await fsa.writeJSON(root, ['progress.json'], merged)
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext)
  if (!v) throw new Error('useStore 必须在 StoreProvider 内使用')
  return v
}
