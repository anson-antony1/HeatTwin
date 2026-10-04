// Fetch the self-hosted Clash Display 600 webfont into public/fonts/ (see src/styles/fonts.css for why it is not
// committed: the ITF Free Font License allows self-hosting on our own site but not redistribution through a public
// repository). Runs before `npm run dev` / `npm run build`; does nothing if the file is already there; never fails
// the build (without the file, headings fall back to Archivo). Needs network only the first time.
//
// Source: the woff2 URL the Fontshare CSS API returns for clash-display@600 (looked up each time, since the CDN path
// can change), else the URL it returned on 2026-10-03.

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts', 'clash-display-600.woff2')
const CSS_API = 'https://api.fontshare.com/v2/css?f[]=clash-display@600&display=swap'
const KNOWN =
  'https://cdn.fontshare.com/wf/FPDAZ2S6SW4QMSRIIKNNGTPM6VIXYMKO/5HNPQ453FRLIQWV2FNOBUU3FKTDZQVSG/Z3MGHFHX6DCTLQ55LJYRJ5MDCZPMFZU6.woff2'
const TIMEOUT_MS = 8_000

async function exists(p) {
  try {
    return (await stat(p)).size > 0
  } catch {
    return false
  }
}

async function woff2Url() {
  try {
    const r = await fetch(CSS_API, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const css = await r.text()
    const m = /url\('?(\/\/cdn\.fontshare\.com\/[^')]+\.woff2)'?\)/.exec(css)
    if (m) return `https:${m[1]}`
  } catch {
    /* use the known URL */
  }
  return KNOWN
}

async function main() {
  if (await exists(OUT)) return
  const url = await woff2Url()
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'wOF2') throw new Error('not a woff2 file')
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, bytes)
  console.log(`fonts: Clash Display 600 saved to public/fonts (${bytes.length} bytes, ITF Free Font License — not committed)`)
}

main().catch((e) => {
  console.warn(`fonts: Clash Display not fetched (${e.message}); headings fall back to Archivo. Run \`npm run fonts\` when online.`)
})
