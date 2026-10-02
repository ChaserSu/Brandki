// FSRS 调度封装：复习队列、自由学习队列（随机/指定业态）、评分、掌握态
import { fsrs, createEmptyCard, Rating, State, type Card } from 'ts-fsrs'
import type { BrandkiCard, ProgressFile, ReviewLogEntry } from './types'
import { makeLogId } from './apkg'

const f = fsrs()

export type Grade = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy

export const DAILY_NEW_LIMIT = 50
export const DEFAULT_BATCH_SIZE = 7

export function newProgress(): ProgressFile {
  return { version: 1, states: {}, logs: [], mastered: {} }
}

/** 兼容旧存档：补齐缺失字段 */
export function normalizeProgress(p: Partial<ProgressFile> | null | undefined): ProgressFile {
  return {
    version: 1,
    states: p?.states ?? {},
    logs: p?.logs ?? [],
    mastered: p?.mastered ?? {},
  }
}

export function isMastered(progress: ProgressFile, cardId: string): boolean {
  return !!progress.mastered[cardId]
}

/** 从存档恢复时把 ISO 字符串转回 Date */
export function reviveCard(raw: unknown): Card {
  const c = raw as Card & { due: unknown; last_review?: unknown }
  if (typeof c.due === 'string') c.due = new Date(c.due)
  if (typeof c.last_review === 'string') c.last_review = new Date(c.last_review)
  return c as Card
}

export function getState(progress: ProgressFile, cardId: string): Card | null {
  const raw = progress.states[cardId]
  return raw ? reviveCard(raw) : null
}

export type QueueKind = 'learning' | 'new' | 'review'

export interface QueueItem {
  card: BrandkiCard
  state: Card | null
  kind: QueueKind
}

export function isDue(card: Card, now: Date): boolean {
  return card.due.getTime() <= now.getTime()
}

/** 到期复习队列：学习/重学 → 新卡（限量）→ 复习；完全掌握的卡不出现 */
export function buildQueue(allCards: BrandkiCard[], progress: ProgressFile, now = new Date()): QueueItem[] {
  const learning: QueueItem[] = []
  const reviews: QueueItem[] = []
  const fresh: QueueItem[] = []

  for (const card of allCards) {
    if (isMastered(progress, card.id)) continue
    const state = getState(progress, card.id)
    if (!state) {
      fresh.push({ card, state: null, kind: 'new' })
      continue
    }
    if (!isDue(state, now)) continue
    if (state.state === State.New) {
      fresh.push({ card, state, kind: 'new' })
    } else if (state.state === State.Learning || state.state === State.Relearning) {
      learning.push({ card, state, kind: 'learning' })
    } else if (state.state === State.Review) {
      reviews.push({ card, state, kind: 'review' })
    }
  }

  return [...learning, ...fresh.slice(0, DAILY_NEW_LIMIT), ...reviews]
}

/** Fisher–Yates 洗牌 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 自由学习队列：随时可学，不看到期时间。
 * 从未掌握的卡池中随机抽取 limit 张；可按业态路径前缀过滤。
 * 新卡优先排在前面（打乱后稳定排序），保证每次都有新面孔。
 */
export function buildStudyQueue(
  allCards: BrandkiCard[],
  progress: ProgressFile,
  limit: number,
  filter?: (card: BrandkiCard) => boolean,
): QueueItem[] {
  const pool = allCards
    .filter((c) => !isMastered(progress, c.id))
    .filter((c) => (filter ? filter(c) : true))
  const withMeta = shuffle(pool).map((card) => ({
    card,
    state: getState(progress, card.id),
    kind: (getState(progress, card.id) ? 'review' : 'new') as QueueKind,
    isNew: !progress.states[card.id],
  }))
  withMeta.sort((a, b) => Number(b.isNew) - Number(a.isNew))
  return withMeta.slice(0, limit).map(({ card, state, kind }) => ({ card, state, kind }))
}

export interface Counts {
  newCount: number
  learningCount: number
  reviewCount: number
  masteredCount: number
  total: number
}

export function countDue(allCards: BrandkiCard[], progress: ProgressFile, now = new Date()): Counts {
  let newCount = 0
  let learningCount = 0
  let reviewCount = 0
  let masteredCount = 0
  for (const card of allCards) {
    if (isMastered(progress, card.id)) {
      masteredCount++
      continue
    }
    const state = getState(progress, card.id)
    if (!state) {
      newCount++
      continue
    }
    if (!isDue(state, now)) continue
    if (state.state === State.Learning || state.state === State.Relearning) learningCount++
    else if (state.state === State.Review) reviewCount++
  }
  return {
    newCount: Math.min(newCount, DAILY_NEW_LIMIT),
    learningCount,
    reviewCount,
    masteredCount,
    total: allCards.length,
  }
}

export interface GradePreview {
  rating: Grade
  label: string
  hint: string
}

function formatInterval(card: Card, now: Date): string {
  const ms = card.due.getTime() - now.getTime()
  if (card.scheduled_days >= 1) {
    return card.scheduled_days >= 30 ? `${Math.round(card.scheduled_days / 30)}个月` : `${card.scheduled_days}天`
  }
  if (ms < 60_000) return '1分钟'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}分钟`
  return `${Math.round(min / 60)}小时`
}

/** 四档按钮的标签与预计间隔 */
export function gradePreviews(state: Card | null, now = new Date()): GradePreview[] {
  const card: Card = state ?? createEmptyCard<Card>(now)
  const repeat = f.repeat(card, now)
  return [
    { rating: Rating.Again, label: '重来', hint: formatInterval(repeat[Rating.Again].card, now) },
    { rating: Rating.Hard, label: '困难', hint: formatInterval(repeat[Rating.Hard].card, now) },
    { rating: Rating.Good, label: '良好', hint: formatInterval(repeat[Rating.Good].card, now) },
    { rating: Rating.Easy, label: '简单', hint: formatInterval(repeat[Rating.Easy].card, now) },
  ]
}

export interface GradeResult {
  next: Card
  log: ReviewLogEntry
}

/** 应用一次评分，返回新状态与日志 */
export function applyGrade(cardId: string, state: Card | null, rating: Grade, now = new Date()): GradeResult {
  const card: Card = state ?? createEmptyCard<Card>(now)
  const result = f.repeat(card, now)[rating]
  const time = now.toISOString()
  const log: ReviewLogEntry = {
    id: makeLogId(cardId, time, rating),
    cardId,
    time,
    rating: rating as 1 | 2 | 3 | 4,
    scheduledDays: result.card.scheduled_days,
    stability: result.card.stability,
    difficulty: result.card.difficulty,
    state: result.card.state as number,
  }
  return { next: result.card, log }
}

/** 标记为完全掌握（不再进入任何队列），同时清掉未到期状态的存在感 */
export function markMastered(progress: ProgressFile, cardId: string, now = new Date()) {
  progress.mastered[cardId] = { at: now.toISOString() }
}

export function unmarkMastered(progress: ProgressFile, cardId: string) {
  delete progress.mastered[cardId]
}
