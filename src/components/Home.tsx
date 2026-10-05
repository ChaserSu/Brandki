import { useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../lib/store'
import { countDue } from '../lib/srs'
import { buildCategoryTree, cardInCategory, flattenTree } from '../lib/categories'
import { Badge, Button, Card, ConfirmDialog, Modal } from './ui'
import { ImportDialog } from './ImportDialog'
import { cn } from '../lib/utils'

export interface StudyConfig {
  mode: 'random' | 'category' | 'review'
  categoryPath?: string[]
  categoryLabel?: string
}

export function Home({
  onStudy,
  onBrowse,
  onSettings,
  onEntry,
  onBatchEntry,
}: {
  onStudy: (cfg: StudyConfig) => void
  onBrowse: () => void
  onSettings: () => void
  onEntry: () => void
  onBatchEntry: () => void
}) {
  const { deck, progress, settings, exportBackup, resetProgress, reseedSample } = useStore()
  const [importOpen, setImportOpen] = useState(false)
  const [catOpen, setCatOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const counts = useMemo(
    () => (deck ? countDue(deck.cards, progress) : { newCount: 0, learningCount: 0, reviewCount: 0, masteredCount: 0, total: 0 }),
    [deck, progress],
  )
  const dueTotal = counts.newCount + counts.learningCount + counts.reviewCount

  const tree = useMemo(() => (deck ? buildCategoryTree(deck.cards) : null), [deck])
  const flat = useMemo(() => (tree ? flattenTree(tree) : []), [tree])

  const countOf = (path: string[]) =>
    deck ? deck.cards.filter((c) => cardInCategory(c, path) && !progress.mastered[c.id]).length : 0

  const startCategory = (path: string[], label: string) => {
    setCatOpen(false)
    onStudy({ mode: 'category', categoryPath: path, categoryLabel: label })
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-10 pt-7">
      {/* 顶栏 */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white">
            B
          </div>
          <div className="text-lg font-bold leading-tight">Brandki</div>
        </div>
        <div className="flex items-center">
          <button onClick={onBrowse} className="rounded-full px-3 py-2 text-sm text-stone-500 hover:bg-stone-200/60">
            🗂 牌库
          </button>
          <button onClick={onSettings} className="rounded-full px-3 py-2 text-lg text-stone-500 hover:bg-stone-200/60">
            ⚙
          </button>
          <div className="relative">
            <button className="rounded-full px-2 py-2 text-xl leading-none text-stone-500 hover:bg-stone-200/60" onClick={() => setMenuOpen((v) => !v)}>
              ⋯
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="animate-fade-up absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-stone-200 bg-white py-1 shadow-xl">
                  <MenuItem onClick={() => { setImportOpen(true); setMenuOpen(false) }}>📥 导入牌组</MenuItem>
                  <MenuItem onClick={() => { void exportBackup(); setMenuOpen(false) }} disabled={!deck}>
                    💾 导出备份
                  </MenuItem>
                  <MenuItem onClick={() => { void reseedSample(); setMenuOpen(false) }}>🔄 恢复示例牌组</MenuItem>
                  <MenuItem
                    danger
                    disabled={Object.keys(progress.states).length + Object.keys(progress.mastered).length === 0}
                    onClick={() => {
                      setConfirmClear(true)
                      setMenuOpen(false)
                    }}
                  >
                    ↺ 清空学习进度
                  </MenuItem>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <section className="mt-8">
        <h1 className="text-3xl font-bold tracking-tight">今天也要记得</h1>
        <h1 className="text-3xl font-bold tracking-tight text-stone-400">几个好品牌。</h1>
      </section>

      {deck ? (
        <>
          {/* 三个学习入口 */}
          <div className="mt-7 space-y-3">
            <ActionCard
              icon="🎲"
              title="开始学习：随机"
              desc={`本轮 ${settings.batchSize} 张 · 从未掌握的卡片中随机抽取，新卡优先`}
              onClick={() => onStudy({ mode: 'random' })}
            />
            <ActionCard
              icon="🏪"
              title="开始学习：指定业态"
              desc="按「零售::女装::中淑装」这样的业态分类挑一组来练"
              onClick={() => setCatOpen(true)}
            />
            <ActionCard
              icon="🔁"
              title="开始复习"
              desc={dueTotal > 0 ? `有 ${dueTotal} 张卡片等待复习` : '当前没有到期卡片，可以去随机学习'}
              badge={dueTotal > 0 ? `${dueTotal} 张待复习` : '已清空'}
              onClick={() => dueTotal > 0 && onStudy({ mode: 'review' })}
              disabled={dueTotal === 0}
            />
          </div>

          {/* 手动录入 */}
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <ActionCard
              icon="📸"
              title="单张录入"
              desc="拍一张门店照，AI 识别后生成一张卡"
              onClick={onEntry}
            />
            <ActionCard
              icon="🗂"
              title="批量录入"
              desc="一次选多张照片，批量 AI 补全，挑好再入库"
              onClick={onBatchEntry}
            />
          </div>

          {/* 统计 */}
          <div className="mt-5 grid grid-cols-4 gap-2.5">
            <Stat label="新卡" value={counts.newCount} tone="text-[#175cd3]" />
            <Stat label="学习中" value={counts.learningCount} tone="text-[#b54708]" />
            <Stat label="待复习" value={counts.reviewCount} tone="text-[#b42318]" />
            <Stat label="已掌握" value={counts.masteredCount} tone="text-brand" />
          </div>

          <Card className="mt-5 flex items-center justify-between p-4">
            <div className="min-w-0">
              <div className="truncate font-medium">{deck.name}</div>
              <div className="mt-0.5 text-xs text-stone-400">
                共 {counts.total} 张卡 · {Object.keys(deck.models).length} 种卡片类型
              </div>
            </div>
            <Button variant="secondary" className="shrink-0" onClick={onBrowse}>
              浏览全部
            </Button>
          </Card>
        </>
      ) : (
        <Card className="mt-8 p-8 text-center">
          <p className="text-stone-500">还没有牌组</p>
          <Button variant="primary" className="mt-4" onClick={() => setImportOpen(true)}>
            导入 .apkg 牌组
          </Button>
        </Card>
      )}

      {/* 业态选择 */}
      <Modal open={catOpen} onClose={() => setCatOpen(false)} className="max-h-[80vh]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">选择业态</h2>
          <button className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60" onClick={() => setCatOpen(false)}>
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs text-stone-400">选中某一分类后，将学习其下所有子类的卡片（每轮 {settings.batchSize} 张）</p>
        <div className="mt-4 space-y-1.5">
          <CategoryRow
            label="全部业态"
            depth={0}
            count={countOf([])}
            onClick={() => startCategory([], '全部业态')}
          />
          {flat.map(({ node, depth }) => (
            <CategoryRow
              key={node.fullPath}
              label={node.label}
              depth={depth + 1}
              count={countOf(node.path)}
              onClick={() => startCategory(node.path, node.fullPath)}
            />
          ))}
        </div>
      </Modal>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <ConfirmDialog
        open={confirmClear}
        title="清空学习进度？"
        message="将重置所有评分与「完全掌握」记录，牌组内容保留。此操作不可撤销。"
        confirmText="清空"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false)
          void resetProgress()
        }}
      />
    </div>
  )
}

function ActionCard({
  icon,
  title,
  desc,
  badge,
  onClick,
  disabled,
}: {
  icon: string
  title: string
  desc: string
  badge?: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-4 rounded-2xl border border-stone-200/80 bg-white p-4 text-left shadow-[0_1px_3px_rgba(28,25,23,0.05)] transition-all',
        disabled ? 'opacity-50' : 'hover:border-brand/40 hover:shadow-md active:scale-[0.99]',
      )}
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-paper-deep text-2xl">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="mt-0.5 block truncate text-xs leading-5 text-stone-400">{desc}</span>
      </span>
      {badge && (
        <Badge className="shrink-0 bg-brand-soft text-brand">{badge}</Badge>
      )}
    </button>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <Card className="p-3 text-center">
      <div className={cn('text-xl font-bold tabular-nums', tone)}>{value}</div>
      <div className="mt-0.5 text-[11px] text-stone-400">{label}</div>
    </Card>
  )
}

function CategoryRow({ label, depth, count, onClick }: { label: string; depth: number; count: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={count === 0}
      className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-left hover:bg-brand-soft/50 disabled:opacity-40"
      style={{ paddingLeft: `${12 + depth * 20}px` }}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-stone-400">{count} 张可学</span>
    </button>
  )
}

function MenuItem({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`block w-full px-4 py-2.5 text-left text-sm hover:bg-stone-50 disabled:opacity-40 ${
        danger ? 'text-red-600' : 'text-stone-700'
      }`}
    >
      {children}
    </button>
  )
}
