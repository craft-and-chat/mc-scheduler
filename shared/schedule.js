// Core time + scoring logic shared by the Worker (backend) and the web app.
// Pure ESM, no dependencies. All "wall clock" times are in the group's timezone.
//
// Concepts
//  - weekId: "YYYY-MM-DD" of the Monday that starts the week (group timezone).
//  - block: one hour of one day in a week, encoded as an int: day * 32 + hour.
//           day 0 = Mon .. 6 = Sun. hour may be >= 24 (e.g. 24 = 00:00 after that day's evening).
//  - slot:  a candidate session = sessionHours consecutive blocks on the same day.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const DEFAULT_CONFIG = {
  timezone: 'Europe/London',
  dayStartHour: 0, // first bookable hour (inclusive)
  viewStartHour: 12, // grid shows from here by default; earlier hours behind "Show morning times"
  dayEndHour: 24, // last bookable hour (exclusive); up to 30 allowed (06:00 next morning)
  sessionHours: 2,
  minPlayers: 2,
  openDaysBefore: 3, openHour: 12, // Discord "availability open" post: Fri 12:00 before the week
  reminderDaysBefore: 2, reminderHour: 18, // Discord reminder: Sat 18:00
  lockDaysBefore: 1, lockHour: 18, // session decided + announced: Sun 18:00
  sessionReminderMinutes: 60, // Discord "starting soon" post
};

export function parseConfig(env = {}) {
  const num = (key, def) => {
    const v = env[key];
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const d = DEFAULT_CONFIG;
  return {
    timezone: env.TIMEZONE || d.timezone,
    dayStartHour: num('DAY_START_HOUR', d.dayStartHour),
    viewStartHour: num('VIEW_START_HOUR', d.viewStartHour),
    dayEndHour: num('DAY_END_HOUR', d.dayEndHour),
    sessionHours: num('SESSION_HOURS', d.sessionHours),
    minPlayers: num('MIN_PLAYERS', d.minPlayers),
    openDaysBefore: num('OPEN_DAYS_BEFORE', d.openDaysBefore),
    openHour: num('OPEN_HOUR', d.openHour),
    reminderDaysBefore: num('REMINDER_DAYS_BEFORE', d.reminderDaysBefore),
    reminderHour: num('REMINDER_HOUR', d.reminderHour),
    lockDaysBefore: num('LOCK_DAYS_BEFORE', d.lockDaysBefore),
    lockHour: num('LOCK_HOUR', d.lockHour),
    sessionReminderMinutes: num('SESSION_REMINDER_MINUTES', d.sessionReminderMinutes),
  };
}

// ---------- date / timezone helpers ----------

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

// Wall-clock parts of an instant in tz.
export function zonedParts(date, tz) {
  const p = {};
  for (const part of dtf(tz).formatToParts(date)) p[part.type] = part.value;
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { ymd, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second), weekday: weekdayOf(ymd) };
}

// 0 = Mon .. 6 = Sun
export function weekdayOf(ymd) {
  return (new Date(ymd + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isWeekId(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && weekdayOf(s) === 0;
}

// Instant for a wall-clock time in tz. hour may be >= 24 (rolls into the next day).
export function zonedToUtc(ymd, hour, minute, tz) {
  ymd = addDays(ymd, Math.floor(hour / 24));
  hour = hour % 24;
  const [y, m, d] = ymd.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour, minute || 0);
  const offsetAt = (ts) => {
    const p = zonedParts(new Date(ts), tz);
    const [py, pm, pd] = p.ymd.split('-').map(Number);
    return Date.UTC(py, pm - 1, pd, p.hour, p.minute, p.second) - ts;
  };
  let ts = target - offsetAt(target);
  ts = target - offsetAt(ts);
  return new Date(ts);
}

// Monday (weekId) of the week containing `date` in tz.
export function weekStartOf(date, tz) {
  const p = zonedParts(date, tz);
  return addDays(p.ymd, -p.weekday);
}

function milestone(weekId, daysBefore, hour, cfg) {
  return zonedToUtc(addDays(weekId, -daysBefore), hour, 0, cfg.timezone);
}
export const openAnnounceTime = (weekId, cfg) => milestone(weekId, cfg.openDaysBefore, cfg.openHour, cfg);
export const reminderTime = (weekId, cfg) => milestone(weekId, cfg.reminderDaysBefore, cfg.reminderHour, cfg);
export const lockTime = (weekId, cfg) => milestone(weekId, cfg.lockDaysBefore, cfg.lockHour, cfg);

// The week people are currently filling in: the earliest week whose lock time is still in the future.
export function openWeek(now, cfg) {
  let w = weekStartOf(now, cfg.timezone);
  while (lockTime(w, cfg) <= now) w = addDays(w, 7);
  return w;
}

// The calendar week we are in right now.
export function currentWeek(now, cfg) {
  return weekStartOf(now, cfg.timezone);
}

// The most recent week whose lock time has passed (the one that should have a decided session).
export function lastLockedWeek(now, cfg) {
  return addDays(openWeek(now, cfg), -7);
}

// ---------- blocks & slots ----------

export const blockId = (day, hour) => day * 32 + hour;
export const blockDay = (b) => Math.floor(b / 32);
export const blockHour = (b) => b % 32;

export function isValidBlock(b, cfg) {
  if (!Number.isInteger(b)) return false;
  const day = blockDay(b), hour = blockHour(b);
  return day >= 0 && day <= 6 && hour >= cfg.dayStartHour && hour < cfg.dayEndHour;
}

export function weekBlocks(cfg) {
  const out = [];
  for (let day = 0; day < 7; day++) for (let h = cfg.dayStartHour; h < cfg.dayEndHour; h++) out.push(blockId(day, h));
  return out;
}

export function blockStart(weekId, b, cfg) {
  return zonedToUtc(addDays(weekId, blockDay(b)), blockHour(b), 0, cfg.timezone);
}

export function candidateSlots(cfg) {
  const out = [];
  for (let day = 0; day < 7; day++) {
    for (let h = cfg.dayStartHour; h + cfg.sessionHours <= cfg.dayEndHour; h++) {
      const blocks = [];
      for (let i = 0; i < cfg.sessionHours; i++) blocks.push(blockId(day, h + i));
      out.push({ day, hour: h, blocks });
    }
  }
  return out;
}

// Recurring rules -> blocks for a given week.
// rule: { weekday 0-6, startHour, endHour (exclusive), until: "YYYY-MM-DD" | null (inclusive) }
export function rulesToBlocks(rules, weekId, cfg) {
  const set = new Set();
  for (const r of rules || []) {
    const date = addDays(weekId, r.weekday);
    if (r.until && date > r.until) continue;
    const from = Math.max(r.startHour, cfg.dayStartHour);
    const to = Math.min(r.endHour, cfg.dayEndHour);
    for (let h = from; h < to; h++) set.add(blockId(r.weekday, h));
  }
  return [...set].sort((a, b) => a - b);
}

// What counts for a person in a week.
// response: { blocks: int[] (free), maybe: int[], no: int[] (definitely not), cant: bool } | null
//   A saved response overrides regular times. A response with nothing marked and no "can't"
//   counts as not answered. Precedence if a block is in several lists: free > maybe > no.
// Returns { status: 'responded' | 'cant' | 'regular' | 'waiting', blocks, maybe, no }
export function effectiveBlocks(response, rules, weekId, cfg) {
  if (response) {
    if (response.cant) return { status: 'cant', blocks: [], maybe: [], no: [] };
    const clean = (a) => [...new Set((a || []).filter((b) => isValidBlock(b, cfg)))].sort((x, y) => x - y);
    const blocks = clean(response.blocks);
    const maybe = []; // "maybe" was removed from the app; any old stored maybe hours are ignored
    const no = clean(response.no).filter((b) => !blocks.includes(b));
    if (blocks.length || maybe.length || no.length) return { status: 'responded', blocks, maybe, no };
  }
  const blocks = rulesToBlocks(rules, weekId, cfg);
  return { status: blocks.length ? 'regular' : 'waiting', blocks, maybe: [], no: [] };
}

// Rank every candidate slot of a week.
// people: [{ id, name, blocks: int[], maybe?: int[] }]
// opts.notBefore: Date — slots starting before this are skipped (e.g. in the past)
// opts.excludeId: person id to leave out (e.g. "everyone except me" for quick picks)
// Returns [{ day, hour, blocks, start, end, available: [{id,name}], maybe: [{id,name}], partial: [{id,name}] }] best first.
//   available = free for every hour; maybe = every hour is free-or-maybe (but not all free);
//   partial = free/maybe for some hours only.
export function rankSlots(people, weekId, cfg, opts = {}) {
  const sets = people
    .filter((p) => p.id !== opts.excludeId)
    .map((p) => ({ id: p.id, name: p.name, set: new Set(p.blocks || []), soft: new Set([...(p.blocks || []), ...(p.maybe || [])]) }));
  const out = [];
  for (const slot of candidateSlots(cfg)) {
    const start = blockStart(weekId, slot.blocks[0], cfg);
    if (opts.notBefore && start < opts.notBefore) continue;
    const available = [], maybe = [], partial = [];
    for (const p of sets) {
      const n = slot.blocks.filter((b) => p.set.has(b)).length;
      const m = slot.blocks.filter((b) => p.soft.has(b)).length;
      if (n === slot.blocks.length) available.push({ id: p.id, name: p.name });
      else if (m === slot.blocks.length) maybe.push({ id: p.id, name: p.name });
      else if (m > 0) partial.push({ id: p.id, name: p.name });
    }
    out.push({ ...slot, start, end: new Date(start.getTime() + cfg.sessionHours * 3600e3), available, maybe, partial });
  }
  out.sort((a, b) =>
    b.available.length - a.available.length ||
    b.maybe.length - a.maybe.length ||
    b.partial.length - a.partial.length ||
    a.day - b.day || a.hour - b.hour);
  return out;
}

// The session to book, or null if nobody/too few can make it.
export function pickSession(ranked, cfg) {
  const top = ranked[0];
  return top && top.available.length >= cfg.minPlayers ? top : null;
}

// Up to n non-overlapping popular slots (for the "tap the ones that work" quick list).
export function quickPicks(ranked, cfg, n = 5) {
  const picked = [];
  for (const s of ranked) {
    if (s.available.length === 0) break;
    if (picked.some((p) => p.day === s.day && Math.abs(p.hour - s.hour) < cfg.sessionHours)) continue;
    picked.push(s);
    if (picked.length >= n) break;
  }
  return picked;
}

// "Full house" solver: slots where everyone who answered could play if just `meId` (and at most
// maxMissing-1 others) said yes. Only offered when no full house is possible already.
// people: [{ id, name, status, blocks, maybe, no }] (effective, as from /api/state)
// Returns [{ ...slot, total, missing: [{id,name}], othersMissing: [{id,name}], meMaybe: bool }]
export function fullHouseNudges(meId, people, weekId, cfg, opts = {}) {
  const { notBefore, maxMissing = 2, limit = 2 } = opts;
  const pool = people.filter((p) => (p.status === 'responded' || p.status === 'regular') &&
    ((p.blocks && p.blocks.length) || (p.maybe && p.maybe.length)));
  const total = pool.length;
  const me = pool.find((p) => p.id === meId);
  if (!me || total < Math.max(2, cfg.minPlayers)) return [];
  const ranked = rankSlots(pool, weekId, cfg, { notBefore });
  if (ranked.some((s) => s.available.length === total)) return [];
  const noOf = new Map(pool.map((p) => [p.id, new Set(p.no || [])]));
  const myMaybe = new Set(me.maybe || []);
  const out = [];
  for (const s of ranked) {
    if (s.available.length === 0) break;
    const avail = new Set(s.available.map((p) => p.id));
    const missing = pool.filter((p) => !avail.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
    if (missing.length > maxMissing || !missing.some((p) => p.id === meId)) continue;
    // nobody missing may have said "definitely not" to any hour of it (incl. me)
    if (missing.some((p) => s.blocks.some((b) => noOf.get(p.id).has(b)))) continue;
    if (out.some((o) => o.day === s.day && Math.abs(o.hour - s.hour) < cfg.sessionHours)) continue;
    out.push({ ...s, total, missing, othersMissing: missing.filter((p) => p.id !== meId),
      meMaybe: s.blocks.every((b) => myMaybe.has(b) || (me.blocks || []).includes(b)) });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- formatting ----------

export const formatHour = (h) => String(h % 24).padStart(2, '0') + ':00';

export function formatDate(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

// "27 Oct – 2 Nov"
export function formatWeek(weekId) {
  return `${formatDate(weekId)} – ${formatDate(addDays(weekId, 6))}`;
}

// "Sat 1 Nov · 19:00–21:00"
export function formatSlot(weekId, slot, cfg) {
  return `${DAYS[slot.day]} ${formatDate(addDays(weekId, slot.day))} · ${formatHour(slot.hour)}–${formatHour(slot.hour + cfg.sessionHours)}`;
}

// Google Calendar "add event" link (no API needed).
export function googleCalendarUrl({ start, end, title, details = '', location = '' }) {
  const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${f(start)}/${f(end)}`, details, location });
  return `https://calendar.google.com/calendar/render?${q}`;
}
