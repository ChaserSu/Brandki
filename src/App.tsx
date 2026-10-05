import { useState } from 'react'
import { useStore } from './lib/store'
import { Home, type StudyConfig } from './components/Home'
import { Study } from './components/Study'
import { Browse } from './components/Browse'
import { Settings } from './components/Settings'
import { Entry } from './components/Entry'
import { BatchEntry } from './components/BatchEntry'
import { CardEdit } from './components/CardEdit'
import { AIPromptEditor } from './components/AIPromptEditor'
import { Welcome } from './components/Welcome'

type View = 'home' | 'browse' | 'settings' | 'entry' | 'batchentry' | 'aiprompt' | 'edit'

export default function App() {
  const { status, supported } = useStore()
  const [view, setView] = useState<View>('home')
  const [editingCardId, setEditingCardId] = useState<string | null>(null)
  const [studyCfg, setStudyCfg] = useState<StudyConfig | null>(null)
  // 每次启动都先展示欢迎页
  const [showWelcome, setShowWelcome] = useState(true)

  if (!supported) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 text-center">
        <div className="max-w-md">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand text-2xl font-bold text-white">
            B
          </div>
          <h1 className="text-2xl font-bold">Brandki</h1>
          <p className="mt-3 text-sm leading-6 text-stone-500">
            当前浏览器不支持本地文件存储（OPFS）。请使用最新版 Chrome 或 Edge 打开本页面。
          </p>
        </div>
      </div>
    )
  }

  if (status === 'loading') {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-xl font-bold text-white">
          B
        </div>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-stone-300 border-t-brand" />
        <p className="text-sm text-stone-400">正在打开本地存档…</p>
      </div>
    )
  }

  if (showWelcome) {
    return <Welcome onDone={() => setShowWelcome(false)} />
  }

  if (studyCfg) {
    return <Study config={studyCfg} onExit={() => setStudyCfg(null)} />
  }

  return (
    <div className="min-h-full">
      {view === 'home' && (
        <Home
          onStudy={(cfg) => setStudyCfg(cfg)}
          onBrowse={() => setView('browse')}
          onSettings={() => setView('settings')}
          onEntry={() => setView('entry')}
          onBatchEntry={() => setView('batchentry')}
        />
      )}
      {view === 'browse' && (
        <Browse
          onBack={() => setView('home')}
          onEditCard={(id) => {
            setEditingCardId(id)
            setView('edit')
          }}
        />
      )}
      {view === 'settings' && (
        <Settings onBack={() => setView('home')} onEditPrompt={() => setView('aiprompt')} />
      )}
      {view === 'entry' && <Entry onBack={() => setView('home')} onSettings={() => setView('settings')} />}
      {view === 'batchentry' && (
        <BatchEntry onBack={() => setView('home')} onSettings={() => setView('settings')} />
      )}
      {view === 'aiprompt' && <AIPromptEditor onBack={() => setView('settings')} />}
      {view === 'edit' && editingCardId && (
        <CardEdit cardId={editingCardId} onBack={() => setView('browse')} onSettings={() => setView('settings')} />
      )}
    </div>
  )
}
