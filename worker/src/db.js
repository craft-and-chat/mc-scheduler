import {
  parseConfig, rulesToBlocks, effectiveBlocks, addDays, formatSlot,
} from '../../shared/schedule.js';

export const normName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const nameKey = (s) => normName(s).toLowerCase();

export async function getPeople(env) {
  const { results } = await env.DB.prepare('SELECT id, name FROM people ORDER BY name COLLATE NOCASE').all();
  return results;
}

export async function getPerson(env, id) {
  return env.DB.prepare('SELECT id, name FROM people WHERE id = ?').bind(id).first();
}

const ruleOut = (r) => ({ id: r.id, personId: r.person_id, weekday: r.weekday, startHour: r.start_hour, endHour: r.end_hour, until: r.until });

export async function getRules(env, personId) {
  const stmt = personId == null
    ? env.DB.prepare('SELECT * FROM recurring ORDER BY id')
    : env.DB.prepare('SELECT * FROM recurring WHERE person_id = ? ORDER BY weekday, start_hour').bind(personId);
  const { results } = await stmt.all();
  return results.map(ruleOut);
}

export async function getResponses(env, week) {
  const { results } = await env.DB.prepare('SELECT person_id, week, blocks, maybe, no, cant, updated_at FROM responses WHERE week = ?').bind(week).all();
  return results.map(parseResp);
}

export function parseResp(r) {
  const list = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const blocks = list(r.blocks), maybe = list(r.maybe), no = list(r.no);
  return { personId: r.person_id, week: r.week, blocks, maybe, no, cant: !!r.cant, updatedAt: toIso(r.updated_at) };
}

// SQLite datetime('now') -> ISO
export function toIso(s) {
  if (!s) return null;
  return /Z|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
}

export function formatSession(row, cfg) {
  if (!row) return null;
  const attendees = typeof row.attendees === 'string' ? JSON.parse(row.attendees || '[]') : (row.attendees || []);
  const out = {
    week: row.week, status: row.status, day: row.day ?? null, hour: row.hour ?? null,
    start: row.start_utc ?? null, end: row.end_utc ?? null, attendees,
    label: row.status === 'scheduled' && row.day != null ? formatSlot(row.week, { day: row.day, hour: row.hour }, cfg) : 'No session',
    discordEventId: row.discord_event_id ?? null,
  };
  return out;
}

export async function getSessions(env, week) {
  const { results } = await env.DB.prepare('SELECT * FROM week_sessions WHERE week = ? ORDER BY idx').bind(week).all();
  return results;
}

// Replace all session rows of a week. rows: [{ status, day, hour, start_utc, end_utc, attendees, discord_event_id }]
export async function saveSessions(env, week, rows) {
  const stmts = [env.DB.prepare('DELETE FROM week_sessions WHERE week = ?').bind(week)];
  rows.forEach((s, idx) => {
    const attendees = typeof s.attendees === 'string' ? s.attendees : JSON.stringify(s.attendees || []);
    stmts.push(env.DB.prepare(
      `INSERT INTO week_sessions (week, idx, status, day, hour, start_utc, end_utc, attendees, locked_at, discord_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    ).bind(week, idx, s.status, s.day ?? null, s.hour ?? null, s.start_utc ?? null, s.end_utc ?? null, attendees, s.discord_event_id ?? null));
  });
  await env.DB.batch(stmts);
}

export async function deleteSessions(env, week) {
  await env.DB.prepare('DELETE FROM week_sessions WHERE week = ?').bind(week).run();
}

export async function markSent(env, key) {
  const r = await env.DB.prepare('INSERT OR IGNORE INTO sent_events (key) VALUES (?)').bind(key).run();
  return (r.meta?.changes ?? 0) > 0; // true if newly marked
}

export async function wasSent(env, key) {
  return !!(await env.DB.prepare('SELECT 1 AS x FROM sent_events WHERE key = ?').bind(key).first());
}

// { cfg, people:[{id,name,status,blocks,updatedAt,active}], sessions: [], session (= sessions[0] | null) }
export async function getWeekState(env, week, now) {
  const cfg = parseConfig(env);
  const [people, rules, resps, activeRows, sessRows] = await Promise.all([
    getPeople(env),
    getRules(env),
    getResponses(env, week),
    env.DB.prepare('SELECT DISTINCT person_id FROM responses WHERE week >= ? AND week <= ?').bind(addDays(week, -42), week).all(),
    getSessions(env, week),
  ]);
  const respBy = new Map(resps.map((r) => [r.personId, r]));
  const rulesBy = new Map();
  for (const r of rules) {
    if (!rulesBy.has(r.personId)) rulesBy.set(r.personId, []);
    rulesBy.get(r.personId).push(r);
  }
  const active = new Set(activeRows.results.map((r) => r.person_id));
  for (const id of rulesBy.keys()) active.add(id);
  const out = people.map((p) => {
    const resp = respBy.get(p.id) || null;
    const eff = effectiveBlocks(resp, rulesBy.get(p.id) || [], week, cfg);
    return { id: p.id, name: p.name, status: eff.status, blocks: eff.blocks, maybe: eff.maybe, no: eff.no, updatedAt: resp ? resp.updatedAt : null, active: active.has(p.id) };
  });
  const sessions = sessRows.map((r) => formatSession(r, cfg));
  return { cfg, people: out, sessions, session: sessions[0] || null };
}

export { rulesToBlocks };
