import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../shared/schedule.js';

const cfg = S.parseConfig({});
const cfgLon = cfg;

test('parseConfig defaults and overrides', () => {
  assert.equal(cfg.timezone, 'Europe/London');
  assert.equal(cfg.sessionHours, 2);
  const c = S.parseConfig({ TIMEZONE: 'America/New_York', MIN_PLAYERS: '3', LOCK_HOUR: 'junk' });
  assert.equal(c.timezone, 'America/New_York'); assert.equal(c.minPlayers, 3); assert.equal(c.lockHour, 18);
});

test('week helpers', () => {
  assert.equal(S.weekdayOf('2026-10-19'), 0);
  assert.equal(S.addDays('2026-10-31', 2), '2026-11-02');
  assert.ok(S.isWeekId('2026-10-26')); assert.ok(!S.isWeekId('2026-10-27')); assert.ok(!S.isWeekId('2026-13-01'));
  assert.equal(S.weekStartOf(new Date('2026-10-25T22:30:00Z'), 'Europe/London'), '2026-10-19');
  assert.equal(S.weekStartOf(new Date('2026-10-25T23:30:00Z'), 'Europe/London'), '2026-10-19');
  assert.equal(S.weekStartOf(new Date('2026-10-26T00:30:00Z'), 'Europe/London'), '2026-10-26');
});

test('DST: zonedToUtc and lockTime', () => {
  assert.equal(S.zonedToUtc('2026-10-24', 19, 0, 'Europe/London').toISOString(), '2026-10-24T18:00:00.000Z'); // BST
  assert.equal(S.zonedToUtc('2026-10-26', 19, 0, 'Europe/London').toISOString(), '2026-10-26T19:00:00.000Z'); // GMT
  assert.equal(S.zonedToUtc('2026-03-28', 24, 0, 'Europe/London').toISOString(), '2026-03-29T00:00:00.000Z'); // hour>=24 rolls
  assert.equal(S.lockTime('2026-10-26', cfg).toISOString(), '2026-10-25T18:00:00.000Z');
  assert.equal(S.lockTime('2026-10-19', cfg).toISOString(), '2026-10-18T17:00:00.000Z');
  assert.equal(S.zonedToUtc('2026-06-01', 12, 0, 'America/New_York').toISOString(), '2026-06-01T16:00:00.000Z');
});

test('openWeek / currentWeek / lastLockedWeek', () => {
  const t = (s) => new Date(s);
  assert.equal(S.openWeek(t('2026-10-21T12:00:00Z'), cfg), '2026-10-26');
  assert.equal(S.openWeek(t('2026-10-25T17:59:00Z'), cfg), '2026-10-26');
  assert.equal(S.openWeek(t('2026-10-25T18:00:00Z'), cfg), '2026-11-02');
  assert.equal(S.openWeek(t('2026-10-26T10:00:00Z'), cfg), '2026-11-02');
  assert.equal(S.currentWeek(t('2026-10-21T12:00:00Z'), cfg), '2026-10-19');
  assert.equal(S.lastLockedWeek(t('2026-10-21T12:00:00Z'), cfg), '2026-10-19');
});

test('blocks validity', () => {
  assert.ok(S.isValidBlock(S.blockId(0, 12), cfg));
  assert.ok(!S.isValidBlock(S.blockId(0, 11), cfg));
  assert.ok(!S.isValidBlock(S.blockId(0, 24), cfg));
  assert.ok(!S.isValidBlock(S.blockId(7, 12), cfg));
  assert.ok(!S.isValidBlock(1.5, cfg));
  assert.equal(S.weekBlocks(cfg).length, 7 * 12);
  assert.equal(S.candidateSlots(cfg).length, 7 * 11);
});

test('rulesToBlocks', () => {
  const b = S.rulesToBlocks([
    { weekday: 6, startHour: 18, endHour: 21, until: null },
    { weekday: 2, startHour: 10, endHour: 14, until: null }, // clipped to 12..14
    { weekday: 4, startHour: 19, endHour: 21, until: '2026-10-29' }, // Fri 30 Oct > until
  ], '2026-10-26', cfg);
  assert.deepEqual(b, [S.blockId(2, 12), S.blockId(2, 13), S.blockId(6, 18), S.blockId(6, 19), S.blockId(6, 20)]);
  const inc = S.rulesToBlocks([{ weekday: 4, startHour: 19, endHour: 20, until: '2026-10-30' }], '2026-10-26', cfg);
  assert.deepEqual(inc, [S.blockId(4, 19)]); // until inclusive
});

test('effectiveBlocks', () => {
  const rules = [{ weekday: 0, startHour: 18, endHour: 20, until: null }];
  assert.deepEqual(S.effectiveBlocks(null, rules, '2026-10-26', cfg), { status: 'regular', blocks: [S.blockId(0, 18), S.blockId(0, 19)] });
  assert.deepEqual(S.effectiveBlocks(null, [], '2026-10-26', cfg), { status: 'waiting', blocks: [] });
  assert.deepEqual(S.effectiveBlocks({ cant: true, blocks: [] }, rules, '2026-10-26', cfg), { status: 'cant', blocks: [] });
  const r = S.effectiveBlocks({ cant: false, blocks: [S.blockId(1, 20), 3] }, rules, '2026-10-26', cfg);
  assert.equal(r.status, 'responded'); assert.deepEqual(r.blocks, [S.blockId(1, 20)]);
  assert.equal(S.effectiveBlocks({ cant: false, blocks: [] }, rules, '2026-10-26', cfg).status, 'responded');
});

const sat = (h) => S.blockId(5, h);
const people = [
  { id: 1, name: 'A', blocks: [sat(19), sat(20), sat(21)] },
  { id: 2, name: 'B', blocks: [sat(19), sat(20)] },
  { id: 3, name: 'C', blocks: [sat(20), sat(21), S.blockId(1, 15), S.blockId(1, 16)] },
  { id: 4, name: 'D', blocks: [] },
];

test('rankSlots ordering, partial, excludeId, notBefore', () => {
  const r = S.rankSlots(people, '2026-10-26', cfg);
  assert.equal(r[0].day, 5); assert.equal(r[0].hour, 19);
  assert.deepEqual(r[0].available.map((p) => p.id), [1, 2]);
  assert.deepEqual(r[0].partial.map((p) => p.id), [3]);
  assert.equal(r[0].start.toISOString(), '2026-10-31T19:00:00.000Z'); // GMT after 25 Oct
  // 20-22: A (20,21 yes), C (20,21 yes), B only 20 -> partial
  const s20 = r.find((s) => s.day === 5 && s.hour === 20);
  assert.deepEqual(s20.available.map((p) => p.id), [1, 3]); assert.deepEqual(s20.partial.map((p) => p.id), [2]);
  assert.equal(S.rankSlots(people, '2026-10-26', cfg, { excludeId: 1 })[0].available.length, 1);
  const nb = S.rankSlots(people, '2026-10-26', cfg, { notBefore: new Date('2026-10-31T19:30:00Z') });
  assert.ok(nb.every((s) => s.start >= new Date('2026-10-31T19:30:00Z')));
  assert.ok(!nb.some((s) => s.day === 5 && s.hour === 19));
});

test('pickSession and quickPicks', () => {
  const r = S.rankSlots(people, '2026-10-26', cfg);
  const pick = S.pickSession(r, cfg);
  assert.equal(pick.day, 5); assert.equal(pick.hour, 19);
  assert.equal(S.pickSession(S.rankSlots([people[0]], '2026-10-26', cfg), cfg), null); // < minPlayers
  const qp = S.quickPicks(r, cfg, 5);
  assert.ok(qp.length >= 1);
  for (let i = 0; i < qp.length; i++) for (let j = i + 1; j < qp.length; j++)
    assert.ok(!(qp[i].day === qp[j].day && Math.abs(qp[i].hour - qp[j].hour) < cfg.sessionHours));
  assert.ok(qp.every((s) => s.available.length > 0));
  assert.equal(S.quickPicks(r, cfg, 1).length, 1);
});

test('formatting', () => {
  assert.equal(S.formatWeek('2026-10-26'), '26 Oct – 1 Nov');
  assert.equal(S.formatSlot('2026-10-26', { day: 5, hour: 19 }, cfg), 'Sat 31 Oct · 19:00–21:00');
  assert.equal(S.formatHour(24), '00:00');
  const u = S.googleCalendarUrl({ start: new Date('2026-10-31T19:00:00Z'), end: new Date('2026-10-31T21:00:00Z'), title: 'MC' });
  assert.ok(u.includes('20261031T190000Z%2F20261031T210000Z'));
});
