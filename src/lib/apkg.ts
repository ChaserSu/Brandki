// 解析 .apkg（Anki 牌组包）与 .brandki.zip（自有备份）
// apkg = zip(collection.anki2 SQLite + 编号媒体文件 + media 映射 JSON)
import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate'
import type { DeckFile, ImportedDeck, NoteModel, ProgressFile, ReviewLogEntry } from './types'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RawCard {
  nid: number
  did: number
  ord: number
  type: number // 0=new 1=learn 2=review 3=relearn
  queue: number
  due: number
  ivl: number
  factor: number
  reps: number
  lapses: number
}

function hashId(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0
  }
  return 'd' + (h >>> 0).toString(36)
}

function emptyProgress(): ProgressFile {
  return { version: 1, states: {}, logs: [], mastered: {} }
}

// ---------- brandki.zip ----------

export function isBrandkiZip(entries: Record<string, Uint8Array>): boolean {
  return Object.keys(entries).some((n) => n === 'progress.json' || n.startsWith('library/'))
}

function parseBrandkiZip(entries: Record<string, Uint8Array>): ImportedDeck {
  const deckPath = Object.keys(entries).find((n) => /^library\/[^/]+\/deck\.json$/.test(n))
  if (!deckPath) throw new Error('备份中找不到 deck.json')
  const deck = JSON.parse(strFromU8(entries[deckPath])) as DeckFile
  const media = new Map<string, Uint8Array>()
  const mediaPrefix = deckPath.replace(/deck\.json$/, 'media/')
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith(mediaPrefix)) media.set(name.slice(mediaPrefix.length), data)
  }
  const progress = entries['progress.json']
    ? (JSON.parse(strFromU8(entries['progress.json'])) as ProgressFile)
    : emptyProgress()
  return { deck, media, progress }
}

// ---------- apkg ----------

/** 把 Anki 的传统调度数据近似映射为 FSRS 卡片状态（快照级，非无损） */
function ankiSnapshotToState(c: RawCard, crt: number): unknown | null {
  if (c.type === 0 || c.ivl <= 0) return null
  if (c.type === 2) {
    // review：due 是相对收藏创建日的天数
    const dueDate = new Date(crt * 1000 + c.due * 86400_000)
    const difficulty = Math.min(10, Math.max(1, (3000 / Math.max(1300, c.factor || 2500)) * 5))
    return {
      due: dueDate.toISOString(),
      stability: c.ivl,
      difficulty: Number(difficulty.toFixed(2)),
      elapsed_days: 0,
      scheduled_days: c.ivl,
      reps: c.reps,
      lapses: c.lapses,
      state: 2, // Review
      last_review: null,
    }
  }
  // 学习中/重学：视为即刻到期
  return {
    due: new Date().toISOString(),
    stability: 0,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: c.reps,
    lapses: c.lapses,
    state: c.type === 3 ? 3 : 1,
    last_review: null,
  }
}

/** 浏览器用 Vite 打包的 wasm URL；Node/SSR 下从 node_modules 解析真实路径 */
async function resolveWasmUrl(): Promise<string> {
  if (typeof window !== 'undefined') return wasmUrl
  const mod = 'node:module'
  const { createRequire } = await import(/* @vite-ignore */ mod)
  return createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm')
}

async function parseApkg(entries: Record<string, Uint8Array>): Promise<ImportedDeck> {
  const dbBytes = entries['collection.anki2'] ?? entries['collection.anki21']
  if (!dbBytes) throw new Error('不是有效的 apkg：缺少 collection.anki2')

  const wasm = await resolveWasmUrl()
  const SQL = await initSqlJs({ locateFile: () => wasm })
  const db = new SQL.Database(dbBytes)

  const scalar = <T,>(sql: string): T => {
    const r = db.exec(sql)
    return r.length ? (r[0].values[0][0] as T) : (null as T)
  }

  const modelsRaw = scalar<string>('SELECT models FROM col')
  const decksRaw = scalar<string>('SELECT decks FROM col')
  const crt = scalar<number>('SELECT crt FROM col') ?? Math.floor(Date.now() / 1000)
  const modelsAnki = JSON.parse(modelsRaw) as Record<string, any>
  const decksAnki = JSON.parse(decksRaw) as Record<string, any>

  const models: Record<string, NoteModel> = {}
  for (const [id, m] of Object.entries(modelsAnki)) {
    models[id] = {
      id,
      name: String(m.name),
      css: typeof m.css === 'string' ? m.css : undefined,
      flds: (m.flds as any[]).map((f) => ({ name: String(f.name), ord: f.ord as number })),
      tmpls: (m.tmpls as any[]).map((t) => ({
        ord: t.ord as number,
        name: String(t.name),
        qfmt: String(t.qfmt ?? ''),
        afmt: String(t.afmt ?? ''),
      })),
    }
  }

  // 笔记
  interface RawNote {
    id: number
    guid: string
    mid: string
    flds: string
    tags: string
  }
  const notes: RawNote[] = []
  const noteRes = db.exec('SELECT id, guid, mid, flds, tags FROM notes')
  if (noteRes.length) {
    for (const row of noteRes[0].values) {
      notes.push({
        id: row[0] as number,
        guid: String(row[1]),
        mid: String(row[2]),
        flds: String(row[3]),
        tags: String(row[4] ?? ''),
      })
    }
  }

  const noteById = new Map<number, RawNote>()
  for (const n of notes) noteById.set(n.id, n)

  // 卡片 + 调度快照
  const rawCards: RawCard[] = []
  const cardRes = db.exec('SELECT nid, did, ord, type, queue, due, ivl, factor, reps, lapses FROM cards')
  if (cardRes.length) {
    for (const row of cardRes[0].values) {
      rawCards.push({
        nid: row[0] as number,
        did: row[1] as number,
        ord: row[2] as number,
        type: row[3] as number,
        queue: row[4] as number,
        due: row[5] as number,
        ivl: row[6] as number,
        factor: row[7] as number,
        reps: row[8] as number,
        lapses: row[9] as number,
      })
    }
  }

  // did -> 嵌套牌组全名（如 零售::运动户外::国际零售）
  const deckNameById = new Map<string, string>()
  for (const [id, d] of Object.entries(decksAnki)) {
    deckNameById.set(id, String(d.name))
  }

  // 牌组名取所有卡片业态路径的公共根段（如「零售」），不再误取最长嵌套名
  const rootVotes = new Map<string, number>()
  for (const rc of rawCards) {
    const full = deckNameById.get(String(rc.did))
    const root = full?.split('::')[0]?.trim()
    if (root && root !== 'Default') rootVotes.set(root, (rootVotes.get(root) ?? 0) + 1)
  }
  const deckName =
    [...rootVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Brandki 牌组'

  const deckId = hashId(`apkg:${deckName}`)
  const progress = emptyProgress()

  const deck: DeckFile = {
    version: 1,
    id: deckId,
    name: String(deckName),
    importedAt: new Date().toISOString(),
    models,
    notes: [],
    cards: [],
  }

  for (const n of notes) {
    const model = models[n.mid]
    if (!model) continue
    const parts = n.flds.split('\x1f')
    const fields: Record<string, string> = {}
    model.flds.forEach((f, i) => {
      fields[f.name] = parts[i] ?? ''
    })
    const tags = n.tags.split(' ').map((t) => t.trim()).filter(Boolean)
    deck.notes.push({ guid: n.guid, mid: n.mid, fields, tags })
  }

  for (const rc of rawCards) {
    const note = noteById.get(rc.nid)
    if (!note) continue
    const model = models[note.mid]
    const tmpl = model?.tmpls.find((t) => t.ord === rc.ord)
    if (!model || !tmpl) continue
    const parts = note.flds.split('\x1f')
    const fields: Record<string, string> = {}
    model.flds.forEach((f, i) => {
      fields[f.name] = parts[i] ?? ''
    })
    const cardId = `${note.guid}#${rc.ord}`
    deck.cards.push({
      id: cardId,
      guid: note.guid,
      ord: rc.ord,
      modelName: model.name,
      templateName: tmpl.name,
      qfmt: tmpl.qfmt,
      afmt: tmpl.afmt,
      fields,
      tags: note.tags.split(' ').map((t) => t.trim()).filter(Boolean),
      deckPath: deckNameById.get(String(rc.did)) ?? deckName,
    })
    const state = ankiSnapshotToState(rc, crt)
    if (state) progress.states[cardId] = state
  }

  db.close()

  // 媒体：media 映射 { "0": "真实文件名.jpg" }
  const media = new Map<string, Uint8Array>()
  if (entries['media']) {
    const map = JSON.parse(strFromU8(entries['media'])) as Record<string, string>
    for (const [idx, filename] of Object.entries(map)) {
      const data = entries[idx]
      if (data) media.set(filename, data)
    }
  }

  return { deck, media, progress }
}

/** 解析任意上传的牌组包 */
export async function parsePackage(buf: ArrayBuffer): Promise<ImportedDeck> {
  const entries = unzipSync(new Uint8Array(buf))
  if (isBrandkiZip(entries)) return parseBrandkiZip(entries)
  return parseApkg(entries)
}

/** 打包 brandki 备份 */
export async function buildBackup(
  deck: DeckFile,
  media: Map<string, Uint8Array>,
  progress: ProgressFile,
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {
    'progress.json': strToU8(JSON.stringify(progress, null, 2)),
    [`library/${deck.id}/deck.json`]: strToU8(JSON.stringify(deck, null, 2)),
  }
  for (const [name, data] of media) {
    files[`library/${deck.id}/media/${name}`] = data
  }
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' })
}

export function makeLogId(cardId: string, time: string, rating: number): string {
  return `${cardId}@${time}#${rating}`
}

export type { ReviewLogEntry }
