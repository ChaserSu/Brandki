import { useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../lib/store'
import { getState, isMastered, type Grade } from '../lib/srs'
import { buildCategoryTree, cardInCategory, displayName, flattenTree, segmentsOf, stripHtml } from '../lib/categories'
import { renderBack, renderFront, remapMedia } from '../lib/template'
import { Badge, Button, Card, ConfirmDialog, Modal } from './ui'
import { cn } from '../lib/utils'
import type { BrandkiCard } from '../lib/types'

type GroupBy = 'category' | 'tag' | 'model' | 'none'
type StatusFilter = 'all' | 'new' | 'learning' | 'review' | 'mastered'

const GROUP_LABELS: { value: GroupBy; label: string }[] = [
  { value: 'category', label: '业态' },
  { value: 'tag', label: '标签' },
  { value: 'model', label: '卡片类型' },
  { value: 'none', label: '不分组' },
]

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '新卡' },
  { value: 'learning', label: '学习中' },
  { value: 'review', label: '复习' },
  { value: 'mastered', label: '已掌握' },
]

const BATCH_ACTIONS: { status: Grade | 'mastered'; label: string; cls: string }[] = [
  { status: 1, label: '重来', cls: 'bg-[#b42318]' },
  { status: 2, label: '困难', cls: 'bg-[#b54708]' },
  { status: 3, label: '良好', cls: 'bg-[#175cd3]' },
  { status: 4, label: '简单', cls: 'bg-[#17803d]' },
  { status: 'mastered', label: '完全掌握', cls: 'bg-stone-800' },
]

function firstImage(card: BrandkiCard, mediaUrls: Record<string, string>): string | null {
  const m = /<img[^>]*\ssrc="([^"]+)"/i.exec(card.fields['Front'] ?? '')
  if (!m) return null
  const filename = m[1].split('/').pop() ?? m[1]
  return mediaUrls[filename] ?? mediaUrls[m[1]] ?? null
}

function statusOf(card: BrandkiCard, progress: ReturnType<typeof useStore>['progress']): { key: StatusFilter; label: string; cls: string } {
  if (isMastered(progress, card.id)) return { key: 'mastered', label: '完全掌握', cls: 'bg-stone-800 text-white' }
  const state = getState(progress, card.id)
  if (!state) return { key: 'new', label: '新卡', cls: 'bg-blue-50 text-[#175cd3]' }
  if (state.state === 1 || state.state === 3) return { key: 'learning', label: '学习中', cls: 'bg-amber-50 text-[#b54708]' }
  return { key: 'review', label: '复习', cls: 'bg-red-50 text-[#b42318]' }
}

export function Browse({ onBack, onEditCard }: { onBack: () => void; onEditCard: (cardId: string) => void }) {
  const { deck, progress, mediaUrls, batchSetStatus, deleteCards } = useStore()
  const [query, setQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('category')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<BrandkiCard | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)

  const cards = deck?.cards ?? []

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cards.filter((c) => {
      const st = statusOf(c, progress)
      if (statusFilter !== 'all' && st.key !== statusFilter) return false
      if (!q) return true
      const hay = [displayName(c), c.fields['英文名'] ?? '', c.deckPath, ...c.tags, stripHtml(c.fields['Back'] ?? '')]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [cards, query, statusFilter, progress])

  // 分组
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; cards: BrandkiCard[] }>()
    for (const c of filtered) {
      let keys: { key: string; label: string }[]
      if (groupBy === 'category') {
        const segs = segmentsOf(c)
        keys = segs.length ? [{ key: segs.join('::'), label: segs.join(' / ') }] : [{ key: '_', label: '未分类' }]
      } else if (groupBy === 'tag') {
        keys = c.tags.length ? c.tags.map((t) => ({ key: t, label: `#${t}` })) : [{ key: '_', label: '无标签' }]
      } else if (groupBy === 'model') {
        keys = [{ key: c.modelName, label: c.modelName }]
      } else {
        keys = [{ key: '_all', label: '全部卡片' }]
      }
      for (const { key, label } of keys) {
        if (!map.has(key)) map.set(key, { label, cards: [] })
        map.get(key)!.cards.push(c)
      }
    }
    return [...map.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'))
  }, [filtered, groupBy])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleGroup = (groupCards: BrandkiCard[]) => {
    const ids = groupCards.map((c) => c.id)
    const allSelected = ids.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  const runBatch = async (status: Grade | 'mastered') => {
    if (selected.size === 0) return
    setBusy(true)
    await batchSetStatus([...selected], status)
    setSelected(new Set())
    setBusy(false)
  }

  /** 执行删除（单卡与批量共用）：清空选中、关掉正在预览的卡 */
  const runDelete = async () => {
    const ids = confirmDelete ?? []
    setConfirmDelete(null)
    if (ids.length === 0) return
    setBusy(true)
    try {
      await deleteCards(ids)
      setSelected((prev) => {
        const next = new Set(prev)
        ids.forEach((id) => next.delete(id))
        return next
      })
      setPreview((p) => (p && ids.includes(p.id) ? null : p))
    } finally {
      setBusy(false)
    }
  }

  const tree = useMemo(() => (deck ? buildCategoryTree(deck.cards) : null), [deck])
  const flatTree = useMemo(() => (tree ? flattenTree(tree) : []), [tree])
  const [catFilter, setCatFilter] = useState<string[]>([])

  const categoryFiltered = useMemo(() => {
    if (catFilter.length === 0) return filtered
    return filtered.filter((c) => cardInCategory(c, catFilter))
  }, [filtered, catFilter])

  // 业态筛选时分组结果需基于筛选后的集合重算（简化：直接再过滤每组）
  const visibleGroups = groups.map((g) => ({
    ...g,
    cards: g.cards.filter((c) => categoryFiltered.some((fc) => fc.id === c.id)),
  })).filter((g) => g.cards.length > 0)

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-xl flex-col px-4 pb-4 pt-5">
      {/* 顶部 */}
      <div className="flex shrink-0 items-center gap-3">
        <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
          ‹
        </button>
        <h1 className="text-lg font-bold">牌库</h1>
        <span className="text-sm text-stone-400">{filtered.length} 张</span>
      </div>

      {/* 搜索 */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索品牌名、业态、标签、介绍…"
        className="mt-3 w-full shrink-0 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand"
      />

      {/* 分组 + 状态筛选 */}
      <div className="mt-2.5 flex shrink-0 flex-wrap gap-1.5">
        {GROUP_LABELS.map((g) => (
          <Chip key={g.value} active={groupBy === g.value} onClick={() => setGroupBy(g.value)}>
            {g.label}
          </Chip>
        ))}
        <span className="mx-1 w-px self-stretch bg-stone-200" />
        {STATUS_FILTERS.map((s) => (
          <Chip key={s.value} active={statusFilter === s.value} onClick={() => setStatusFilter(s.value)}>
            {s.label}
          </Chip>
        ))}
      </div>

      {/* 业态树快速筛选（仅按业态分组时显示） */}
      {groupBy === 'category' && flatTree.length > 0 && (
        <div className="mt-2 flex shrink-0 items-center gap-1.5 overflow-x-auto pb-1">
          <Chip active={catFilter.length === 0} onClick={() => setCatFilter([])}>
            全部分类
          </Chip>
          {flatTree.map(({ node, depth }) => (
            <Chip
              key={node.fullPath}
              active={catFilter.join('::') === node.fullPath}
              onClick={() => setCatFilter(catFilter.join('::') === node.fullPath ? [] : node.path)}
              title={node.fullPath}
            >
              {'　'.repeat(Math.max(0, depth - 1)) + node.label}
            </Chip>
          ))}
        </div>
      )}

      {/* 卡片列表 */}
      <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto pb-24">
        {visibleGroups.length === 0 && (
          <div className="py-16 text-center text-sm text-stone-400">没有符合条件的卡片</div>
        )}
        {visibleGroups.map((g) => {
          const ids = g.cards.map((c) => c.id)
          const picked = ids.filter((id) => selected.has(id)).length
          return (
            <div key={g.key}>
              <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-xl bg-paper/95 px-1 py-1.5 backdrop-blur">
                <button onClick={() => toggleGroup(g.cards)} className="flex items-center gap-2 text-sm font-semibold">
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded border text-[10px] text-white',
                      picked === ids.length && ids.length > 0 ? 'border-brand bg-brand' : 'border-stone-300 bg-white',
                    )}
                  >
                    {picked === ids.length && ids.length > 0 ? '✓' : picked > 0 ? '–' : ''}
                  </span>
                  {g.label}
                  <span className="font-normal text-stone-400">
                    {ids.length} 张{picked > 0 && ` · 已选 ${picked}`}
                  </span>
                </button>
                <button className="text-xs text-brand" onClick={() => toggleGroup(g.cards)}>
                  {picked === ids.length ? '取消全选' : '全选本组'}
                </button>
              </div>
              <div className="space-y-2 pt-1">
                {g.cards.map((card) => (
                  <CardRow
                    key={card.id}
                    card={card}
                    checked={selected.has(card.id)}
                    thumb={firstImage(card, mediaUrls)}
                    status={statusOf(card, progress)}
                    onToggle={() => toggle(card.id)}
                    onPreview={() => setPreview(card)}
                    onDelete={() => setConfirmDelete([card.id])}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* 批量操作固定底栏 */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-xl border-t border-stone-200 bg-white/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">已选 {selected.size} 张，批量设为</span>
            <button className="text-stone-400" onClick={() => setSelected(new Set())}>
              取消
            </button>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {BATCH_ACTIONS.map((a) => (
              <button
                key={a.status}
                disabled={busy}
                onClick={() => void runBatch(a.status)}
                className={cn('rounded-lg py-2.5 text-xs font-medium text-white transition-all active:scale-95', a.cls)}
              >
                {a.label}
              </button>
            ))}
          </div>
          <button
            disabled={busy}
            onClick={() => setConfirmDelete([...selected])}
            className="mt-2 w-full rounded-lg border border-red-200 bg-red-50 py-2.5 text-xs font-medium text-[#b42318] transition-all active:scale-[0.98] disabled:opacity-40"
          >
            🗑 删除所选 {selected.size} 张
          </button>
        </div>
      )}

      {/* 单卡预览 */}
      {preview && (
        <CardPreview
          card={preview}
          mediaUrls={mediaUrls}
          onClose={() => setPreview(null)}
          onEdit={() => {
            const id = preview.id
            setPreview(null)
            onEditCard(id)
          }}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`删除 ${confirmDelete?.length ?? 0} 张卡片？`}
        message={`${
          (confirmDelete?.length ?? 0) === 1 ? '这张卡片' : `这 ${confirmDelete?.length ?? 0} 张卡片`
        }及其学习进度会被永久删除，只被它们使用的图片也会一并从媒体库移除。此操作不可撤销。`}
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void runDelete()}
      />
    </div>
  )
}

function Chip({
  children,
  active,
  onClick,
  title,
}: {
  children: ReactNode
  active: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors',
        active ? 'bg-brand text-white' : 'bg-white text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50',
      )}
    >
      {children}
    </button>
  )
}

function CardRow({
  card,
  checked,
  thumb,
  status,
  onToggle,
  onPreview,
  onDelete,
}: {
  card: BrandkiCard
  checked: boolean
  thumb: string | null
  status: { label: string; cls: string }
  onToggle: () => void
  onPreview: () => void
  onDelete: () => void
}) {
  return (
    <Card className="flex items-center gap-3 p-2.5">
      <button
        onClick={onToggle}
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs text-white',
          checked ? 'border-brand bg-brand' : 'border-stone-300 bg-white',
        )}
      >
        {checked ? '✓' : ''}
      </button>
      <button onClick={onPreview} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        {thumb ? (
          <img src={thumb} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-stone-100 object-cover" />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-paper-deep text-xl">
            🏷
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{displayName(card)}</span>
            {card.fields['英文名'] && card.fields['英文名'] !== displayName(card) && (
              <span className="truncate text-xs text-stone-400">{card.fields['英文名']}</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-stone-400">{card.deckPath}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge className={status.cls}>{status.label}</Badge>
            {card.tags.map((t) => (
              <Badge key={t} className="bg-stone-100 text-stone-500">
                #{t}
              </Badge>
            ))}
          </div>
        </div>
        <span className="shrink-0 pr-1 text-stone-300">›</span>
      </button>
      <button
        onClick={onDelete}
        title="删除这张卡"
        aria-label="删除这张卡"
        className="shrink-0 rounded-lg p-2 text-base text-stone-300 transition-colors hover:bg-red-50 hover:text-[#b42318]"
      >
        🗑
      </button>
    </Card>
  )
}

function CardPreview({
  card,
  mediaUrls,
  onClose,
  onEdit,
}: {
  card: BrandkiCard
  mediaUrls: Record<string, string>
  onClose: () => void
  onEdit: () => void
}) {
  const [flipped, setFlipped] = useState(false)
  const front = remapMedia(renderFront(card.qfmt, card.fields), mediaUrls)
  const back = remapMedia(renderBack(card.qfmt, card.afmt, card.fields), mediaUrls)
  return (
    <Modal open onClose={onClose} className="max-h-[90vh] p-0">
      <div className="flex items-center justify-between p-4 pb-0">
        <div className="min-w-0">
          <div className="truncate font-semibold">{displayName(card)}</div>
          <div className="truncate text-xs text-stone-400">{card.deckPath}</div>
        </div>
        <button className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="flip-scene h-[60vh] p-4">
        <div className={`flip-inner relative h-full ${flipped ? 'flipped' : ''}`}>
          <div className="flip-face absolute inset-0 overflow-y-auto rounded-2xl border border-stone-200 bg-white p-4">
            <div className="anki-content" dangerouslySetInnerHTML={{ __html: front }} />
          </div>
          <div className="flip-face flip-back absolute inset-0 overflow-y-auto rounded-2xl border border-stone-200 bg-white p-4">
            <div className="anki-content" dangerouslySetInnerHTML={{ __html: back }} />
          </div>
        </div>
      </div>
      <div className="flex gap-2.5 px-4 pb-4">
        <Button variant="secondary" className="flex-1" onClick={() => setFlipped((v) => !v)}>
          {flipped ? '看正面' : '翻面看答案'}
        </Button>
        <Button variant="primary" className="flex-1" onClick={onEdit}>
          ✏️ 编辑这张卡
        </Button>
      </div>
    </Modal>
  )
}
