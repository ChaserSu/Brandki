import { useState } from 'react'
import { useStore } from '../lib/store'
import { DEFAULT_BATCH_SIZE } from '../lib/srs'
import { Button } from './ui'
import { cn } from '../lib/utils'

const PRESETS = [7, 15, 20]

export function Welcome({ onDone }: { onDone: () => void }) {
  const { settings, updateSettings } = useStore()
  const [batch, setBatch] = useState(settings.batchSize || DEFAULT_BATCH_SIZE)
  const [custom, setCustom] = useState('')
  const [saving, setSaving] = useState(false)

  const choosePreset = (n: number) => {
    setBatch(n)
    setCustom('')
  }

  const finish = async () => {
    const size = custom ? Math.max(1, Math.min(200, Number(custom) || batch)) : batch
    setSaving(true)
    // 欢迎页每次启动都会出现，这里只记住每轮张数
    await updateSettings({ batchSize: size })
    onDone()
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-6 py-10">
      <div className="flex-1">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-3xl font-bold text-white shadow-lg">
          B
        </div>
        <h1 className="mt-8 text-4xl font-bold tracking-tight">
          欢迎使用
          <br />
          <span className="text-brand">Brandki</span>
        </h1>
        <p className="mt-4 text-lg leading-8 text-stone-500">
          像背单词一样记住每一个品牌。
          <br />
          看品牌图片，回忆它的名字、定位和业态，
          <br />
          用间隔重复算法，把它们刻进长期记忆。
        </p>

        <div className="mt-10 space-y-3">
          {[
            ['🃏', 'Anki 牌组即开即用', '直接导入 .apkg，卡片模板与图片完整保留'],
            ['🧠', 'FSRS 智能调度', '重来 / 困难 / 良好 / 简单，越熟越少见面'],
            ['🏪', '按业态分组学习', '零售、运动户外、女装……想练哪块练哪块'],
            ['💾', '进度只在本机', '所有数据保存在本地，离线可用'],
          ].map(([icon, title, desc]) => (
            <div key={title} className="flex items-start gap-3 rounded-2xl bg-white/70 p-4">
              <span className="text-2xl leading-none">{icon}</span>
              <div>
                <div className="font-medium">{title}</div>
                <div className="mt-0.5 text-sm text-stone-400">{desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10">
          <h2 className="font-semibold">每轮自由学习多少张卡？</h2>
          <p className="mt-1 text-sm text-stone-400">随机学习和指定业态学习时，每轮一次性学习的卡片数量，之后可在设置中修改。</p>
          <div className="mt-4 grid grid-cols-4 gap-2.5">
            {PRESETS.map((n) => (
              <button
                key={n}
                onClick={() => choosePreset(n)}
                className={cn(
                  'rounded-xl border py-3.5 text-base font-medium transition-all',
                  !custom && batch === n
                    ? 'border-brand bg-brand text-white shadow-sm'
                    : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300',
                )}
              >
                {n} 张
              </button>
            ))}
            <div
              className={cn(
                'flex items-center justify-center rounded-xl border px-2 transition-all',
                custom ? 'border-brand bg-brand-soft ring-1 ring-brand' : 'border-stone-200 bg-white',
              )}
            >
              <input
                type="number"
                min={1}
                max={200}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="其他"
                className="w-full bg-transparent text-center text-sm outline-none placeholder:text-stone-400"
              />
            </div>
          </div>
        </div>
      </div>

      <Button variant="primary" className="mt-10 w-full py-3.5 text-base" disabled={saving} onClick={() => void finish()}>
        开始使用 Brandki
      </Button>
    </div>
  )
}
