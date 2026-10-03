import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The web app reads the engine's shared fixtures (../fixtures) so roster ids match /simulate.
  server: { fs: { allow: ['..'] } },
})
