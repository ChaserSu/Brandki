import { useState } from 'react'
import { useStore } from '../lib/store'
import { Button, Card } from './ui'
import { DEFAULT_AI_PROMPT, PROMPT_VARIABLES } from '../lib/ai'

export function AIPromptEditor({ onBack }: { onBack: () => void }) {
  const { settings, updateSettings } = useStore()
  const [text, setText] = useState(settings.ai?.promptTemplate?.trim() ? settings.ai.promptTemplate! : DEFAULT_AI_PROMPT)
  const [usingDefault, setUsingDefault] = useState(!settings.ai?.promptTemplate?.trim())
  const [saved, setSaved] = useState(false)

  const missingList = !text.includes('{{属性列表}}')

  const insertToken = (token: string) => {
    setText((t) => t + (t.endsWith('\n') || !t ? '' : '\n') + token)
    setUsingDefault(false)
  }

  const restoreDefault = () => {
    setText(DEFAULT_AI_PROMPT)
    setUsingDefault(true)
  }

  const save = async () => {
    const base = settings.ai ?? { protocol: 'openai' as const, apiKey: '', baseUrl: '', model: '' }
    // 与默认完全一致（或留空）时不保存自定义内容，保持「使用默认」语义
    const trimmed = text.trim()
    await updateSettings({
      ai: { ...base, promptTemplate: !trimmed || trimmed === DEFAULT_AI_PROMPT.trim() ? '' : trimmed },
    })
    setUsingDefault(!trimmed || trimmed === DEFAULT_AI_PROMPT.trim())
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col px-5 pb-10 pt-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="rounded-full p-2 text-stone-400 hover:bg-stone-200/60">
          ‹
        </button>
        <div>
          <h1 className="text-lg font-bold">AI 提示词模板</h1>
          <p className="text-xs text-stone-400">录入页点「AI 自动补全」时，连同门店照片一起发送给模型的指令</p>
        </div>
      </div>

      {/* 变量说明 */}
      <h2 className="mt-6 px-1 text-sm font-semibold text-stone-500">可插入的变量</h2>
      <div className="mt-2 space-y-2">
        {PROMPT_VARIABLES.map((v) => (
          <Card key={v.token} className="flex items-start gap-3 p-3">
            <button
              onClick={() => insertToken(v.token)}
              className="shrink-0 rounded-lg bg-stone-100 px-2.5 py-1.5 font-mono text-xs text-brand hover:bg-brand-soft"
              title="点击追加到模板末尾"
            >
              {v.token}
            </button>
            <p className="text-xs leading-5 text-stone-500">{v.desc}</p>
          </Card>
        ))}
      </div>

      {/* 编辑器 */}
      <div className="mt-6 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-stone-500">
          模板内容{usingDefault && <span className="ml-2 font-normal text-stone-400">（当前为内置默认）</span>}
        </h2>
        <button onClick={restoreDefault} className="text-sm font-medium text-brand hover:underline">
          恢复默认
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setUsingDefault(e.target.value.trim() === DEFAULT_AI_PROMPT.trim())
        }}
        rows={22}
        spellCheck={false}
        className="mt-2 w-full resize-y rounded-2xl border border-stone-200 bg-white p-4 font-mono text-[13px] leading-6 outline-none focus:border-brand"
      />

      {missingList && (
        <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800">
          ⚠ 模板中没有 {'{{属性列表}}'}，AI 将收不到要补全的属性标题，可能无法按字段返回结果。建议保留该变量。
        </div>
      )}

      <Card className="mt-3 p-3 text-xs leading-5 text-stone-500">
        提示：请要求模型「只输出一个 JSON 对象」，且 JSON 的键与属性标题完全一致，否则自动回填会失败。
        改完后可回到录入页实际补全一次验证效果；模板只保存在本地，不会随其他数据上传。
      </Card>

      <div className="mt-4">
        <Button variant="primary" className="w-full" onClick={() => void save()}>
          {saved ? '已保存 ✓' : '保存模板'}
        </Button>
      </div>
    </div>
  )
}
