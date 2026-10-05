import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'
import { Card, ConfirmDialog, Button } from './ui'
import { ImportDialog } from './ImportDialog'
import { nativeBridge } from '../lib/native'
import { testConnection } from '../lib/ai'
import type { AIProtocol, AISettings } from '../lib/types'
import { cn, formatBytes } from '../lib/utils'

const PRESETS = [7, 15, 20]

export function Settings({ onBack, onEditPrompt }: { onBack: () => void; onEditPrompt: () => void }) {
  const { settings, updateSettings, exportBackup, exportApkg, reseedSample, resetProgress, deck, progress } = useStore()
  const [importOpen, setImportOpen] = useState(false)
  const [apkgOpen, setApkgOpen] = useState(false)
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

      {/* AI 自动补全 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">AI 自动补全</h2>
      <AISection onEditPrompt={onEditPrompt} />

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

      {/* 存储空间 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">存储空间</h2>
      <StorageSection />

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
          icon="📦"
          title="导出为 apkg"
          desc="导出可在 Anki 等兼容软件打开的 .apkg（非无损）；分享给 Brandki 用户请用「导出备份」"
          disabled={!deck}
          onClick={() => setApkgOpen(true)}
        />
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
        open={apkgOpen}
        title="导出为 apkg？"
        message="将导出标准 .apkg，可在 Anki 等兼容软件中打开。注意：这是有损导出——卡片内容与图片完整保留，但学习进度只能近似转换，无法无损还原。若要把数据分享给其他 Brandki 用户，请改用「导出备份」（.brandki.zip，无损）。"
        confirmText="导出"
        onCancel={() => setApkgOpen(false)}
        onConfirm={() => {
          setApkgOpen(false)
          void exportApkg()
        }}
      />

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

function StorageSection() {
  const { compressMedia, cleanupStorage } = useStore()
  const [compressing, setCompressing] = useState(false)
  const [compressProgress, setCompressProgress] = useState<{ done: number; total: number; name: string } | null>(null)
  const [compressResult, setCompressResult] = useState<
    { ok: boolean; message: string } | null
  >(null)

  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<
    { ok: boolean; message: string } | null
  >(null)

  const runCompress = async () => {
    setCompressing(true)
    setCompressResult(null)
    setCompressProgress({ done: 0, total: 0, name: '' })
    try {
      const r = await compressMedia((p) => setCompressProgress(p))
      setCompressResult(
        r.count > 0
          ? { ok: true, message: `已压缩 ${r.count} 张图片，节省约 ${formatBytes(r.bytesSaved)} 空间。` }
          : r.total > 0
            ? { ok: true, message: `检查了 ${r.total} 张超过 2MB 的图片，但重新编码后体积没有变小，均保持原样。` }
            : { ok: true, message: '媒体库中没有超过 2MB 且未压缩过的图片。' },
      )
    } catch (e) {
      setCompressResult({ ok: false, message: e instanceof Error ? e.message : '压缩失败，请重试' })
    } finally {
      setCompressing(false)
      setCompressProgress(null)
    }
  }

  const runCleanup = async () => {
    setCleanupOpen(false)
    setCleaning(true)
    setCleanupResult(null)
    try {
      const r = await cleanupStorage()
      const parts: string[] = []
      if (r.orphanCount > 0) parts.push(`删除 ${r.orphanCount} 个孤儿媒体（${formatBytes(r.orphanBytes)}）`)
      if (r.packageCount > 0) parts.push(`删除 ${r.packageCount} 个已打包的 .apkg / 备份包（${formatBytes(r.packageBytes)}）`)
      setCleanupResult(
        parts.length > 0
          ? { ok: true, message: `清理完成，共释放约 ${formatBytes(r.orphanBytes + r.packageBytes)}：${parts.join('；')}。` }
          : { ok: true, message: '没有发现孤儿媒体或已打包的备份文件，存储空间很干净。' },
      )
    } catch (e) {
      setCleanupResult({ ok: false, message: e instanceof Error ? e.message : '清理失败，请重试' })
    } finally {
      setCleaning(false)
    }
  }

  return (
    <Card className="mt-2 divide-y divide-stone-100">
      <StorageRow
        icon="🗜"
        title="压缩超大图片"
        desc="媒体库中超过 2MB 且未压缩过的照片将自动压缩（最长边 2560px），卡片内容与学习进度不受影响"
        action={
          <Button variant="secondary" disabled={compressing || cleaning} onClick={() => void runCompress()}>
            {compressing
              ? compressProgress && compressProgress.total > 0
                ? `压缩中 ${compressProgress.done}/${compressProgress.total}`
                : '扫描中…'
              : '开始压缩'}
          </Button>
        }
      />
      {compressing && compressProgress && compressProgress.name && (
        <div className="px-4 pb-3 text-xs text-stone-400">正在处理：{compressProgress.name}</div>
      )}
      {compressResult && (
        <div
          className={cn(
            'mx-4 my-3 rounded-xl px-3 py-2.5 text-xs leading-5',
            compressResult.ok ? 'bg-brand-soft text-brand' : 'bg-red-50 text-red-700',
          )}
        >
          {compressResult.ok ? '✓ ' : '✕ '}
          {compressResult.message}
        </div>
      )}

      <StorageRow
        icon="🧹"
        title="清理存储空间"
        desc="删除没有被任何卡片引用的孤儿媒体，以及存档里已打包好的 .apkg / .brandki.zip 备份包"
        action={
          <Button variant="secondary" disabled={compressing || cleaning} onClick={() => setCleanupOpen(true)}>
            {cleaning ? '清理中…' : '开始清理'}
          </Button>
        }
      />
      {cleanupResult && (
        <div
          className={cn(
            'mx-4 my-3 rounded-xl px-3 py-2.5 text-xs leading-5',
            cleanupResult.ok ? 'bg-brand-soft text-brand' : 'bg-red-50 text-red-700',
          )}
        >
          {cleanupResult.ok ? '✓ ' : '✕ '}
          {cleanupResult.message}
        </div>
      )}

      <ConfirmDialog
        open={cleanupOpen}
        title="清理存储空间？"
        message="将永久删除未被任何卡片引用的孤儿媒体，以及存档中已打包的 .apkg / .brandki.zip 备份包（已导出到「下载」文件夹的副本不受影响）。此操作不可撤销。"
        confirmText="清理"
        danger
        onCancel={() => setCleanupOpen(false)}
        onConfirm={() => void runCleanup()}
      />
    </Card>
  )
}

function StorageRow({ icon, title, desc, action }: { icon: string; title: string; desc: string; action: ReactNode }) {
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3.5">
      <span className="text-xl">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-stone-400">{desc}</span>
      </span>
      <span className="shrink-0">{action}</span>
    </div>
  )
}

const AI_PLACEHOLDERS: Record<AIProtocol, { baseUrl: string; model: string; baseExample: string; modelExample: string }> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    baseExample: 'https://api.openai.com/v1',
    modelExample: 'gpt-4o-mini',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-latest',
    baseExample: 'https://api.anthropic.com',
    modelExample: 'claude-3-5-sonnet-latest',
  },
}

function AISection({ onEditPrompt }: { onEditPrompt: () => void }) {
  const { settings, updateSettings } = useStore()
  const initial = settings.ai
  const [protocol, setProtocol] = useState<AIProtocol>(initial?.protocol ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saved, setSaved] = useState(false)

  const ph = AI_PLACEHOLDERS[protocol]

  const persist = async (next: AISettings) => {
    await updateSettings({ ai: next })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const buildCfg = (): AISettings => ({ protocol, apiKey, baseUrl, model })

  const switchProtocol = (p: AIProtocol) => {
    setProtocol(p)
    setResult(null)
    // 只在当前没填或填的是另一协议的官方示例时，才自动替换示例
    if (!baseUrl.trim() || Object.values(AI_PLACEHOLDERS).some((v) => v.baseUrl === baseUrl.trim())) {
      setBaseUrl(AI_PLACEHOLDERS[p].baseUrl)
    }
    if (!model.trim() || Object.values(AI_PLACEHOLDERS).some((v) => v.modelExample === model.trim())) {
      setModel(AI_PLACEHOLDERS[p].model)
    }
  }

  const save = async () => {
    await persist(buildCfg())
  }

  const test = async () => {
    const cfg = buildCfg()
    setTesting(true)
    setResult(null)
    await persist(cfg)
    const r = await testConnection(cfg)
    setResult(r)
    setTesting(false)
  }

  return (
    <Card className="mt-2 p-4">
      <div className="font-medium">图片识别模型</div>
      <p className="mt-0.5 text-xs leading-5 text-stone-400">
        手动录入时把门店照片发给 AI 自动补全品牌信息。
        <span className="font-medium text-amber-700">必须填写支持图像识别的多模态模型</span>
        （纯文本模型会报错），例如 OpenAI gpt-4o 系列、Anthropic Claude 系列、
        小米 MiMo v2.6 flash 或同等视觉模型（模型名与地址以你的服务商控制台为准）。
      </p>

      {/* 协议切换 */}
      <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-stone-100 p-1">
        {(['openai', 'anthropic'] as AIProtocol[]).map((p) => (
          <button
            key={p}
            onClick={() => switchProtocol(p)}
            className={cn(
              'rounded-lg py-2 text-sm font-medium transition-all',
              protocol === p ? 'bg-white text-brand shadow-sm' : 'text-stone-500',
            )}
          >
            {p === 'openai' ? 'OpenAI 兼容' : 'Anthropic'}
          </button>
        ))}
      </div>

      <label className="mt-3 block text-xs font-medium text-stone-500">API 地址（Base URL）</label>
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={ph.baseUrl}
        className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
      />

      <label className="mt-3 block text-xs font-medium text-stone-500">API Key（仅保存在本地存档中）</label>
      <div className="relative mt-1">
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type={showKey ? 'text' : 'password'}
          placeholder="sk-..."
          autoComplete="off"
          className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 pr-14 text-sm outline-none focus:border-brand"
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-stone-400 hover:text-stone-600"
        >
          {showKey ? '隐藏' : '显示'}
        </button>
      </div>

      <label className="mt-3 block text-xs font-medium text-stone-500">模型名称</label>
      <input
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder={ph.model}
        className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand"
      />

      {/* 示例 */}
      <div className="mt-3 rounded-xl bg-stone-50 p-3 text-xs leading-5 text-stone-500">
        <div className="font-medium text-stone-600">填写示例（{protocol === 'openai' ? 'OpenAI 兼容协议' : 'Anthropic 协议'}）</div>
        <div className="mt-1 font-mono text-[11px]">
          API 地址：{ph.baseExample}
          <br />
          模型名称：{ph.modelExample}
        </div>
        {protocol === 'openai' && (
          <div className="mt-1">
            兼容 OpenAI 协议的第三方网关（如 MiMo 等）通常只需把地址和模型名换成服务商提供的值，Key 用对方签发的 Key。
          </div>
        )}
      </div>

      <div className="mt-3 flex gap-2.5">
        <Button variant="secondary" className="flex-1" onClick={() => void save()}>
          {saved ? '已保存 ✓' : '保存配置'}
        </Button>
        <Button variant="primary" className="flex-1" disabled={testing} onClick={() => void test()}>
          {testing ? '测试中…' : '测试连通性'}
        </Button>
      </div>

      {result && (
        <div
          className={cn(
            'mt-3 rounded-xl px-3 py-2.5 text-xs leading-5',
            result.ok ? 'bg-brand-soft text-brand' : 'bg-red-50 text-red-700',
          )}
        >
          {result.ok ? '✓ ' : '✕ '}
          {result.message}
        </div>
      )}

      <button
        onClick={onEditPrompt}
        className="mt-3 flex w-full items-center justify-between rounded-xl border border-stone-200 bg-stone-50 px-3 py-3 text-left hover:bg-stone-100"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-stone-700">编辑 AI 提示词模板</span>
          <span className="mt-0.5 block truncate text-xs text-stone-400">
            自定义发送给模型的识别指令，可用变量插入属性列表
          </span>
        </span>
        <span className="shrink-0 text-stone-300">›</span>
      </button>
    </Card>
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
