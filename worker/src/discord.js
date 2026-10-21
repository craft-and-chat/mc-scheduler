// Discord output: webhook posts, message builders, optional guild scheduled events (bot token).
// Everything degrades gracefully when env vars are empty (logs instead of posting).
import { googleCalendarUrl } from '../../shared/schedule.js';

const DEFAULT_API = 'https://discord.com/api/v10';
const GREEN = 0x5dbb63, BLUE = 0x5865f2, GREY = 0x808080, ORANGE = 0xf0a030;

export const apiBase = (env) => (env.DISCORD_API_BASE || DEFAULT_API).replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mentions ----------
// Returns { text, allowed_mentions } for DISCORD_MENTION ("@everyone" | "@here" | "<@&roleId>" | "").
function mentionInfo(env, ping) {
  const m = String(env.DISCORD_MENTION || '').trim();
  if (!ping || !m) return { text: '', allowed: { parse: [] } };
  if (m === '@everyone' || m === '@here') return { text: m, allowed: { parse: ['everyone'] } };
  const role = m.match(/^<@&(\d+)>$/);
  if (role) return { text: m, allowed: { parse: [], roles: [role[1]] } };
  return { text: '', allowed: { parse: [] } }; // unrecognised value: never ping
}

// ---------- webhook ----------
// payload: { content?, embeds?, ping? }. `ping:true` prefixes DISCORD_MENTION and permits only that mention.
export async function postDiscord(env, payload) {
  const url = env.DISCORD_WEBHOOK_URL;
  const { ping, ...rest } = payload || {};
  const mi = mentionInfo(env, ping);
  const body = { username: env.APP_NAME || 'Craft & Chat', ...rest, allowed_mentions: mi.allowed };
  if (mi.text) body.content = body.content ? `${mi.text} ${body.content}` : mi.text;
  if (!url) {
    console.log('[discord:skipped] DISCORD_WEBHOOK_URL not set:', JSON.stringify(body));
    return { skipped: true };
  }
  const target = url + (url.includes('?') ? '&' : '?') + 'wait=true';
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      console.log('[discord] network error', String(e));
      return { ok: false, error: String(e) };
    }
    if (res.status === 429 && attempt === 0) {
      let wait = 1;
      try { wait = Number((await res.json()).retry_after) || 1; } catch {}
      await sleep(Math.min(wait, 10) * 1000 + 100);
      continue;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.log('[discord] webhook failed', res.status, t.slice(0, 200));
      return { ok: false, status: res.status, error: t.slice(0, 200) };
    }
    const msg = await res.json().catch(() => ({}));
    return { ok: true, id: msg.id };
  }
  return { ok: false, status: 429 };
}

// ---------- helpers for builders ----------
export function appLink(env) {
  const base = env.APP_URL || '';
  if (!base) return '';
  if (!env.ACCESS_CODE) return base;
  return base + (base.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(env.ACCESS_CODE);
}
const serverText = (env) => (env.MC_SERVER_ADDRESS ? `\`${env.MC_SERVER_ADDRESS}\`` : 'Server address coming soon');
const names = (arr) => arr.join(', ');
const appName = (env) => env.APP_NAME || 'Craft & Chat';
const toDate = (d) => (d instanceof Date ? d : new Date(d));

export function calendarLink(env, session) {
  return googleCalendarUrl({
    start: toDate(session.start), end: toDate(session.end),
    title: `${appName(env)} 🎮`,
    details: `Minecraft session with ${names(session.attendees || [])}` + (env.MC_SERVER_ADDRESS ? `\nServer: ${env.MC_SERVER_ADDRESS}` : ''),
    location: env.MC_SERVER_ADDRESS || 'Minecraft',
  });
}

// Discord timestamp markup, renders in each viewer's local timezone.
const ts = (d, style = 'F') => `<t:${Math.floor(toDate(d).getTime() / 1000)}:${style}>`;

// ---------- message builders ----------
// ctx: { env, weekLabel, label, ... } — all pure.
export function buildOpen({ env, weekLabel }) {
  const link = appLink(env);
  return {
    ping: true,
    embeds: [{
      title: `🗓️ Availability for ${weekLabel} is open`,
      description: 'Takes 10 seconds — tap the times you can play.' + (link ? `\n\n👉 **[Fill in your times](${link})**` : ''),
      color: BLUE,
    }],
  };
}

export function buildRemind({ env, weekLabel, waiting, leaderLabel, leaderCount, lockLabel }) {
  const link = appLink(env);
  const lines = [];
  lines.push(waiting.length ? `⏳ Still waiting on: **${names(waiting)}**` : '✅ Everyone has answered!');
  lines.push(leaderLabel ? `Leading so far: **${leaderLabel}** (${leaderCount} can play)` : 'No times with enough people yet.');
  if (lockLabel) lines.push(`Session gets locked in ${lockLabel}.`);
  if (link) lines.push(`\n👉 **[Fill in your times](${link})**`);
  return { embeds: [{ title: `⏰ Reminder: ${weekLabel}`, description: lines.join('\n'), color: ORANGE }] };
}

export function buildLock({ env, weekLabel, session, bestLabel, bestCount }) {
  const link = appLink(env);
  if (!session || session.status !== 'scheduled') {
    const best = bestLabel ? ` Best was ${bestLabel} with ${bestCount} ${bestCount === 1 ? 'person' : 'people'}.` : '';
    return { embeds: [{ title: `😢 No session this week (${weekLabel})`, description: `Not enough people were free.${best}` + (link ? `\n\n[Plan the next one](${link})` : ''), color: GREY }] };
  }
  const desc = [
    `**${session.label}**`,
    `🕒 ${ts(session.start)} (${ts(session.start, 'R')}) — your local time`,
    `👥 ${names(session.attendees)} (${session.attendees.length})`,
    `🌐 ${serverText(env)}`,
    `📅 [Add to Google Calendar](${calendarLink(env, session)})` + (link ? ` · [Open app](${link})` : ''),
  ];
  return { ping: true, embeds: [{ title: `🎮 Minecraft session locked in!`, description: desc.join('\n'), color: GREEN }] };
}

export function buildSoon({ env, session }) {
  return {
    ping: true,
    embeds: [{
      title: '⛏️ Starting in about an hour!',
      description: [`**${session.label}**`, `🌐 Server: ${serverText(env)}`, `👥 ${names(session.attendees)}`].join('\n'),
      color: GREEN,
    }],
  };
}

// ---------- optional Guild Scheduled Events (bot token) ----------
const botConfigured = (env) => !!(env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID);

async function discordApi(env, method, path, body) {
  const res = await fetch(apiBase(env) + path, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json };
}

// Create or update the EXTERNAL event for a scheduled session. Returns event id or null.
export async function upsertScheduledEvent(env, session, existingId, now = new Date()) {
  if (!botConfigured(env)) return null;
  const start = toDate(session.start);
  if (start.getTime() <= now.getTime() + 5000) return existingId || null; // API rejects past starts
  const body = {
    name: `${appName(env)} 🎮`.slice(0, 100),
    description: `${session.label}\nPlaying: ${names(session.attendees || [])}`.slice(0, 1000),
    scheduled_start_time: start.toISOString(),
    scheduled_end_time: toDate(session.end).toISOString(),
    privacy_level: 2, entity_type: 3,
    entity_metadata: { location: (env.MC_SERVER_ADDRESS || 'Minecraft').slice(0, 100) },
  };
  try {
    const g = `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events`;
    if (existingId) {
      const r = await discordApi(env, 'PATCH', `${g}/${existingId}`, body);
      if (r.ok) return existingId;
      if (r.status !== 404) { console.log('[discord] event update failed', r.status); return existingId; }
    }
    const r = await discordApi(env, 'POST', g, body);
    if (r.ok && r.json?.id) return r.json.id;
    console.log('[discord] event create failed', r.status, JSON.stringify(r.json));
  } catch (e) { console.log('[discord] event error', String(e)); }
  return existingId || null;
}

export async function deleteScheduledEvent(env, eventId) {
  if (!botConfigured(env) || !eventId) return;
  try {
    const r = await discordApi(env, 'DELETE', `/guilds/${env.DISCORD_GUILD_ID}/scheduled-events/${eventId}`);
    if (!r.ok && r.status !== 404) console.log('[discord] event delete failed', r.status);
  } catch (e) { console.log('[discord] event delete error', String(e)); }
}
