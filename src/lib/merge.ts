// 导入时的四种进度合并策略
// 设 A = 当前库，B = 导入包
import type { MergeStrategy, ProgressFile, ReviewLogEntry } from './types'

interface MergeInput {
  old: ProgressFile
  incoming: ProgressFile
  /** 当前库全部卡片 id */
  oldCardIds: Set<string>
  /** 新牌组全部卡片 id（以 guid#ord 匹配） */
  newCardIds: Set<string>
  strategy: MergeStrategy
}

function mergeLogs(oldLogs: ReviewLogEntry[], incomingLogs: ReviewLogEntry[], preferNew: boolean | null) {
  // preferNew: null = 只取一侧；true/false = 并集时冲突优先谁
  const map = new Map<string, ReviewLogEntry>()
  if (preferNew === false) {
    for (const l of oldLogs) map.set(l.id, l)
    for (const l of incomingLogs) if (!map.has(l.id)) map.set(l.id, l)
  } else if (preferNew === true) {
    for (const l of oldLogs) map.set(l.id, l)
    for (const l of incomingLogs) map.set(l.id, l)
  }
  return [...map.values()].sort((a, b) => a.time.localeCompare(b.time))
}

export function mergeProgress({ old, incoming, oldCardIds, newCardIds, strategy }: MergeInput): ProgressFile {
  const states: ProgressFile['states'] = {}
  let logs: ReviewLogEntry[] = []

  const ids = new Set([...Object.keys(old.states), ...Object.keys(incoming.states)])

  for (const id of ids) {
    const a = old.states[id]
    const b = incoming.states[id]
    const inOld = oldCardIds.has(id)
    const inNew = newCardIds.has(id)

    if (strategy === 'old') {
      // 仅保留旧进度：匹配卡用 A；新增卡用 B；旧有新无：保留 A
      if (a) states[id] = a
      else if (b && inNew) states[id] = b
    } else if (strategy === 'new') {
      // 仅保留新进度：匹配卡用 B；新增卡用 B；旧有新无：重置（不写入）
      if (b && inNew) states[id] = b
    } else if (strategy === 'merge-old') {
      // 合并旧优先：匹配卡保留 A，其余取 B
      if (a) states[id] = a
      else if (b) states[id] = b
    } else {
      // 合并新优先：匹配卡取 B，旧独有保留 A
      if (b) states[id] = b
      else if (a && inOld) states[id] = a
    }
  }

  // mastered 名单与 states 采用相同的冲突语义
  const mastered: ProgressFile['mastered'] = {}
  const mIds = new Set([...Object.keys(old.mastered ?? {}), ...Object.keys(incoming.mastered ?? {})])
  for (const id of mIds) {
    const a = old.mastered?.[id]
    const b = incoming.mastered?.[id]
    if (strategy === 'old') {
      if (a) mastered[id] = a
      else if (b && newCardIds.has(id)) mastered[id] = b
    } else if (strategy === 'new') {
      if (b && newCardIds.has(id)) mastered[id] = b
    } else if (strategy === 'merge-old') {
      if (a) mastered[id] = a
      else if (b) mastered[id] = b
    } else {
      if (b) mastered[id] = b
      else if (a && oldCardIds.has(id)) mastered[id] = a
    }
  }

  if (strategy === 'old') {
    logs = old.logs
  } else if (strategy === 'new') {
    logs = incoming.logs
  } else if (strategy === 'merge-old') {
    logs = mergeLogs(old.logs, incoming.logs, false)
  } else {
    logs = mergeLogs(old.logs, incoming.logs, true)
  }

  return { version: 1, states, logs, mastered }
}

export interface ImportDiff {
  added: number
  updated: number
  removed: number
  matchedWithProgress: number
  incomingHasProgress: boolean
}

export function diffDecks(
  oldCardIds: Set<string>,
  newCardIds: Set<string>,
  incoming: ProgressFile,
): ImportDiff {
  let added = 0
  let updated = 0
  for (const id of newCardIds) {
    if (oldCardIds.has(id)) updated++
    else added++
  }
  const removed = [...oldCardIds].filter((id) => !newCardIds.has(id)).length
  const incomingHasProgress = Object.keys(incoming.states).length > 0
  const matchedWithProgress = Object.keys(incoming.states).filter((id) => oldCardIds.has(id)).length
  return { added, updated, removed, matchedWithProgress, incomingHasProgress }
}
