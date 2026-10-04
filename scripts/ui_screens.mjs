// Screenshots of every screen of the web app at 1440x900 and 1280x800 (final-ui reference / comparison).
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core/index.mjs \
//     node scripts/ui_screens.mjs http://localhost:5180 docs/ui_before
//
// Uses the installed Google Chrome (no browser download). Each screen: fresh context (no saved plan), demo playback
// paused right after load, then the screen opened through the app's own navigation. Full-page PNGs.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const base = process.argv[2] ?? 'http://localhost:5180'
const out = process.argv[3] ?? 'docs/ui_before'
const SIZES = [
  [1440, 900],
  [1280, 800],
]
const settle = (page, ms = 1500) => page.waitForTimeout(ms)

async function open(page) {
  await page.goto(base, { waitUntil: 'networkidle' })
  await settle(page, 2500)
  const pause = page.getByRole('button', { name: /^Pause/ })
  if (await pause.count()) await pause.first().click()
  await settle(page)
}
const nav = (label) => async (page) => {
  await page.getByText(label, { exact: true }).first().click()
  await settle(page)
}
const SCREENS = {
  live: async () => {},
  plan: nav('Practice plan'),
  'plan-edit': async (page) => {
    await nav('Practice plan')(page)
    await page.getByRole('button', { name: /^Edit$/ }).first().click()
    await settle(page)
  },
  athlete: nav('Athlete twin'),
  response: nav('Response'),
  collapse: async (page) => {
    await nav('Response')(page)
    await page.getByRole('button', { name: /Start collapse response/i }).first().click()
    await settle(page, 2000)
  },
  settings: nav('Settings'),
  dock: async (page) => {
    await page.locator('.dock__text').first().click()
    await settle(page)
  },
}

mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const [w, h] of SIZES) {
  for (const [name, go] of Object.entries(SCREENS)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    try {
      await open(page)
      await go(page)
      const file = join(out, `${name}-${w}x${h}.png`)
      await page.screenshot({ path: file, fullPage: true })
      console.log(`${file}${errors.length ? `  (page errors: ${errors.join(' | ')})` : ''}`)
    } catch (e) {
      console.log(`FAILED ${name} ${w}x${h}: ${String(e).split('\n')[0]}`)
    }
    await ctx.close()
  }
}
await browser.close()
