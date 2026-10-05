// 极简 Anki 模板渲染：{{字段}}、{{#字段}}...{{/字段}} 条件块、{{FrontSide}}
// 字段内容本身是受信任的牌组 HTML，原样插入；渲染后再替换媒体地址

function stripAnkiComments(tpl: string): string {
  return tpl.replace(/<!--[\s\S]*?-->/g, '')
}

/** 解析字段名：支持 Anki 修饰符（text:Field / cloze:Field / type:Field / hint:Field / tts xx:Field） */
function resolveField(fields: Record<string, string>, rawName: string): string | null {
  const name = rawName.trim()
  if (name in fields) return fields[name]
  const m = /^[a-zA-Z_][\w-]*(?:\s+[^:]*)?:([\s\S]+)$/.exec(name)
  if (m) {
    const inner = m[1].trim()
    if (inner in fields) return fields[inner]
  }
  return null
}

function renderOnce(tpl: string, fields: Record<string, string>): string {
  let out = stripAnkiComments(tpl)

  // 条件块（含嵌套）：反复求值直到不再变化，最多 10 轮兜底
  for (let i = 0; i < 10; i++) {
    const before = out
    // {{#Name}}...{{/Name}}：字段非空则保留
    out = out.replace(/\{\{#([^{}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, body: string) => {
      const v = resolveField(fields, name)
      return v && v.trim() ? body : ''
    })
    // {{^Name}}...{{/Name}}：字段为空则保留
    out = out.replace(/\{\{\^([^{}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, body: string) => {
      const v = resolveField(fields, name)
      return v && v.trim() ? '' : body
    })
    if (out === before) break
  }

  // 普通字段（未知字段与残留标签一律替换为空，避免字面量泄漏到卡面）
  out = out.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, name: string) => resolveField(fields, name) ?? '')

  return out
}

/** 渲染正面 HTML */
export function renderFront(qfmt: string, fields: Record<string, string>): string {
  return renderOnce(qfmt, fields)
}

/** 渲染背面 HTML（{{FrontSide}} 替换为正面渲染结果，<hr id=answer> 保留） */
export function renderBack(
  qfmt: string,
  afmt: string,
  fields: Record<string, string>,
): string {
  const front = renderOnce(qfmt, fields)
  const withFront = stripAnkiComments(afmt).replace(/\{\{\s*FrontSide\s*\}\}/g, () => front)
  return renderOnce(withFront, fields)
}

/** <img src> 引用（单双引号都支持），以及 Anki 的 [sound:...] 音视频引用 */
const MEDIA_SRC_RE = /(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']*)\2/gi
const SOUND_RE = /\[sound:([^\]]+)\]/g

/** 把 HTML 里的图片/音频引用映射到运行时媒体 ObjectURL */
export function remapMedia(html: string, mediaUrls: Record<string, string>): string {
  let out = html.replace(MEDIA_SRC_RE, (_m, pre: string, q: string, src: string) => {
    const filename = src.split('/').pop() ?? src
    const url = mediaUrls[filename] ?? mediaUrls[src]
    return url ? `${pre}${q}${url}${q}` : _m
  })
  out = out.replace(SOUND_RE, (m, name: string) => {
    const filename = name.split('/').pop() ?? name
    const url = mediaUrls[filename] ?? mediaUrls[name]
    return url ? `<audio controls preload="none" src="${url}"></audio>` : m
  })
  return out
}

/** 从字段 HTML 中提取所有引用到的媒体文件名 */
export function referencedMedia(fields: Record<string, string>): Set<string> {
  const set = new Set<string>()
  const add = (src: string) => {
    if (src) set.add(src.split('/').pop() ?? src)
  }
  for (const v of Object.values(fields)) {
    for (const m of v.matchAll(MEDIA_SRC_RE)) add(m[3])
    for (const m of v.matchAll(SOUND_RE)) add(m[1])
  }
  return set
}
