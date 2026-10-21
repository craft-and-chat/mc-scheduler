import {
  parseConfig, isWeekId, addDays, openWeek, currentWeek, lockTime, isValidBlock, rulesToBlocks,
  rankSlots, zonedParts, formatSlot,
} from '../../shared/schedule.js';
import {
  getPerson, getRules, getWeekState, getSession, deleteSession, formatSession, normName, nameKey, parseResp, toIso,
} from './db.js';
import { runScheduled, lockWeek, announce, unlockWeek } from './cron.js';
import { postDiscord } from './discord.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes('*')) h['Access-Control-Allow-Origin'] = origin || '*';
  else if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getNow(request, env) {
  if (env.DEV_FAKE_NOW_ALLOWED === '1') {
    const f = request.headers.get('X-Fake-Now');
    if (f) {
      const d = new Date(f);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return new Date();
}

async function body(request) {
  try {
    const b = await request.json();
    if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  } catch { /* fallthrough */ }
  throw bad('invalid JSON body');
}

const toInt = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN);

function requireAdmin(request, env) {
  if (!env.ADMIN_KEY) throw new HttpError(403, 'admin not configured');
  if (request.headers.get('X-Admin-Key') !== env.ADMIN_KEY) throw new HttpError(403, 'bad admin key');
}

function validName(raw) {
  const name = normName(raw);
  if (name.length < 1 || name.length > 40) throw bad('name must be 1-40 characters');
  return name;
}

function weekParam(v, cfg, now, fallback) {
  if (v == null || v === '') return fallback;
  if (!isWeekId(v)) throw bad('invalid week');
  return v;
}

async function handle(request, env, url, now) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  const cfg = parseConfig(env);
  const oWeek = openWeek(now, cfg);
  const cWeek = currentWeek(now, cfg);

  if (path === '/api/health') return json({ ok: true });

  // dev-only: drive the cron with a fake clock
  if (path === '/api/dev/run-scheduled' && method === 'POST' && env.DEV_FAKE_NOW_ALLOWED === '1') {
    const n = new Date(url.searchParams.get('now') || now);
    if (Number.isNaN(n.getTime())) throw bad('invalid now');
    return json({ ok: true, log: await runScheduled(env, n) });
  }

  let m;
  // ---------- public ----------
  if (path === '/api/state' && method === 'GET') {
    const week = weekParam(url.searchParams.get('week'), cfg, now, oWeek);
    const st = await getWeekState(env, week, now);
    const lockAt = lockTime(week, cfg);
    const cur = week === cWeek ? st.session : formatSession(await getSession(env, cWeek), cfg);
    return json({
      now: now.toISOString(), openWeek: oWeek, currentWeek: cWeek, week,
      lockAt: lockAt.toISOString(), locked: lockAt <= now || !!st.session,
      config: { ...cfg, appName: env.APP_NAME || 'Craft & Chat', mcServerAddress: env.MC_SERVER_ADDRESS || '', discordInviteUrl: env.DISCORD_INVITE_URL || '' },
      people: st.people, session: st.session, currentSession: cur,
    });
  }

  if (path === '/api/people' && method === 'POST') {
    const name = validName((await body(request)).name);
    const key = nameKey(name);
    const existing = await env.DB.prepare('SELECT id, name FROM people WHERE name_key = ?').bind(key).first();
    if (existing) return json({ id: existing.id, name: existing.name, created: false });
    try {
      const r = await env.DB.prepare('INSERT INTO people (name, name_key) VALUES (?, ?)').bind(name, key).run();
      return json({ id: r.meta.last_row_id, name, created: true });
    } catch {
      const e = await env.DB.prepare('SELECT id, name FROM people WHERE name_key = ?').bind(key).first();
      if (e) return json({ id: e.id, name: e.name, created: false });
      throw new HttpError(500, 'could not create person');
    }
  }

  if ((m = path.match(/^\/api\/people\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const name = validName((await body(request)).name);
      if (!(await getPerson(env, id))) throw new HttpError(404, 'person not found');
      const key = nameKey(name);
      const other = await env.DB.prepare('SELECT id FROM people WHERE name_key = ? AND id != ?').bind(key, id).first();
      if (other) throw new HttpError(409, 'name already taken');
      await env.DB.prepare('UPDATE people SET name = ?, name_key = ? WHERE id = ?').bind(name, key, id).run();
      return json({ id, name });
    }
    if (method === 'GET') {
      const p = await getPerson(env, id);
      if (!p) throw new HttpError(404, 'person not found');
      const rules = await getRules(env, id);
      const { results } = await env.DB.prepare('SELECT * FROM responses WHERE person_id = ? AND week >= ? ORDER BY week DESC')
        .bind(id, addDays(cWeek, -56)).all();
      return json({
        id: p.id, name: p.name,
        recurring: rules.map(({ id, weekday, startHour, endHour, until }) => ({ id, weekday, startHour, endHour, until })),
        responses: results.map((r) => { const x = parseResp(r); return { week: x.week, blocks: x.blocks, cant: x.cant, updatedAt: x.updatedAt }; }),
      });
    }
  }

  if (path === '/api/availability' && method === 'PUT') {
    const b = await body(request);
    const personId = toInt(b.personId);
    if (!Number.isInteger(personId) || !(await getPerson(env, personId))) throw bad('unknown person');
    if (!isWeekId(b.week)) throw bad('invalid week');
    if (b.week < cWeek) throw bad('week is in the past');
    if (b.week > addDays(oWeek, 56)) throw bad('week is too far ahead');
    const cant = b.cant === true || b.cant === 1;
    if (cant && b.blocks === undefined) b.blocks = [];
    if (!Array.isArray(b.blocks)) throw bad('blocks must be an array');
    if (b.blocks.length > 7 * 30) throw bad('too many blocks');
    if (!cant) for (const x of b.blocks) if (!isValidBlock(x, cfg)) throw bad(`invalid block: ${JSON.stringify(x)}`);
    const blocks = cant ? [] : [...new Set(b.blocks)].sort((a, c) => a - c);
    await env.DB.prepare(
      `INSERT INTO responses (person_id, week, blocks, cant, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(person_id, week) DO UPDATE SET blocks=excluded.blocks, cant=excluded.cant, updated_at=excluded.updated_at`,
    ).bind(personId, b.week, JSON.stringify(blocks), cant ? 1 : 0).run();
    return json({ ok: true, status: cant ? 'cant' : 'responded', blocks });
  }

  if (path === '/api/availability' && method === 'DELETE') {
    const personId = toInt(url.searchParams.get('personId'));
    const week = url.searchParams.get('week');
    if (!Number.isInteger(personId)) throw bad('invalid personId');
    if (!isWeekId(week)) throw bad('invalid week');
    await env.DB.prepare('DELETE FROM responses WHERE person_id = ? AND week = ?').bind(personId, week).run();
    return json({ ok: true });
  }

  if (path === '/api/recurring' && method === 'POST') {
    const b = await body(request);
    const personId = toInt(b.personId);
    if (!Number.isInteger(personId) || !(await getPerson(env, personId))) throw bad('unknown person');
    const weekday = b.weekday, startHour = b.startHour, endHour = b.endHour;
    if (![weekday, startHour, endHour].every(Number.isInteger)) throw bad('weekday, startHour and endHour must be integers');
    if (weekday < 0 || weekday > 6) throw bad('weekday must be 0-6');
    if (startHour >= endHour) throw bad('startHour must be before endHour');
    if (startHour < cfg.dayStartHour || endHour > cfg.dayEndHour) throw bad(`hours must be within ${cfg.dayStartHour}-${cfg.dayEndHour}`);
    let until = b.until ?? null;
    if (until !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until + 'T00:00:00Z')))) throw bad('invalid until date');
    const r = await env.DB.prepare('INSERT INTO recurring (person_id, weekday, start_hour, end_hour, until) VALUES (?, ?, ?, ?, ?)')
      .bind(personId, weekday, startHour, endHour, until).run();
    const rule = { id: r.meta.last_row_id, weekday, startHour, endHour, until };
    // merge into existing non-cant responses for weeks >= openWeek
    const { results } = await env.DB.prepare('SELECT * FROM responses WHERE person_id = ? AND week >= ? AND cant = 0').bind(personId, oWeek).all();
    for (const row of results) {
      const x = parseResp(row);
      const merged = [...new Set([...x.blocks, ...rulesToBlocks([rule], x.week, cfg)])].sort((a, c) => a - c);
      await env.DB.prepare("UPDATE responses SET blocks = ?, updated_at = datetime('now') WHERE person_id = ? AND week = ?")
        .bind(JSON.stringify(merged), personId, x.week).run();
    }
    return json({ ...rule, personId });
  }

  if ((m = path.match(/^\/api\/recurring\/(\d+)$/)) && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM recurring WHERE id = ?').bind(Number(m[1])).run();
    return json({ ok: true });
  }

  if (path === '/api/calendar.ics' && method === 'GET') {
    return calendar(env, cfg, now);
  }

  // ---------- admin ----------
  if (path.startsWith('/api/admin/')) {
    requireAdmin(request, env);
    if (path === '/api/admin/check' && method === 'GET') return json({ ok: true });
    if (path === '/api/admin/lock' && method === 'POST') {
      const b = await body(request);
      if (!isWeekId(b.week)) throw bad('invalid week');
      const session = await lockWeek(env, b.week, now, { silent: !!b.silent });
      return json({ ok: true, session: session ?? formatSession(await getSession(env, b.week), cfg) });
    }
    if (path === '/api/admin/unlock' && method === 'POST') {
      const b = await body(request);
      if (!isWeekId(b.week)) throw bad('invalid week');
      await unlockWeek(env, b.week);
      return json({ ok: true });
    }
    if (path === '/api/admin/announce' && method === 'POST') {
      const b = await body(request);
      if (!isWeekId(b.week)) throw bad('invalid week');
      if (!['open', 'remind', 'lock', 'soon'].includes(b.type)) throw bad('invalid type');
      await announce(env, b.type, b.week, now);
      return json({ ok: true });
    }
    if (path === '/api/admin/test-discord' && method === 'POST') {
      await postDiscord(env, { content: `Test message from ${env.APP_NAME || 'Craft & Chat'} ✅` });
      return json({ ok: true });
    }
    if ((m = path.match(/^\/api\/admin\/people\/(\d+)$/)) && method === 'DELETE') {
      const id = Number(m[1]);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM responses WHERE person_id = ?').bind(id),
        env.DB.prepare('DELETE FROM recurring WHERE person_id = ?').bind(id),
        env.DB.prepare('DELETE FROM people WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'not found');
}

const icsEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

async function calendar(env, cfg, now) {
  const since = addDays(zonedParts(now, cfg.timezone).ymd, -28);
  const { results } = await env.DB.prepare("SELECT * FROM sessions WHERE status = 'scheduled' AND week >= ? ORDER BY week")
    .bind(addDays(since, -7)).all();
  const app = env.APP_NAME || 'Craft & Chat';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${app}//mc-scheduler//EN`, 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEsc(app)}`];
  for (const row of results) {
    if (!row.start_utc || row.start_utc < new Date(Date.parse(since + 'T00:00:00Z')).toISOString()) continue;
    const s = formatSession(row, cfg);
    const desc = `Playing: ${s.attendees.join(', ')}${env.MC_SERVER_ADDRESS ? `\nServer: ${env.MC_SERVER_ADDRESS}` : ''}`;
    lines.push('BEGIN:VEVENT', `UID:${row.week}@mc-scheduler`, `DTSTAMP:${icsDate(toIso(row.locked_at) || row.start_utc)}`,
      `DTSTART:${icsDate(row.start_utc)}`, `DTEND:${icsDate(row.end_utc)}`, `SUMMARY:${icsEsc(app)}`,
      `DESCRIPTION:${icsEsc(desc)}`, ...(env.MC_SERVER_ADDRESS ? [`LOCATION:${icsEsc(env.MC_SERVER_ADDRESS)}`] : []), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n') + '\r\n', { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      const url = new URL(request.url);
      if (env.ACCESS_CODE && url.pathname.startsWith('/api/')) {
        const code = request.headers.get('X-Access-Code') || url.searchParams.get('code');
        if (code !== env.ACCESS_CODE) throw new HttpError(401, 'access code required');
      }
      res = await handle(request, env, url, getNow(request, env));
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status);
      else { console.error(e); res = json({ error: 'internal error' }, 500); }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env, new Date()));
  },
};
