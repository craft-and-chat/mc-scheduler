// Integration: real frontend (vite dev, VITE_API_URL=localhost:8787) against real local worker + D1.
import { chromium, devices } from '@playwright/test';
const API = 'http://localhost:8787/api', APP = 'http://localhost:5173/';
const SS = process.argv[2];
const j = (r) => r.json();
const post = (p, b, m = 'POST', h = {}) => fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b) }).then(j);
const st0 = await fetch(API + '/state').then(j);
const W = st0.openWeek, sat = (h) => 5 * 32 + h;
for (const [name, blocks] of [['Alex', [sat(19), sat(20), sat(21)]], ['Sam', [sat(19), sat(20)]], ['Jo', [sat(20), sat(21), 4 * 32 + 20, 4 * 32 + 21]]]) {
  const p = await post('/people', { name });
  await post('/availability', { personId: p.id, week: W, blocks }, 'PUT');
}
const browser = await chromium.launch();
for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));
  await page.goto(APP);
  if (scheme === 'dark') {
    await page.getByPlaceholder('Your name').fill('Tom M');
    await page.getByRole('button', { name: "Let's go" }).click();
  } else {
    await page.getByRole('button', { name: 'Tom M' }).click();
  }
  await page.getByTestId('week-screen').waitFor();
  await page.screenshot({ path: `${SS}/int-${scheme}-top.png` });
  if (scheme === 'dark') {
    const picks = await page.getByTestId('pick').count();
    console.log('quick picks:', picks, await page.getByTestId('pick').first().textContent());
    await page.getByTestId('pick').first().click();
    await page.getByTestId('save-pill').filter({ hasText: 'Saved' }).waitFor({ timeout: 5000 });
    const st = await fetch(API + '/state').then(j);
    const me = st.people.find((p) => p.name === 'Tom M');
    console.log('server sees Tom M:', me.status, me.blocks);
    await post('/admin/lock', { week: W, silent: true }, 'POST', { 'X-Admin-Key': 'e2ekey' }).then((r) => console.log('lock:', JSON.stringify(r).slice(0, 200)));
    await page.reload();
    await page.getByTestId('week-screen').waitFor();
  }
  await page.screenshot({ path: `${SS}/int-${scheme}-full.png`, fullPage: true });
  console.log(scheme, 'overflow ok:', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await ctx.close();
}
await browser.close();
