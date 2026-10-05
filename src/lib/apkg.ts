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
  if (c.type === 0) return null // 新卡：没有调度状态
  if (c.queue < 0) return null // 挂起(-1)/埋藏(-2/-3)：不导入调度状态，避免其「复活」进队列
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
  // 学习中/重学（type 1/3）：due 是 Unix 秒时间戳，ivl 恒为 0
  return {
    due: (c.due > 0 ? new Date(c.due * 1000) : new Date()).toISOString(),
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

// ---------- 导出 apkg（有损：仅供导入 Anki 等兼容软件） ----------

/** Anki collection.anki2 建表语句（对齐 Anki 2.1 legacy schema） */
const APKG_SCHEMA = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null,
  conf text not null, models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null,
  csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null,
  due integer not null, ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null,
  type integer not null
);
CREATE TABLE graves ( usn integer not null, oid integer not null, type integer not null );
`

/** 极简 SHA-1（40 位十六进制），用于生成 Anki 的 notes.csum */
function sha1Hex(input: Uint8Array): string {
  const ml = input.length * 8
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6)
  padded.set(input)
  padded[input.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(ml / 0x100000000), false)
  dv.setUint32(padded.length - 4, ml >>> 0, false)

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false)
    for (let j = 16; j < 80; j++) {
      const v = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16]
      w[j] = (v << 1) | (v >>> 31)
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let j = 0; j < 80; j++) {
      let f: number, k: number
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
      else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('')
}

/** 去掉 HTML 标签，得到 Anki 排序字段用的纯文本 */
function stripForSort(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
}

interface AnkiSched {
  type: number
  queue: number
  due: number
  ivl: number
  factor: number
  reps: number
  lapses: number
  left: number
}

/**
 * FSRS 状态 → Anki 卡片调度字段（近似映射，与 ankiSnapshotToState 方向相反）。
 * 新卡 type=0/queue=0、due 为排队序号；学习/重学 type=1/3、due 为 Unix 秒；
 * 复习 type=2/queue=2、due 为相对收藏创建日的天数。
 */
function fsrsToAnkiSched(raw: unknown, crtSec: number, position: number): AnkiSched {
  const s = (raw ?? null) as {
    due?: string | Date
    difficulty?: number
    scheduled_days?: number
    reps?: number
    lapses?: number
    state?: number
  } | null
  if (!s || !s.state) {
    return { type: 0, queue: 0, due: position, ivl: 0, factor: 2500, reps: 0, lapses: 0, left: 0 }
  }
  const reps = Math.max(0, Math.round(s.reps ?? 0))
  const lapses = Math.max(0, Math.round(s.lapses ?? 0))
  const dueMs = s.due ? new Date(s.due).getTime() : Date.now()
  if (s.state === 2) {
    const ivl = Math.max(1, Math.round(s.scheduled_days ?? 0))
    const diff = Math.min(10, Math.max(1, s.difficulty ?? 5))
    const factor = Math.round(Math.min(3000, Math.max(1300, 15000 / diff)))
    return { type: 2, queue: 2, due: Math.floor((dueMs - crtSec * 1000) / 86400_000), ivl, factor, reps, lapses, left: 0 }
  }
  const type = s.state === 3 ? 3 : 1
  return { type, queue: type, due: Math.floor(dueMs / 1000), ivl: 0, factor: 2500, reps, lapses, left: 0 }
}

/**
 * 打包为标准 .apkg（Anki 牌组包），可导入 Anki 及兼容软件。
 * 注意：这是有损导出——卡片内容与图片完整保留，但学习进度只能近似转换为 Anki
 * 的传统调度字段（FSRS 记忆状态无法无损还原）；卡片 id / 笔记 guid 也会重新编号。
 * 若要在 Brandki 之间迁移，请用 buildBackup（.brandki.zip，无损）。
 */
export async function buildApkg(
  deck: DeckFile,
  media: Map<string, Uint8Array>,
  progress: ProgressFile,
): Promise<Blob> {
  const wasm = await resolveWasmUrl()
  const SQL = await initSqlJs({ locateFile: () => wasm })
  const db = new SQL.Database()
  db.run(APKG_SCHEMA)

  const nowSec = Math.floor(Date.now() / 1000)
  // Anki 的 review due 是「相对 col.crt 的天数」，crt 取当地午夜才能按天对齐
  const crtSec = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000)

  // 模型 id / 牌组 id 映射（Anki 要求整型 id）
  const modelIdByKey = new Map<string, number>()
  let modelSeq = 1700000000000
  for (const key of Object.keys(deck.models)) modelIdByKey.set(key, modelSeq++)

  const deckIdByPath = new Map<string, number>()
  let deckSeq = 1700000000100
  deckIdByPath.set('Default', 1)
  for (const c of deck.cards) {
    const p = c.deckPath?.trim() || 'Default'
    if (!deckIdByPath.has(p)) deckIdByPath.set(p, deckSeq++)
  }

  const modelsJson: Record<string, unknown> = {}
  /** 每个模型用于 Anki 排序的字段下标（Front 是图片，跳过它取第一个文字字段） */
  const sortfByKey = new Map<string, number>()
  for (const [key, m] of Object.entries(deck.models)) {
    const mid = modelIdByKey.get(key)!
    const orderedFlds = [...m.flds].sort((a, b) => a.ord - b.ord)
    const sortf = Math.max(0, orderedFlds.findIndex((f) => f.name !== 'Front'))
    sortfByKey.set(key, sortf)
    modelsJson[String(mid)] = {
      id: mid,
      name: m.name,
      type: 0,
      mod: nowSec,
      usn: -1,
      sortf,
      did: 1,
      tmpls: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({
        name: t.name, ord: t.ord, qfmt: t.qfmt, afmt: t.afmt,
        bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0,
      })),
      flds: orderedFlds.map((f) => ({
        name: f.name, ord: f.ord, font: 'Arial', size: 20, sticky: false, media: [],
      })),
      css: m.css ?? '',
      latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
      latexPost: '\\end{document}',
      req: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => [t.ord, 'any', [t.ord]]),
      tags: [],
      vers: [],
    }
  }

  const deckBase = {
    mod: nowSec, usn: -1,
    lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
    conf: 1, desc: '', dyn: 0, collapsed: false, extendNew: 10, extendRev: 50, browserCollapsed: false,
  }
  const decksJson: Record<string, unknown> = { '1': { id: 1, name: 'Default', ...deckBase } }
  for (const [path, id] of deckIdByPath) {
    if (id === 1) continue
    decksJson[String(id)] = { id, name: path, ...deckBase }
  }

  const conf = {
    nextPos: 1, estTimes: true, activeDecks: [1], sortType: 'noteFld', timeLim: 0,
    sortBackwards: false, addToCur: true, curDeck: 1, newBury: true, newSpread: 0,
    dueCounts: true, curModel: null, collapseTime: 1200,
  }
  const dconf = {
    '1': {
      id: 1, name: 'Default', mod: 0, usn: -1, maxTaken: 60, autoplay: true, timer: 0, replayq: true,
      new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
      rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
      lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
      dyn: false, collapseTime: 1200, newMix: 0, newPerDayMinimum: 0, relearnSteps: 1, learnSteps: 1,
    },
  }

  db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    1, crtSec, nowSec, nowSec, 11, 0, 0, 0,
    JSON.stringify(conf), JSON.stringify(modelsJson), JSON.stringify(decksJson), JSON.stringify(dconf), '{}',
  ])

  // 笔记
  const noteIdByGuid = new Map<string, number>()
  let noteSeq = 1700000000000
  const insertNote = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  for (const n of deck.notes) {
    const mid = modelIdByKey.get(n.mid)
    const model = deck.models[n.mid]
    if (!mid || !model) continue
    const nid = noteSeq++
    noteIdByGuid.set(n.guid, nid)
    const ordered = [...model.flds].sort((a, b) => a.ord - b.ord)
    const flds = ordered.map((f) => n.fields[f.name] ?? '').join('\x1f')
    const sortField = ordered[sortfByKey.get(n.mid) ?? 0]
    const sfld = stripForSort(sortField ? (n.fields[sortField.name] ?? '') : '')
    const csum = parseInt(sha1Hex(new TextEncoder().encode(sfld)).slice(0, 8), 16) || 0
    const tags = n.tags.length ? ` ${n.tags.join(' ')} ` : ''
    insertNote.run([nid, n.guid, mid, nowSec, -1, tags, flds, sfld, csum, 0, ''])
  }
  insertNote.free()

  // 卡片
  const cardIdByKey = new Map<string, number>()
  let cardSeq = 1700000000000
  let newPos = 1
  const insertCard = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const c of deck.cards) {
    const nid = noteIdByGuid.get(c.guid)
    if (!nid) continue
    const did = deckIdByPath.get(c.deckPath?.trim() || 'Default') ?? 1
    const sched = fsrsToAnkiSched(progress.states[c.id], crtSec, newPos)
    if (sched.type === 0) newPos++
    const cid = cardSeq++
    cardIdByKey.set(c.id, cid)
    insertCard.run([
      cid, nid, did, c.ord, nowSec, -1, sched.type, sched.queue, sched.due,
      sched.ivl, sched.factor, sched.reps, sched.lapses, sched.left, 0, 0, 0, '',
    ])
  }
  insertCard.free()

  // 复习日志（近似）
  const insertLog = db.prepare('INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)')
  let revSeq = Date.now()
  for (const log of progress.logs) {
    const cid = cardIdByKey.get(log.cardId)
    if (!cid) continue
    const type = log.state === 2 ? 1 : log.state === 3 ? 2 : 0
    insertLog.run([revSeq++, cid, -1, log.rating, Math.round(log.scheduledDays ?? 0), 0, 2500, 0, type])
  }
  insertLog.free()

  const dbBytes = db.export()
  db.close()

  // 媒体：{ "0": "真实文件名", ... } + 以编号命名的文件
  const files: Record<string, Uint8Array> = { 'collection.anki2': dbBytes }
  const mediaMap: Record<string, string> = {}
  let idx = 0
  for (const [name, data] of media) {
    mediaMap[String(idx)] = name
    files[String(idx)] = data
    idx++
  }
  files['media'] = strToU8(JSON.stringify(mediaMap))

  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' })
}

export function makeLogId(cardId: string, time: string, rating: number): string {
  return `${cardId}@${time}#${rating}`
}

export type { ReviewLogEntry }
