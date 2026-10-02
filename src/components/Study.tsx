import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../lib/store'
import {
  applyGrade,
  buildQueue,
  buildStudyQueue,
  gradePreviews,
  markMastered,
  type Grade,
  type QueueItem,
} from '../lib/srs'
import { cardInCategory } from '../lib/categories'
import { renderBack, renderFront, remapMedia } from '../lib/template'
import { Button, Progress } from './ui'
import type { StudyConfig } from './Home'

const GRADE_CLASSES = [
  'bg-[#b42318] hover:bg-[#941c13]',
  'bg-[#b54708] hover:bg-[#933a06]',
  'bg-[#175cd3] hover:bg-[#124bab]',
  'bg-[#17803d] hover:bg-[#116631]',
] as const

const MODE_TITLE: Record<StudyConfig['mode'], string> = {
  random: '随机学习',
  category: '业态学习',
  review: '到期复习',
}

export function Study({ config, onExit }: { config: StudyConfig; onExit: () => void }) {
  const { deck, progress, settings, mediaUrls, patchProgress } = useStore()
  const [queue, setQueue] = useState<QueueItem[]>(() => {
    if (!deck) return []
    if (config.mode === 'review') return buildQueue(deck.cards, progress)
    const filter =
      config.mode === 'category' && config.categoryPath
        ? (card: (typeof deck.cards)[number]) => cardInCategory(card, config.categoryPath!)
        : undefined
    return buildStudyQueue(deck.cards, progress, settings.batchSize, filter)
  })
  const [done, setDone] = useState(0)
  const [agains, setAgains] = useState(0)
  const [masteredCount, setMasteredCount] = useState(0)
  const [flipped, setFlipped] = useState(false)

  const total = done + queue.length
  const current = queue[0]

  const frontHtml = useMemo(() => {
    if (!current) return ''
    return remapMedia(renderFront(current.card.qfmt, current.card.fields), mediaUrls)
  }, [current, mediaUrls])

  const backHtml = useMemo(() => {
    if (!current) return ''
    return remapMedia(renderBack(current.card.qfmt, current.card.afmt, current.card.fields), mediaUrls)
  }, [current, mediaUrls])

  const previews = useMemo(() => (current ? gradePreviews(current.state) : []), [current])

  const advance = useCallback(
    async (action: Grade | 'mastered') => {
      if (!current) return
      await patchProgress((p) => {
        if (action === 'mastered') {
          markMastered(p, current.card.id)
          setMasteredCount((n) => n + 1)
        } else {
          const { next, log } = applyGrade(current.card.id, current.state, action)
          p.states[current.card.id] = next
          if (!p.logs.some((l) => l.id === log.id)) p.logs.push(log)
        }
      })
      setQueue((q) => {
        const [head, ...rest] = q
        if (action === 1) return [...rest, head]
        return rest
      })
      setDone((d) => d + 1)
      if (action === 1) setAgains((a) => a + 1)
      setFlipped(false)
    },
    [current, patchProgress],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        setFlipped((v) => (current ? !v : v))
      } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
        void advance(Number(e.key) as Grade)
      } else if (flipped && (e.key === '5' || e.key.toLowerCase() === 'm')) {
        void advance('mastered')
      } else if (e.key === 'Escape') {
        onExit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flipped, advance, current, onExit])

  if (!deck) return null

  if (!current) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center px-6 text-center">
        <div className="animate-fade-up text-6xl">🎉</div>
        <h1 className="mt-4 text-2xl font-bold">本轮学习完成</h1>
        <p className="mt-2 text-stone-500">
          共学习 {done} 张
          {agains > 0 && `，${agains} 张需要再见一次`}
          {masteredCount > 0 && `，${masteredCount} 张已完全掌握`}
        </p>
        <Button variant="primary" className="mt-8 w-full max-w-xs py-3" onClick={onExit}>
          返回首页
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-xl flex-col px-4 pb-4 pt-4">
      {/* 顶部：退出 + 模式 + 进度 */}
      <div className="flex shrink-0 items-center gap-3">
        <button onClick={onExit} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60" aria-label="退出">
          ✕
        </button>
        <div className="min-w-0 flex-1">
          <Progress value={total ? (done / total) * 100 : 0} />
        </div>
        <span className="shrink-0 text-sm tabular-nums text-stone-400">
          {done + 1}/{total}
        </span>
      </div>
      <div className="mt-2 flex shrink-0 items-center justify-between px-1 text-xs text-stone-400">
        <span className="truncate">
          {MODE_TITLE[config.mode]}
          {config.categoryLabel ? ` · ${config.categoryLabel}` : ''} · {current.card.modelName}
        </span>
        <span className="shrink-0">{flipped ? '选择掌握程度' : '请辨认这个品牌'}</span>
      </div>

      {/* 卡片：占满除顶部和底部按钮外的全部空间 */}
      <div className="flip-scene mt-3 min-h-0 flex-1 cursor-pointer select-none" onClick={() => setFlipped(true)}>
        <div className={`flip-inner relative h-full ${flipped ? 'flipped' : ''}`}>
          {/* 正面 */}
          <div className="flip-face absolute inset-0 overflow-hidden rounded-3xl border border-stone-200/80 bg-white shadow-sm">
            <div className="anki-content flex h-full flex-col p-4">
              <div className="min-h-0 flex-1">
                <div dangerouslySetInnerHTML={{ __html: frontHtml }} />
              </div>
              <div className="shrink-0 pt-2 text-center text-xs text-stone-400">
                点击卡片或按空格显示答案
              </div>
            </div>
          </div>
          {/* 背面 */}
          <div className="flip-face flip-back absolute inset-0 overflow-hidden rounded-3xl border border-stone-200/80 bg-white shadow-sm">
            <div className="anki-content h-full overflow-y-auto p-5">
              <div dangerouslySetInnerHTML={{ __html: backHtml }} />
            </div>
          </div>
        </div>
      </div>

      {/* 底部固定操作区 */}
      {!flipped ? (
        <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
          <Button variant="primary" className="mt-3 w-full py-3.5 text-base" onClick={() => setFlipped(true)}>
            显示答案
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid shrink-0 grid-cols-5 gap-2 pb-[env(safe-area-inset-bottom)]">
          {previews.map((p, i) => (
            <button
              key={p.rating}
              onClick={() => void advance(p.rating)}
              className={`flex flex-col items-center gap-0.5 rounded-xl px-1 py-2.5 text-white transition-all active:scale-95 ${GRADE_CLASSES[i]}`}
            >
              <span className="text-xs font-medium sm:text-sm">{p.label}</span>
              <span className="text-[10px] opacity-80">{p.hint}</span>
            </button>
          ))}
          <button
            onClick={() => void advance('mastered')}
            className="flex flex-col items-center gap-0.5 rounded-xl bg-stone-800 px-1 py-2.5 text-white transition-all hover:bg-stone-900 active:scale-95"
          >
            <span className="text-xs font-medium sm:text-sm">完全掌握</span>
            <span className="text-[10px] opacity-70">不再出现</span>
          </button>
        </div>
      )}
    </div>
  )
}
