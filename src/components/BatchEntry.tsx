import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import {
  CardForm,
  DECK_PATH_KEY,
  createInitialRows,
  type FieldRow,
} from './CardForm'
import { Button, Card, ConfirmDialog } from './ui'
import { cn } from '../lib/utils'
import { autofillFields, fileToDataUrl, isAIConfigured } from '../lib/ai'

interface DraftCard {
  id: string
  file: File
  previewUrl: string
  rows: FieldRow[]
  tags: string[]
  aiStatus: 'idle' | 'running' | 'done' | 'error'
  aiError?: string
  aiFilledCount: number
}

function draftBrand(d: DraftCard): string {
  const cn = d.rows.find((r) => r.key === '中文名')?.value ?? ''
  const en = d.rows.find((r) => r.key === '英文名')?.value ?? ''
  return cn || en || d.file.name
}

function rowsToPayload(rows: FieldRow[]): { fieldValues: Record<string, string>; deckPath: string } {
  const fieldValues: Record<string, string> = {}
  let deckPath = ''
  for (const r of rows) {
    if (r.key === DECK_PATH_KEY) {
      deckPath = r.value.trim()
      continue
    }
    const name = r.custom ? r.key.trim() : r.key
    if (name) fieldValues[name] = r.value
  }
  return { fieldValues, deckPath }
}

export function BatchEntry({ onBack, onSettings }: { onBack: () => void; onSettings: () => void }) {
  const { addManualCard, settings } = useStore()
  const aiReady = isAIConfigured(settings.ai)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [drafts, setDrafts] = useState<DraftCard[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiProgress, setAiProgress] = useState({ done: 0, total: 0 })
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 })
  const [importResult, setImportResult] = useState<{ added: number; skipped: number; errors: string[] } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<'selected' | 'all' | null>(null)

  const pickFiles = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const newDrafts: DraftCard[] = []
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i]
      if (!f.type.startsWith('image/')) continue
      const id = `draft-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`
      newDrafts.push({
        id,
        file: f,
        previewUrl: URL.createObjectURL(f),
        rows: createInitialRows(),
        tags: [],
        aiStatus: 'idle',
        aiFilledCount: 0,
      })
    }
    if (!newDrafts.length) return
    setDrafts((ds) => [...ds, ...newDrafts])
    setSelected((s) => {
      const next = new Set(s)
      for (const d of newDrafts) next.add(d.id)
      return next
    })
  }, [])

  // 清理预览 URL：用 ref 跟踪最新草稿，避免卸载时闭包捕获初始空数组导致泄漏
  const draftsRef = useRef<DraftCard[]>([])
  draftsRef.current = drafts
  const mountedRef = useRef(true)
  useEffect(() => {
    return () => {
      mountedRef.current = false
      for (const d of draftsRef.current) URL.revokeObjectURL(d.previewUrl)
    }
  }, [])

  const updateDraft = useCallback((id: string, patch: Partial<DraftCard>) => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }, [])

  const removeDrafts = useCallback((ids: Set<string>) => {
    setDrafts((ds) => {
      const keep: DraftCard[] = []
      for (const d of ds) {
        if (ids.has(d.id)) URL.revokeObjectURL(d.previewUrl)
        else keep.push(d)
      }
      return keep
    })
    setSelected((s) => {
      const next = new Set(s)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  const allSelected = drafts.length > 0 && drafts.every((d) => selected.has(d.id))
  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(drafts.map((d) => d.id)))
  }
  const invertSelection = () => {
    setSelected((s) => {
      const next = new Set<string>()
      for (const d of drafts) if (!s.has(d.id)) next.add(d.id)
      return next
    })
  }

  // ---------- 批量 AI 补全 ----------
  const runBatchAI = async () => {
    const targets = drafts.filter((d) => selected.has(d.id))
    if (!targets.length) return
    if (!aiReady || !settings.ai) {
      alert('尚未配置多模态模型，请先到设置中填写 API Key 与模型名。')
      return
    }
    setAiBusy(true)
    setAiProgress({ done: 0, total: targets.length })
    let done = 0
    // 串行请求，避免同时发太多导致限流或 token 超限
    for (const d of targets) {
      if (!mountedRef.current) return // 已离开页面：停止继续消耗 AI 配额
      updateDraft(d.id, { aiStatus: 'running', aiError: undefined })
      try {
        const image = await fileToDataUrl(d.file)
        const fields = d.rows
          .filter((r) => (r.builtin || r.key.trim()) && r.key !== 'Front')
          .map((r) => ({ key: r.id, label: r.label, value: r.value }))
        // 标签作为合成属性
        fields.push({
          key: '__tags__',
          label: '标签（Anki Tags）',
          value: d.tags.join(' '),
        })
        const result = await autofillFields(settings.ai, image, fields)
        const nextRows = d.rows.map((r) => (result[r.id] ? { ...r, value: result[r.id] } : r))
        const filledCount = d.rows.filter((r) => !!result[r.id]).length
        let nextTags = d.tags
        if (result['__tags__']) {
          nextTags = result['__tags__']
            .split(/[\s,，、;；]+/)
            .map((t) => t.trim().replace(/^#/, ''))
            .filter((t) => t)
            .filter((t, i, arr) => arr.indexOf(t) === i)
        }
        updateDraft(d.id, { rows: nextRows, tags: nextTags, aiStatus: 'done', aiFilledCount: filledCount })
      } catch (err) {
        updateDraft(d.id, {
          aiStatus: 'error',
          aiError: err instanceof Error ? err.message : 'AI 补全失败',
        })
      }
      done += 1
      setAiProgress({ done, total: targets.length })
    }
    setAiBusy(false)
  }

  // ---------- 单张编辑 ----------
  const editingDraft = useMemo(
    () => drafts.find((d) => d.id === editingId) ?? null,
    [drafts, editingId],
  )

  // ---------- 批量入库 ----------
  const runImport = async () => {
    const targets = drafts.filter((d) => selected.has(d.id))
    if (!targets.length) return
    setImporting(true)
    setImportProgress({ done: 0, total: targets.length })
    const errors: string[] = []
    let added = 0
    let done = 0
    for (const d of targets) {
      try {
        const { fieldValues, deckPath } = rowsToPayload(d.rows)
        await addManualCard({ file: d.file, fieldValues, deckPath, tags: d.tags })
        added += 1
        // 入库后从草稿移除，避免重复
        URL.revokeObjectURL(d.previewUrl)
        setDrafts((ds) => ds.filter((x) => x.id !== d.id))
      } catch (err) {
        errors.push(`${draftBrand(d)}：${err instanceof Error ? err.message : '未知错误'}`)
      }
      done += 1
      setImportProgress({ done, total: targets.length })
    }
    setSelected(new Set())
    setImportResult({ added, skipped: targets.length - added - errors.length + errors.length, errors })
    setImporting(false)
  }

  // 还没选图：上传引导页
  if (drafts.length === 0 && !importResult) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-10 pt-5">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
            ‹
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight">批量录入品牌</h1>
            <p className="text-xs text-stone-400">一次选多张门店照，AI 批量识别，再挑要入库的</p>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => pickFiles(e.target.files)}
        />

        <Card className="mt-8 flex flex-col items-center gap-3 p-10 text-center">
          <span className="text-5xl">📸</span>
          <span className="text-base font-semibold text-stone-700">选择多张门店照片</span>
          <span className="text-xs leading-5 text-stone-400">
            支持同时选多张，建议使用「马克水印相机」等带水印的相机拍摄
            <br />
            AI 可以从水印中读取拍摄地址、时间、商场等信息
          </span>
          <Button variant="primary" className="mt-4 w-full" onClick={() => fileInputRef.current?.click()}>
            选择照片
          </Button>
        </Card>

        <div className="mt-6 space-y-2 text-xs text-stone-400">
          <p>1. 选图 → 生成草稿卡片列表</p>
          <p>2. 可选「一键 AI 补全」批量识别所有信息，也可以跳过、之后手动编辑</p>
          <p>3. 点击任意卡片可单独修改字段、标签、更换照片</p>
          <p>4. 勾选要保留的（全选/反选），点「录入牌库」一次性入库</p>
        </div>
      </div>
    )
  }

  // 入库完成页
  if (importResult) {
    const hasMore = drafts.length > 0
    return (
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-10 pt-5">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
            ‹
          </button>
          <h1 className="text-lg font-bold">批量录入完成</h1>
        </div>
        <Card className="mt-8 p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-soft text-3xl">
            ✓
          </div>
          <div className="mt-4 text-base font-semibold text-stone-800">
            已成功录入 {importResult.added} 张卡片
          </div>
          {importResult.errors.length > 0 && (
            <div className="mt-4 text-left text-xs leading-5 text-red-600">
              <div className="mb-1 font-medium">失败 {importResult.errors.length} 张：</div>
              {importResult.errors.map((e, i) => (
                <div key={i}>• {e}</div>
              ))}
            </div>
          )}
        </Card>
        <div className="mt-6 flex gap-2.5">
          <Button variant="secondary" className="flex-1" onClick={onBack}>
            返回首页
          </Button>
          {hasMore && (
            <Button
              variant="primary"
              className="flex-1"
              onClick={() => {
                setImportResult(null)
              }}
            >
              继续处理剩余 {drafts.length} 张
            </Button>
          )}
        </div>
      </div>
    )
  }

  const selectedCount = selected.size

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-40 pt-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold tracking-tight">批量录入品牌</h1>
          <p className="text-xs text-stone-400">
            共 {drafts.length} 张草稿，已选 {selectedCount} 张
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 rounded-full bg-brand-soft px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand-soft/70"
        >
          ＋ 添加
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => pickFiles(e.target.files)}
      />

      {/* 选择工具栏 */}
      <div className="mt-4 flex items-center gap-2 px-1 text-xs">
        <button
          onClick={toggleSelectAll}
          className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-stone-600 hover:bg-stone-50"
        >
          {allSelected ? '取消全选' : '全选'}
        </button>
        <button
          onClick={invertSelection}
          className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-stone-600 hover:bg-stone-50"
        >
          反选
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setConfirmDelete(selectedCount ? 'selected' : 'all')}
          className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[#b42318] hover:bg-red-100"
        >
          {selectedCount ? `删除选中 ${selectedCount} 张` : '清空全部'}
        </button>
      </div>

      {/* 草稿网格 */}
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {drafts.map((d) => {
          const brand = draftBrand(d)
          const cat = d.rows.find((r) => r.key === DECK_PATH_KEY)?.value
          const isSelected = selected.has(d.id)
          const aiBadge =
            d.aiStatus === 'done'
              ? { label: `AI 补全 ${d.aiFilledCount}`, cls: 'bg-brand-soft text-brand' }
              : d.aiStatus === 'running'
                ? { label: 'AI 识别中…', cls: 'bg-amber-50 text-amber-700' }
                : d.aiStatus === 'error'
                  ? { label: 'AI 失败', cls: 'bg-red-50 text-red-600' }
                  : null
          return (
            <div
              key={d.id}
              role="button"
              tabIndex={0}
              onClick={() => setEditingId(d.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setEditingId(d.id)
              }}
              className={cn(
                'relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white text-left shadow-[0_1px_3px_rgba(28,25,23,0.05)] transition-all',
                isSelected ? 'ring-2 ring-brand ring-offset-1' : '',
              )}
            >
              <div className="relative aspect-square w-full bg-stone-900">
                <img src={d.previewUrl} alt="" className="h-full w-full object-cover" />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelected((s) => {
                      const next = new Set(s)
                      if (next.has(d.id)) next.delete(d.id)
                      else next.add(d.id)
                      return next
                    })
                  }}
                  className={cn(
                    'absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold text-white shadow-sm transition-colors',
                    isSelected ? 'border-brand bg-brand' : 'border-white/70 bg-black/30',
                  )}
                  aria-label={isSelected ? '取消选择' : '选择'}
                >
                  {isSelected ? '✓' : ''}
                </button>
                {aiBadge && (
                  <span
                    className={cn(
                      'absolute bottom-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-medium',
                      aiBadge.cls,
                    )}
                  >
                    {aiBadge.label}
                  </span>
                )}
              </div>
              <div className="flex min-h-[60px] flex-col gap-1 p-2.5">
                <div className="line-clamp-1 text-xs font-semibold text-stone-800">{brand}</div>
                <div className="line-clamp-1 text-[11px] text-stone-400">{cat || '未分配业态'}</div>
                {d.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {d.tags.slice(0, 3).map((t) => (
                      <span key={t} className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500">
                        #{t}
                      </span>
                    ))}
                    {d.tags.length > 3 && (
                      <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-400">
                        +{d.tags.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 单张编辑弹窗 */}
      {editingDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-0 sm:p-6">
          <div className="h-full w-full overflow-y-auto bg-paper sm:h-[90vh] sm:max-w-xl sm:rounded-2xl">
            <CardForm
              mode="edit"
              title={`编辑 · ${draftBrand(editingDraft)}`}
              subtitle="修改后会更新草稿，不会立即入库"
              submitLabel="保存修改"
              onBack={() => setEditingId(null)}
              onSettings={onSettings}
              initial={{ imageUrl: editingDraft.previewUrl, rows: editingDraft.rows, tags: editingDraft.tags }}
              onSubmit={async () => {
                // 不做真正的写入，实际保存在 onSaved 回调里
              }}
              onSaved={(payload) => {
                // 直接采用表单提交的完整行，保留自定义属性的新增/删除/改名
                let nextPreview = editingDraft.previewUrl
                if (payload.file) {
                  URL.revokeObjectURL(editingDraft.previewUrl)
                  nextPreview = URL.createObjectURL(payload.file)
                }
                updateDraft(editingDraft.id, {
                  rows: payload.rows,
                  tags: payload.tags,
                  file: payload.file ?? editingDraft.file,
                  previewUrl: nextPreview,
                })
                setEditingId(null)
              }}
              done={{
                title: (name) => `「${name}」已保存`,
                message: '草稿已更新，回到列表继续处理其他卡片。',
                primaryLabel: '返回列表',
              }}
            />
          </div>
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete === 'all' ? '清空全部草稿？' : `删除选中 ${selectedCount} 张草稿？`}
        message="删除后无法恢复，但不会影响已入库的卡片。"
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete === 'all') {
            for (const d of drafts) URL.revokeObjectURL(d.previewUrl)
            setDrafts([])
            setSelected(new Set())
          } else {
            removeDrafts(selected)
          }
          setConfirmDelete(null)
        }}
      />

      {/* 底部固定操作栏 */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-paper/95 px-5 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-2">
          <div className="flex gap-2.5">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={aiBusy || importing || !selectedCount || !aiReady}
              onClick={() => void runBatchAI()}
            >
              {aiBusy
                ? `AI 批量识别中… ${aiProgress.done}/${aiProgress.total}`
                : `✨ AI 批量补全${aiReady ? '' : '（未配置）'}`}
            </Button>
            <Button
              variant="primary"
              className="flex-1"
              disabled={importing || aiBusy || !selectedCount}
              onClick={() => void runImport()}
            >
              {importing
                ? `录入中… ${importProgress.done}/${importProgress.total}`
                : `录入 ${selectedCount} 张到牌库`}
            </Button>
          </div>
          <p className="text-center text-[11px] text-stone-400">
            点击任一张卡片可单独编辑字段和标签；AI 批量补全只处理已选中的卡片
          </p>
        </div>
      </div>
    </div>
  )
}
