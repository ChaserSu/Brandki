// Brandki 领域模型与存档类型

/** 笔记模型（对应 Anki note type）：字段定义 + 卡片模板 */
export interface NoteModel {
  id: string
  name: string
  css?: string
  flds: { name: string; ord: number }[]
  tmpls: { ord: number; name: string; qfmt: string; afmt: string }[]
}

export interface BrandkiNote {
  guid: string
  mid: string
  fields: Record<string, string>
  tags: string[]
}

/** 展开后的卡片：一张笔记 × 一个模板 = 一张卡 */
export interface BrandkiCard {
  id: string // `${guid}#${ord}`
  guid: string
  ord: number
  modelName: string
  templateName: string
  qfmt: string
  afmt: string
  fields: Record<string, string>
  tags: string[]
  /** Anki 嵌套牌组全路径，如「零售::运动户外::国际零售」，即业态路径 */
  deckPath: string
}

/** library/<deckId>/deck.json */
export interface DeckFile {
  version: 1
  id: string
  name: string
  importedAt: string
  models: Record<string, NoteModel>
  notes: BrandkiNote[]
  cards: BrandkiCard[]
}

/** 可导入的牌组包（解析 apkg / brandki.zip 的结果） */
export interface ImportedDeck {
  deck: DeckFile
  media: Map<string, Uint8Array>
  /** 导入包自带的进度（Anki 快照或 brandki 备份），key 为 cardId */
  progress: ProgressFile
}

/** 一条复习日志 */
export interface ReviewLogEntry {
  id: string
  cardId: string
  time: string // ISO
  rating: 1 | 2 | 3 | 4
  scheduledDays: number
  stability?: number
  difficulty?: number
  state: number
}

/** progress.json：FSRS 记忆状态 + 复习日志 + 完全掌握名单 */
export interface ProgressFile {
  version: 1
  states: Record<string, unknown> // 序列化的 ts-fsrs Card
  logs: ReviewLogEntry[]
  /** 完全掌握：这些卡片不再出现在任何学习/复习队列中 */
  mastered: Record<string, { at: string }>
}

/** settings.json */
export interface SettingsFile {
  version: 1
  deckId: string | null
  seeded: boolean
  welcomed: boolean
  /** 每轮自由学习一次性学习的卡片数 */
  batchSize: number
}

export type MergeStrategy = 'old' | 'new' | 'merge-old' | 'merge-new'
