// Weekly cycle: open -> remind -> lock -> "starting soon". Idempotent via sent_events.
import {
  openWeek, lastLockedWeek, lockTime, openAnnounceTime, reminderTime,
  parseConfig, rankSlots, pickSessions, formatSlot, formatWeek, addDays,
} from '../../shared/schedule.js';
import { getWeekState, getSessions, saveSessions, deleteSessions, markSent, wasSent, formatSession } from './db.js';
import {
  postDiscord, buildOpen, buildRemind, buildLock, buildSoon, upsertScheduledEvent, deleteScheduledEvent,
} from './discord.js';

const H = 3600e3;
const MAX_LATE_NUDGE = 6 * H; // open/remind posts are pointless if > 6 h late
const MAX_LATE_LOCK = 24 * H;
const ok = (r) => !!(r && (r.ok || r.skipped));

// Who answered, and how many of them play in at least one of the given sessions.
function coverageOf(people, sessions) {
  const answered = people.filter((p) => (p.status === 'responded' || p.status === 'regular') && p.blocks.length).map((p) => p.name);
  const inAny = new Set(sessions.flatMap((s) => s.attendees || []));
  const left = answered.filter((n) => !inAny.has(n));
  return { total: answered.length, covered: answered.length - left.length, left };
}

// Post one of the messages (forced; no idempotency bookkeeping). Returns the postDiscord result.
// type 'soon' posts for opts.idx, or for every scheduled session of the week if idx is undefined.
export async function announce(env, type, week, now = new Date(), opts = {}) {
  const st = await getWeekState(env, week, now);
  const { cfg, people, sessions } = st;
  const weekLabel = formatWeek(week);
  if (type === 'open') return postDiscord(env, buildOpen({ env, weekLabel }));
  if (type === 'remind') {
    const planned = pickSessions(rankSlots(people, week, cfg, { notBefore: now }), cfg)
      .map((s) => ({ label: formatSlot(week, s, cfg), count: s.available.length }));
    const t = lockTime(week, cfg);
    return postDiscord(env, buildRemind({
      env, weekLabel,
      waiting: people.filter((p) => p.status === 'waiting').map((p) => p.name),
      planned,
      lockLabel: t > now ? `<t:${Math.floor(t.getTime() / 1000)}:R>` : '',
    }));
  }
  if (type === 'lock') {
    const sched = sessions.filter((s) => s.status === 'scheduled');
    let best = null;
    if (!sched.length) {
      const top = rankSlots(people, week, cfg, { notBefore: now })[0];
      if (top && top.available.length > 0) best = top;
    }
    return postDiscord(env, buildLock({
      env, weekLabel, sessions: sched, coverage: sched.length ? coverageOf(people, sched) : null,
      bestLabel: best ? formatSlot(week, best, cfg) : '', bestCount: best ? best.available.length : 0,
    }));
  }
  if (type === 'soon') {
    const targets = sessions.map((s, i) => [s, i]).filter(([s, i]) => s.status === 'scheduled' && (opts.idx == null || opts.idx === i));
    if (!targets.length) return { skipped: true, reason: 'no scheduled session' };
    let res;
    for (const [session] of targets) res = await postDiscord(env, buildSoon({ env, session }));
    return res;
  }
  throw new Error('unknown announce type: ' + type);
}

// (Re)compute and store the sessions for a week. Announces unless silent.
export async function lockWeek(env, week, now = new Date(), { silent = false } = {}) {
  const { cfg, people } = await getWeekState(env, week, now);
  const prev = await getSessions(env, week);
  const picked = pickSessions(rankSlots(people, week, cfg, { notBefore: now }), cfg);
  let rows;
  if (picked.length) {
    rows = picked.map((top, i) => ({
      status: 'scheduled', day: top.day, hour: top.hour,
      start_utc: top.start.toISOString(), end_utc: top.end.toISOString(),
      attendees: top.available.map((p) => p.name), discord_event_id: prev[i]?.discord_event_id ?? null,
    }));
  } else {
    rows = [{ status: 'none', day: null, hour: null, start_utc: null, end_utc: null, attendees: [], discord_event_id: null }];
  }
  // events of previous sessions that no longer have a slot
  for (const p of prev.slice(picked.length ? picked.length : 0)) if (p.discord_event_id) await deleteScheduledEvent(env, p.discord_event_id);
  await saveSessions(env, week, rows);
  if (picked.length) {
    let changed = false;
    for (const [i, row] of rows.entries()) {
      const id = await upsertScheduledEvent(env, formatSession({ ...row, week }, cfg), row.discord_event_id, now);
      if (id !== row.discord_event_id) { row.discord_event_id = id; changed = true; }
    }
    if (changed) await saveSessions(env, week, rows);
  }
  if (!silent) {
    const r = await announce(env, 'lock', week, now);
    if (ok(r)) await markSent(env, `lock:${week}`);
    else console.log('[cron] lock announce failed; will retry');
  }
  const out = (await getSessions(env, week)).map((r) => formatSession(r, cfg));
  return out;
}

export async function unlockWeek(env, week) {
  for (const prev of await getSessions(env, week)) if (prev.discord_event_id) await deleteScheduledEvent(env, prev.discord_event_id);
  await deleteSessions(env, week);
}

// Send `type` once for `week` (and session idx, if given) if due; late posts are skipped (but marked).
async function sendOnce(env, type, week, now, dueAt, maxLate, log, idx = null) {
  const key = idx == null ? `${type}:${week}` : `${type}:${week}:${idx}`;
  if (now < dueAt || (await wasSent(env, key))) return;
  // legacy single-session key (before multi-session support)
  if (idx === 0 && (await wasSent(env, `${type}:${week}`))) return;
  if (now.getTime() - dueAt.getTime() > maxLate) {
    await markSent(env, key);
    log.push(`${key}: too late, skipped`);
    return;
  }
  const r = await announce(env, type, week, now, { idx });
  if (ok(r)) { await markSent(env, key); log.push(`${key}: sent${r.skipped ? ' (no webhook)' : ''}`); }
  else log.push(`${key}: FAILED, will retry`);
}

export async function runScheduled(env, now = new Date()) {
  const log = [];
  try {
    const cfg = parseConfig(env);
    const ow = openWeek(now, cfg);
    await sendOnce(env, 'open', ow, now, openAnnounceTime(ow, cfg), MAX_LATE_NUDGE, log);
    await sendOnce(env, 'remind', ow, now, reminderTime(ow, cfg), MAX_LATE_NUDGE, log);

    // lock
    const lw = lastLockedWeek(now, cfg);
    const lt = lockTime(lw, cfg);
    if (now >= lt) {
      if (!(await getSessions(env, lw)).length) {
        await lockWeek(env, lw, now, { silent: true });
        log.push(`lock:${lw}: session stored`);
      }
      const key = `lock:${lw}`;
      if (!(await wasSent(env, key))) {
        if (now.getTime() - lt.getTime() > MAX_LATE_LOCK) await markSent(env, key);
        else {
          const r = await announce(env, 'lock', lw, now);
          if (ok(r)) { await markSent(env, key); log.push(`${key}: sent${r.skipped ? ' (no webhook)' : ''}`); }
          else log.push(`${key}: FAILED, will retry`);
        }
      }
    }

    // "starting soon" for sessions of the last-locked week or the one before (Sunday-night sessions)
    for (const w of [lw, addDays(lw, -7)]) {
      const rows = await getSessions(env, w);
      for (const [idx, row] of rows.entries()) {
        if (row.status !== 'scheduled' || !row.start_utc) continue;
        const start = new Date(row.start_utc);
        const from = new Date(start.getTime() - cfg.sessionReminderMinutes * 60e3);
        if (now >= from && now < start) await sendOnce(env, 'soon', w, now, from, Infinity, log, idx);
      }
    }
  } catch (e) {
    console.log('[cron] error', e && e.stack || String(e));
    log.push('error: ' + String(e));
  }
  if (log.length) console.log('[cron]', log.join(' | '));
  return log;
}
