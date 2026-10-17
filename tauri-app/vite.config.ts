import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
export default defineConfig({
  root: __dirname, base: './', plugins: [react()],
  resolve: { alias: { electron: path.join(__dirname, 'frontend-electron.ts'), '@': path.join(__dirname, '../src/renderer') } },
  build: { outDir: 'dist', emptyOutDir: true }
})
