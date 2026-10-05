// 预加载：向渲染进程暴露最小化的本地硬盘文件接口（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('brandkiNative', {
  isDesktop: true,
  ensureStructure: () => ipcRenderer.invoke('fs:ensureStructure'),
  readText: (parts) => ipcRenderer.invoke('fs:readText', parts),
  writeText: (parts, content) => ipcRenderer.invoke('fs:writeText', parts, content),
  listFiles: (parts) => ipcRenderer.invoke('fs:listFiles', parts),
  listDirs: (parts) => ipcRenderer.invoke('fs:listDirs', parts),
  deleteFile: (parts) => ipcRenderer.invoke('fs:deleteFile', parts),
  readBlob: (parts) => ipcRenderer.invoke('fs:readBlob', parts),
  writeBlob: (parts, buffer) => ipcRenderer.invoke('fs:writeBlob', parts, buffer),
  getSavePath: () => ipcRenderer.invoke('app:getSavePath'),
  openSaveFolder: () => ipcRenderer.invoke('app:openSaveFolder'),
  aiRequest: (payload) => ipcRenderer.invoke('ai:request', payload),
})
