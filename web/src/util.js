import { DAYS, formatDate, formatHour, zonedParts } from '../../shared/schedule.js';

export function formatLock(lockAt, cfg) {
  const p = zonedParts(new Date(lockAt), cfg.timezone);
  return `${DAYS[p.weekday]} ${formatDate(p.ymd)} ${formatHour(p.hour)}`;
}

export function tzNote(tz) {
  return tz === 'Europe/London' ? 'All times are UK time (Europe/London)' : `All times are ${tz.replace(/_/g, ' ')} time`;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch { return false; }
}

// Contiguous runs of hours per day -> [{weekday,startHour,endHour}]
export function blocksToRuns(blocks) {
  const byDay = new Map();
  for (const b of [...blocks].sort((a, c) => a - c)) {
    const d = Math.floor(b / 32), h = b % 32;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(h);
  }
  const runs = [];
  for (const [weekday, hs] of byDay) {
    let s = hs[0], p = hs[0];
    for (const h of hs.slice(1)) {
      if (h === p + 1) { p = h; continue; }
      runs.push({ weekday, startHour: s, endHour: p + 1 }); s = p = h;
    }
    runs.push({ weekday, startHour: s, endHour: p + 1 });
  }
  return runs;
}
