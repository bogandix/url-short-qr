import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// Built into the edge Worker's static assets, served at /_/admin on the admin host.
export default defineConfig({
  base: '/_/admin/',
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL('../edge/public/_/admin', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    // `npm run dev:admin` proxies the API to a local `wrangler dev` (port 8787)
    proxy: { '/_/api': 'http://localhost:8787', '/_/qr': 'http://localhost:8787' },
  },
})
