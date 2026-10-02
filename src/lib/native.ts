// 桌面壳（Electron preload）注入的本地硬盘接口
export interface NativeBridge {
  isDesktop: true
  ensureStructure: () => Promise<string>
  readText: (parts: string[]) => Promise<string | null>
  writeText: (parts: string[], content: string) => Promise<void>
  listFiles: (parts: string[]) => Promise<string[]>
  readBlob: (parts: string[]) => Promise<ArrayBuffer | null>
  writeBlob: (parts: string[], buffer: ArrayBuffer) => Promise<void>
  getSavePath: () => Promise<string>
  openSaveFolder: () => Promise<void>
}

export function nativeBridge(): NativeBridge | null {
  if (typeof window === 'undefined') return null
  const b = (window as unknown as { brandkiNative?: NativeBridge }).brandkiNative
  return b?.isDesktop ? b : null
}
