import { useMemo, useRef, useState } from 'react'
import { autofillFields, fileToDataUrl, isAIConfigured, parseAITags, TAG_FIELD_KEY, TAG_FIELD_LABEL } from '../lib/ai'
import { useStore } from '../lib/store'
import { Button, Card } from './ui'
import { cn } from '../lib/utils'

export interface FieldRow {
  id: string
  /** Anki 模型字段名；业态等非字段属性用特殊键 */
  key: string
  /** 展示名，也是发给 AI 的属性标题 */
  label: string
  value: string
  multiline?: boolean
  /** 系统预置属性，不可改名/删除 */
  builtin?: boolean
  /** 自定义属性，名称可编辑 */
  custom?: boolean
}

export const DECK_PATH_KEY = '__deckPath__'

/** 录入页的内置属性（顺序即展示顺序） */
export const BUILTIN_FIELD_KEYS = ['Back', '中文名', '英文名', '品牌级次']

export function createInitialRows(): FieldRow[] {
  return [
    { id: 'r-back', key: 'Back', label: '品牌简介', value: '', multiline: true, builtin: true },
    { id: 'r-cn', key: '中文名', label: '品牌名（中文）', value: '', builtin: true },
    { id: 'r-en', key: '英文名', label: '品牌名（英文）', value: '', builtin: true },
    { id: 'r-tier', key: '品牌级次', label: '品牌级次（A/B/C/D）', value: '', builtin: true },
    { id: 'r-cat', key: DECK_PATH_KEY, label: '业态（如 零售::女装::中淑装）', value: '', builtin: true },
    { id: 'r-addr', key: '地址', label: '地址（水印照片可自动识别）', value: '', custom: true },
  ]
}

let seq = 0
export function nextRowId(): string {
  seq += 1
  return `r-${Date.now().toString(36)}-${seq}`
}

export interface CardFormPayload {
  /** 编辑模式下为 null 表示保留原照片；录入模式下必有文件 */
  file: File | null
  fieldValues: Record<string, string>
  deckPath: string
  tags: string[]
}

export interface CardFormInitial {
  /** 已有照片的可访问 URL（blob:），编辑模式预填 */
  imageUrl?: string
  rows?: FieldRow[]
  tags?: string[]
}

interface CardFormProps {
  mode: 'create' | 'edit'
  title: string
  subtitle: string
  submitLabel: string
  onBack: () => void
  onSettings: () => void
  onSubmit: (payload: CardFormPayload) => Promise<void>
  initial?: CardFormInitial
  /** 提交成功后回调。有此回调时不显示自身的完成页，由父组件决定下一步（如关闭弹窗） */
  onSaved?: (payload: CardFormPayload) => void
  done: {
    title: (brand: string) => string
    message: string
    primaryLabel: string
    /** 录入模式：显示「继续录入下一张」 */
    allowReset?: boolean
    resetLabel?: string
  }
}

export function CardForm({
  mode,
  title,
  subtitle,
  submitLabel,
  onBack,
  onSettings,
  onSubmit,
  initial,
  onSaved,
  done,
}: CardFormProps) {
  const { settings } = useStore()
  const aiReady = isAIConfigured(settings.ai)

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const existingImage = initial?.imageUrl ?? ''
  const [rows, setRows] = useState<FieldRow[]>(() =>
    initial?.rows ? initial.rows.map((r) => ({ ...r })) : createInitialRows(),
  )
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>(initial?.tags ?? [])
  const [aiFilled, setAiFilled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [doneBrand, setDoneBrand] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const shownPreview = preview || existingImage
  const isEdit = mode === 'edit'

  const aiFieldCount = useMemo(
    () => rows.filter((r) => (r.builtin || r.key.trim()) && r.key !== 'Front').length,
    [rows],
  )

  const pickFile = (f: File | null) => {
    if (!f) return
    if (!f.type.startsWith('image/')) {
      setSubmitError('请选择图片文件')
      return
    }
    setSubmitError('')
    setFile(f)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(URL.createObjectURL(f))
  }

  const updateRow = (id: string, patch: Partial<FieldRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setAiFilled((s) => {
      if (!s.has(id)) return s
      const next = new Set(s)
      next.delete(id)
      return next
    })
  }

  const removeRow = (id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id))
  }

  const addCustomRow = () => {
    setRows((rs) => [...rs, { id: nextRowId(), key: '', label: '', value: '', custom: true }])
  }

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '')
    if (t && !tags.includes(t)) setTags((ts) => [...ts, t])
    setTagInput('')
  }

  /** 取得要送给 AI 的图片文件：新选的文件优先，否则把已有照片的 blob URL 取回为 File */
  const resolveImageFile = async (): Promise<File | null> => {
    if (file) return file
    if (existingImage) {
      try {
        const resp = await fetch(existingImage)
        const blob = await resp.blob()
        const name = existingImage.split('/').pop()?.split('-').slice(-1)[0] || 'store.jpg'
        return new File([blob], name, { type: blob.type || 'image/jpeg' })
      } catch {
        return null
      }
    }
    return null
  }

  const runAI = async () => {
    setAiError('')
    const imageFile = await resolveImageFile()
    if (!imageFile) {
      setAiError('请先上传门店照片，AI 需要根据图片识别品牌信息。')
      return
    }
    if (!aiReady || !settings.ai) {
      setAiError('尚未配置多模态模型，请先到设置中填写 API Key 与模型名。')
      return
    }
    const valid = rows.filter((r) => (r.builtin || r.key.trim()) && r.key !== 'Front')
    setBusy(true)
    try {
      const image = await fileToDataUrl(imageFile)
      const fields = valid.map((r) => ({ key: r.id, label: r.label, value: r.value }))
      // 标签作为合成属性一起送给模型：已有标签当作提示线索，返回后覆盖
      fields.push({ key: TAG_FIELD_KEY, label: TAG_FIELD_LABEL, value: tags.join(' ') })
      const result = await autofillFields(settings.ai, image, fields)
      const filledIds = new Set<string>()
      setRows((rs) =>
        rs.map((r) => {
          const v = result[r.id]
          if (v) {
            filledIds.add(r.id)
            return { ...r, value: v }
          }
          return r
        }),
      )
      setAiFilled(filledIds)
      // 与属性一致：AI 返回非空才覆盖，空则保留原有标签，避免误清空
      const aiTags = result[TAG_FIELD_KEY] ? parseAITags(result[TAG_FIELD_KEY]) : []
      if (aiTags.length) setTags(aiTags)
      if (!filledIds.size && !aiTags.length) setAiError('AI 没有从照片中辨认出可补全的信息，可以换张更清晰的照片再试。')
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI 补全失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  const resetForm = () => {
    setFile(null)
    if (preview) URL.revokeObjectURL(preview)
    setPreview('')
    setRows(createInitialRows())
    setTags([])
    setTagInput('')
    setAiFilled(new Set())
    setAiError('')
    setSubmitError('')
    setDoneBrand(null)
  }

  const submit = async () => {
    setSubmitError('')
    if (!file && !isEdit) {
      setSubmitError('请先上传一张门店照片（必填）。')
      return
    }
    if (!file && !existingImage) {
      setSubmitError('请先上传一张门店照片（必填）。')
      return
    }
    // 校验自定义属性名
    const names = new Set<string>()
    for (const r of rows) {
      if (r.key === DECK_PATH_KEY) continue
      const name = (r.custom ? r.key.trim() : r.key) || ''
      if (r.custom && !name) {
        setSubmitError('有自定义属性还没填写名称，请补全或删除该属性。')
        return
      }
      if (name === 'Front') {
        setSubmitError('「Front」是系统保留字段名，请换一个属性名。')
        return
      }
      if (names.has(name)) {
        setSubmitError(`属性名「${name}」重复了，请修改。`)
        return
      }
      names.add(name)
    }

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

    try {
      const payload = { file, fieldValues, deckPath, tags }
      await onSubmit(payload)
      const brand = fieldValues['中文名'] || fieldValues['英文名'] || '新品牌'
      if (onSaved) {
        onSaved(payload)
      } else {
        setDoneBrand(brand)
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '保存失败，请重试')
    }
  }

  if (doneBrand) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-10 pt-5">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
            ‹
          </button>
          <h1 className="text-lg font-bold">{title}</h1>
        </div>
        <Card className="mt-10 p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-soft text-3xl">
            ✓
          </div>
          <h2 className="mt-4 text-xl font-bold">{done.title(doneBrand)}</h2>
          <p className="mt-2 text-sm leading-6 text-stone-500">{done.message}</p>
          <div className="mt-6 flex gap-2.5">
            <Button variant="secondary" className="flex-1" onClick={onBack}>
              {done.primaryLabel}
            </Button>
            {done.allowReset && (
              <Button variant="primary" className="flex-1" onClick={resetForm}>
                {done.resetLabel ?? '继续录入下一张'}
              </Button>
            )}
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-32 pt-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
          ‹
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold tracking-tight">{title}</h1>
          <p className="text-xs text-stone-400">{subtitle}</p>
        </div>
      </div>

      {/* 图片上传 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">
        门店照片{isEdit ? '' : '（必填）'}
      </h2>
      <Card className="mt-2 overflow-hidden">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
        {shownPreview ? (
          <div className="relative">
            <img
              src={shownPreview}
              alt="门店照片"
              className="max-h-[320px] w-full bg-stone-900 object-contain"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="absolute right-3 top-3 rounded-full bg-black/55 px-3 py-1.5 text-xs text-white"
            >
              更换照片
            </button>
            {isEdit && !file && (
              <span className="absolute bottom-3 left-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] text-white">
                当前照片，不更换则保留原图
              </span>
            )}
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 px-4 py-10 text-center"
          >
            <span className="text-4xl">📷</span>
            <span className="text-sm font-medium text-stone-700">点击上传门店照片</span>
            <span className="text-xs leading-5 text-stone-400">
              建议使用「马克水印相机」等带水印的相机拍摄，
              <br />
              AI 可以从水印中读取拍摄地址、时间、商场等信息
            </span>
          </button>
        )}
      </Card>

      {/* 属性 */}
      <div className="mt-6 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-stone-500">品牌属性（除照片外均选填）</h2>
        <button onClick={addCustomRow} className="text-sm font-medium text-brand hover:underline">
          ＋ 添加属性
        </button>
      </div>

      <div className="mt-2 space-y-3">
        {rows.map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-center gap-2">
              {r.custom ? (
                <input
                  value={r.key}
                  onChange={(e) => updateRow(r.id, { key: e.target.value, label: e.target.value })}
                  placeholder="自定义属性名，如：客单价 / 拓展电话 / 母公司"
                  className="min-w-0 flex-1 rounded-lg border border-dashed border-stone-300 bg-stone-50 px-2.5 py-1.5 text-sm font-medium outline-none focus:border-brand"
                />
              ) : (
                <label className="flex-1 text-sm font-medium text-stone-700">{r.label}</label>
              )}
              {aiFilled.has(r.id) && (
                <span className="shrink-0 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-brand">
                  AI 补全
                </span>
              )}
              {r.custom && (
                <button
                  onClick={() => removeRow(r.id)}
                  className="shrink-0 rounded-full px-2 py-1 text-xs text-stone-400 hover:bg-red-50 hover:text-red-600"
                >
                  删除
                </button>
              )}
            </div>
            {r.multiline ? (
              <textarea
                value={r.value}
                onChange={(e) => updateRow(r.id, { value: e.target.value })}
                rows={3}
                placeholder="留空让 AI 识别；已有文字则会作为提示词交给 AI 补全校正"
                className="mt-2 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-brand"
              />
            ) : (
              <input
                value={r.value}
                onChange={(e) => updateRow(r.id, { value: e.target.value })}
                placeholder="留空让 AI 识别；已有文字则会作为提示词"
                className="mt-2 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
              />
            )}
          </Card>
        ))}
      </div>

      {/* 标签 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">标签（Anki Tags）</h2>
      <Card className="mt-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-700"
            >
              #{t}
              <button
                onClick={() => setTags((ts) => ts.filter((x) => x !== t))}
                className="text-stone-400 hover:text-red-500"
              >
                ✕
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
                e.preventDefault()
                addTag(tagInput)
              }
            }}
            placeholder={tags.length ? '' : '输入标签后回车，如：潮牌、高端、咖啡'}
            className="min-w-[140px] flex-1 bg-transparent px-1 py-1 text-sm outline-none placeholder:text-stone-400"
          />
        </div>
      </Card>

      {aiError && (
        <div className="mt-4 rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">
          ✕ {aiError}
          {!aiReady && (
            <button onClick={onSettings} className="ml-1 font-medium underline">
              去设置
            </button>
          )}
        </div>
      )}
      {submitError && (
        <div className="mt-4 rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">✕ {submitError}</div>
      )}

      {/* 底部固定操作区 */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-paper/95 px-5 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-xl gap-2.5">
          <Button
            variant="secondary"
            className={cn('flex-1', busy && 'opacity-60')}
            disabled={busy}
            onClick={() => void runAI()}
          >
            {busy ? 'AI 识别中…' : `✨ AI 自动补全${aiReady ? '' : '（未配置）'}`}
          </Button>
          <Button variant="primary" className="flex-1" disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
        <p className="mx-auto mt-1.5 w-full max-w-xl text-center text-[11px] text-stone-400">
          AI 将补全 {aiFieldCount} 个属性与标签：空属性直接识别，已有文字/标签会作为提示词
        </p>
      </div>
    </div>
  )
}
