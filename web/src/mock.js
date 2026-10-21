// In-browser fake of the Worker API (same contract as docs/DESIGN.md). Data lives in localStorage.
import {
  parseConfig, openWeek, currentWeek, lockTime, addDays, isWeekId, isValidBlock, blockId,
  effectiveBlocks, rulesToBlocks, rankSlots, pickSession, formatSlot,
} from '../../shared/schedule.js';
import { getNow } from './clock.js';

const KEY = 'mcs_mock_db_v1';
export const MOCK_ADMIN_KEY = 'admin';
const qs = () => new URLSearchParams(location.search);
const cfgOf = () => {
  const empty = qs().has('empty');
  return {
    ...parseConfig({}),
    appName: 'Craft & Chat',
    mcServerAddress: empty ? '' : 'play.example.net',
    discordInviteUrl: empty ? '' : 'https://discord.gg/example',
  };
};
const run = (day, from, to) => { const o = []; for (let h = from; h < to; h++) o.push(blockId(day, h)); return o; };
const iso = (d) => d.toISOString();

function seed() {
  const cfg = cfgOf(), now = getNow();
  const ow = openWeek(now, cfg), cw = currentWeek(now, cfg), pw = addDays(cw, -7);
  const stamp = iso(now);
  const people = ['Alex', 'Sam', 'Jo', 'Priya', 'Dan', 'Lee', 'Kai'].map((name, i) => ({ id: i + 1, name }));
  const R = (personId, week, blocks, cant = false) => ({ personId, week, blocks, cant, updatedAt: stamp });
  const responses = [
    R(1, ow, [...run(4, 19, 24), ...run(5, 18, 23)]),
    R(2, ow, [...run(5, 19, 24), ...run(6, 14, 20)]),
    R(4, ow, [...run(3, 19, 22), ...run(4, 20, 24), ...run(5, 17, 22)]),
    R(5, ow, [], true),
    R(7, ow, [...run(5, 19, 22), ...run(6, 15, 21)]),
    R(1, cw, run(5, 19, 23)), R(2, cw, run(5, 19, 23)), R(4, cw, run(5, 18, 23)),
    R(1, pw, run(5, 18, 22)), R(2, pw, run(6, 15, 20)),
  ];
  const rules = [
    { id: 1, personId: 3, weekday: 2, startHour: 19, endHour: 23, until: null },
    { id: 2, personId: 3, weekday: 5, startHour: 18, endHour: 22, until: null },
  ];
  return { people, responses, rules, sessions: {}, nextId: 20, nextRule: 10 };
}

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!db) { db = seed(); persist(); }
  return db;
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} }

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m, s = 400) => new HttpError(s, m);

function weekData(week, cfg, now) {
  const d = load();
  const cw = currentWeek(now, cfg);
  const people = d.people.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const resp = d.responses.find((r) => r.personId === p.id && r.week === week) || null;
    const rules = d.rules.filter((r) => r.personId === p.id);
    const eff = effectiveBlocks(resp, rules, week, cfg);
    const active = rules.length > 0 || d.responses.some((r) => r.personId === p.id && r.week >= addDays(cw, -42));
    return { id: p.id, name: p.name, status: eff.status, blocks: eff.blocks, updatedAt: resp ? resp.updatedAt : null, active };
  });
  return people;
}

const mkSession = (week, top, cfg) => top ? {
  week, status: 'scheduled', day: top.day, hour: top.hour, start: iso(top.start), end: iso(top.end),
  attendees: top.available.map((a) => a.name), label: formatSlot(week, top, cfg),
} : { week, status: 'none' };

function sessionFor(week, cfg, now, people) {
  const d = load();
  if (week in d.sessions) return d.sessions[week];
  if (lockTime(week, cfg) > now) return null;
  return mkSession(week, pickSession(rankSlots(people, week, cfg), cfg), cfg);
}

function mergeRuleIntoResponses(personId, rule, cfg, ow) {
  const d = load();
  for (const r of d.responses) {
    if (r.personId !== personId || r.cant || r.week < ow) continue;
    const add = rulesToBlocks([rule], r.week, cfg);
    r.blocks = [...new Set([...r.blocks, ...add])].sort((a, b) => a - b);
  }
}

export async function mockRequest(method, path, query, body, headers) {
  await new Promise((r) => setTimeout(r, 40));
  const d = load();
  const cfg = cfgOf(), now = getNow();
  const ow = openWeek(now, cfg), cw = currentWeek(now, cfg);
  let m;

  if (method === 'GET' && path === '/api/health') return { ok: true };

  if (method === 'GET' && path === '/api/state') {
    const week = query.get('week') || ow;
    if (!isWeekId(week)) throw bad('bad week');
    const people = weekData(week, cfg, now);
    return {
      now: iso(now), openWeek: ow, currentWeek: cw, week, lockAt: iso(lockTime(week, cfg)),
      locked: lockTime(week, cfg) <= now, config: cfg, people,
      session: sessionFor(week, cfg, now, people),
      currentSession: sessionFor(cw, cfg, now, weekData(cw, cfg, now)),
    };
  }

  if (method === 'POST' && path === '/api/people') {
    const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 40) throw bad('name must be 1-40 characters');
    const ex = d.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (ex) return { id: ex.id, name: ex.name, created: false };
    const p = { id: d.nextId++, name }; d.people.push(p); persist();
    return { id: p.id, name: p.name, created: true };
  }

  if ((m = path.match(/^\/api\/people\/(\d+)$/))) {
    const p = d.people.find((x) => x.id === Number(m[1]));
    if (!p) throw bad('not found', 404);
    if (method === 'PATCH') {
      const name = String(body?.name || '').trim().replace(/\s+/g, ' ');
      if (!name || name.length > 40) throw bad('name must be 1-40 characters');
      if (d.people.some((x) => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase())) throw bad('name taken', 409);
      p.name = name; persist(); return { id: p.id, name };
    }
    if (method === 'GET') {
      return {
        id: p.id, name: p.name,
        recurring: d.rules.filter((r) => r.personId === p.id).map(({ personId, ...r }) => r),
        responses: d.responses.filter((r) => r.personId === p.id && r.week >= addDays(cw, -56))
          .sort((a, b) => (a.week < b.week ? 1 : -1)).map(({ personId, ...r }) => r),
      };
    }
  }

  if (method === 'PUT' && path === '/api/availability') {
    const { personId, week, cant } = body || {};
    if (!d.people.some((p) => p.id === personId)) throw bad('unknown person', 404);
    if (!isWeekId(week) || week < cw || week > addDays(ow, 56)) throw bad('week out of range');
    let blocks = Array.isArray(body.blocks) ? body.blocks : [];
    if (!blocks.every((b) => isValidBlock(b, cfg)) || blocks.length > 210) throw bad('bad blocks');
    blocks = cant ? [] : [...new Set(blocks)].sort((a, b) => a - b);
    const rec = { personId, week, blocks, cant: !!cant, updatedAt: iso(now) };
    const i = d.responses.findIndex((r) => r.personId === personId && r.week === week);
    if (i >= 0) d.responses[i] = rec; else d.responses.push(rec);
    persist();
    return { ok: true, status: cant ? 'cant' : 'responded', blocks };
  }

  if (method === 'DELETE' && path === '/api/availability') {
    const pid = Number(query.get('personId')), week = query.get('week');
    d.responses = d.responses.filter((r) => !(r.personId === pid && r.week === week));
    persist(); return { ok: true };
  }

  if (method === 'POST' && path === '/api/recurring') {
    const { personId, weekday, startHour, endHour, until = null } = body || {};
    if (!d.people.some((p) => p.id === personId)) throw bad('unknown person', 404);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw bad('bad weekday');
    if (!(startHour >= cfg.dayStartHour && endHour <= cfg.dayEndHour && startHour < endHour)) throw bad('bad hours');
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw bad('bad until');
    const rule = { id: d.nextRule++, personId, weekday, startHour, endHour, until: until || null };
    d.rules.push(rule);
    mergeRuleIntoResponses(personId, rule, cfg, ow);
    persist();
    const { personId: _p, ...out } = rule; return out;
  }

  if ((m = path.match(/^\/api\/recurring\/(\d+)$/)) && method === 'DELETE') {
    d.rules = d.rules.filter((r) => r.id !== Number(m[1])); persist(); return { ok: true };
  }

  if (path.startsWith('/api/admin/')) {
    if (headers['X-Admin-Key'] !== MOCK_ADMIN_KEY) throw bad('forbidden', 403);
    if (path === '/api/admin/check') return { ok: true };
    if (path === '/api/admin/lock') {
      const week = body?.week;
      const people = weekData(week, cfg, now);
      d.sessions[week] = mkSession(week, pickSession(rankSlots(people, week, cfg, { notBefore: now }), cfg), cfg);
      persist(); return { ok: true };
    }
    if (path === '/api/admin/unlock') { d.sessions[body?.week] = null; persist(); return { ok: true }; }
    if (path === '/api/admin/announce' || path === '/api/admin/test-discord') {
      console.log('[mock] discord', path, body); return { ok: true };
    }
    if ((m = path.match(/^\/api\/admin\/people\/(\d+)$/)) && method === 'DELETE') {
      const id = Number(m[1]);
      d.people = d.people.filter((p) => p.id !== id);
      d.responses = d.responses.filter((r) => r.personId !== id);
      d.rules = d.rules.filter((r) => r.personId !== id);
      persist(); return { ok: true };
    }
  }

  throw bad('not found', 404);
}
