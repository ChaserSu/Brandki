// AI 自动补全：兼容 OpenAI Chat Completions 与 Anthropic Messages 两种协议
// - 桌面端（Electron）走主进程代理发请求，绕过浏览器 CORS；浏览器端直接 fetch
// - apiKey 只从本地存档读取，不经过任何除所选服务商之外的服务器
import type { AISettings } from './types'
import { nativeBridge } from './native'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AIField {
  /** 程序内键（Anki 模型字段名或特殊键如 __deckPath__） */
  key: string
  /** 展示给用户和 AI 的属性标题，如「品牌名（中文）」 */
  label: string
  /** 当前值：空 = 请 AI 从图中识别；非空 = 作为提示/线索交给 AI 补全校正 */
  value: string
}

export interface AIImage {
  dataUrl: string
  mediaType: string
}

export function isAIConfigured(cfg: AISettings | null | undefined): cfg is AISettings {
  return !!cfg && !!cfg.apiKey.trim() && !!cfg.baseUrl.trim() && !!cfg.model.trim()
}

/** 返回错误文案；null 表示配置完整 */
export function validateConfig(cfg: AISettings | null | undefined): string | null {
  if (!cfg) return '尚未配置 AI，请先到「设置 → AI 自动补全」填写 API Key'
  if (!cfg.baseUrl.trim()) return '请填写 API 地址（Base URL）'
  if (!cfg.apiKey.trim()) return '请填写 API Key'
  if (!cfg.model.trim()) return '请填写模型名称（必须是支持图像识别的多模态模型）'
  if (!/^https?:\/\//i.test(cfg.baseUrl.trim())) return 'API 地址需以 http(s):// 开头'
  return null
}

function trimEnd(s: string, tail: string): string {
  return s.endsWith(tail) ? s.slice(0, -tail.length) : s
}

function endpoint(cfg: AISettings): string {
  const base = cfg.baseUrl.trim().replace(/\/+$/, '')
  if (cfg.protocol === 'anthropic') {
    // 用户可能填 https://api.anthropic.com 或 .../v1，统一到 /v1/messages
    const withV1 = /\/v1$/.test(base) ? base : `${base}/v1`
    return `${withV1}/messages`
  }
  // OpenAI 兼容：base 通常到 /v1 一级
  return `${trimEnd(base, '/chat/completions')}/chat/completions`
}

interface RawHttp {
  status: number
  ok: boolean
  body: string
}

async function httpSend(cfg: AISettings, headers: Record<string, string>, body: unknown, timeoutMs = 90000): Promise<RawHttp> {
  const bodyStr = JSON.stringify(body)
  const url = endpoint(cfg)
  const bridge = nativeBridge()
  if (bridge) {
    return bridge.aiRequest({ url, method: 'POST', headers, body: bodyStr, timeoutMs })
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    })
    const text = await resp.text()
    return { status: resp.status, ok: resp.ok, body: text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const hint = msg.toLowerCase().includes('failed to fetch')
      ? '网络请求失败：可能是该服务商不允许浏览器直接跨域访问（CORS），请使用 Brandki 桌面版，或换用支持跨域的 API 网关。'
      : `网络请求失败：${msg}`
    return { status: 0, ok: false, body: hint }
  } finally {
    window.clearTimeout(timer)
  }
}

function authHeaders(cfg: AISettings): Record<string, string> {
  return cfg.protocol === 'anthropic'
    ? {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey.trim(),
        'anthropic-version': '2023-06-01',
      }
    : {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey.trim()}`,
      }
}

/** 从模型返回体里取出纯文本（兼容两种协议） */
function extractText(cfg: AISettings, raw: string): string {
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return ''
  }
  if (cfg.protocol === 'anthropic') {
    return Array.isArray(data?.content) ? data.content.map((b: any) => b.text ?? '').join('') : ''
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b: any) => b.text ?? '').join('')
  return ''
}

/**
 * 返回体是否为结构合法的补全响应。推理模型（如带 reasoning_content 的模型）在
 * max_tokens 很小时会把额度全用在思考上，message.content 可能是空串，但 HTTP 200
 * 且 choices/content 结构完整就说明 Key、地址、模型都对得上，连通性测试应判为成功。
 */
function isWellFormedCompletion(cfg: AISettings, raw: string): boolean {
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return false
  }
  if (cfg.protocol === 'anthropic') return Array.isArray(data?.content)
  return Array.isArray(data?.choices) && data.choices.length > 0
}

/** 连通性测试：发一条最小的纯文本请求 */
export async function testConnection(cfg: AISettings): Promise<{ ok: boolean; message: string }> {
  const err = validateConfig(cfg)
  if (err) return { ok: false, message: err }
  const body =
    cfg.protocol === 'anthropic'
      ? { model: cfg.model.trim(), max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
      : { model: cfg.model.trim(), max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
  const res = await httpSend(cfg, authHeaders(cfg), body, 30000)
  if (res.ok && (extractText(cfg, res.body) || isWellFormedCompletion(cfg, res.body))) {
    return { ok: true, message: `连接成功，模型「${cfg.model.trim()}」已正常响应。` }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: `认证失败（HTTP ${res.status}）：API Key 错误或没有该模型权限。` }
  }
  if (res.status === 404) {
    return { ok: false, message: `找不到接口或模型（HTTP 404）：请检查 Base URL 与模型名「${cfg.model.trim()}」。` }
  }
  if (res.status === 429) {
    return { ok: false, message: '请求被限流（HTTP 429）：请稍后再试，或检查账户额度。' }
  }
  if (res.status === 200) {
    return { ok: false, message: `接口返回内容无法识别（HTTP 200）：请确认 Base URL 指向的是 Chat Completions 接口。返回：${res.body.slice(0, 300)}` }
  }
  const detail = res.body.slice(0, 300)
  return { ok: false, message: `连接失败（HTTP ${res.status}）：${detail}` }
}

/**
 * 业态分类参考：新城集团 260901 版本的业态分类规则。
 * 作为默认提示词的一部分发给 AI，约束它把门店归入标准的「大类::中类::小类」。
 */
export const BUSINESS_TAXONOMY: string[] = [
  '零售::珠宝首饰::黄金',
  '零售::珠宝首饰::钻石镶嵌',
  '零售::珠宝首饰::玉石翡翠',
  '零售::珠宝首饰::时尚珠宝',
  '零售::3C数码::数码生活馆',
  '零售::3C数码::手机电脑',
  '零售::3C数码::潮流数码',
  '零售::3C数码::数码配件',
  '零售::3C数码::数码集合店',
  '零售::男装::休闲男装',
  '零售::男装::商务男装',
  '零售::女装::大淑装',
  '零售::女装::中淑装',
  '零售::女装::少淑女装',
  '零售::服装集合::国际快时尚',
  '零售::服装集合::国内快时尚',
  '零售::服装集合::男女装集合',
  '零售::服装集合::折扣集合',
  '零售::服装集合::买手集合',
  '零售::服装集合::订制服装',
  '零售::服装集合::贴身衣物',
  '零售::服装集合::鞋品箱包',
  '零售::服装集合::穿搭配饰',
  '零售::运动户外::国际运动',
  '零售::运动户外::国内运动',
  '零售::运动户外::国际户外',
  '零售::运动户外::国内户外',
  '零售::运动户外::运动户外集合店',
  '零售::潮牌服装::国际潮牌',
  '零售::潮牌服装::国内潮牌',
  '零售::潮玩集合::潮流杂品',
  '零售::潮玩集合::IP文创',
  '零售::潮玩集合::二次元服饰',
  '零售::儿童零售::婴幼服装',
  '零售::儿童零售::儿童服装',
  '零售::儿童零售::童鞋',
  '零售::儿童零售::童车玩具',
  '零售::儿童零售::儿童杂品',
  '零售::儿童零售::儿童数码',
  '零售::儿童零售::孕婴集合',
  '零售::化妆护肤::日化',
  '零售::化妆护肤::高化',
  '零售::化妆护肤::香氛精油',
  '零售::化妆护肤::化妆品集合店',
  '零售::生活零售::汽车',
  '零售::生活零售::家电',
  '零售::生活零售::家具',
  '零售::生活零售::家纺',
  '零售::生活零售::座椅仪器',
  '零售::生活零售::餐厨用具',
  '零售::生活零售::花艺礼品',
  '零售::生活零售::烟酒茶补',
  '零售::生活零售::生活集合店',
  '体验业态::娱乐运动::儿童乐园',
  '体验业态::娱乐运动::儿童游乐',
  '体验业态::娱乐运动::健身',
  '体验业态::娱乐运动::专业运动',
  '体验业态::娱乐运动::瑜伽舞蹈',
  '体验业态::娱乐运动::成人运动馆',
  '体验业态::娱乐运动::KTV',
  '体验业态::娱乐运动::电玩',
  '体验业态::娱乐运动::电竞网咖',
  '体验业态::娱乐运动::影院',
  '体验业态::娱乐运动::密室桌游',
  '体验业态::娱乐运动::台球',
  '体验业态::娱乐运动::演艺剧场',
  '体验业态::儿童教培::学科培训',
  '体验业态::儿童教培::智力开发',
  '体验业态::儿童教培::美术',
  '体验业态::儿童教培::舞蹈',
  '体验业态::儿童教培::书法',
  '体验业态::儿童教培::音乐',
  '体验业态::儿童教培::形体/语言',
  '体验业态::儿童教培::球类',
  '体验业态::儿童教培::对抗类',
  '体验业态::儿童教培::游泳',
  '体验业态::儿童教培::综合运动',
  '体验业态::儿童教培::特色运动',
  '体验业态::儿童教培::早教',
  '体验业态::生活健康::超市',
  '体验业态::生活健康::生活配套',
  '体验业态::生活健康::医疗美容',
  '体验业态::生活健康::日常美护',
  '体验业态::生活健康::健康配套',
  '体验业态::生活健康::养生保健',
  '体验业态::生活健康::康复管理',
  '体验业态::生活健康::宠物服务',
  '体验业态::生活健康::书店',
  '体验业态::生活健康::摄影冲印',
  '餐饮::精致正餐::高档中餐厅',
  '餐饮::精致正餐::品质异国餐',
  '餐饮::全天候休闲轻餐::休闲西餐',
  '餐饮::全天候休闲轻餐::酒吧\\日咖夜酒',
  '餐饮::全天候休闲轻餐::中式茶楼',
  '餐饮::正餐/自助::鲁菜',
  '餐饮::正餐/自助::川菜',
  '餐饮::正餐/自助::粤菜',
  '餐饮::正餐/自助::淮扬菜',
  '餐饮::正餐/自助::江浙菜',
  '餐饮::正餐/自助::闽菜',
  '餐饮::正餐/自助::湘菜',
  '餐饮::正餐/自助::徽菜',
  '餐饮::正餐/自助::京菜',
  '餐饮::正餐/自助::上海菜',
  '餐饮::正餐/自助::云贵菜',
  '餐饮::正餐/自助::赣菜',
  '餐饮::正餐/自助::鄂菜',
  '餐饮::正餐/自助::新疆菜',
  '餐饮::正餐/自助::台湾菜',
  '餐饮::正餐/自助::琼菜',
  '餐饮::正餐/自助::东北菜',
  '餐饮::正餐/自助::西北菜',
  '餐饮::正餐/自助::桂菜',
  '餐饮::正餐/自助::融合菜',
  '餐饮::正餐/自助::茶餐厅',
  '餐饮::正餐/自助::素餐',
  '餐饮::正餐/自助::其他中餐',
  '餐饮::正餐/自助::东南亚菜',
  '餐饮::正餐/自助::日餐',
  '餐饮::正餐/自助::韩餐',
  '餐饮::正餐/自助::法餐',
  '餐饮::正餐/自助::意餐',
  '餐饮::正餐/自助::西餐牛排',
  '餐饮::正餐/自助::其他异国餐',
  '餐饮::正餐/自助::西式自助',
  '餐饮::正餐/自助::烤涮自助',
  '餐饮::正餐/自助::海鲜自助',
  '餐饮::正餐/自助::其他自助',
  '餐饮::正餐/自助::酒楼',
  '餐饮::特色餐::烧烤',
  '餐饮::特色餐::烤鱼',
  '餐饮::特色餐::串串',
  '餐饮::特色餐::铁板烧',
  '餐饮::特色餐::本地特色',
  '餐饮::特色餐::亲子餐厅',
  '餐饮::特色餐::川渝火锅',
  '餐饮::特色餐::潮汕火锅',
  '餐饮::特色餐::京式火锅',
  '餐饮::特色餐::小火锅',
  '餐饮::特色餐::干锅',
  '餐饮::特色餐::焖锅',
  '餐饮::特色餐::鱼火锅',
  '餐饮::特色餐::其它锅类',
  '餐饮::快餐::洋快餐',
  '餐饮::快餐::异国简餐',
  '餐饮::快餐::中式简餐',
  '餐饮::快餐::美食广场',
  '餐饮::饮品甜品铺::面包烘焙店',
  '餐饮::饮品甜品铺::甜品店',
  '餐饮::饮品甜品铺::咖啡店',
  '餐饮::饮品甜品铺::茶饮店',
]

/** 业态分类参考在提示词里的标题（含版本来源标注） */
const TAXONOMY_HEADING = '业态分类参考（来源：新城集团 260901 版本业态分类规则）：'

/**
 * 标签（Anki Tags）在 AI 补全里的合成属性键与标题。
 * 它不对应任何 Anki 字段，只是借「属性」这条链路让模型一并输出标签；
 * 标题会作为 JSON 键回传，再由调用方切分写回 tags。
 */
export const TAG_FIELD_KEY = '__tags__'
export const TAG_FIELD_LABEL = '标签（Anki Tags）'

/** 把 AI 返回的标签串切成 Anki 标签：按空格/逗号/顿号分隔，去掉 # 前缀并去重 */
export function parseAITags(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[\s,，、;；]+/)) {
    const t = part.trim().replace(/^#/, '')
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * 内置默认提示词模板。用户可在「设置 → 编辑 AI 提示词模板」中自定义。
 *
 * 可用变量（会在发送前替换）：
 *   {{属性列表}}  —— 逐行列出每个属性标题及用户已填的提示/线索（必填，AI 据此输出 JSON）
 *   {{JSON示例}}  —— 按当前属性标题生成的 JSON 骨架
 */
export const DEFAULT_AI_PROMPT = [
  '你是一名商业地产招商助理，正在帮用户从门店照片中识别品牌信息。',
  '照片可能是带水印的打卡照片（如马克水印相机），水印里可能包含拍摄地址、时间、城市、商场名等，请尽量读取这些信息。',
  '',
  '请为下列属性补全信息，严格只输出一个 JSON 对象，不要输出任何解释、前后缀或 markdown 代码块：',
  '{{JSON示例}}',
  '',
  '规则：',
  '1. 当前为空的属性：直接根据照片识别填写；照片中确实无法辨认的，值填空字符串。',
  '2. 已有文字的属性：把该文字视为用户给出的提示或已知线索，结合照片补全或校正，不要盲目照抄。',
  '3. 品牌简介用一小段简体中文（30-100 字），包含定位、客群、风格等招商关注的信息。',
  '4. 业态必须从下方「业态分类参考」中选取最匹配的一项，按「大类::中类::小类」原样输出；确实找不到匹配项时，才按同样格式自行归纳。',
  '5. 地址照实抄录照片水印或门店招牌中的信息；品牌级次用 A/B/C/D 之类的单级标记，拿不准就留空。',
  '6. 所有值用简体中文，双引号内部不要出现换行；JSON 的键必须与下面属性列表中的标题完全一致。',
  '7. 「标签（Anki Tags）」给 2-4 个最能概括品牌特征的短标签，用空格分隔，单个标签内不要有空格、不要带 # 号；照片里看不出行业特征时可留空。',
  '',
  TAXONOMY_HEADING,
  ...BUSINESS_TAXONOMY,
  '',
  '属性列表：',
  '{{属性列表}}',
].join('\n')

/** 模板里可使用的变量说明（设置页展示给用户） */
export const PROMPT_VARIABLES: { token: string; desc: string }[] = [
  { token: '{{属性列表}}', desc: '逐行列出每个属性的标题，以及用户已经填写的文字（作为提示/线索）。AI 按这些标题返回 JSON。' },
  { token: '{{JSON示例}}', desc: '按当前属性标题自动生成的 JSON 输出骨架，告诉模型该返回什么结构。' },
]

function fieldSpec(fields: AIField[]): string {
  return fields
    .map((f) => `- 「${f.label}」${f.value.trim() ? `（用户提示/已知线索：${f.value.trim()}）` : '（当前为空）'}`)
    .join('\n')
}

function jsonSkeleton(fields: AIField[]): string {
  return ['{', ...fields.map((f) => `  "${f.label}": "值",`), '}'].join('\n')
}

export function buildPrompt(template: string, fields: AIField[]): string {
  const tpl = template.trim() || DEFAULT_AI_PROMPT
  return tpl
    .replaceAll('{{属性列表}}', fieldSpec(fields))
    .replaceAll('{{JSON示例}}', jsonSkeleton(fields))
}

/** 容错提取模型输出里的 JSON 对象 */
function parseJSONLoose(text: string): Record<string, string> {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  const obj = JSON.parse(t) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue
    out[k] = typeof v === 'string' ? v.trim() : String(v)
  }
  return out
}

/**
 * 用门店照片为所有字段做一次自动补全，返回 key=字段键、value=AI 给出的值。
 * 辨认不出的字段模型会返回空串，调用方按「非空才覆盖」处理。
 */
export async function autofillFields(
  cfg: AISettings,
  image: AIImage,
  fields: AIField[],
): Promise<Record<string, string>> {
  const err = validateConfig(cfg)
  if (err) throw new Error(err)
  if (!fields.length) throw new Error('没有需要补全的属性')

  const prompt = buildPrompt(cfg.promptTemplate ?? DEFAULT_AI_PROMPT, fields)
  let body: unknown
  if (cfg.protocol === 'anthropic') {
    const comma = image.dataUrl.indexOf(',')
    const base64 = comma >= 0 ? image.dataUrl.slice(comma + 1) : image.dataUrl
    body = {
      model: cfg.model.trim(),
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: base64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }
  } else {
    body = {
      model: cfg.model.trim(),
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image.dataUrl } },
          ],
        },
      ],
    }
  }

  const res = await httpSend(cfg, authHeaders(cfg), body, 90000)
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('AI 认证失败：API Key 错误或没有该模型权限')
    if (res.status === 404) throw new Error('AI 接口或模型不存在：请检查 Base URL 与模型名')
    throw new Error(`AI 请求失败（HTTP ${res.status}）：${res.body.slice(0, 200)}`)
  }
  const text = extractText(cfg, res.body)
  if (!text) throw new Error('AI 没有返回有效内容，请确认该模型支持图像识别')

  let parsed: Record<string, string>
  try {
    parsed = parseJSONLoose(text)
  } catch {
    throw new Error('AI 返回内容不是有效 JSON，请重试一次；若持续失败可更换模型')
  }

  // 模型被要求按「属性标题」作键，映射回字段 key
  const byLabel = new Map(fields.map((f) => [f.label, f.key]))
  const result: Record<string, string> = {}
  for (const [label, value] of Object.entries(parsed)) {
    const key = byLabel.get(label)
    if (key && value.trim()) result[key] = value.trim()
  }
  return result
}

/** 读取本地图片文件为 data URL（用于发给多模态模型） */
export function fileToDataUrl(file: File): Promise<AIImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      resolve({ dataUrl, mediaType: file.type || 'image/jpeg' })
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}
