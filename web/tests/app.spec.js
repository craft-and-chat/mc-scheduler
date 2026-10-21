import { test, expect } from '@playwright/test';

const URL = '/?mock=1&now=2026-10-21T12:00:00Z';
const shot = (page, name) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
const cell = (page, day, hour) => page.locator(`[data-b="${day * 32 + hour}"]`);

async function join(page, name = 'Tom M') {
  await page.goto(URL);
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: "Let's go" }).click();
  await expect(page.getByTestId('week-screen')).toBeVisible();
}
const openGrid = async (page) => {
  await expect(page.getByTestId('status')).toBeVisible();
  const t = page.getByTestId('toggle-grid');
  if (await t.count()) { if ((await t.textContent()).includes('Pick other')) await t.click(); }
  await expect(page.getByTestId('grid')).toBeVisible();
};
const saved = (page) => expect(page.getByTestId('save-pill')).toHaveText('Saved ✓', { timeout: 5000 });
const noOverflow = async (page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

test('name picker: choose existing and create new', async ({ page }) => {
  await page.goto(URL);
  await expect(page.getByTestId('name-chips')).toBeVisible();
  await noOverflow(page);
  await shot(page, '01-name-screen');
  await page.getByRole('button', { name: 'Priya' }).click();
  await expect(page.getByTestId('me')).toContainText('Priya');
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Priya');
  await page.getByRole('button', { name: 'switch' }).click();
  await page.getByPlaceholder('Your name').fill('Newbie');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('me')).toContainText('Newbie');
  await expect(page.getByTestId('demo-note')).toBeVisible();
});

test('week view: grid shown directly, no popular-times cards, autosave persists', async ({ page }) => {
  await join(page);
  await expect(page.getByTestId('grid')).toBeVisible();
  await expect(page.getByTestId('quick-picks')).toHaveCount(0);
  await expect(page.getByTestId('toggle-grid')).toHaveCount(0);
  await shot(page, '02-week-top');
  await cell(page, 5, 19).tap();
  await expect(page.getByTestId('status')).toContainText("You've answered");
  await saved(page);
  await page.reload();
  await expect(cell(page, 5, 19)).toHaveClass(/on/);
  await noOverflow(page);
});

test('grid: tap toggles, day header toggles, persists', async ({ page }) => {
  await join(page);
  await openGrid(page);
  await cell(page, 4, 20).tap();
  await expect(cell(page, 4, 20)).toHaveClass(/on/);
  await cell(page, 4, 20).tap();
  await expect(cell(page, 4, 20)).not.toHaveClass(/on/);
  await cell(page, 4, 20).tap();
  await cell(page, 4, 21).tap();
  await page.getByTestId('day-6').tap();
  await expect(cell(page, 6, 12)).toHaveClass(/on/);
  await expect(cell(page, 6, 23)).toHaveClass(/on/);
  await saved(page);
  await shot(page, '04-grid-filled');
  await page.getByTestId('day-6').tap();
  await expect(cell(page, 6, 12)).not.toHaveClass(/on/);
  await saved(page);
  await page.reload();
  await openGrid(page);
  await expect(cell(page, 4, 20)).toHaveClass(/on/);
  await expect(cell(page, 4, 21)).toHaveClass(/on/);
  await expect(cell(page, 6, 12)).not.toHaveClass(/on/);
});

test('past hours are disabled in current week', async ({ page }) => {
  await join(page);
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.getByTestId('week-label')).toContainText('19 Oct');
  await openGrid(page);
  await expect(cell(page, 0, 12)).toHaveClass(/past/);
  await cell(page, 0, 12).tap({ force: true });
  await expect(cell(page, 0, 12)).not.toHaveClass(/on/);
  await expect(cell(page, 4, 20)).not.toHaveClass(/past/);
  await shot(page, '05-current-week-past');
});

test('touch long-press drag paints many cells; quick swipe does not', async ({ page }) => {
  await join(page);
  await openGrid(page);
  await page.getByTestId('grid').evaluate((el) => el.scrollIntoView());
  const a = await cell(page, 2, 18).boundingBox();
  const b = await cell(page, 2, 22).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const pt = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const s = pt(a), e = pt(b);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [s] });
  await page.waitForTimeout(400);
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: s.x, y: s.y + ((e.y - s.y) * i) / 8 }] });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  for (const h of [18, 19, 20, 21, 22]) await expect(cell(page, 2, h)).toHaveClass(/on/);
  await expect(cell(page, 2, 17)).not.toHaveClass(/on/);
  await expect(cell(page, 2, 23)).not.toHaveClass(/on/);
  await saved(page);
  await shot(page, '06-after-drag');
  // quick swipe (no long press) scrolls and paints nothing
  const y0 = await page.evaluate(() => scrollY);
  const c = pt(await cell(page, 3, 20).boundingBox());
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [c] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x, y: c.y - i * 25 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  await expect(cell(page, 3, 20)).not.toHaveClass(/on/);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(y0);
});

test('mouse drag paints', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } });
  const page = await ctx.newPage();
  await join(page);
  await openGrid(page);
  await page.getByTestId('grid').evaluate((el) => el.scrollIntoView());
  const a = await cell(page, 1, 15).boundingBox();
  const b = await cell(page, 1, 18).boundingBox();
  await page.mouse.move(a.x + 5, a.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + 5, b.y + 5, { steps: 6 });
  await page.mouse.up();
  for (const h of [15, 16, 17, 18]) await expect(cell(page, 1, h)).toHaveClass(/on/);
  await ctx.close();
});

test("can't play toggles and undoes", async ({ page }) => {
  await join(page);
  await openGrid(page);
  await cell(page, 4, 20).tap();
  await saved(page);
  await page.getByTestId('cant').tap();
  await expect(page.getByTestId('status')).toContainText("Can't play");
  await saved(page);
  await shot(page, '07-cant');
  await page.reload();
  await expect(page.getByTestId('status')).toContainText("Can't play");
  // tapping a time clears cant
  await openGrid(page);
  await cell(page, 5, 20).tap();
  await expect(page.getByTestId('status')).toContainText("You've answered");
  await saved(page);
  await page.getByTestId('cant').tap();
  await page.getByTestId('cant').tap();
  await expect(page.getByTestId('status')).toContainText('Not answered');
});

test('same as last week appears for returning person', async ({ page }) => {
  await page.goto(URL);
  await page.getByRole('button', { name: 'Sam' }).click();
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.getByTestId('week-label')).toContainText('2 Nov');
  await page.getByTestId('same-last').click();
  await expect(page.getByTestId('status')).toContainText("You've answered");
  await saved(page);
});

test('regular times add/remove, prompt, and effect', async ({ page }) => {
  await join(page);
  await openGrid(page);
  await cell(page, 4, 19).tap();
  await cell(page, 4, 20).tap();
  await saved(page);
  await expect(page.getByTestId('regular-prompt')).toBeVisible();
  await shot(page, '08-regular-prompt');
  await page.getByRole('button', { name: 'Make these my regular times' }).click();
  await expect(page.getByTestId('regular-card')).toContainText('Fridays 19:00–21:00 · forever');
  await expect(page.getByTestId('regular-prompt')).toHaveCount(0);
  await page.getByTestId('add-regular').click();
  await page.getByRole('button', { name: 'Weekend' }).click();
  await shot(page, '09-regular-form');
  await page.getByTestId('save-regular').click();
  await expect(page.getByTestId('regular-card')).toContainText('Saturdays 18:00–22:00 · forever');
  await expect(page.getByTestId('regular-card')).toContainText('Sundays');
  await page.reload();
  await expect(page.getByTestId('regular-card')).toContainText('Sundays');
  await page.getByRole('button', { name: /Remove Sundays/ }).click();
  await expect(page.getByTestId('regular-card')).not.toContainText('Sundays');
  await page.getByRole('button', { name: /Remove Saturdays/ }).click();
  await page.getByRole('button', { name: /Remove Fridays/ }).click();
  await expect(page.getByTestId('regular-card')).not.toContainText('forever');
});

test('regular times give status without answering', async ({ page }) => {
  await page.goto(URL);
  await page.getByRole('button', { name: 'Jo' }).click();
  await expect(page.getByTestId('status')).toContainText('regular times');
  await shot(page, '10-regular-user');
});

test('no horizontal overflow at 360px on all screens', async ({ page }) => {
  await join(page);
  await noOverflow(page);
  await openGrid(page);
  await noOverflow(page);
  await page.getByTestId('add-regular').click();
  await noOverflow(page);
  await shot(page, '11-full-page');
  await page.goto('/?mock=1&empty=1&now=2026-10-21T12:00:00Z#admin');
  await page.getByPlaceholder('demo key').fill('admin');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('People')).toBeVisible();
  await noOverflow(page);
  await shot(page, '12-admin');
});

test('access code is captured and stripped', async ({ page }) => {
  await page.goto(URL + '&code=abc123');
  await expect(page).not.toHaveURL(/code=/);
  expect(await page.evaluate(() => localStorage.getItem('mcs_code'))).toBe('abc123');
});

test('clearing every hour goes back to "not answered"', async ({ page }) => {
  await join(page, 'Clear Tester');
  await cell(page, 4, 20).tap();
  await expect(page.getByTestId('status')).toContainText("You've answered");
  await saved(page);
  await cell(page, 4, 20).tap();
  await expect(page.getByTestId('status')).toContainText('Not answered');
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('status')).toContainText('Not answered');
});

test('morning times are hidden until shown, and stay shown once used', async ({ page }) => {
  await join(page, 'Early Bird');
  await expect(cell(page, 5, 9)).toHaveCount(0);
  await expect(cell(page, 5, 12)).toBeVisible();
  await page.getByTestId('toggle-morning').click();
  await expect(cell(page, 5, 0)).toBeVisible();
  await cell(page, 5, 9).tap();
  await expect(cell(page, 5, 9)).toHaveClass(/on/);
  await saved(page);
  await page.reload();
  await expect(cell(page, 5, 9)).toHaveClass(/on/);
  await noOverflow(page);
  await shot(page, '13-morning');
});

// ---------- maybe / no brushes and full-house nudges ----------
const brush = (page, k) => page.getByTestId('brush-' + k).tap();
const st = (page, day, hour) => cell(page, day, hour).getAttribute('data-state');

test('brush bar: switch brush, paint maybe/no, tap again clears, persists', async ({ page }) => {
  await join(page, 'Brusher');
  const bar = page.getByTestId('brush');
  await expect(bar).toBeVisible();
  const box = await page.getByTestId('brush-free').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('brush-free')).toHaveAttribute('aria-checked', 'true');
  await noOverflow(page);

  await cell(page, 1, 12).tap();                         // free (default brush)
  await brush(page, 'maybe');
  await expect(page.getByTestId('brush-maybe')).toHaveAttribute('aria-checked', 'true');
  await cell(page, 1, 13).tap();
  await cell(page, 1, 14).tap();
  await brush(page, 'no');
  await cell(page, 1, 15).tap();
  expect(await st(page, 1, 12)).toBe('free');
  expect(await st(page, 1, 13)).toBe('maybe');
  expect(await st(page, 1, 15)).toBe('no');
  await expect(cell(page, 1, 13)).toHaveText('?');
  await expect(cell(page, 1, 15)).toHaveText('✗');
  // painting over a different state replaces it
  await cell(page, 1, 12).tap();
  expect(await st(page, 1, 12)).toBe('no');
  // tapping the brush's own state clears
  await cell(page, 1, 12).tap();
  expect(await st(page, 1, 12)).toBe('');
  await saved(page);
  // day header: set all with brush, then clear
  await brush(page, 'maybe');
  await page.getByTestId('day-3').tap();
  expect(await st(page, 3, 12)).toBe('maybe'); expect(await st(page, 3, 23)).toBe('maybe');
  await page.getByTestId('day-3').tap();
  expect(await st(page, 3, 12)).toBe(''); expect(await st(page, 3, 23)).toBe('');
  await saved(page);
  await page.reload();
  expect(await st(page, 1, 13)).toBe('maybe');
  expect(await st(page, 1, 14)).toBe('maybe');
  expect(await st(page, 1, 15)).toBe('no');
  expect(await st(page, 1, 12)).toBe('');
  await expect(page.getByTestId('status')).toContainText("You've answered");
  await noOverflow(page);
});

test('only marking "no" counts as answered; regular-times prompt ignores maybe/no', async ({ page }) => {
  await join(page, 'No Only');
  await brush(page, 'no');
  await cell(page, 2, 20).tap();
  await expect(page.getByTestId('status')).toContainText("You've answered");
  await saved(page);
  await page.reload();
  expect(await st(page, 2, 20)).toBe('no');
  await expect(page.getByTestId('regular-prompt')).toHaveCount(0);
  await brush(page, 'maybe');
  await cell(page, 2, 21).tap();
  await saved(page);
  await expect(page.getByTestId('regular-prompt')).toHaveCount(0); // no free hours => nothing to make regular
  await page.getByTestId('cant').tap();
  await saved(page);
  await page.reload();
  expect(await st(page, 2, 20)).toBe('');
  expect(await st(page, 2, 21)).toBe('');
});

test('mouse drag paints with the brush; starting on a brush-state cell clears', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } });
  const page = await ctx.newPage();
  await join(page, 'Mouse Paint');
  await page.getByTestId('brush-maybe').click();
  await page.getByTestId('grid').evaluate((el) => el.scrollIntoView());
  const drag = async (h1, h2) => {
    const a = await cell(page, 1, h1).boundingBox(), b = await cell(page, 1, h2).boundingBox();
    await page.mouse.move(a.x + 5, a.y + 5); await page.mouse.down();
    await page.mouse.move(b.x + 5, b.y + 5, { steps: 6 }); await page.mouse.up();
  };
  await drag(15, 18);
  for (const h of [15, 16, 17, 18]) expect(await st(page, 1, h)).toBe('maybe');
  await drag(16, 19); // starts on a maybe cell => clears the stroke
  expect(await st(page, 1, 15)).toBe('maybe');
  for (const h of [16, 17, 18, 19]) expect(await st(page, 1, h)).toBe('');
  await ctx.close();
});

// Demo seed (open week 26 Oct): Alex has Sat 18-23 as "maybe"; everyone else on Sat 19-21 is free.
// A newcomer who answers anything is the 2nd one missing for Sat 19:00-21:00 => nudge.
async function newcomerWithNudge(page, name = 'Nudgee') {
  await join(page, name);
  await cell(page, 0, 12).tap(); // Mon 12:00 free: now counts as "answered"
  await expect(page.getByTestId('nudge')).toHaveCount(1);
}

test('full-house nudge: Yes marks free and card disappears', async ({ page }) => {
  await newcomerWithNudge(page);
  const card = page.getByTestId('nudge');
  await expect(card).toContainText('Can you do Sat 31 Oct · 19:00–21:00?');
  await expect(card).toContainText('Only you and Alex are missing for a full house (4 of 6)');
  // placed below the grid, above the regular times card
  const gy = (await page.getByTestId('grid').boundingBox()).y, ny = (await card.boundingBox()).y;
  const ry = (await page.getByTestId('regular-card').boundingBox()).y;
  expect(gy).toBeLessThan(ny); expect(ny).toBeLessThan(ry);
  await noOverflow(page);
  await card.scrollIntoViewIfNeeded();
  await shot(page, '14-nudge-card');
  await page.getByTestId('nudge-yes').tap();
  // the answered slot's card is gone (an overlapping 20:00-22:00 card may legitimately take its place)
  await expect(page.getByTestId('nudge').filter({ hasText: '19:00–21:00' })).toHaveCount(0);
  expect(await st(page, 5, 19)).toBe('free'); expect(await st(page, 5, 20)).toBe('free');
  await saved(page);
  await page.reload();
  expect(await st(page, 5, 19)).toBe('free');
  await expect(page.getByTestId('nudge').filter({ hasText: '19:00–21:00' })).toHaveCount(0);
});

test('full-house nudge: Definitely not marks no and hides it', async ({ page }) => {
  await newcomerWithNudge(page, 'Nope');
  await page.getByTestId('nudge-no').tap();
  await expect(page.getByTestId('nudge').filter({ hasText: '19:00–21:00' })).toHaveCount(0);
  expect(await st(page, 5, 19)).toBe('no'); expect(await st(page, 5, 20)).toBe('no');
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('nudge')).toHaveCount(0);
  expect(await st(page, 5, 19)).toBe('no');
});

test('full-house nudge: Maybe keeps it with a confirm prompt; maybe button hidden', async ({ page }) => {
  await newcomerWithNudge(page, 'Maybee');
  await page.getByTestId('nudge-maybe').tap();
  expect(await st(page, 5, 19)).toBe('maybe');
  await expect(page.getByTestId('nudge')).toContainText('You said maybe — can you confirm?');
  await expect(page.getByTestId('nudge-maybe')).toHaveCount(0);
  await saved(page);
});

test('nudge for a seeded user (Alex, who said maybe) and only-you-missing wording', async ({ page }) => {
  await page.goto(URL);
  await page.getByRole('button', { name: 'Alex' }).click();
  const card = page.getByTestId('nudge');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Can you do Sat 31 Oct · 19:00–21:00?');
  await expect(card).toContainText("You're the only one missing — everyone else (4 of 5) can make it. Full house!");
  await expect(card).toContainText('You said maybe');
  await page.getByTestId('nudge-yes').tap();
  await expect(card).toHaveCount(0);
});

test('screenshots: brush bar + grid + nudge, light and dark', async ({ browser }) => {
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: scheme, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await join(page, 'Shot ' + scheme);
    await cell(page, 5, 18).tap();
    await cell(page, 5, 22).tap();
    await brush(page, 'maybe');
    await cell(page, 4, 19).tap(); await cell(page, 4, 20).tap();
    await brush(page, 'no');
    await cell(page, 3, 19).tap(); await cell(page, 3, 20).tap(); await cell(page, 1, 15).tap();
    await saved(page);
    await expect(page.getByTestId('nudge')).toHaveCount(1);
    await noOverflow(page);
    await shot(page, `15-brush-grid-${scheme}`);
    await page.getByTestId('nudge').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `screenshots/16-nudge-${scheme}.png` });
    await ctx.close();
  }
});

test('best times and leader use a "Show list" toggle listing everyone, no "+N"', async ({ page }) => {
  await join(page, 'List Viewer');
  const best = page.getByTestId('best-list').first();
  await expect(page.getByText(/ \+\d+$/)).toHaveCount(0);
  await best.click();
  await expect(page.getByText(/Can make it \(\d+\)/).first()).toBeVisible();
  await expect(page.getByText(/Can’t make it \(\d+\)/).first()).toBeVisible();
  await page.getByTestId('leader-list').click();
  await expect(page.getByTestId('leader')).toContainText('Can make it');
  await noOverflow(page);
  await shot(page, '17-show-list');
  await best.click();
  await expect(best).toHaveText(/Show list/);
});
