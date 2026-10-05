// 本地存档层：
// - 桌面 APP（Electron）：通过 preload 桥直接读写本机硬盘（~/Library/Application Support/Brandki/save）
// - 浏览器：使用 OPFS（Origin-Private File System）私有目录
// 两种后端对上层暴露完全一致的接口，存档结构相同：
//   library/<deckId>/deck.json + media/*
//   progress.json
//   settings.json

import { nativeBridge } from './native'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFS = any

const native = nativeBridge()

export function isFileSystemSupported(): boolean {
  if (native) return true
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function'
}

/** 获取存档根目录（OPFS root；桌面端返回标记对象，实际路径由主进程管理） */
export async function getRoot(): Promise<AnyFS> {
  if (native) return { __brandkiNativeRoot: true }
  return navigator.storage.getDirectory()
}

// ---------- 目录/文件基础操作 ----------

async function getDir(parent: AnyFS, name: string, create = false): Promise<AnyFS | null> {
  try {
    return await parent.getDirectoryHandle(name, { create })
  } catch {
    return null
  }
}

async function ensureDir(parent: AnyFS, path: string[]): Promise<AnyFS> {
  let dir = parent
  for (const seg of path) {
    dir = await getDir(dir, seg, true)
  }
  return dir
}

export async function readText(root: AnyFS, path: string[]): Promise<string | null> {
  if (native) return native.readText(path)
  let dir: AnyFS = root
  for (const seg of path.slice(0, -1)) {
    dir = await getDir(dir, seg)
    if (!dir) return null
  }
  try {
    const fh = await dir.getFileHandle(path[path.length - 1])
    const file: File = await fh.getFile()
    return await file.text()
  } catch {
    return null
  }
}

export async function writeText(root: AnyFS, path: string[], content: string): Promise<void> {
  if (native) {
    await native.writeText(path, content)
    return
  }
  const dir = await ensureDir(root, path.slice(0, -1))
  const fh = await dir.getFileHandle(path[path.length - 1], { create: true })
  const w = await fh.createWritable()
  await w.write(content)
  await w.close()
}

export async function writeJSON(root: AnyFS, path: string[], data: unknown): Promise<void> {
  await writeText(root, path, JSON.stringify(data, null, 2))
}

export async function readJSON<T>(root: AnyFS, path: string[]): Promise<T | null> {
  const text = await readText(root, path)
  if (text === null) return null
  return JSON.parse(text) as T
}

/** 列出某目录下的文件名 */
export async function listFiles(root: AnyFS, path: string[]): Promise<string[]> {
  if (native) return native.listFiles(path)
  let dir: AnyFS = root
  for (const seg of path) {
    dir = await getDir(dir, seg)
    if (!dir) return []
  }
  const names: string[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') names.push(name)
  }
  return names
}

/** 列出某目录下的子目录名 */
export async function listDirs(root: AnyFS, path: string[]): Promise<string[]> {
  if (native) return native.listDirs(path)
  let dir: AnyFS = root
  for (const seg of path) {
    dir = await getDir(dir, seg)
    if (!dir) return []
  }
  const names: string[] = []
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') names.push(name)
  }
  return names
}

/** 删除单个文件（不存在视为成功）。路径目录必须存在 */
export async function deleteFile(root: AnyFS, path: string[]): Promise<void> {
  if (native) {
    await native.deleteFile(path)
    return
  }
  let dir: AnyFS = root
  for (const seg of path.slice(0, -1)) {
    dir = await getDir(dir, seg)
    if (!dir) return
  }
  try {
    await dir.removeEntry(path[path.length - 1])
  } catch {
    // 文件已不存在：忽略
  }
}

/** 以 Blob 形式读文件（媒体用） */
export async function readBlob(root: AnyFS, path: string[]): Promise<Blob | null> {
  if (native) {
    const buf = await native.readBlob(path)
    return buf === null ? null : new Blob([buf])
  }
  let dir: AnyFS = root
  for (const seg of path.slice(0, -1)) {
    dir = await getDir(dir, seg)
    if (!dir) return null
  }
  try {
    const fh = await dir.getFileHandle(path[path.length - 1])
    return (await fh.getFile()) as Blob
  } catch {
    return null
  }
}

export async function writeBlob(root: AnyFS, path: string[], blob: Blob): Promise<void> {
  if (native) {
    await native.writeBlob(path, await blob.arrayBuffer())
    return
  }
  const dir = await ensureDir(root, path.slice(0, -1))
  const fh = await dir.getFileHandle(path[path.length - 1], { create: true })
  const w = await fh.createWritable()
  await w.write(blob)
  await w.close()
}

/** 初始化标准目录结构 */
export async function ensureStructure(root: AnyFS): Promise<void> {
  if (native) {
    await native.ensureStructure()
    return
  }
  await ensureDir(root, ['library'])
}

/** 清空全部存档（危险操作，仅调试/重置用） */
export async function wipe(root: AnyFS): Promise<void> {
  for await (const [, handle] of root.entries()) {
    await handle.remove({ recursive: true })
  }
}
