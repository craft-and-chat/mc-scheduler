import { useEffect, useState } from 'preact/hooks';
import { addDays, formatWeek, DAYS, formatDate, formatHour, blockId } from '../../shared/schedule.js';
import { adminKey, api, MOCK } from './api.js';

// Read-only heatmap; tap a tile to see who is free that hour.
function AdminGrid({ st, week }) {
  const [sel, setSel] = useState(null);
  const cfg = st.config, people = st.people;
  const counts = new Map();
  let earliest = cfg.dayEndHour;
  for (const p of people) for (const b of p.blocks) { counts.set(b, (counts.get(b) || 0) + 1); earliest = Math.min(earliest, b % 32); }
  const from = Math.max(cfg.dayStartHour, Math.min(cfg.viewStartHour ?? cfg.dayStartHour, earliest));
  const max = Math.max(1, ...counts.values());
  const hours = [];
  for (let h = from; h < cfg.dayEndHour; h++) hours.push(h);
  const groups = sel == null ? [] : [
    ['✅ Free', people.filter((p) => p.blocks.includes(sel))],
    ['✗ Definitely not', people.filter((p) => (p.no || []).includes(sel))],
    ['❌ Not free', people.filter((p) => p.status !== 'waiting' && !p.blocks.includes(sel) && !(p.no || []).includes(sel))],
    ['⏳ Not answered yet', people.filter((p) => p.status === 'waiting')],
  ];
  return (
    <section class="card" data-testid="admin-grid">
      <h3>Who's free when</h3>
      <p class="small muted">Tap a tile to see who's free then.</p>
      <div class="agrid">
        <div />
        {DAYS.map((d, i) => <div key={d} class="ahead">{d}<br /><b>{formatDate(addDays(week, i)).split(' ')[0]}</b></div>)}
        {hours.map((h) => [
          <div key={'h' + h} class="ahour">{String(h % 24).padStart(2, '0')}</div>,
          ...DAYS.map((_, d) => {
            const b = blockId(d, h), n = counts.get(b) || 0;
            return (
              <button key={b} type="button" data-ab={b} class={'acell' + (sel === b ? ' asel' : '')}
                style={n ? `background: color-mix(in srgb, var(--accent) ${20 + 70 * n / max}%, transparent)` : ''}
                onClick={() => setSel(sel === b ? null : b)}>{n || ''}</button>
            );
          }),
        ])}
      </div>
      {sel != null && (
        <div class="adetail" data-testid="admin-tile">
          <b>{DAYS[Math.floor(sel / 32)]} {formatDate(addDays(week, Math.floor(sel / 32)))} · {formatHour(sel % 32)}–{formatHour(sel % 32 + 1)}</b>
          {groups.filter(([, l]) => l.length).map(([t, l]) => (
            <p key={t} class="who small"><b>{t} ({l.length})</b> <span>{l.map((p) => p.name).join(', ')}</span></p>
          ))}
        </div>
      )}
    </section>
  );
}

export function Admin({ now }) {
  const [key, setKey] = useState(adminKey.get());
  const [ok, setOk] = useState(false);
  const [st, setSt] = useState(null);
  const [week, setWeek] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = async (w) => {
    try { const s = await api.state(w || undefined); setSt(s); setWeek(s.week); } catch (e) { setErr(e.message); }
  };
  const check = async (k = key) => {
    adminKey.set(k); setErr(''); setMsg('');
    try { await api.admin.check(); setOk(true); load(); } catch (e) { setOk(false); setErr(e.status === 403 || e.status === 401 ? 'Wrong key' : e.message); }
  };
  useEffect(() => { if (key) check(key); }, []);

  const act = async (label, fn) => {
    setErr(''); setMsg('');
    try { await fn(); setMsg(label + ' ✓'); await load(week); } catch (e) { setErr(e.message); }
  };

  return (
    <div class="wrap" data-testid="admin">
      <header class="top"><b class="app">Admin</b><a href="#" onClick={() => { location.hash = ''; }}>← Back</a></header>
      <section class="card">
        <label for="akey"><b>Admin key</b></label>
        <div class="row">
          <input id="akey" class="input" type="password" value={key} onInput={(e) => setKey(e.currentTarget.value)} placeholder={MOCK ? 'demo key: admin' : ''} />
          <button class="btn primary" onClick={() => check()}>Check</button>
        </div>
      </section>
      {err && <div class="banner err">{err}</div>}
      {msg && <div class="banner ok">{msg}</div>}
      {ok && st && (
        <>
          <div class="switcher">
            <button class="btn sq" onClick={() => load(addDays(week, -7))}>‹</button>
            <div class="wk"><b>{formatWeek(week)}</b><span class="muted small">{st.locked ? 'locked' : 'open'}</span></div>
            <button class="btn sq" onClick={() => load(addDays(week, 7))}>›</button>
          </div>
          <section class="card">
            <div class="row wrapRow">
              <button class="btn" onClick={() => act('Locked', () => api.admin.lock(week))}>Lock now</button>
              <button class="btn" onClick={() => act('Unlocked', () => api.admin.unlock(week))}>Unlock</button>
              <button class="btn" onClick={() => act('Posted open', () => api.admin.announce('open', week))}>Post open</button>
              <button class="btn" onClick={() => act('Posted reminder', () => api.admin.announce('remind', week))}>Post reminder</button>
              <button class="btn" onClick={() => act('Test sent', () => api.admin.testDiscord())}>Post test message</button>
            </div>
            <p class="small muted">Session: {st.session ? (st.session.status === 'scheduled' ? st.session.label : 'none') : 'not decided yet'}</p>
          </section>
          <AdminGrid st={st} week={week} />
          <section class="card">
            <h3>People</h3>
            {st.people.map((p) => (
              <div class="prow" key={p.id}>
                <span class="grow">{p.name} <span class="muted small">({p.status})</span></span>
                <button class="btn" onClick={() => { const n = prompt('New name', p.name); if (n && n.trim()) act('Renamed', () => api.admin.rename(p.id, n)); }}>Rename</button>
                <button class="btn danger" onClick={() => { if (confirm(`Delete ${p.name} and all their data?`)) act('Deleted', () => api.admin.remove(p.id)); }}>Delete</button>
              </div>
            ))}
          </section>
        </>
      )}
      <footer class="foot"><a href="#">Back to the app</a></footer>
    </div>
  );
}
