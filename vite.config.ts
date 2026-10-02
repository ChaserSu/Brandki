import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // 相对路径：打包成桌面 APP 后通过 app:// 协议加载
  base: './',
  plugins: [react(), tailwindcss()],
})
