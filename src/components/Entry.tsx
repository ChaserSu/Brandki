import { useStore } from '../lib/store'
import { CardForm } from './CardForm'

export function Entry({ onBack, onSettings }: { onBack: () => void; onSettings: () => void }) {
  const { addManualCard } = useStore()

  return (
    <CardForm
      mode="create"
      title="Commercial Leasing Super Ultra Man"
      subtitle="拍一张门店照，补全信息，生成一张品牌卡"
      submitLabel="录入"
      onBack={onBack}
      onSettings={onSettings}
      onSubmit={async (p) => {
        if (!p.file) throw new Error('请先上传门店照片')
        await addManualCard({ file: p.file, fieldValues: p.fieldValues, deckPath: p.deckPath, tags: p.tags })
      }}
      done={{
        title: (name) => `「${name}」已录入`,
        message: '新卡片已加入牌组，回到首页就能在随机学习、指定业态和牌库中看到它。',
        primaryLabel: '返回首页',
        allowReset: true,
        resetLabel: '继续录入下一张',
      }}
    />
  )
}
