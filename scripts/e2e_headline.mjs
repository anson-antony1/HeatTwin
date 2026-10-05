// End-to-end check: the Practice plan screen shows exactly the headline numbers in docs/demo_numbers.json
// (before and after Optimize), read from the rendered page.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node scripts/e2e_headline.mjs http://localhost:5173
//
// Exit 1 on any mismatch. Needs the engine (warmed: `make warm`) and the web dev server running.
import { readFileSync } from 'node:fs'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const base = process.argv[2] ?? 'http://localhost:5173'
const demo = JSON.parse(readFileSync(new URL('../docs/demo_numbers.json', import.meta.url))).demo
const sim = demo.simulate
const opt = demo.optimize.max_load

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

async function metrics() {
  return page.$$eval('.metric', (els) =>
    Object.fromEntries(
      els.map((el) => [
        (el.querySelector('.eyebrow')?.textContent ?? '').trim().toLowerCase(),
        (el.querySelector('.metric__value .sr-only')?.textContent ?? el.querySelector('.metric__value')?.textContent ?? '').trim(),
      ]),
    ),
  )
}
const num = (s) => {
  const m = String(s ?? '').match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}
const pick = (m, re) => num(Object.entries(m).find(([k]) => re.test(k))?.[1])

await page.goto(base, { waitUntil: 'networkidle' })
await page.getByText('Practice plan', { exact: true }).first().click()
await page.waitForFunction(() => document.querySelectorAll('.metric').length >= 4, null, { timeout: 30000 })
await page.waitForTimeout(3000)
const before = await metrics()
await page.getByRole('button', { name: /Optimize plan/i }).first().click()
await page.waitForFunction(() => /optimized/i.test(document.querySelector('main')?.textContent ?? ''), null, { timeout: 120000 })
await page.waitForTimeout(3000)
const after = await metrics()
await browser.close()

// The screen prints °F (web/src/lib/format.ts); docs/demo_numbers.json keeps the engine's °C.
const toF = (c) => Math.round((c * 1.8 + 32) * 100) / 100
const checks = [
  ['before: athletes over the line (p95)', pick(before, /over the line/), sim.over_limit],
  ['before: hottest p95 °F', pick(before, /hottest/), toF(sim.max_p95_c)],
  ['before: FHSAA issues', pick(before, /fhsaa/), sim.fhsaa_violations],
  ['after: athletes over the line (p95)', pick(after, /over the line/), opt.after.over_limit],
  ['after: hottest p95 °F', pick(after, /hottest/), toF(opt.after.max_p95_c)],
  ['after: FHSAA issues', pick(after, /fhsaa/), opt.after.fhsaa_violations],
  ['after: training load kept %', pick(after, /load kept/), opt.load_kept_pct],
]
let bad = 0
for (const [name, shown, expected] of checks) {
  const ok = shown === expected
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: screen ${shown} · docs/demo_numbers.json ${expected}`)
}
if (errors.length) console.log(`page errors: ${errors.join(' | ')}`)
process.exit(bad || errors.length ? 1 : 0)
