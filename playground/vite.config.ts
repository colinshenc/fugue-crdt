import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative asset paths, so the build works under any GitHub Pages subpath.
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist-playground', import.meta.url)),
    emptyOutDir: true,
  },
})
