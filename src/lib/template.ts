// 极简 Anki 模板渲染：{{字段}}、{{#字段}}...{{/字段}} 条件块、{{FrontSide}}
// 字段内容本身是受信任的牌组 HTML，原样插入；渲染后再替换媒体地址

function stripAnkiComments(tpl: string): string {
  return tpl.replace(/<!--[\s\S]*?-->/g, '')
}

function renderOnce(tpl: string, fields: Record<string, string>): string {
  let out = stripAnkiComments(tpl)

  // 条件块 {{#Name}} ... {{/Name}}（字段非空则保留）
  out = out.replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, body: string) => {
    const v = fields[name.trim()]
    return v && v.trim() ? body : ''
  })

  // 普通字段
  out = out.replace(/\{\{\s*([^#/}][^}]*?)\s*\}\}/g, (_m, name: string) => {
    return fields[name.trim()] ?? ''
  })

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

/** 把 HTML 里的 <img src="..."> 映射到运行时媒体 ObjectURL */
export function remapMedia(html: string, mediaUrls: Record<string, string>): string {
  return html.replace(/(<img[^>]*\ssrc=")([^"]+)(")/gi, (_m, pre: string, src: string, post: string) => {
    const filename = src.split('/').pop() ?? src
    const url = mediaUrls[filename] ?? mediaUrls[src]
    return url ? `${pre}${url}${post}` : _m
  })
}

/** 从字段 HTML 中提取所有引用到的媒体文件名 */
export function referencedMedia(fields: Record<string, string>): Set<string> {
  const set = new Set<string>()
  for (const v of Object.values(fields)) {
    const re = /<img[^>]*\ssrc="([^"]+)"/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(v))) set.add(m[1].split('/').pop() ?? m[1])
  }
  return set
}
