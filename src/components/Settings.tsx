import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { Card, ConfirmDialog } from './ui'
import { ImportDialog } from './ImportDialog'
import { nativeBridge } from '../lib/native'
import { cn } from '../lib/utils'

const PRESETS = [7, 15, 20]

export function Settings({ onBack }: { onBack: () => void }) {
  const { settings, updateSettings, exportBackup, reseedSample, resetProgress, deck, progress } = useStore()
  const [importOpen, setImportOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'reseed' | 'reset' | null>(null)
  const [custom, setCustom] = useState(
    PRESETS.includes(settings.batchSize) ? '' : String(settings.batchSize || ''),
  )

  const hasProgress = Object.keys(progress.states).length + Object.keys(progress.mastered).length > 0
  const native = nativeBridge()
  const [savePath, setSavePath] = useState('')

  useEffect(() => {
    if (native) void native.getSavePath().then(setSavePath)
  }, [native])

  const setBatch = async (n: number) => {
    await updateSettings({ batchSize: n })
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-10 pt-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
          ‹
        </button>
        <h1 className="text-lg font-bold">设置</h1>
      </div>

      {/* 每轮张数 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">学习</h2>
      <Card className="mt-2 p-4">
        <div className="font-medium">每轮自由学习张数</div>
        <p className="mt-0.5 text-xs leading-5 text-stone-400">
          「随机学习」和「指定业态」每轮抽取的卡片数。复习模式按到期数量进行，不受此限制。
        </p>
        <div className="mt-3 grid grid-cols-4 gap-2.5">
          {PRESETS.map((n) => (
            <button
              key={n}
              onClick={() => {
                setCustom('')
                void setBatch(n)
              }}
              className={cn(
                'rounded-xl border py-3 text-sm font-medium transition-all',
                !custom && settings.batchSize === n
                  ? 'border-brand bg-brand text-white'
                  : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300',
              )}
            >
              {n} 张
            </button>
          ))}
          <div
            className={cn(
              'flex items-center justify-center rounded-xl border px-2',
              custom ? 'border-brand bg-brand-soft ring-1 ring-brand' : 'border-stone-200 bg-white',
            )}
          >
            <input
              type="number"
              min={1}
              max={200}
              value={custom}
              onChange={(e) => {
                const v = e.target.value
                setCustom(v)
                const n = Number(v)
                if (v && n >= 1) void setBatch(Math.min(200, n))
              }}
              placeholder="其他"
              className="w-full bg-transparent text-center text-sm outline-none placeholder:text-stone-400"
            />
          </div>
        </div>
      </Card>

      {/* 存档位置 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">存档位置</h2>
      <Card className="mt-2 p-4">
        {native ? (
          <>
            <div className="flex items-start gap-3">
              <span className="text-xl">🗄</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">本地硬盘存档</div>
                <p className="mt-0.5 break-all text-xs leading-5 text-stone-400">
                  牌组、图片与进度都保存在这个文件夹里，清除浏览器数据或更换浏览器均不受影响。
                  <br />
                  {savePath}
                </p>
              </div>
            </div>
            <button
              onClick={() => void native.openSaveFolder()}
              className="mt-3 w-full rounded-xl border border-stone-200 bg-white py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50"
            >
              在访达中打开存档文件夹
            </button>
          </>
        ) : (
          <div className="flex items-start gap-3">
            <span className="text-xl">🌐</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">当前为浏览器模式</div>
              <p className="mt-0.5 text-xs leading-5 text-stone-400">
                数据保存在当前浏览器的私有存储（OPFS）中，清除浏览器站点数据或更换浏览器会丢失进度。
                下载 Brandki 桌面版可将存档保存在本地硬盘，并通过「导出备份」迁移数据。
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* 牌组与数据 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">牌组与数据</h2>
      <Card className="mt-2 divide-y divide-stone-100">
        <Row
          icon="📥"
          title="导入牌组"
          desc="从 .apkg 文件导入，可选择合并或替换进度"
          onClick={() => setImportOpen(true)}
        />
        <Row icon="💾" title="导出备份" desc="导出包含卡片、图片和进度的备份文件" disabled={!deck} onClick={() => void exportBackup()} />
        <Row
          icon="🔄"
          title="恢复示例牌组"
          desc="重新载入内置示例（会替换当前牌组与进度）"
          onClick={() => setConfirmAction('reseed')}
        />
        <Row
          icon="↺"
          title="清空学习进度"
          desc="保留牌组内容，重置所有评分与掌握记录"
          disabled={!hasProgress}
          danger
          onClick={() => setConfirmAction('reset')}
        />
      </Card>

      <p className="mt-8 px-1 text-center text-xs leading-5 text-stone-400">
        Brandki Demo · 数据仅保存在当前浏览器本地（OPFS）
        <br />
        清除浏览器站点数据会同时删除牌组与进度，请及时导出备份。
      </p>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <ConfirmDialog
        open={confirmAction === 'reseed'}
        title="恢复示例牌组？"
        message="将重新载入内置示例牌组，并替换当前牌组与全部学习进度。此操作不可撤销。"
        confirmText="恢复"
        danger
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          setConfirmAction(null)
          void reseedSample()
        }}
      />
      <ConfirmDialog
        open={confirmAction === 'reset'}
        title="清空学习进度？"
        message="将重置所有评分与「完全掌握」记录，牌组内容保留。此操作不可撤销。"
        confirmText="清空"
        danger
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          setConfirmAction(null)
          void resetProgress()
        }}
      />
    </div>
  )
}

function Row({
  icon,
  title,
  desc,
  onClick,
  disabled,
  danger,
}: {
  icon: string
  title: string
  desc: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left disabled:opacity-40"
    >
      <span className="text-xl">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm font-medium', danger && 'text-red-600')}>{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-stone-400">{desc}</span>
      </span>
      <span className="text-stone-300">›</span>
    </button>
  )
}
