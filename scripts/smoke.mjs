// 逻辑冒烟测试：解析内置示例 apkg → 模板渲染 → FSRS 评分流 → 合并策略
// 运行：node scripts/smoke.mjs
import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function assert(cond, msg) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failures++
  }
}

const server = await createServer({
  root,
  server: { middlewareMode: true },
  logLevel: 'silent',
  appType: 'custom',
})

try {
  const apkgMod = await server.ssrLoadModule('/src/lib/apkg.ts')
  const tplMod = await server.ssrLoadModule('/src/lib/template.ts')
  const srsMod = await server.ssrLoadModule('/src/lib/srs.ts')
  const mergeMod = await server.ssrLoadModule('/src/lib/merge.ts')

  // 1. 解析示例牌组
  const buf = await readFile(path.join(root, 'public/sample.apkg'))
  const imported = await apkgMod.parsePackage(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const { deck, media, progress: snap } = imported

  console.log('\n[1] apkg 解析')
  assert(deck.cards.length === 2, `解析出 2 张卡片（实际 ${deck.cards.length}）`)
  assert(media.size === 2, `解析出 2 个媒体文件（实际 ${media.size}）`)
  assert(!!deck.models && Object.keys(deck.models).length === 1, '包含 1 个笔记模型')
  const card0 = deck.cards[0]
  assert(!!card0.fields['Front']?.includes('<img'), 'Front 字段包含图片')
  assert(!!card0.fields['中文名'], `中文字段存在（${card0.fields['中文名']}）`)
  assert(['C', 'D'].includes(card0.fields['品牌级次']), '品牌级次字段存在')
  for (const [name, bytes] of media) assert(bytes.byteLength > 1000, `媒体 ${name} 非空（${bytes.byteLength}B）`)

  // 2. 模板渲染
  console.log('\n[2] 模板渲染')
  const front = tplMod.renderFront(card0.qfmt, card0.fields)
  assert(front.includes('<img'), '正面渲染出图片')
  const back = tplMod.renderBack(card0.qfmt, card0.afmt, card0.fields)
  assert(back.includes('<img'), '背面包含 FrontSide 图片')
  assert(back.includes(card0.fields['中文名']), '背面包含中文名')
  assert(back.includes('品牌级次'), '条件块渲染出品牌级次')
  const remapped = tplMod.remapMedia(front, { 'r2_E_UW6nbDvq.jpg': 'blob:mock' })
  assert(remapped.includes('blob:mock'), '媒体地址替换成功')

  // 3. FSRS 评分流
  console.log('\n[3] FSRS 调度')
  const p = srsMod.newProgress()
  let queue = srsMod.buildQueue(deck.cards, p)
  assert(queue.length === 2, `新库队列有 2 张新卡（实际 ${queue.length}）`)
  const previews0 = srsMod.gradePreviews(null)
  assert(previews0.length === 4 && previews0[0].label === '重来', '四档按钮预览正常')
  const { next, log } = srsMod.applyGrade(card0.id, null, 3 /* Good */)
  assert(next.state === 1, 'Good 新卡进入学习步（Learning）')
  assert(next.due.getTime() > Date.now(), '学习步到期时间在未来')
  p.states[card0.id] = next
  p.logs.push(log)
  const easy = srsMod.applyGrade(card0.id, null, 4 /* Easy */)
  assert(easy.next.scheduled_days >= 1, `Easy 新卡直接毕业（${easy.next.scheduled_days}天）`)
  const again = srsMod.applyGrade(deck.cards[1].id, null, 1)
  assert(again.next.scheduled_days === 0, 'Again 后进入短期学习（<1天）')
  p.states[deck.cards[1].id] = again.next
  const counts = srsMod.countDue(deck.cards, p)
  assert(counts.newCount === 0, `新卡计数归零（实际 ${counts.newCount}）`)
  // 11 分钟后，Again（1分钟）与 Good（10分钟）学习卡都应到期
  const later = new Date(Date.now() + 11 * 60_000)
  const countsLater = srsMod.countDue(deck.cards, p, later)
  assert(countsLater.learningCount >= 2, `11 分钟后学习卡到期（${countsLater.learningCount}）`)

  // 4. 合并策略
  console.log('\n[4] 合并策略')
  const incoming = srsMod.newProgress()
  const oldIds = new Set(deck.cards.map((c) => c.id))
  const mergedOld = mergeMod.mergeProgress({
    old: p,
    incoming,
    oldCardIds: oldIds,
    newCardIds: oldIds,
    strategy: 'old',
  })
  assert(Object.keys(mergedOld.states).length === 2, '仅保留旧进度：2 条状态保留')
  const mergedNew = mergeMod.mergeProgress({
    old: p,
    incoming,
    oldCardIds: oldIds,
    newCardIds: oldIds,
    strategy: 'new',
  })
  assert(Object.keys(mergedNew.states).length === 0, '仅保留新进度：空导入清空状态')
  const diff = mergeMod.diffDecks(oldIds, oldIds, snap)
  assert(diff.added === 0 && diff.updated === 2, 'diff 识别 0 新增 / 2 更新')

  console.log('\n[5] brandki 备份往返')
  const blob = await apkgMod.buildBackup(deck, media, p)
  const roundtrip = await apkgMod.parsePackage(await blob.arrayBuffer())
  assert(roundtrip.deck.cards.length === 2, '备份重新解析得到 2 张卡')
  assert(roundtrip.media.size === 2, '备份媒体完整')
  assert(Object.keys(roundtrip.progress.states).length === 2, '备份进度完整')

  console.log(failures === 0 ? '\n✅ 全部通过\n' : `\n❌ ${failures} 项失败\n`)
} finally {
  await server.close()
}
process.exit(failures === 0 ? 0 : 1)
