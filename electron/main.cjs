// Brandki 桌面壳：Electron 主进程
// - 双击 Brandki.app 即打开独立窗口（自带 Chromium，不依赖系统浏览器）
// - 存档直接写入本地硬盘：~/Library/Application Support/Brandki/save
const { app, BrowserWindow, ipcMain, protocol, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const fssync = require('fs')

// 固定应用名：userData 即 ~/Library/Application Support/Brandki（必须在 ready 前设置）
app.setName('Brandki')

const DIST_DIR = path.join(__dirname, '..', 'dist')

// 注意：app.getPath('userData') 必须在 app ready 之后调用，故惰性求值
let SAVE_DIR = null
function getSaveDir() {
  if (!SAVE_DIR) SAVE_DIR = path.join(app.getPath('userData'), 'save')
  return SAVE_DIR
}

// 自定义 app:// 协议，等价于一个本地静态站点（支持 fetch / WASM）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

// ---------- 本地硬盘存档 IPC ----------

function safeJoin(parts) {
  const root = getSaveDir()
  const p = path.join(root, ...parts.map((s) => String(s)))
  if (!p.startsWith(root)) throw new Error('非法路径')
  return p
}

async function ensureDir(parts) {
  await fs.mkdir(safeJoin(parts), { recursive: true })
}

ipcMain.handle('fs:ensureStructure', async () => {
  await ensureDir(['library'])
  return getSaveDir()
})

ipcMain.handle('fs:readText', async (_e, parts) => {
  try {
    return await fs.readFile(safeJoin(parts), 'utf8')
  } catch {
    return null
  }
})

ipcMain.handle('fs:writeText', async (_e, parts, content) => {
  const p = safeJoin(parts)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content, 'utf8')
})

ipcMain.handle('fs:listFiles', async (_e, parts) => {
  try {
    const entries = await fs.readdir(safeJoin(parts), { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
})

ipcMain.handle('fs:listDirs', async (_e, parts) => {
  try {
    const entries = await fs.readdir(safeJoin(parts), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
})

ipcMain.handle('fs:deleteFile', async (_e, parts) => {
  try {
    await fs.unlink(safeJoin(parts))
  } catch (err) {
    // 文件不存在不算错误；其余错误（如路径是目录）抛出
    if (err && err.code !== 'ENOENT') throw err
  }
})

ipcMain.handle('fs:readBlob', async (_e, parts) => {
  try {
    const data = await fs.readFile(safeJoin(parts))
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  } catch {
    return null
  }
})

ipcMain.handle('fs:writeBlob', async (_e, parts, buffer) => {
  const p = safeJoin(parts)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, Buffer.from(buffer))
})

// ---------- AI 请求代理（绕过浏览器 CORS，apiKey 不经过任何第三方） ----------

ipcMain.handle('ai:request', async (_e, { url, method, headers, body, timeoutMs }) => {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('AI 地址必须是 http(s) URL')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(Number(timeoutMs) || 90000, 120000))
  try {
    const resp = await fetch(url, {
      method: method || 'POST',
      headers: headers || {},
      body: body ?? undefined,
      signal: controller.signal,
    })
    const text = await resp.text()
    return { status: resp.status, ok: resp.ok, body: text }
  } catch (err) {
    return { status: 0, ok: false, body: String(err && err.message ? err.message : err) }
  } finally {
    clearTimeout(timer)
  }
})

ipcMain.handle('app:getSavePath', () => getSaveDir())

ipcMain.handle('app:openSaveFolder', async () => {
  const dir = getSaveDir()
  await fs.mkdir(dir, { recursive: true })
  await shell.openPath(dir)
})

// ---------- 窗口与协议 ----------

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    // app://bundle/index.html -> dist/index.html
    const segments = url.hostname === 'bundle' ? url.pathname.slice(1) : ''
    const filePath = path.join(DIST_DIR, segments || 'index.html')
    if (!filePath.startsWith(DIST_DIR)) return new Response('Not found', { status: 404 })
    try {
      const data = await fs.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.wasm': 'application/wasm',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.apkg': 'application/octet-stream',
        '.ttf': 'font/ttf',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
      }
      return new Response(data, { headers: { 'content-type': types[ext] ?? 'application/octet-stream' } })
    } catch {
      // 单页应用回退
      const index = await fs.readFile(path.join(DIST_DIR, 'index.html'))
      return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 420,
    minHeight: 680,
    title: 'Brandki',
    backgroundColor: '#f7f5f2',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // 便于打包后冒烟验证：把渲染进程日志带到主进程 stdout
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[renderer:${level}] ${message}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', details)
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else if (fssync.existsSync(DIST_DIR)) {
    void win.loadURL('app://bundle/index.html')
  } else {
    void win.loadURL('data:text/html,<h1>未找到构建产物，请先运行 npm run app:build</h1>')
  }
}

// 简洁的应用菜单（保留复制粘贴 / 退出）
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [{
          label: 'Brandki',
          submenu: [
            { role: 'about', label: '关于 Brandki' },
            { type: 'separator' },
            { role: 'hide', label: '隐藏 Brandki' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
            { role: 'quit', label: '退出 Brandki' },
          ],
        }]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  registerAppProtocol()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
