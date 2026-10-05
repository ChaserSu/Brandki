// 桌面壳（Electron preload）注入的本地硬盘接口
export interface NativeBridge {
  isDesktop: true
  ensureStructure: () => Promise<string>
  readText: (parts: string[]) => Promise<string | null>
  writeText: (parts: string[], content: string) => Promise<void>
  listFiles: (parts: string[]) => Promise<string[]>
  listDirs: (parts: string[]) => Promise<string[]>
  deleteFile: (parts: string[]) => Promise<void>
  readBlob: (parts: string[]) => Promise<ArrayBuffer | null>
  writeBlob: (parts: string[], buffer: ArrayBuffer) => Promise<void>
  getSavePath: () => Promise<string>
  openSaveFolder: () => Promise<void>
  /** 主进程代理 HTTP 请求（AI 自动补全），桌面端可绕过浏览器 CORS */
  aiRequest: (payload: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  }) => Promise<{ status: number; ok: boolean; body: string }>
}

export function nativeBridge(): NativeBridge | null {
  if (typeof window === 'undefined') return null
  const b = (window as unknown as { brandkiNative?: NativeBridge }).brandkiNative
  return b?.isDesktop ? b : null
}
