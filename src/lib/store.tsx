import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DeckFile, ImportedDeck, MergeStrategy, ProgressFile, SettingsFile } from './types'
import * as fsa from './fsa'
import { parsePackage, buildBackup, buildApkg } from './apkg'
import { mergeProgress, diffDecks } from './merge'
import { applyGrade, getState, markMastered, newProgress, normalizeProgress, DEFAULT_BATCH_SIZE, type Grade } from './srs'
import { referencedMedia } from './template'
import type { BrandkiCard, BrandkiNote, NoteModel } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Folder = any

/** 手动录入新卡的入参 */
export interface ManualCardInput {
  /** 门店照片（必填，写入媒体库并作为卡片正面） */
  file: File
  /** Anki 字段值，键为模型字段名，如 Back / 中文名 / 地址（Front 由图片自动生成，不用传） */
  fieldValues: Record<string, string>
  /** 业态全路径，如「零售::女装::中淑装」；留空归入「手动录入」 */
  deckPath?: string
  tags: string[]
}

/** 编辑已有卡片的入参；file 为空表示保留原照片。卡片 id/guid 与学习进度保持不变 */
export interface UpdateCardInput {
  file?: File | null
  fieldValues: Record<string, string>
  deckPath?: string
  tags: string[]
}

/** 手动录入卡片专用模型 ID（从示例模型克隆，可不断追加自定义字段） */
const MANUAL_MODEL_ID = 'brandki-manual-v1'

// ---------- 存储维护（压缩 / 清理）常量与工具 ----------

/** 超过该大小的图片才压缩：2MB */
const COMPRESS_LIMIT = 2 * 1024 * 1024
/** 压缩后图片最长边像素 */
const COMPRESS_MAX_EDGE = 2560
/** JPEG 压缩质量 */
const COMPRESS_QUALITY = 0.82
/** 可重新编码的位图格式（gif 保留动画、heic 浏览器未必能解码，均跳过） */
const COMPRESSIBLE_RE = /\.(jpe?g|png|webp)$/i
/** 已打包备份/牌组包文件名 */
const PACKAGE_RE = /\.(apkg|brandki\.zip)$/i

export interface CompressResult {
  /** 实际完成压缩的张数 */
  count: number
  /** 超过 2MB 且此前未压缩过的候选总数 */
  total: number
  /** 累计节省字节数 */
  bytesSaved: number
}

export interface CleanupResult {
  orphanCount: number
  orphanBytes: number
  packageCount: number
  packageBytes: number
}

/**
 * 在渲染进程里把图片重新编码为 JPEG：最长边限制 COMPRESS_MAX_EDGE，
 * 底色铺白（避免 png/webp 透明区域变黑）。无法解码时抛错或返回 null。
 */
async function compressImageBlob(blob: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', COMPRESS_QUALITY),
    )
  } finally {
    bitmap.close()
  }
}

/** 把牌组内所有字段 HTML 中的 <img src="oldName"> 改成新文件名（notes 与 cards 都改） */
function rewriteMediaRefs(d: DeckFile, oldName: string, newName: string): void {
  const swap = (html: string) =>
    html.replace(/(<img\b[^>]*\bsrc=)(["'])([^"']*)\2/gi, (m, pre: string, q: string, src: string) => {
      const file = src.split('/').pop() ?? src
      if (file !== oldName) return m
      const prefix = src.slice(0, src.length - file.length)
      return `${pre}${q}${prefix}${newName}${q}`
    })
  for (const note of d.notes) {
    for (const k of Object.keys(note.fields)) note.fields[k] = swap(note.fields[k])
  }
  for (const card of d.cards) {
    for (const k of Object.keys(card.fields)) card.fields[k] = swap(card.fields[k])
  }
}

/** 收集牌组内所有笔记/卡片字段引用到的媒体文件名 */
function collectReferencedMedia(d: DeckFile): Set<string> {
  const set = new Set<string>()
  for (const note of d.notes) for (const n of referencedMedia(note.fields)) set.add(n)
  for (const card of d.cards) for (const n of referencedMedia(card.fields)) set.add(n)
  return set
}

/**
 * 删除存档内已打包的牌组包：exports/ 目录下全部，以及存档根目录散落的包。
 * 返回删除数量与释放字节数。
 */
async function removePackagedFiles(root: Folder): Promise<{ count: number; bytes: number }> {
  let count = 0
  let bytes = 0
  const scan = async (dir: string[]) => {
    let names: string[] = []
    try {
      names = (await fsa.listFiles(root, dir)).filter((n) => PACKAGE_RE.test(n))
    } catch {
      return
    }
    for (const name of names) {
      const blob = await fsa.readBlob(root, [...dir, name])
      bytes += blob?.size ?? 0
      await fsa.deleteFile(root, [...dir, name])
      count++
    }
  }
  await scan(['exports'])
  await scan([])
  return { count, bytes }
}

function extFromFile(file: File): string {
  const byMime: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
  }
  if (byMime[file.type]) return byMime[file.type]
  const m = /\.([a-z0-9]{2,4})$/i.exec(file.name)
  return m ? m[1].toLowerCase() : 'jpg'
}

/** 牌组内所有模型已定义的字段名集合 */
function allFldNames(deck: DeckFile): Set<string> {
  const set = new Set<string>()
  for (const m of Object.values(deck.models)) for (const f of m.flds) set.add(f.name)
  return set
}

/** 取得/创建手动录入模型：克隆带 Front 字段的基础模型，按需追加自定义字段 */
function ensureManualModel(deck: DeckFile, customKeys: string[], preferredBase?: NoteModel): NoteModel {
  const base =
    preferredBase && preferredBase.flds.some((f) => f.name === 'Front')
      ? preferredBase
      : Object.values(deck.models).find((m) => m.flds.some((f) => f.name === 'Front')) ??
        Object.values(deck.models)[0]
  if (!base) throw new Error('当前牌组缺少卡片模型，无法录入')

  const existing = deck.models[MANUAL_MODEL_ID]
  const model: NoteModel = existing
    ? structuredClone(existing)
    : {
        id: MANUAL_MODEL_ID,
        name: `${base.name} · 手动录入`,
        css: base.css,
        flds: base.flds.map((f) => ({ ...f })),
        tmpls: base.tmpls.map((t) => ({ ...t })),
      }

  for (const key of customKeys) {
    if (model.flds.some((f) => f.name === key)) continue
    model.flds.push({ name: key, ord: model.flds.length })
    // 给每个模板背面追加该字段的条件块（已存在则不重复追加）
    for (const tmpl of model.tmpls) {
      if (tmpl.afmt.includes(`{{${key}}}`)) continue
      tmpl.afmt += `\n{{#${key}}}<div class="extra"><span class="lbl">${key}：</span>{{${key}}}</div>{{/${key}}}`
    }
  }
  return model
}

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
  /** 导出标准 .apkg（有损，供导入 Anki 等兼容软件；Brandki 间迁移请用 exportBackup） */
  exportApkg: () => Promise<void>
  patchProgress: (mutator: (p: ProgressFile) => void) => Promise<void>
  updateSettings: (patch: Partial<SettingsFile>) => Promise<void>
  batchSetStatus: (cardIds: string[], status: Grade | 'mastered') => Promise<void>
  addManualCard: (input: ManualCardInput) => Promise<{ cardId: string }>
  updateCard: (cardId: string, input: UpdateCardInput) => Promise<{ cardId: string }>
  /** 删除卡片（单个或批量）：连同其学习进度一起移除；仅被它们引用的媒体文件也会被回收 */
  deleteCards: (cardIds: string[]) => Promise<{ removed: number; removedMedia: number }>
  /** 压缩媒体库中超过 2MB 且未压缩过的图片 */
  compressMedia: (onProgress?: (p: { done: number; total: number; name: string }) => void) => Promise<CompressResult>
  /** 清理孤儿媒体与已打包的 apkg/备份包 */
  cleanupStorage: () => Promise<CleanupResult>
}

const StoreContext = createContext<StoreValue | null>(null)

const DEFAULT_SETTINGS: SettingsFile = {
  version: 1,
  deckId: null,
  seeded: false,
  welcomed: false,
  batchSize: DEFAULT_BATCH_SIZE,
  ai: null,
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

  /** 手动录入一张新品牌卡：写媒体 → 扩展模型 → 追加 note/card → 落盘 */
  const addManualCard = useCallback(
    async (input: ManualCardInput) => {
      const root = rootRef.current
      if (!root) throw new Error('本地存档不可用')
      if (!deck) throw new Error('还没有牌组，请先恢复示例牌组后再录入')

      const nextDeck: DeckFile = structuredClone(deck)

      // 清理字段值：去掉 Front（由图片生成），空值字段也要登记在模型里
      const values: Record<string, string> = {}
      for (const [k, v] of Object.entries(input.fieldValues)) {
        if (k === 'Front') continue
        values[k] = String(v ?? '').trim()
      }

      const known = allFldNames(nextDeck)
      const customKeys = Object.keys(values).filter((k) => !known.has(k) && values[k])
      const model = ensureManualModel(nextDeck, customKeys)
      nextDeck.models[MANUAL_MODEL_ID] = model

      // 写入图片媒体
      const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      const mediaName = `manual-${stamp}.${extFromFile(input.file)}`
      await fsa.writeBlob(root, ['library', nextDeck.id, 'media', mediaName], input.file)

      // 组装笔记字段（模型全字段，缺失补空串）
      const fields: Record<string, string> = {}
      for (const f of model.flds) fields[f.name] = values[f.name] ?? ''
      fields['Front'] = `<img src="${mediaName}">`

      const guid = `bk-${stamp}`
      const tags = input.tags.map((t) => t.trim()).filter(Boolean)
      const deckPath = input.deckPath?.trim() || '手动录入'

      const note: BrandkiNote = { guid, mid: MANUAL_MODEL_ID, fields, tags }
      nextDeck.notes.push(note)

      const newCards: BrandkiCard[] = model.tmpls.map((tmpl) => ({
        id: `${guid}#${tmpl.ord}`,
        guid,
        ord: tmpl.ord,
        modelName: model.name,
        templateName: tmpl.name,
        qfmt: tmpl.qfmt,
        afmt: tmpl.afmt,
        fields,
        tags,
        deckPath,
      }))
      nextDeck.cards.push(...newCards)

      await fsa.writeJSON(root, ['library', nextDeck.id, 'deck.json'], nextDeck)
      setDeck(nextDeck)
      setMediaUrls((prev) => ({ ...prev, [mediaName]: URL.createObjectURL(input.file) }))
      return { cardId: newCards[0]?.id ?? '' }
    },
    [deck],
  )

  /**
   * 编辑已有卡片：原地更新 note 及其展开的 cards。
   * 关键：guid 与卡片 id（`${guid}#${ord}`）都不变，progress.json 里的调度状态、
   * 复习日志、完全掌握标记因此原样保留——这不是重新录入一张新卡。
   * 若卡片原本属于示例模型，会把它迁移到「手动录入」克隆模型（克隆源是它当前的模型，
   * 模板 ord 一一对应），以便追加用户自定义字段。
   */
  const updateCard = useCallback(
    async (cardId: string, input: UpdateCardInput) => {
      const root = rootRef.current
      if (!root) throw new Error('本地存档不可用')
      if (!deck) throw new Error('还没有牌组')

      const target = deck.cards.find((c) => c.id === cardId)
      if (!target) throw new Error('找不到要编辑的卡片')

      const nextDeck: DeckFile = structuredClone(deck)
      const note = nextDeck.notes.find((n) => n.guid === target.guid)
      if (!note) throw new Error('找不到卡片对应的笔记数据')

      // 清理字段值
      const values: Record<string, string> = {}
      for (const [k, v] of Object.entries(input.fieldValues)) {
        if (k === 'Front') continue
        values[k] = String(v ?? '').trim()
      }

      const known = allFldNames(nextDeck)
      const customKeys = Object.keys(values).filter((k) => !known.has(k) && values[k])
      // 已经是手动模型就直接扩展；否则以该笔记当前模型为克隆源，保证模板 ord 对齐
      const currentModel = nextDeck.models[note.mid]
      const model =
        note.mid === MANUAL_MODEL_ID
          ? ensureManualModel(nextDeck, customKeys)
          : ensureManualModel(nextDeck, customKeys, currentModel)
      nextDeck.models[MANUAL_MODEL_ID] = model

      // 照片：传了新文件才替换，否则保留原 Front（原图片引用）
      let newMedia: { name: string; url: string } | null = null
      let frontHtml = note.fields['Front'] ?? ''
      if (input.file) {
        const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        const mediaName = `manual-${stamp}.${extFromFile(input.file)}`
        await fsa.writeBlob(root, ['library', nextDeck.id, 'media', mediaName], input.file)
        frontHtml = `<img src="${mediaName}">`
        newMedia = { name: mediaName, url: URL.createObjectURL(input.file) }
      }

      // 重建字段（模型全字段，缺失补空串）
      const fields: Record<string, string> = {}
      for (const f of model.flds) fields[f.name] = values[f.name] ?? ''
      fields['Front'] = frontHtml

      const tags = input.tags.map((t) => t.trim()).filter(Boolean)
      const deckPath = input.deckPath?.trim() || '手动录入'

      note.mid = MANUAL_MODEL_ID
      note.fields = fields
      note.tags = tags

      // 原地更新同一 guid 下的所有卡片——id 不变即进度保留；模板按 ord 对齐
      const tmplByOrd = new Map(model.tmpls.map((t) => [t.ord, t]))
      const presentOrds = new Set<number>()
      for (const c of nextDeck.cards) {
        if (c.guid !== note.guid) continue
        presentOrds.add(c.ord)
        const tmpl = tmplByOrd.get(c.ord)
        c.fields = fields
        c.tags = tags
        c.deckPath = deckPath
        if (tmpl) {
          c.modelName = model.name
          c.templateName = tmpl.name
          c.qfmt = tmpl.qfmt
          c.afmt = tmpl.afmt
        }
      }
      // 兜底：迁移后若模板比原来多（正常不会），为新 ord 补卡
      for (const tmpl of model.tmpls) {
        if (presentOrds.has(tmpl.ord)) continue
        nextDeck.cards.push({
          id: `${note.guid}#${tmpl.ord}`,
          guid: note.guid,
          ord: tmpl.ord,
          modelName: model.name,
          templateName: tmpl.name,
          qfmt: tmpl.qfmt,
          afmt: tmpl.afmt,
          fields,
          tags,
          deckPath,
        })
      }

      await fsa.writeJSON(root, ['library', nextDeck.id, 'deck.json'], nextDeck)
      setDeck(nextDeck)
      if (newMedia) setMediaUrls((prev) => ({ ...prev, [newMedia!.name]: newMedia!.url }))
      return { cardId }
    },
    [deck],
  )

  /**
   * 删除卡片（单个或批量）：
   * 1. 从 deck.cards 移除指定卡片；同一 guid 下的卡片全被删光时，笔记也一并移除；
   * 2. 清理 progress.json 中这些卡片的调度状态、复习日志、完全掌握标记；
   * 3. 回收「删除前被引用、删除后不再被任何笔记/卡片引用」的媒体文件（含 Blob URL）。
   * 注意与 updateCard 的区别：编辑会保留旧照片（允许孤儿），删除则连图片一起回收。
   */
  const deleteCards = useCallback(
    async (cardIds: string[]) => {
      const root = rootRef.current
      if (!root) throw new Error('本地存档不可用')
      if (!deck) throw new Error('还没有牌组')

      const removeIds = new Set(cardIds.filter((id) => deck.cards.some((c) => c.id === id)))
      if (removeIds.size === 0) return { removed: 0, removedMedia: 0 }

      const nextDeck: DeckFile = structuredClone(deck)
      nextDeck.cards = nextDeck.cards.filter((c) => !removeIds.has(c.id))

      // 该 guid 下已无任何卡片 → 笔记一并删除
      const aliveGuids = new Set(nextDeck.cards.map((c) => c.guid))
      nextDeck.notes = nextDeck.notes.filter((n) => aliveGuids.has(n.guid))

      // 删除后不再被引用的媒体：这些文件只服务于刚被删掉的卡片
      const beforeRefs = collectReferencedMedia(deck)
      const afterRefs = collectReferencedMedia(nextDeck)
      const orphaned = [...beforeRefs].filter((name) => !afterRefs.has(name))

      await fsa.writeJSON(root, ['library', nextDeck.id, 'deck.json'], nextDeck)
      for (const name of orphaned) {
        await fsa.deleteFile(root, ['library', nextDeck.id, 'media', name])
      }

      const nextProgress: ProgressFile = structuredClone(normalizeProgress(progress))
      for (const id of removeIds) {
        delete nextProgress.states[id]
        delete nextProgress.mastered[id]
      }
      nextProgress.logs = nextProgress.logs.filter((l) => !removeIds.has(l.cardId))
      setProgress(nextProgress)
      await fsa.writeJSON(root, ['progress.json'], nextProgress)

      setMediaUrls((prev) => {
        const next = { ...prev }
        for (const name of orphaned) {
          if (next[name]) URL.revokeObjectURL(next[name])
          delete next[name]
        }
        return next
      })

      setDeck(nextDeck)
      return { removed: removeIds.size, removedMedia: orphaned.length }
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
    // 桌面端/OPFS 内同时留存一份打包文件，供「设置 → 清理存储空间」统一回收
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    await fsa.writeBlob(root, ['exports', `brandki-backup-${stamp}.brandki.zip`], blob)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `brandki-backup-${new Date().toISOString().slice(0, 10)}.brandki.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [deck, progress])

  /**
   * 导出标准 .apkg（Anki 牌组包）：卡片内容与图片完整，但学习进度为近似映射（有损）。
   * 只下载到「下载」文件夹，不在存档内留存副本——它体积与媒体等同，且用途是拿出去
   * 导入别的软件；Brandki 之间迁移请用 exportBackup。
   */
  const exportApkg = useCallback(async () => {
    const root = rootRef.current
    if (!root || !deck) return
    const media = new Map<string, Uint8Array>()
    const files = await fsa.listFiles(root, ['library', deck.id, 'media'])
    for (const name of files) {
      const blob = await fsa.readBlob(root, ['library', deck.id, 'media', name])
      if (blob) media.set(name, new Uint8Array(await blob.arrayBuffer()))
    }
    const blob = await buildApkg(deck, media, progress)
    const safeName = (deck.name || 'brandki').replace(/[\\/:*?"<>|]/g, '_')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${safeName}-${new Date().toISOString().slice(0, 10)}.apkg`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [deck, progress])

  /**
   * 压缩媒体库：遍历存档内所有牌组的 media 目录，把超过 2MB、且此前未压缩过的
   * jpg/png/webp 重新编码为 JPEG（最长边 2560、质量 0.82）。
   * - jpg 原扩展名不变，直接覆写；
   * - png/webp 转成 jpg 后文件名变化，需同步改写 deck.json 里的 <img src> 并删除旧文件；
   * - 已处理（含压缩后反而更大、解码失败被跳过）的文件名记入
   *   settings.compressedMediaKeys，保证「没被压缩过」才会再次处理。
   */
  const compressMedia = useCallback(
    async (onProgress?: (p: { done: number; total: number; name: string }) => void): Promise<CompressResult> => {
      const root = rootRef.current
      if (!root) throw new Error('本地存档不可用')

      const doneKeys = new Set(settings.compressedMediaKeys ?? [])
      const candidates: { deckId: string; name: string }[] = []
      for (const deckId of await fsa.listDirs(root, ['library'])) {
        const files = await fsa.listFiles(root, ['library', deckId, 'media'])
        for (const name of files) {
          if (!COMPRESSIBLE_RE.test(name)) continue
          if (doneKeys.has(`${deckId}/${name}`)) continue
          const blob = await fsa.readBlob(root, ['library', deckId, 'media', name])
          if (blob && blob.size > COMPRESS_LIMIT) candidates.push({ deckId, name })
        }
      }

      const total = candidates.length
      let count = 0
      let bytesSaved = 0
      let processed = 0
      for (const { deckId, name } of candidates) {
        onProgress?.({ done: processed, total, name })
        processed++
        const key = `${deckId}/${name}`
        const mediaPath = ['library', deckId, 'media', name]
        const blob = await fsa.readBlob(root, mediaPath)
        if (!blob) {
          doneKeys.add(key)
          continue
        }

        let out: Blob | null = null
        try {
          out = await compressImageBlob(blob)
        } catch {
          // 浏览器无法解码（如 heic 伪装成 jpg）：登记为已处理，不再反复尝试
          doneKeys.add(key)
          continue
        }
        // 无论是否实际写回，都视为「已压缩过」，避免每次维护都重新编码
        doneKeys.add(key)
        if (!out || out.size >= blob.size) continue

        if (/\.jpe?g$/i.test(name)) {
          // 同名覆写，卡片引用无需改动
          await fsa.writeBlob(root, mediaPath, out)
        } else {
          // png/webp → jpg：换文件名 → 改写 deck.json 引用 → 删除旧文件
          const stem = name.replace(/\.[^.]+$/, '')
          let newName = `${stem}.jpg`
          const existing = new Set(await fsa.listFiles(root, ['library', deckId, 'media']))
          if (existing.has(newName)) newName = `${stem}-${Date.now().toString(36)}.jpg`
          await fsa.writeBlob(root, ['library', deckId, 'media', newName], out)
          const d = await fsa.readJSON<DeckFile>(root, ['library', deckId, 'deck.json'])
          if (d) {
            rewriteMediaRefs(d, name, newName)
            await fsa.writeJSON(root, ['library', deckId, 'deck.json'], d)
          }
          await fsa.deleteFile(root, mediaPath)
          doneKeys.add(`${deckId}/${newName}`)
        }

        bytesSaved += blob.size - out.size
        count++
      }
      onProgress?.({ done: total, total, name: '' })

      const nextSettings: SettingsFile = { ...settings, compressedMediaKeys: [...doneKeys] }
      setSettings(nextSettings)
      await fsa.writeJSON(root, ['settings.json'], nextSettings)
      // 重新载入牌组与媒体 ObjectURL，让覆写/改名后的图片立即生效
      await loadAll(root, nextSettings)
      return { count, total, bytesSaved }
    },
    [settings, loadAll],
  )

  /**
   * 清理存储空间：
   * 1. 每个牌组 media 目录里、未被任何笔记/卡片字段引用的孤儿媒体（换照片后遗留的
   *    旧图、旧导入残留等）；牌组已不存在的旧 library 目录，其媒体全部视为孤儿；
   * 2. 存档 exports/ 目录及根目录里已打包好的 .apkg / .brandki.zip 备份包。
   */
  const cleanupStorage = useCallback(async (): Promise<CleanupResult> => {
    const root = rootRef.current
    if (!root) throw new Error('本地存档不可用')

    let orphanCount = 0
    let orphanBytes = 0
    for (const deckId of await fsa.listDirs(root, ['library'])) {
      const d = await fsa.readJSON<DeckFile>(root, ['library', deckId, 'deck.json'])
      const referenced = d ? collectReferencedMedia(d) : new Set<string>()
      const files = await fsa.listFiles(root, ['library', deckId, 'media'])
      for (const name of files) {
        if (referenced.has(name)) continue
        const blob = await fsa.readBlob(root, ['library', deckId, 'media', name])
        orphanBytes += blob?.size ?? 0
        await fsa.deleteFile(root, ['library', deckId, 'media', name])
        orphanCount++
      }
    }

    const pkgs = await removePackagedFiles(root)
    await loadAll(root, settings)
    return { orphanCount, orphanBytes, packageCount: pkgs.count, packageBytes: pkgs.bytes }
  }, [settings, loadAll])

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
      exportApkg,
      patchProgress,
      updateSettings,
      batchSetStatus,
      addManualCard,
      updateCard,
      deleteCards,
      compressMedia,
      cleanupStorage,
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
      exportApkg,
      patchProgress,
      updateSettings,
      batchSetStatus,
      addManualCard,
      updateCard,
      deleteCards,
      compressMedia,
      cleanupStorage,
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
