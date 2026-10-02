import { useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { parsePackage } from '../lib/apkg'
import { diffDecks } from '../lib/merge'
import type { ImportDiff } from '../lib/merge'
import type { MergeStrategy } from '../lib/types'
import { Button, Modal } from './ui'
import { cn } from '../lib/utils'

const STRATEGIES: { value: MergeStrategy; title: string; desc: string }[] = [
  { value: 'old', title: '仅保留旧进度', desc: '牌组内容更新，学习进度保持现状；新加入的卡片从新卡开始' },
  { value: 'new', title: '仅保留新进度', desc: '以导入包内的进度为准，当前进度被覆盖；已删卡片重置' },
  { value: 'merge-old', title: '合并进度（旧优先）', desc: '两边进度都保留；同一张卡冲突时保留当前进度' },
  { value: 'merge-new', title: '合并进度（新优先）', desc: '两边进度都保留；同一张卡冲突时采用导入包进度' },
]

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { deck, progress, importFile } = useStore()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [diff, setDiff] = useState<ImportDiff | null>(null)
  const [deckName, setDeckName] = useState('')
  const [strategy, setStrategy] = useState<MergeStrategy>('merge-old')
  const [phase, setPhase] = useState<'pick' | 'parsed' | 'working' | 'done'>('pick')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setFile(null)
    setDiff(null)
    setPhase('pick')
    setError(null)
    setStrategy('merge-old')
  }

  const handleClose = () => {
    if (phase === 'working') return
    reset()
    onClose()
  }

  const onFile = async (f: File) => {
    setError(null)
    try {
      const imported = await parsePackage(await f.arrayBuffer())
      const oldIds = new Set(deck?.cards.map((c) => c.id) ?? [])
      const newIds = new Set(imported.deck.cards.map((c) => c.id))
      setFile(f)
      setDeckName(imported.deck.name)
      setDiff(diffDecks(oldIds, newIds, imported.progress))
      setPhase('parsed')
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析失败，请确认是 .apkg 或 .brandki.zip 文件')
    }
  }

  const confirm = async () => {
    if (!file) return
    setPhase('working')
    try {
      await importFile(file, strategy)
      setPhase('done')
      setTimeout(handleClose, 900)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('parsed')
    }
  }

  return (
    <Modal open={open} onClose={handleClose}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">导入牌组</h2>
        <button className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60" onClick={handleClose}>
          ✕
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".apkg,.zip,.brandki.zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />

      {phase === 'pick' && (
        <div className="mt-4">
          <button
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-stone-300 bg-white/60 px-6 py-10 text-center transition-colors hover:border-brand hover:bg-brand-soft/40"
          >
            <span className="text-3xl">📥</span>
            <span className="font-medium">选择 .apkg 或 .brandki.zip</span>
            <span className="text-xs text-stone-400">Anki 牌组包或 Brandki 备份</span>
          </button>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <p className="mt-4 text-xs leading-5 text-stone-400">
            当前牌组：{deck ? `${deck.name}（${deck.cards.length} 张卡）` : '无'} · 已有进度{' '}
            {Object.keys(progress.states).length} 条
          </p>
        </div>
      )}

      {phase === 'parsed' && diff && (
        <div className="mt-4">
          <div className="rounded-xl bg-white p-4">
            <div className="font-medium">{deckName}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">新增 {diff.added}</span>
              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">更新 {diff.updated}</span>
              {diff.removed > 0 && (
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-stone-600">移除 {diff.removed}</span>
              )}
              <span
                className={cn(
                  'rounded-full px-2.5 py-1',
                  diff.incomingHasProgress ? 'bg-blue-50 text-blue-700' : 'bg-stone-100 text-stone-500',
                )}
              >
                {diff.incomingHasProgress ? '包含学习进度' : '不含进度（全新卡）'}
              </span>
            </div>
          </div>

          <h3 className="mt-5 mb-2 text-sm font-semibold text-stone-600">进度冲突处理</h3>
          <div className="space-y-2">
            {STRATEGIES.map((s) => (
              <button
                key={s.value}
                onClick={() => setStrategy(s.value)}
                className={cn(
                  'w-full rounded-xl border p-3.5 text-left transition-all',
                  strategy === s.value
                    ? 'border-brand bg-brand-soft/60 ring-1 ring-brand'
                    : 'border-stone-200 bg-white hover:border-stone-300',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      strategy === s.value ? 'border-brand' : 'border-stone-300',
                    )}
                  >
                    {strategy === s.value && <span className="h-2 w-2 rounded-full bg-brand" />}
                  </span>
                  <span className="text-sm font-medium">{s.title}</span>
                </div>
                <p className="mt-1 pl-7 text-xs leading-5 text-stone-500">{s.desc}</p>
              </button>
            ))}
          </div>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

          <div className="mt-5 flex gap-3">
            <Button className="flex-1" onClick={() => inputRef.current?.click()}>
              重新选择
            </Button>
            <Button variant="primary" className="flex-[2]" onClick={confirm}>
              确认导入
            </Button>
          </div>
        </div>
      )}

      {phase === 'working' && (
        <div className="py-12 text-center text-stone-500">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-brand" />
          正在写入本地存档…
        </div>
      )}

      {phase === 'done' && <div className="py-12 text-center text-lg font-medium text-brand">✓ 导入完成</div>}
    </Modal>
  )
}
