import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({ root: import.meta.dirname, plugins: [preact()], build: { outDir: '../src/operator-web', emptyOutDir: true }, server: { host: '127.0.0.1' } })
