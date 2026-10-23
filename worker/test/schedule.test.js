import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../shared/schedule.js';
const { parseConfig, effectiveBlocks, isValidBlock } = S;

const cfg = S.parseConfig({ DAY_START_HOUR: '12' }); // pre-existing tests were written for a 12:00 start
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
  assert.deepEqual(S.effectiveBlocks(null, rules, '2026-10-26', cfg), { status: 'regular', blocks: [S.blockId(0, 18), S.blockId(0, 19)], maybe: [], no: [] });
  assert.deepEqual(S.effectiveBlocks(null, [], '2026-10-26', cfg), { status: 'waiting', blocks: [], maybe: [], no: [] });
  assert.deepEqual(S.effectiveBlocks({ cant: true, blocks: [] }, rules, '2026-10-26', cfg), { status: 'cant', blocks: [], maybe: [], no: [] });
  const r = S.effectiveBlocks({ cant: false, blocks: [S.blockId(1, 20), 3] }, rules, '2026-10-26', cfg);
  assert.equal(r.status, 'responded'); assert.deepEqual(r.blocks, [S.blockId(1, 20)]);
  assert.equal(S.effectiveBlocks({ cant: false, blocks: [] }, rules, '2026-10-26', cfg).status, 'regular'); // empty answer = not answered → regular times apply
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

test('empty response (not cant) counts as not answered and falls back to regular times', () => {
  const cfg = parseConfig({});
  const w = '2026-10-26';
  assert.equal(effectiveBlocks({ blocks: [], cant: false }, [], w, cfg).status, 'waiting');
  const r = effectiveBlocks({ blocks: [], cant: false }, [{ weekday: 6, startHour: 17, endHour: 19, until: null }], w, cfg);
  assert.equal(r.status, 'regular');
  assert.equal(r.blocks.length, 2);
  assert.equal(effectiveBlocks({ blocks: [], cant: true }, [], w, cfg).status, 'cant');
  assert.ok(isValidBlock(5 * 32 + 9, cfg), 'mornings are bookable');
});

// ---------- maybe / no / full house ----------
const { blockId: B } = S;
const W = '2026-10-26';
const slotBlocks = (day, h) => [B(day, h), B(day, h + 1)];
const person = (id, name, o = {}) => ({ id, name, status: 'responded', blocks: [], maybe: [], no: [], ...o });

test('rankSlots: maybe ordering (available > maybe > partial)', () => {
  const cfg = S.parseConfig({ DAY_START_HOUR: '12' });
  const people = [
    person(1, 'A', { blocks: [...slotBlocks(1, 19), ...slotBlocks(2, 19)] }),
    person(2, 'B', { blocks: slotBlocks(1, 19), maybe: slotBlocks(2, 19) }),
    person(3, 'C', { blocks: [B(1, 19)], maybe: [B(1, 20)] }), // free+maybe mix => maybe for Tue
    person(4, 'D', { blocks: [B(2, 19)] }), // partial for Wed
  ];
  const r = S.rankSlots(people, W, cfg);
  const tue = r.find((s) => s.day === 1 && s.hour === 19), wed = r.find((s) => s.day === 2 && s.hour === 19);
  assert.deepEqual(tue.available.map((p) => p.id), [1, 2]);
  assert.deepEqual(tue.maybe.map((p) => p.id), [3]);
  assert.deepEqual(wed.available.map((p) => p.id), [1]);
  assert.deepEqual(wed.maybe.map((p) => p.id), [2]);
  assert.deepEqual(wed.partial.map((p) => p.id), [4]);
  assert.equal(r[0].day, 1); assert.equal(r[1].day, 2);
  // equal availability: more maybes wins
  const r2 = S.rankSlots([person(1, 'A', { blocks: slotBlocks(3, 15) }), person(2, 'B', { maybe: slotBlocks(3, 15) }), person(3, 'C', { blocks: slotBlocks(4, 15) })], W, cfg);
  assert.equal(r2[0].day, 3);
});

test('effectiveBlocks: maybe ignored, free beats no, and only-no counts as answered', () => {
  const cfg = S.parseConfig({ DAY_START_HOUR: '12' });
  const e = S.effectiveBlocks({ blocks: [B(1, 19)], maybe: [B(1, 19), B(1, 20)], no: [B(1, 19), B(1, 20), B(1, 21)] }, [], W, cfg);
  assert.deepEqual([e.blocks, e.maybe, e.no], [[B(1, 19)], [], [B(1, 20), B(1, 21)]]);
  const o = S.effectiveBlocks({ blocks: [], maybe: [], no: [B(1, 19)] }, [{ weekday: 6, startHour: 17, endHour: 19, until: null }], W, cfg);
  assert.equal(o.status, 'responded'); assert.deepEqual(o.blocks, []);
});

test('fullHouseNudges: the 6-person example', () => {
  const cfg9 = S.parseConfig({}); // dayStartHour 0 so 09:00 is bookable
  const TUE = slotBlocks(1, 9), WED = slotBlocks(2, 9);
  const people = [
    person(1, 'Matt', { blocks: TUE }),
    person(2, 'P2', { blocks: [...TUE, ...WED] }), person(3, 'P3', { blocks: [...TUE, ...WED] }),
    person(4, 'P4', { blocks: [...TUE, ...WED] }), person(5, 'P5', { blocks: [...TUE, ...WED] }),
    person(6, 'Elsie', { blocks: WED }),
  ];
  // Everyone in P2..P5 can do both; Matt only Tue; Elsie only Wed.
  const forElsie = S.fullHouseNudges(6, people, W, cfg9);
  assert.equal(forElsie.length, 1);
  assert.equal(forElsie[0].day, 1); assert.equal(forElsie[0].hour, 9);
  assert.deepEqual(forElsie[0].othersMissing, []); assert.deepEqual(forElsie[0].missing.map((p) => p.name), ['Elsie']);
  assert.equal(forElsie[0].total, 6); assert.equal(forElsie[0].meMaybe, false);
  const forMatt = S.fullHouseNudges(1, people, W, cfg9);
  assert.deepEqual(forMatt.map((n) => [n.day, n.hour]), [[2, 9]]);
  assert.deepEqual(forMatt[0].othersMissing, []);
  for (const id of [2, 3, 4, 5]) assert.deepEqual(S.fullHouseNudges(id, people, W, cfg9), []);
  // 2 missing: Zed free Thu only; Elsie nudged for Tue? Tue missing = Elsie+Zed => othersMissing [Zed]
  const withZed = [...people.map((p) => ({ ...p })), person(7, 'Zed', { blocks: slotBlocks(3, 9) })];
  const z = S.fullHouseNudges(6, withZed, W, cfg9);
  assert.ok(z.length === 0 || z.every((x) => x.othersMissing.length <= 1));
  const fixed = people.map((p) => (p.id === 1 ? { ...p, blocks: [...TUE, ...WED] } : p));
  assert.deepEqual(S.fullHouseNudges(6, fixed, W, cfg9), []);   // Wed already full house
  const onlyMe = fixed.map((p) => (p.id === 6 ? { ...p, blocks: [B(3, 10)] } : p));
  const n = S.fullHouseNudges(6, onlyMe, W, cfg9);
  assert.ok(n.length >= 1); assert.equal(n[0].othersMissing.length, 0);
});

test('fullHouseNudges: no suppresses, maybe flagged, notBefore skips past', () => {
  const cfg9 = S.parseConfig({});
  const TUE = slotBlocks(1, 9);
  const base = [person(1, 'Matt', { blocks: TUE }), person(2, 'Bo', { blocks: TUE }), person(3, 'Elsie', { blocks: slotBlocks(2, 9) })];
  assert.equal(S.fullHouseNudges(3, base, W, cfg9).length, 1);
  // Elsie said definitely not to one hour => no nudge for her
  const noEl = base.map((p) => (p.id === 3 ? { ...p, no: [B(1, 10)] } : p));
  assert.deepEqual(S.fullHouseNudges(3, noEl, W, cfg9), []);
  // another missing person said no => suppressed
  const two = [...base, person(4, 'Zed', { blocks: slotBlocks(4, 20), no: [B(1, 9)] })];
  assert.deepEqual(S.fullHouseNudges(3, two, W, cfg9).filter((n) => n.day === 1), []);
  // maybe => meMaybe
  const mb = base.map((p) => (p.id === 3 ? { ...p, maybe: TUE } : p));
  const n = S.fullHouseNudges(3, mb, W, cfg9);
  assert.equal(n[0].meMaybe, true);
  // existing full house => none
  const full = base.map((p) => (p.id === 3 ? { ...p, blocks: [...p.blocks, ...TUE] } : p));
  assert.deepEqual(S.fullHouseNudges(3, full, W, cfg9), []);
  // slot in the past is skipped
  assert.deepEqual(S.fullHouseNudges(3, base, W, cfg9, { notBefore: new Date('2026-10-28T00:00:00Z') }), []);
  // too many missing
  const many = [person(1, 'A', { blocks: TUE }), person(2, 'B', { blocks: slotBlocks(2, 9) }), person(3, 'C', { blocks: slotBlocks(3, 9) }), person(4, 'Me', { blocks: slotBlocks(4, 9) })];
  assert.deepEqual(S.fullHouseNudges(4, many, W, cfg9), []);
});

test('discord lock message lists every session', async () => {
  const { buildLock } = await import('../src/discord.js');
  const mk = (label, attendees) => ({ status: 'scheduled', label, start: '2026-10-27T19:00:00Z', end: '2026-10-27T21:00:00Z', attendees, week: '2026-10-26' });
  const sessions = [mk('Tue 27 Oct · 19:00–21:00', ['A', 'B']), mk('Thu 29 Oct · 19:00–21:00', ['C', 'D', 'E'])];
  const d = (cov) => buildLock({ env: {}, weekLabel: 'x', sessions, coverage: cov }).embeds[0].description;
  const all = d({ total: 5, covered: 5, left: [] });
  assert.ok(all.includes('Tue 27 Oct') && all.includes('Thu 29 Oct') && all.includes('(2)') && all.includes('(3)'));
  assert.equal((all.match(/calendar\.google\.com/g) || []).length, 2);
  assert.ok(all.includes('Everyone gets to play at least once ✓'));
  assert.ok(d({ total: 6, covered: 5, left: ['Zed'] }).includes('5 of 6 who answered can play'));
  assert.ok(d({ total: 6, covered: 5, left: ['Zed'] }).includes('Zed'));
});

// ---------- multi-session ----------
const WK = '2026-10-26';
const cfgS = S.parseConfig({ DAY_START_HOUR: '12', SESSIONS_PER_WEEK: '2' });
const slotAt = (day, h) => [day * 32 + h, day * 32 + h + 1];
const ppl = (id, name, blocks, extra = {}) => ({ id, name, status: 'responded', blocks, maybe: [], no: [], ...extra });
const names = (arr) => arr.map((s) => `${s.day}@${s.hour}`);

test('parseConfig sessionsPerWeek default and clamp', () => {
  assert.equal(S.parseConfig({}).sessionsPerWeek, 2);
  assert.equal(S.parseConfig({ SESSIONS_PER_WEEK: '9' }).sessionsPerWeek, 3);
  assert.equal(S.parseConfig({ SESSIONS_PER_WEEK: '0' }).sessionsPerWeek, 1);
});

test('pickSessions: a pair covering everyone beats the most popular single slot', () => {
  // Tue: A B C ; Thu: D E ; Sat: A B C D (most popular single slot, but E is never covered with it)
  const people = [
    ppl(1, 'A', [...slotAt(1, 19), ...slotAt(5, 19)]), ppl(2, 'B', [...slotAt(1, 19), ...slotAt(5, 19)]),
    ppl(3, 'C', [...slotAt(1, 19), ...slotAt(5, 19)]), ppl(4, 'D', [...slotAt(3, 19), ...slotAt(5, 19)]),
    ppl(5, 'E', slotAt(3, 19)),
  ];
  const r = S.rankSlots(people, WK, cfgS);
  assert.deepEqual(names([S.pickSession(r, cfgS)]), ['5@19']); // old behaviour: Sat alone leaves E out
  const two = S.pickSessions(r, cfgS);
  assert.equal(two.length, 2);
  assert.deepEqual(names(two), ['3@19', '5@19']); // chronological, Thu adds E to the popular Sat
  const covered = new Set(two.flatMap((s) => s.available.map((p) => p.id)));
  assert.equal(covered.size, 5);
  assert.notEqual(two[0].day, two[1].day);
});

test('pickSessions: always different days, k=1 like before, below minPlayers -> []', () => {
  const people = [ppl(1, 'A', [...slotAt(2, 18), ...slotAt(2, 20)]), ppl(2, 'B', [...slotAt(2, 18), ...slotAt(2, 20)])];
  const r = S.rankSlots(people, WK, cfgS);
  const p = S.pickSessions(r, cfgS);
  assert.equal(p.length, 1); // only one day has anyone
  assert.equal(S.pickSessions(r, cfgS, 1)[0], r[0]);
  const one = S.parseConfig({ DAY_START_HOUR: '12', SESSIONS_PER_WEEK: '1' });
  assert.deepEqual(S.pickSessions(S.rankSlots(people, WK, one), one).map((s) => s.day), [2]);
  assert.deepEqual(S.pickSessions(S.rankSlots([people[0]], WK, cfgS), cfgS), []);
  assert.deepEqual(S.pickSessions([], cfgS), []);
});

test('coverageNudges basics', () => {
  const people = [
    ppl(1, 'A', [...slotAt(1, 19), ...slotAt(3, 19)]), ppl(2, 'B', [...slotAt(1, 19), ...slotAt(3, 19)]),
    ppl(3, 'C', [...slotAt(1, 19), ...slotAt(3, 19)]), ppl(4, 'D', slotAt(5, 12)),
  ];
  // D answered but plays in neither planned session
  const n = S.coverageNudges(4, people, WK, cfgS);
  assert.equal(n.length, 2);
  assert.deepEqual(names(n), ['1@19', '3@19']);
  assert.equal(n[0].total, 4); assert.equal(n[0].covered, 3); assert.deepEqual(n[0].notCovered.map((p) => p.name), ['D']);
  // someone covered gets nothing
  assert.deepEqual(S.coverageNudges(1, people, WK, cfgS), []);
  // "definitely not" hides that session
  const no = people.map((p) => (p.id === 4 ? { ...p, no: [1 * 32 + 20] } : p));
  assert.deepEqual(names(S.coverageNudges(4, no, WK, cfgS)), ['3@19']);
  // unanswered viewer gets nothing
  assert.deepEqual(S.coverageNudges(9, people, WK, cfgS), []);
  assert.deepEqual(S.coverageNudges(4, people.map((p) => (p.id === 4 ? { ...p, status: 'waiting', blocks: [] } : p)), WK, cfgS), []);
});
