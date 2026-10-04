import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The web app reads the engine's shared fixtures (../fixtures) so roster ids match /simulate.
    fs: { allow: ['..'] },
    // Same-origin path to the engine: works on any dev port (and from a phone on the LAN)
    // without depending on the engine's CORS allowlist. Override with VITE_ENGINE_URL.
    proxy: {
      '/engine': {
        // Engine port: HEATTWIN_PORT (default 8010, same default as the Makefile); ENGINE_URL overrides the whole URL.
        target: process.env.ENGINE_URL ?? `http://127.0.0.1:${process.env.HEATTWIN_PORT ?? '8010'}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/engine/, ''),
      },
    },
  },
})
