import { useEffect, useState } from 'preact/hooks';
import { addDays, formatWeek } from '../../shared/schedule.js';
import { adminKey, api, MOCK } from './api.js';

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
