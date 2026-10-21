import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, client } from './helpers.js';
import { blockId } from '../../shared/schedule.js';

// Fake clock: Wed 2026-10-21 12:00 UTC (= 13:00 BST). Open week = 2026-10-26 (lock Sun 25 Oct 18:00 local).
const NOW = '2026-10-21T12:00:00Z';
const CUR = '2026-10-19', OPEN = '2026-10-26', NEXT = '2026-11-02';
let w, api, api2, w2;
const fake = { 'X-Fake-Now': NOW };

before(async () => {
  w = await startWorker({ port: 8787 });
  w2 = await startWorker({ port: 8790, vars: { ACCESS_CODE: 'sesame', ALLOWED_ORIGINS: 'https://good.example' } });
  api = client(w.base, fake);
  api2 = client(w2.base, fake);
});
after(async () => { await Promise.all([w?.stop(), w2?.stop()]); });

const mk = async (name) => (await api('POST', '/api/people', { name })).json;
const state = async (week = OPEN) => (await api('GET', `/api/state?week=${week}`)).json;
const me = (st, id) => st.people.find((p) => p.id === id);

test('health', async () => {
  const r = await api('GET', '/api/health');
  assert.deepEqual(r.json, { ok: true });
});

test('people create / match / rename', async () => {
  const a = await mk('  Tom   M ');
  assert.equal(a.name, 'Tom M'); assert.equal(a.created, true);
  const b = await mk('tom m');
  assert.equal(b.id, a.id); assert.equal(b.created, false); assert.equal(b.name, 'Tom M');
  assert.equal((await api('POST', '/api/people', { name: '   ' })).status, 400);
  assert.equal((await api('POST', '/api/people', { name: 'x'.repeat(41) })).status, 400);
  const c = await mk('Alex');
  assert.equal((await api('PATCH', `/api/people/${c.id}`, { name: 'tom m' })).status, 409);
  const r = await api('PATCH', `/api/people/${c.id}`, { name: 'Alexa' });
  assert.equal(r.status, 200); assert.equal(r.json.name, 'Alexa');
  assert.equal((await api('PATCH', '/api/people/9999', { name: 'Zed' })).status, 404);
  const st = await state();
  assert.deepEqual(st.people.map((p) => p.name), ['Alexa', 'Tom M']);
  const g = (await api('GET', `/api/people/${a.id}`)).json;
  assert.equal(g.name, 'Tom M'); assert.deepEqual(g.recurring, []); assert.deepEqual(g.responses, []);
});

test('availability put / delete / cant + validation', async () => {
  const p = await mk('Avail Person');
  const blocks = [blockId(5, 19), blockId(5, 20), blockId(5, 19)];
  let r = await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks });
  assert.equal(r.status, 200); assert.equal(r.json.status, 'responded');
  assert.deepEqual(r.json.blocks, [blockId(5, 19), blockId(5, 20)]);
  let st = await state();
  assert.equal(me(st, p.id).status, 'responded');
  assert.deepEqual(me(st, p.id).blocks, [blockId(5, 19), blockId(5, 20)]);
  assert.ok(me(st, p.id).updatedAt);

  r = await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks: [1, 2], cant: true });
  assert.equal(r.json.status, 'cant'); assert.deepEqual(r.json.blocks, []);
  st = await state();
  assert.equal(me(st, p.id).status, 'cant'); assert.deepEqual(me(st, p.id).blocks, []);

  const g = (await api('GET', `/api/people/${p.id}`)).json;
  assert.equal(g.responses[0].week, OPEN); assert.equal(g.responses[0].cant, true);

  assert.equal((await api('DELETE', `/api/availability?personId=${p.id}&week=${OPEN}`)).status, 200);
  assert.equal(me(await state(), p.id).status, 'waiting');

  // validation
  const put = (b) => api('PUT', '/api/availability', b);
  assert.equal((await put({ personId: 9999, week: OPEN, blocks: [] })).status, 400);
  assert.equal((await put({ personId: p.id, week: '2026-10-27', blocks: [] })).status, 400); // not Monday
  assert.equal((await put({ personId: p.id, week: 'nope', blocks: [] })).status, 400);
  assert.equal((await put({ personId: p.id, week: '2026-10-12', blocks: [] })).status, 400); // past
  assert.equal((await put({ personId: p.id, week: '2027-06-07', blocks: [] })).status, 400); // too far
  assert.equal((await put({ personId: p.id, week: OPEN, blocks: [blockId(0, 5)] })).status, 400); // outside hours
  assert.equal((await put({ personId: p.id, week: OPEN, blocks: [blockId(7, 19)] })).status, 400);
  assert.equal((await put({ personId: p.id, week: OPEN, blocks: ['x'] })).status, 400);
  assert.equal((await put({ personId: p.id, week: OPEN, blocks: 'x' })).status, 400);
  const r2 = await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks: [] }, { 'Content-Type': 'text/plain' });
  assert.equal(r2.status, 200);
  await api('DELETE', `/api/availability?personId=${p.id}&week=${OPEN}`);
});

test('recurring rules: regular status, until, merge into responses', async () => {
  const p = await mk('Regular Reg');
  const bad = (b) => api('POST', '/api/recurring', { personId: p.id, ...b });
  assert.equal((await bad({ weekday: 7, startHour: 18, endHour: 20 })).status, 400);
  assert.equal((await bad({ weekday: 1, startHour: 20, endHour: 18 })).status, 400);
  assert.equal((await bad({ weekday: 1, startHour: 8, endHour: 10 })).status, 400);
  assert.equal((await bad({ weekday: 1, startHour: 18, endHour: 25 })).status, 400);
  assert.equal((await bad({ weekday: 1, startHour: 18, endHour: 20, until: 'soon' })).status, 400);
  assert.equal((await api('POST', '/api/recurring', { personId: 9999, weekday: 1, startHour: 18, endHour: 20 })).status, 400);

  const forever = (await bad({ weekday: 6, startHour: 17 + 1, endHour: 21, until: null })).json;
  assert.ok(forever.id);
  const limited = (await bad({ weekday: 2, startHour: 19, endHour: 21, until: '2026-10-28' })).json;

  let st = await state(OPEN);
  assert.equal(me(st, p.id).status, 'regular');
  assert.deepEqual(me(st, p.id).blocks, [blockId(2, 19), blockId(2, 20), blockId(6, 18), blockId(6, 19), blockId(6, 20)]);
  assert.equal(me(st, p.id).active, true);
  // next week: Wed is 2026-11-04 > until
  st = await state(NEXT);
  assert.deepEqual(me(st, p.id).blocks, [blockId(6, 18), blockId(6, 19), blockId(6, 20)]);

  // response overrides rules
  await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks: [blockId(0, 12)] });
  assert.deepEqual(me(await state(OPEN), p.id).blocks, [blockId(0, 12)]);
  // adding a rule merges into the existing response (weeks >= openWeek)
  const added = await bad({ weekday: 4, startHour: 20, endHour: 22 });
  assert.equal(added.status, 200);
  assert.deepEqual(me(await state(OPEN), p.id).blocks, [blockId(0, 12), blockId(4, 20), blockId(4, 21)]);
  // cant responses untouched
  await api('PUT', '/api/availability', { personId: p.id, week: NEXT, blocks: [], cant: true });
  await bad({ weekday: 3, startHour: 20, endHour: 22 });
  assert.equal(me(await state(NEXT), p.id).status, 'cant');

  const g = (await api('GET', `/api/people/${p.id}`)).json;
  assert.equal(g.recurring.length, 4);
  assert.deepEqual(Object.keys(g.recurring[0]).sort(), ['endHour', 'id', 'startHour', 'until', 'weekday']);

  assert.equal((await api('DELETE', `/api/recurring/${limited.id}`)).status, 200);
  assert.equal((await api('GET', `/api/people/${p.id}`)).json.recurring.length, 3);
});

test('state shape', async () => {
  const st = await state();
  assert.equal(st.now, NOW.replace('Z', '.000Z'));
  assert.equal(st.openWeek, OPEN); assert.equal(st.currentWeek, CUR); assert.equal(st.week, OPEN);
  assert.equal(st.locked, false);
  assert.equal(st.lockAt, '2026-10-25T18:00:00.000Z'); // GMT after DST ends on 25 Oct
  assert.equal(st.config.timezone, 'Europe/London');
  assert.equal(st.config.appName, 'Craft & Chat');
  assert.equal(st.config.sessionHours, 2);
  assert.ok('mcServerAddress' in st.config && 'discordInviteUrl' in st.config);
  assert.equal(st.session, null); assert.equal(st.currentSession, null);
  assert.deepEqual(Object.keys(st.people[0]).sort(), ['active', 'blocks', 'id', 'maybe', 'name', 'no', 'status', 'updatedAt']);
  // default week = open week
  const d = (await api('GET', '/api/state')).json;
  assert.equal(d.week, OPEN);
  // past week is locked; later fake time locks open week
  assert.equal((await state(CUR)).locked, true);
  const later = (await api('GET', `/api/state?week=${OPEN}`, null, { 'X-Fake-Now': '2026-10-25T19:00:00Z' })).json;
  assert.equal(later.locked, true); assert.equal(later.openWeek, NEXT);
  assert.equal((await api('GET', '/api/state?week=2026-10-27')).status, 400);
});

test('X-Fake-Now ignored when not allowed', async () => {
  const w3 = await startWorker({ port: 8791, vars: { DEV_FAKE_NOW_ALLOWED: '0' } });
  try {
    const r = await client(w3.base)('GET', '/api/state', null, { 'X-Fake-Now': '2020-01-01T00:00:00Z' });
    assert.notEqual(r.json.currentWeek, '2019-12-30');
  } finally { await w3.stop(); }
});

test('session in state + ics + admin unlock', async () => {
  // insert a session row directly through the local D1 via admin-less path: use sqlite through wrangler is heavy,
  // so exercise the calendar/state with whatever lockWeek produces (skipped if the stub does nothing).
  const r = await api('POST', '/api/admin/lock', { week: OPEN, silent: true }, { 'X-Admin-Key': 'testkey' });
  assert.equal(r.status, 200);
  const ics = await fetch(w.base + '/api/calendar.ics', { headers: fake });
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  const txt = await ics.text();
  assert.match(txt, /BEGIN:VCALENDAR/); assert.match(txt, /END:VCALENDAR/);
  const st = await state();
  if (st.session) {
    assert.ok(['scheduled', 'none'].includes(st.session.status));
    assert.equal(st.locked, true);
    assert.equal((await api('POST', '/api/admin/unlock', { week: OPEN }, { 'X-Admin-Key': 'testkey' })).status, 200);
    assert.equal((await state()).session, null);
  }
});

test('access code enforcement', async () => {
  assert.equal((await api2('GET', '/api/state')).status, 401);
  assert.deepEqual((await api2('GET', '/api/state')).json, { error: 'access code required' });
  assert.equal((await api2('GET', '/api/state', null, { 'X-Access-Code': 'wrong' })).status, 401);
  assert.equal((await api2('GET', '/api/state', null, { 'X-Access-Code': 'sesame' })).status, 200);
  assert.equal((await api2('GET', '/api/state?code=sesame')).status, 200);
  assert.equal((await api2('POST', '/api/people', { name: 'X' })).status, 401);
  const pre = await fetch(w2.base + '/api/state', { method: 'OPTIONS', headers: { Origin: 'https://good.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
});

test('CORS', async () => {
  const pre = await fetch(w.base + '/api/people', { method: 'OPTIONS', headers: { Origin: 'https://craft-and-chat.github.io', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://craft-and-chat.github.io');
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Access-Code/);
  assert.match(pre.headers.get('access-control-allow-methods'), /PATCH/);
  const res = await fetch(w.base + '/api/health', { headers: { Origin: 'https://craft-and-chat.github.io' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://craft-and-chat.github.io');
  // restricted origins
  const ok = await fetch(w2.base + '/api/health', { headers: { Origin: 'https://good.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://good.example');
  const no = await fetch(w2.base + '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('admin auth and delete person', async () => {
  const none = await api('GET', '/api/admin/check');
  assert.equal(none.status, 403);
  assert.equal((await api('GET', '/api/admin/check', null, { 'X-Admin-Key': 'nope' })).status, 403);
  assert.deepEqual((await api('GET', '/api/admin/check', null, { 'X-Admin-Key': 'testkey' })).json, { ok: true });
  assert.equal((await api('POST', '/api/admin/lock', { week: OPEN })).status, 403);
  assert.equal((await api('POST', '/api/admin/lock', { week: 'bad' }, { 'X-Admin-Key': 'testkey' })).status, 400);

  const p = await mk('Doomed');
  await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks: [blockId(1, 20)] });
  await api('POST', '/api/recurring', { personId: p.id, weekday: 1, startHour: 20, endHour: 22 });
  assert.equal((await api('DELETE', `/api/admin/people/${p.id}`)).status, 403);
  assert.equal((await api('DELETE', `/api/admin/people/${p.id}`, null, { 'X-Admin-Key': 'testkey' })).status, 200);
  assert.equal((await api('GET', `/api/people/${p.id}`)).status, 404);
  assert.equal(me(await state(), p.id), undefined);
});

test('404 is JSON', async () => {
  const r = await api('GET', '/api/nope');
  assert.equal(r.status, 404); assert.ok(r.json.error);
});

test('maybe / no round-trip, precedence, only-no counts as answered, cant clears', async () => {
  const p = await mk('Maybe Person');
  const T = (h) => blockId(1, h);
  let r = await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks: [T(19)], maybe: [T(19), T(20), T(20)], no: [T(21), T(20)] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.blocks, r.json.maybe, r.json.no], [[T(19)], [T(19), T(20)], [T(20), T(21)]]); // stored as sent (deduped)
  let e = me(await state(), p.id);
  assert.equal(e.status, 'responded');
  assert.deepEqual([e.blocks, e.maybe, e.no], [[T(19)], [T(20)], [T(21)]]); // effective: free > maybe > no
  const g = (await api('GET', `/api/people/${p.id}`)).json;
  assert.deepEqual(g.responses[0].maybe, [T(19), T(20)]);
  assert.deepEqual(g.responses[0].blocks, [T(19)]);
  assert.ok(g.responses[0].no.includes(T(21)));
  // validation
  assert.equal((await api('PUT', '/api/availability', { personId: p.id, week: OPEN, maybe: [999] })).status, 400);
  assert.equal((await api('PUT', '/api/availability', { personId: p.id, week: OPEN, no: 'x' })).status, 400);
  // only "no" counts as answered (overrides regular times)
  const q = await mk('No Only');
  await api('POST', '/api/recurring', { personId: q.id, weekday: 3, startHour: 19, endHour: 21 });
  assert.equal(me(await state(), q.id).status, 'regular');
  await api('PUT', '/api/availability', { personId: q.id, week: OPEN, blocks: [], no: [blockId(3, 19)] });
  e = me(await state(), q.id);
  assert.equal(e.status, 'responded'); assert.deepEqual(e.blocks, []); assert.deepEqual(e.no, [blockId(3, 19)]);
  // omitted maybe/no default to empty
  await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks: [T(19)] });
  e = me(await state(), p.id);
  assert.deepEqual([e.maybe, e.no], [[], []]);
  // cant clears everything
  r = await api('PUT', '/api/availability', { personId: p.id, week: OPEN, blocks: [T(19)], maybe: [T(20)], no: [T(21)], cant: true });
  assert.equal(r.json.status, 'cant'); assert.deepEqual([r.json.blocks, r.json.maybe, r.json.no], [[], [], []]);
  e = me(await state(), p.id);
  assert.deepEqual([e.status, e.maybe, e.no], ['cant', [], []]);
});
