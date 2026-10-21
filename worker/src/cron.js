// Weekly cycle: open -> remind -> lock -> "starting soon". Idempotent via sent_events.
import {
  openWeek, lastLockedWeek, lockTime, openAnnounceTime, reminderTime,
  parseConfig, rankSlots, pickSession, formatSlot, formatWeek, addDays,
} from '../../shared/schedule.js';
import { getWeekState, getSession, saveSession, deleteSession, markSent, wasSent, formatSession } from './db.js';
import {
  postDiscord, buildOpen, buildRemind, buildLock, buildSoon, upsertScheduledEvent, deleteScheduledEvent,
} from './discord.js';

const H = 3600e3;
const MAX_LATE_NUDGE = 6 * H; // open/remind posts are pointless if > 6 h late
const MAX_LATE_LOCK = 24 * H;
const ok = (r) => !!(r && (r.ok || r.skipped));

// Post one of the messages (forced; no idempotency bookkeeping). Returns the postDiscord result.
// Names of people who said "maybe" for the whole of a scheduled session's slot.
function maybeNames(session, people, week, cfg) {
  if (!session || session.status !== 'scheduled' || session.day == null) return [];
  const slot = rankSlots(people, week, cfg).find((s) => s.day === session.day && s.hour === session.hour);
  return slot ? slot.maybe.map((p) => p.name) : [];
}

export async function announce(env, type, week, now = new Date()) {
  const st = await getWeekState(env, week, now);
  const { cfg, people, session } = st;
  const weekLabel = formatWeek(week);
  if (type === 'open') return postDiscord(env, buildOpen({ env, weekLabel }));
  if (type === 'remind') {
    const ranked = rankSlots(people, week, cfg, { notBefore: now });
    const top = ranked[0];
    const lead = top && top.available.length > 0 ? top : null;
    const t = lockTime(week, cfg);
    return postDiscord(env, buildRemind({
      env, weekLabel,
      waiting: people.filter((p) => p.status === 'waiting').map((p) => p.name),
      leaderLabel: lead ? formatSlot(week, lead, cfg) : '',
      leaderCount: lead ? lead.available.length : 0,
      lockLabel: t > now ? `<t:${Math.floor(t.getTime() / 1000)}:R>` : '',
    }));
  }
  if (type === 'lock') {
    let best = null;
    if (!session || session.status !== 'scheduled') {
      const top = rankSlots(people, week, cfg, { notBefore: now })[0];
      if (top && top.available.length > 0) best = top;
    }
    return postDiscord(env, buildLock({
      env, weekLabel, session, maybe: maybeNames(session, people, week, cfg),
      bestLabel: best ? formatSlot(week, best, cfg) : '', bestCount: best ? best.available.length : 0,
    }));
  }
  if (type === 'soon') {
    if (!session || session.status !== 'scheduled') return { skipped: true, reason: 'no scheduled session' };
    return postDiscord(env, buildSoon({ env, session, maybe: maybeNames(session, people, week, cfg) }));
  }
  throw new Error('unknown announce type: ' + type);
}

// (Re)compute and store the session for a week. Announces unless silent.
export async function lockWeek(env, week, now = new Date(), { silent = false } = {}) {
  const { cfg, people } = await getWeekState(env, week, now);
  const prev = await getSession(env, week);
  const top = pickSession(rankSlots(people, week, cfg, { notBefore: now }), cfg);
  let row;
  if (top) {
    row = {
      week, status: 'scheduled', day: top.day, hour: top.hour,
      start_utc: top.start.toISOString(), end_utc: top.end.toISOString(),
      attendees: top.available.map((p) => p.name), discord_event_id: prev?.discord_event_id ?? null,
    };
  } else {
    row = { week, status: 'none', day: null, hour: null, start_utc: null, end_utc: null, attendees: [], discord_event_id: null };
    if (prev?.discord_event_id) await deleteScheduledEvent(env, prev.discord_event_id);
  }
  await saveSession(env, row);
  let session = formatSession(await getSession(env, week), cfg);
  if (top) {
    const id = await upsertScheduledEvent(env, session, row.discord_event_id, now);
    if (id !== row.discord_event_id) {
      await saveSession(env, { ...row, discord_event_id: id });
      session = formatSession(await getSession(env, week), cfg);
    }
  }
  if (!silent) {
    const r = await announce(env, 'lock', week, now);
    if (ok(r)) await markSent(env, `lock:${week}`);
    else console.log('[cron] lock announce failed; will retry');
  }
  return session;
}

export async function unlockWeek(env, week) {
  const prev = await getSession(env, week);
  if (prev?.discord_event_id) await deleteScheduledEvent(env, prev.discord_event_id);
  await deleteSession(env, week);
}

// Send `type` once for `week` if due; late posts are skipped (but marked).
async function sendOnce(env, type, week, now, dueAt, maxLate, log) {
  const key = `${type}:${week}`;
  if (now < dueAt || (await wasSent(env, key))) return;
  if (now.getTime() - dueAt.getTime() > maxLate) {
    await markSent(env, key);
    log.push(`${key}: too late, skipped`);
    return;
  }
  const r = await announce(env, type, week, now);
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
      if (!(await getSession(env, lw))) {
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
      const row = await getSession(env, w);
      if (!row || row.status !== 'scheduled' || !row.start_utc) continue;
      const start = new Date(row.start_utc);
      const from = new Date(start.getTime() - cfg.sessionReminderMinutes * 60e3);
      if (now >= from && now < start) await sendOnce(env, 'soon', w, now, from, Infinity, log);
    }
  } catch (e) {
    console.log('[cron] error', e && e.stack || String(e));
    log.push('error: ' + String(e));
  }
  if (log.length) console.log('[cron]', log.join(' | '));
  return log;
}
