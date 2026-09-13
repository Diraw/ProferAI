import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }
import { resolveDevVitePort } from './src/main/lib/dev-instance'

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    port: resolveDevVitePort(),
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
    // 部分 macOS 环境下“基于路径的 FSEvents 流”不派发任何事件（本机实测：fsevents 原生模块、
    // fs.watch({recursive:true}) 与 chokidar 默认模式全部零事件，而 libuv 的逐目录 fs.watch 正常），
    // 于是 Vite 的文件监听会静默失效：改动不触发 HMR、dev server 一直返回旧模块、只能重启生效。
    // 默认改走 chokidar 的 fs.watch 路径；若需要恢复 FSEvents 设 PROFER_VITE_WATCH_FSEVENTS=1，
    // 若极少数环境连 fs.watch 也失效，可设 PROFER_VITE_WATCH_POLLING=1 改用轮询兜底。
    watch: {
      useFsEvents: process.env.PROFER_VITE_WATCH_FSEVENTS === '1',
      ...(process.env.PROFER_VITE_WATCH_POLLING === '1'
        ? { usePolling: true, interval: 300 }
        : {}),
    },
  },
})
