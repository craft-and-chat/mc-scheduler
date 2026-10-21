// Full weekly-cycle test against a local `wrangler dev` (port 8788) with a fake Discord.
// Run: cd worker && node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startMock } from './discord-mock.mjs';
import { postDiscord } from '../src/discord.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8788, MOCK = 9911;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin-key';
const PERSIST = '.wrangler-discord';
let mock, wr, wrLog = '';

const W = '2026-11-02'; // Monday; Europe/London = GMT in November
const SAT = 5 * 32;
const T = (s) => s + ':00Z'; // helper: ISO instants are UTC == London in Nov

async function api(method, p, body, now) {
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN };
  if (now) headers['X-Fake-Now'] = now;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  assert.ok(r.ok, `${method} ${p} -> ${r.status} ${JSON.stringify(j)}\n${wrLog.slice(-1500)}`);
  return j;
}
const tick = (now) => api('POST', '/api/dev/run-scheduled?now=' + encodeURIComponent(now), null, now);
const person = async (name) => (await api('POST', '/api/people', { name })).id;
const avail = (id, week, blocks, now, cant = false) => api('PUT', '/api/availability', { personId: id, week, blocks, cant }, now);
const text = (m) => [m.content, ...(m.embeds || []).flatMap((e) => [e.title, e.description])].filter(Boolean).join('\n');
const last = () => mock.webhooks[mock.webhooks.length - 1];

before(async () => {
  mock = await startMock(MOCK);
  rmSync(path.join(root, PERSIST), { recursive: true, force: true });
  const vars = {
    ADMIN_KEY: ADMIN, DEV_FAKE_NOW_ALLOWED: '1', APP_URL: 'https://example.test/mc', ACCESS_CODE: 'sekret',
    DISCORD_WEBHOOK_URL: `http://127.0.0.1:${MOCK}/webhook`, DISCORD_MENTION: '@everyone',
    DISCORD_BOT_TOKEN: 'bot-token', DISCORD_GUILD_ID: '42', DISCORD_API_BASE: `http://127.0.0.1:${MOCK}/api/v10`,
    MC_SERVER_ADDRESS: 'mc.example.test',
  };
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  const sh = spawnSync('npx', ['wrangler', 'd1', 'execute', 'mc-scheduler', '--local', '--persist-to', PERSIST, '--file=schema.sql'], { cwd: root, encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stdout + sh.stderr);
  wr = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--inspector-port', '9239', '--persist-to', PERSIST, ...varArgs],
    { cwd: root, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  wr.stdout.on('data', (d) => (wrLog += d));
  wr.stderr.on('data', (d) => (wrLog += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/api/health?code=sekret')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler did not start:\n' + wrLog);
});

after(async () => {
  if (wr) { wr.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 300)); wr.kill('SIGKILL'); }
  if (mock) await mock.close();
});

// the access code is set, so every call needs it: patch fetch for the worker origin
const _fetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => {
  if (typeof u === 'string' && u.startsWith(BASE)) o = { ...o, headers: { ...o.headers, 'X-Access-Code': 'sekret' } };
  return _fetch(u, o);
};

test('postDiscord: unset webhook is skipped; 429 retried once; mentions explicit', async () => {
  assert.deepEqual(await postDiscord({}, { content: 'x' }), { skipped: true });
  const env = { DISCORD_WEBHOOK_URL: `http://127.0.0.1:${MOCK}/webhook`, DISCORD_MENTION: '<@&123>' };
  mock.reset();
  mock.failNext.push({ status: 429, body: { retry_after: 0.05 } });
  const r = await postDiscord(env, { content: 'hi', ping: true });
  assert.ok(r.ok);
  assert.equal(mock.webhooks.length, 1);
  assert.deepEqual(mock.webhooks[0].allowed_mentions, { parse: [], roles: ['123'] });
  assert.match(mock.webhooks[0].content, /^<@&123> hi/);
  assert.match(mock.webhooks[0]._query, /wait=true/);
  mock.reset();
  await postDiscord(env, { content: 'quiet' });
  assert.deepEqual(mock.webhooks[0].allowed_mentions, { parse: [] });
  mock.reset();
});

test('weekly cycle: open -> remind -> lock -> soon, idempotent', async () => {
  mock.reset();
  // Before the open time: nothing posted. (Also stores a silent 'none' for the previous week - too old to announce.)
  await tick('2026-10-30T10:00:00Z');
  assert.equal(mock.webhooks.length, 0);

  // people
  const alice = await person('Alice'), bob = await person('Bob'), cara = await person('Cara');
  const eve = await person('Eve'); await person('Frank');
  await avail(eve, '2026-10-26', [SAT + 20, SAT + 21], '2026-10-27T10:00:00Z'); // active but hasn't answered W
  await avail(alice, W, [SAT + 19, SAT + 20, SAT + 21], '2026-10-30T11:00:00Z');
  await avail(bob, W, [SAT + 19, SAT + 20, SAT + 21], '2026-10-30T11:00:00Z');
  await avail(cara, W, [SAT + 20, SAT + 21, 4 * 32 + 19, 4 * 32 + 20], '2026-10-30T11:00:00Z');

  // open announcement, once
  await tick('2026-10-30T12:15:00Z');
  assert.equal(mock.webhooks.length, 1);
  assert.match(text(last()), /2 Nov – 8 Nov.*open/s);
  assert.match(text(last()), /https:\/\/example\.test\/mc\?code=sekret/);
  assert.deepEqual(last().allowed_mentions, { parse: ['everyone'] });
  assert.match(last().content, /^@everyone/);
  await tick('2026-10-30T12:30:00Z');
  assert.equal(mock.webhooks.length, 1, 'no duplicate open');

  // reminder lists everyone who hasn't answered (incl. people who only entered their name), and the leader
  await tick('2026-10-31T18:05:00Z');
  assert.equal(mock.webhooks.length, 2);
  const rem = text(last());
  assert.match(rem, /Eve/); assert.match(rem, /Frank/);
  assert.match(rem, /Sat 7 Nov · 20:00–22:00/); assert.match(rem, /3 can play/);
  await tick('2026-10-31T18:20:00Z');
  assert.equal(mock.webhooks.length, 2, 'no duplicate reminder');

  // lock
  await tick('2026-11-01T18:05:00Z');
  assert.equal(mock.webhooks.length, 3);
  const lk = text(last());
  assert.match(lk, /Sat 7 Nov · 20:00–22:00/); assert.match(lk, /Alice, Bob, Cara/);
  assert.match(lk, /mc\.example\.test/); assert.match(lk, /calendar\.google\.com/);
  const st = await api('GET', '/api/state?week=' + W, null, '2026-11-01T18:10:00Z');
  assert.equal(st.session.status, 'scheduled');
  assert.deepEqual(st.session.attendees, ['Alice', 'Bob', 'Cara']);
  assert.equal(st.session.start, '2026-11-07T20:00:00.000Z');
  await tick('2026-11-01T18:20:00Z');
  assert.equal(mock.webhooks.length, 3, 'no duplicate lock');
  // Discord scheduled event created
  const ev = mock.api.filter((c) => c.method === 'POST' && c.path === '/guilds/42/scheduled-events');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].auth, 'Bot bot-token');
  assert.equal(ev[0].body.entity_type, 3);
  assert.equal(ev[0].body.entity_metadata.location, 'mc.example.test');
  assert.equal(ev[0].body.scheduled_start_time, '2026-11-07T20:00:00.000Z');

  // starting soon: not yet, then once
  await tick('2026-11-07T18:30:00Z'); // (this is also the reminder time for the *next* week, 30 min late: sent)
  assert.equal(mock.webhooks.length, 4);
  assert.match(text(last()), /Reminder: 9 Nov/);
  await tick('2026-11-07T19:10:00Z');
  assert.equal(mock.webhooks.length, 5);
  assert.match(text(last()), /Starting in about an hour/); assert.match(text(last()), /mc\.example\.test/);
  await tick('2026-11-07T19:25:00Z');
  assert.equal(mock.webhooks.length, 5, 'no duplicate soon');
});

test("'none' case, admin re-lock and unlock", async () => {
  mock.reset();
  const W2 = '2026-11-09';
  const people = (await api('GET', '/api/state?week=' + W2, null, '2026-11-06T10:00:00Z')).people;
  const id = Object.fromEntries(people.map((p) => [p.name, p.id]));
  // only Alice answers W2 (Tue 18-20) -> below MIN_PLAYERS
  await avail(id.Alice, W2, [32 + 18, 32 + 19], '2026-11-06T10:00:00Z');
  await tick('2026-11-08T18:05:00Z');
  const lk = mock.webhooks.filter((m) => /No session/.test(text(m)));
  assert.equal(lk.length, 1, JSON.stringify(mock.webhooks.map(text)));
  assert.match(text(lk[0]), /Best was Tue 10 Nov · 18:00–20:00 with 1 person/);
  const n = mock.webhooks.length;
  await tick('2026-11-08T18:20:00Z');
  assert.equal(mock.webhooks.length, n, 'no duplicate');
  assert.equal((await api('GET', '/api/state?week=' + W2, null, '2026-11-08T19:00:00Z')).session.status, 'none');

  // everyone adds Wed 12-14 and an admin re-locks
  for (const name of ['Alice', 'Bob', 'Cara']) await avail(id[name], W2, [32 + 18, 32 + 19, 64 + 12, 64 + 13], '2026-11-08T18:30:00Z');
  const before = mock.webhooks.length;
  const r = await api('POST', '/api/admin/lock', { week: W2 }, '2026-11-08T19:00:00Z');
  assert.equal(r.session.status, 'scheduled');
  assert.equal(mock.webhooks.length, before + 1);
  assert.match(text(last()), /Tue 10 Nov · 18:00–20:00/);
  assert.deepEqual(r.session.attendees, ['Alice', 'Bob', 'Cara']);
  assert.equal(mock.api.filter((c) => c.method === 'POST').length, 1, 'event created');

  // re-lock updates (PATCH) the same event; silent => no post
  await api('POST', '/api/admin/lock', { week: W2, silent: true }, '2026-11-08T19:05:00Z');
  assert.equal(mock.webhooks.length, before + 1);
  assert.equal(mock.api.filter((c) => c.method === 'PATCH').length, 1);

  // forced announce
  await api('POST', '/api/admin/announce', { type: 'remind', week: W2 }, '2026-11-08T19:06:00Z');
  assert.equal(mock.webhooks.length, before + 2);

  // unlock deletes the event + session
  await api('POST', '/api/admin/unlock', { week: W2 }, '2026-11-08T19:10:00Z');
  assert.equal(mock.api.filter((c) => c.method === 'DELETE').length, 1);
  assert.equal((await api('GET', '/api/state?week=' + W2, null, '2026-11-08T19:11:00Z')).session, null);
});
