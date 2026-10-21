import { useState } from 'preact/hooks';
import { DAYS, DAYS_LONG, formatDate, formatHour } from '../../shared/schedule.js';
import { api } from './api.js';

export function ruleLabel(r) {
  return `${DAYS_LONG[r.weekday]}s ${formatHour(r.startHour)}–${formatHour(r.endHour)} · ${r.until ? 'until ' + formatDate(r.until.slice(0, 10).split('-').slice(0, 3).join('-')) : 'forever'}`;
}

export function RegularCard({ cfg, personId, rules, today, onChanged }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(new Set());
  const clamp = (h, lo, hi) => Math.min(Math.max(h, lo), hi);
  const [from, setFrom] = useState(clamp(18, cfg.dayStartHour, cfg.dayEndHour - 1));
  const [to, setTo] = useState(clamp(22, cfg.dayStartHour + 1, cfg.dayEndHour));
  const [forever, setForever] = useState(true);
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const toggleDay = (d) => { const s = new Set(days); s.has(d) ? s.delete(d) : s.add(d); setDays(s); };
  const setPreset = (arr) => setDays(new Set(arr));

  const hoursFrom = [], hoursTo = [];
  for (let h = cfg.dayStartHour; h < cfg.dayEndHour; h++) hoursFrom.push(h);
  for (let h = cfg.dayStartHour + 1; h <= cfg.dayEndHour; h++) hoursTo.push(h);

  const save = async () => {
    setErr('');
    if (!days.size) return setErr('Pick at least one day.');
    if (from >= to) return setErr('"To" must be after "From".');
    if (!forever && !until) return setErr('Pick an end date.');
    setBusy(true);
    try {
      for (const d of [...days].sort()) {
        await api.addRule({ personId, weekday: d, startHour: from, endHour: to, until: forever ? null : until });
      }
      setDays(new Set()); setOpen(false);
      await onChanged();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const remove = async (id) => { try { await api.delRule(id); await onChanged(); } catch (e) { setErr(e.message); } };

  return (
    <section class="card" data-testid="regular-card">
      <h3>↻ Regular times</h3>
      <p class="muted small">Free at the same time every week? Add it once — you'll be counted automatically every week.</p>
      {rules.length > 0 && (
        <ul class="rules">
          {rules.map((r) => (
            <li key={r.id}>
              <span>{ruleLabel(r)}</span>
              <button class="x" aria-label={`Remove ${ruleLabel(r)}`} onClick={() => remove(r.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {!open && <button class="btn" data-testid="add-regular" onClick={() => setOpen(true)}>+ Add regular time</button>}
      {open && (
        <div class="form" data-testid="regular-form">
          <div class="chips tight">
            {DAYS.map((d, i) => (
              <button key={i} type="button" class={'chip' + (days.has(i) ? ' sel' : '')} onClick={() => toggleDay(i)}>{d}</button>
            ))}
          </div>
          <div class="chips tight">
            <button type="button" class="chip ghost" onClick={() => setPreset([0, 1, 2, 3, 4])}>Weekdays</button>
            <button type="button" class="chip ghost" onClick={() => setPreset([5, 6])}>Weekend</button>
          </div>
          <div class="row">
            <label class="grow">From
              <select class="input" value={from} onChange={(e) => setFrom(Number(e.currentTarget.value))}>
                {hoursFrom.map((h) => <option value={h}>{formatHour(h)}</option>)}
              </select>
            </label>
            <label class="grow">To
              <select class="input" value={to} onChange={(e) => setTo(Number(e.currentTarget.value))}>
                {hoursTo.map((h) => <option value={h}>{formatHour(h)}</option>)}
              </select>
            </label>
          </div>
          <div class="chips tight">
            <button type="button" class={'chip' + (forever ? ' sel' : '')} onClick={() => setForever(true)}>Forever</button>
            <button type="button" class={'chip' + (!forever ? ' sel' : '')} onClick={() => setForever(false)}>Until date</button>
            {!forever && <input type="date" class="input date" min={today} value={until} onInput={(e) => setUntil(e.currentTarget.value)} />}
          </div>
          {err && <div class="banner err">{err}</div>}
          <div class="row">
            <button class="btn primary grow" disabled={busy} onClick={save} data-testid="save-regular">Save regular time</button>
            <button class="btn" onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
          </div>
        </div>
      )}
      {open ? null : err && <div class="banner err">{err}</div>}
    </section>
  );
}
