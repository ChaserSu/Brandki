// 业态分类：卡片的 deckPath（如「零售::运动户外::国际零售」）构成层级树；标签为平级属性
import type { BrandkiCard } from './types'

export interface CategoryNode {
  /** 从根到当前节点的路径段 */
  path: string[]
  /** 完整路径名，用 :: 连接 */
  fullPath: string
  label: string
  count: number
  children: Map<string, CategoryNode>
}

export function segmentsOf(card: BrandkiCard): string[] {
  return card.deckPath.split('::').map((s) => s.trim()).filter(Boolean)
}

/** 构建业态树（count 为该节点及子树下的卡片总数） */
export function buildCategoryTree(cards: BrandkiCard[]): CategoryNode {
  const root: CategoryNode = {
    path: [],
    fullPath: '',
    label: '全部业态',
    count: cards.length,
    children: new Map(),
  }

  for (const card of cards) {
    const segs = segmentsOf(card)
    let node = root
    const acc: string[] = []
    for (const seg of segs) {
      acc.push(seg)
      let next = node.children.get(seg)
      if (!next) {
        next = { path: [...acc], fullPath: acc.join('::'), label: seg, count: 0, children: new Map() }
        node.children.set(seg, next)
      }
      next.count++
      node = next
    }
  }
  return root
}

/** 卡片是否属于某业态节点（路径前缀匹配；根节点匹配全部） */
export function cardInCategory(card: BrandkiCard, path: string[]): boolean {
  if (path.length === 0) return true
  const segs = segmentsOf(card)
  return path.every((seg, i) => segs[i] === seg)
}

/** 树的深度优先展开（用于列表展示） */
export function flattenTree(node: CategoryNode, depth = 0): { node: CategoryNode; depth: number }[] {
  const out: { node: CategoryNode; depth: number }[] = []
  for (const child of [...node.children.values()].sort((a, b) => b.count - a.count)) {
    out.push({ node: child, depth })
    out.push(...flattenTree(child, depth + 1))
  }
  return out
}

/** 收集所有标签及计数 */
export function collectTags(cards: BrandkiCard[]): { tag: string; count: number }[] {
  const map = new Map<string, number>()
  for (const c of cards) {
    for (const t of c.tags) map.set(t, (map.get(t) ?? 0) + 1)
  }
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
}

/** 从字段中取一个可显示的名字（优先中文名/英文名/Front 纯文本） */
export function displayName(card: BrandkiCard): string {
  return (
    card.fields['中文名'] ||
    card.fields['英文名'] ||
    card.fields['Name'] ||
    stripHtml(card.fields['Front']).slice(0, 20) ||
    card.templateName
  )
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}
