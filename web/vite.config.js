import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 用绝对路径而不是相对路径：这样不管从哪个目录执行 vite，root 和 outDir 都不会跑偏。
const webDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: webDir,
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.join(webDir, 'src')
    }
  },
  build: {
    // 产物直接落到 lib/web，随 npm 包一起发布，使用者不需要自己构建
    outDir: path.join(webDir, '..', 'lib', 'web'),
    emptyOutDir: true,
    // 资源放在 /__apiloop/ 下，尽量少遮住用户项目根目录里的同名文件
    assetsDir: '__apiloop',
    chunkSizeWarningLimit: 3000
  },
  server: {
    port: 5173,
    proxy: {
      '/__admin': 'http://127.0.0.1:8080',
      '/mock': 'http://127.0.0.1:8080'
    }
  }
});
