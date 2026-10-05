import { useMemo } from 'react'
import { useStore } from '../lib/store'
import { BUILTIN_FIELD_KEYS, CardForm, DECK_PATH_KEY, nextRowId, type FieldRow } from './CardForm'
import { Card } from './ui'

const RESERVED_KEYS = new Set(['Front', ...BUILTIN_FIELD_KEYS])
const DEFAULT_DECK_PATH = '手动录入'

/** 从卡片 Front 字段里取出第一张图片的媒体文件名 */
function frontImageName(front: string | undefined): string | null {
  const m = /<img[^>]*\ssrc="([^"]+)"/i.exec(front ?? '')
  if (!m) return null
  return m[1].split('/').pop() ?? m[1]
}

export function CardEdit({
  cardId,
  onBack,
  onSettings,
}: {
  cardId: string
  onBack: () => void
  onSettings: () => void
}) {
  const { deck, mediaUrls, updateCard } = useStore()

  const initial = useMemo(() => {
    if (!deck) return null
    const card = deck.cards.find((c) => c.id === cardId)
    if (!card) return null
    const note = deck.notes.find((n) => n.guid === card.guid)
    const model = note ? deck.models[note.mid] : undefined
    const fields = note?.fields ?? card.fields

    const rows: FieldRow[] = [
      { id: nextRowId(), key: 'Back', label: '品牌简介', value: fields['Back'] ?? '', multiline: true, builtin: true },
      { id: nextRowId(), key: '中文名', label: '品牌名（中文）', value: fields['中文名'] ?? '', builtin: true },
      { id: nextRowId(), key: '英文名', label: '品牌名（英文）', value: fields['英文名'] ?? '', builtin: true },
      { id: nextRowId(), key: '品牌级次', label: '品牌级次（A/B/C/D）', value: fields['品牌级次'] ?? '', builtin: true },
      {
        id: nextRowId(),
        key: DECK_PATH_KEY,
        label: '业态（如 零售::女装::中淑装）',
        value: card.deckPath === DEFAULT_DECK_PATH ? '' : card.deckPath,
        builtin: true,
      },
    ]
    // 模型里的其余字段全部作为可编辑/可删除的自定义属性预填
    const extraNames = model ? model.flds.map((f) => f.name) : Object.keys(fields)
    for (const name of extraNames) {
      if (RESERVED_KEYS.has(name)) continue
      rows.push({ id: nextRowId(), key: name, label: name, value: fields[name] ?? '', custom: true })
    }

    const imgName = frontImageName(fields['Front'])
    return {
      rows,
      tags: [...card.tags],
      imageUrl: (imgName && (mediaUrls[imgName] ?? undefined)) || '',
      brand: fields['中文名'] || fields['英文名'] || '品牌卡',
    }
  }, [deck, cardId, mediaUrls])

  if (!deck || !initial) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-10 pt-5">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
            ‹
          </button>
          <h1 className="text-lg font-bold">编辑品牌卡</h1>
        </div>
        <Card className="mt-10 p-8 text-center text-sm text-stone-400">找不到这张卡片，它可能已被删除。</Card>
      </div>
    )
  }

  return (
    <CardForm
      mode="edit"
      title={`编辑 · ${initial.brand}`}
      subtitle="修改后原地保存，这张卡的学习进度（新卡/学习中/复习/已掌握）会完整保留"
      submitLabel="保存修改"
      onBack={onBack}
      onSettings={onSettings}
      initial={{ imageUrl: initial.imageUrl, rows: initial.rows, tags: initial.tags }}
      onSubmit={async (p) => {
        await updateCard(cardId, {
          file: p.file,
          fieldValues: p.fieldValues,
          deckPath: p.deckPath,
          tags: p.tags,
        })
      }}
      done={{
        title: (name) => `「${name}」已保存`,
        message: '卡片信息已更新，学习进度原样保留，没有产生新卡片。',
        primaryLabel: '返回牌库',
      }}
    />
  )
}
