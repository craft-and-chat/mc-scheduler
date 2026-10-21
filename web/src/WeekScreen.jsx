import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  addDays, rankSlots, quickPicks, formatWeek, formatSlot, googleCalendarUrl, blockStart,
} from '../../shared/schedule.js';
import { api, MOCK, store } from './api.js';
import { Grid } from './Grid.jsx';
import { RegularCard } from './Regular.jsx';
import { blocksToRuns, copyText, formatLock, tzNote } from './util.js';

const STATUS_TEXT = {
  responded: ["✅", "You've answered"],
  regular: ['↻', 'Using your regular times'],
  cant: ['❌', "Can't play this week"],
  waiting: ['⏳', 'Not answered yet'],
};

function namesLine(list, max = 3) {
  const n = list.map((x) => x.name);
  return n.slice(0, max).join(', ') + (n.length > max ? ` +${n.length - max}` : '');
}

export function WeekScreen({ me, now, onSwitch }) {
  const [sel, setSel] = useState(null);
  const [st, setSt] = useState(null);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mine, setMineState] = useState(new Set());
  const [cant, setCantState] = useState(false);
  const [status, setStatus] = useState('waiting');
  const [pill, setPill] = useState('');
  const [gridOpen, setGridOpen] = useState(null);
  const [promptOk, setPromptOk] = useState(false);
  const [dismissed, setDismissed] = useState(() => store.get('mcs_prompt_off') === '1');
  const [copied, setCopied] = useState(false);

  const mineRef = useRef(mine), cantRef = useRef(cant), weekRef = useRef(null);
  const dirty = useRef(false), timer = useRef(null), queue = useRef(Promise.resolve()), fade = useRef(null);
  const nowRef = useRef(now); nowRef.current = now;

  const setMine = (s) => { mineRef.current = s; setMineState(s); };
  const setCant = (v) => { cantRef.current = v; setCantState(v); };

  const doSave = async () => {
    if (!dirty.current) return;
    const week = weekRef.current;
    dirty.current = false;
    setPill('saving');
    try {
      await api.save(me.id, week, [...mineRef.current].sort((a, b) => a - b), cantRef.current);
      if (!dirty.current) {
        setPill('saved'); setPromptOk(true);
        clearTimeout(fade.current);
        fade.current = setTimeout(() => setPill((p) => (p === 'saved' ? '' : p)), 2200);
      }
    } catch { dirty.current = true; setPill('error'); }
  };
  const chain = () => { queue.current = queue.current.then(doSave); return queue.current; };
  const schedule = () => {
    dirty.current = true; setPill('saving'); clearTimeout(timer.current);
    timer.current = setTimeout(chain, 700);
  };
  const flush = () => { clearTimeout(timer.current); return chain(); };

  const load = useCallback(async (week, reset = true) => {
    setErr('');
    try {
      const [s, d] = await Promise.all([api.state(week || undefined), api.person(me.id)]);
      const mePerson = s.people.find((p) => p.id === me.id);
      if (!mePerson) { onSwitch(); return; }
      setSt(s); setDetail(d); weekRef.current = s.week;
      if (reset && !dirty.current) {
        setMine(new Set(mePerson.blocks)); setCant(mePerson.status === 'cant'); setStatus(mePerson.status);
      }
    } catch (e) { setErr(e.network ? "Couldn't reach the server." : e.message); }
  }, [me.id]);

  useEffect(() => { load(null); }, [load]);
  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === 'hidden') { if (dirty.current) flush(); }
      else if (!dirty.current) load(weekRef.current, true);
    };
    document.addEventListener('visibilitychange', vis);
    addEventListener('pagehide', vis);
    return () => { document.removeEventListener('visibilitychange', vis); removeEventListener('pagehide', vis); };
  }, [load]);

  const goWeek = async (w) => {
    setBusy(true); await flush(); setSel(w); setPromptOk(false); setGridOpen(null);
    await load(w, true); setBusy(false);
  };

  const edit = (nextMine) => {
    setMine(nextMine); setCant(false); setStatus('responded'); schedule();
  };
  const onApply = (blocks, value) => {
    const s = new Set(mineRef.current);
    for (const b of blocks) value ? s.add(b) : s.delete(b);
    edit(s);
  };
  const toggleCant = async () => {
    if (!cantRef.current) {
      setMine(new Set()); setCant(true); setStatus('cant'); schedule(); return;
    }
    clearTimeout(timer.current); dirty.current = false; await queue.current;
    setPill('saving');
    try { await api.clear(me.id, weekRef.current); await load(weekRef.current, true); setPill('saved'); setTimeout(() => setPill(''), 2000); }
    catch { setPill('error'); }
  };
  const sameAsLast = (prev) => {
    const s = new Set(prev.blocks.filter((b) => blockStart(weekRef.current, b, cfg) >= nowRef.current));
    edit(s);
  };
  const reloadAll = async () => { await flush(); await load(weekRef.current, true); };
  const makeRegular = async () => {
    setBusy(true);
    try {
      await flush();
      for (const r of blocksToRuns([...mineRef.current])) await api.addRule({ personId: me.id, ...r, until: null });
      await load(weekRef.current, true);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (!st) {
    return (
      <div class="wrap">
        <Header me={me} onSwitch={onSwitch} appName={"Craft & Chat"} />
        {err ? <div class="banner err">{err} <button class="link" onClick={() => load(null)}>Retry</button></div>
          : <div class="skeletons"><div class="skel" style="height:90px" /><div class="skel" style="height:60px" /><div class="skel" style="height:300px" /></div>}
      </div>
    );
  }

  const cfg = st.config, week = st.week, today = st.now.slice(0, 10);
  const people = st.people.map((p) => (p.id === me.id ? { ...p, blocks: [...mine], status } : p));
  const others = people.filter((p) => p.id !== me.id);
  const counts = new Map();
  for (const p of others) for (const b of p.blocks) counts.set(b, (counts.get(b) || 0) + 1);
  const maxCount = Math.max(0, ...counts.values());

  const ranked = rankSlots(people, week, cfg, { notBefore: now });
  const best3 = quickPicks(ranked, cfg, 3);
  const rankedOthers = rankSlots(people, week, cfg, { excludeId: me.id, notBefore: now });
  const picks = others.filter((p) => p.blocks.length).length >= 2 ? quickPicks(rankedOthers, cfg, 5) : [];
  const showGrid = gridOpen === null ? picks.length === 0 : gridOpen;

  const weeks = [];
  for (let w = st.currentWeek; w <= addDays(st.openWeek, 21); w = addDays(w, 7)) weeks.push(w);
  const wi = weeks.indexOf(week);

  const answered = people.filter((p) => p.status !== 'waiting');
  const lead = best3[0];
  const cs = st.currentSession;
  const showBanner = cs && cs.status === 'scheduled' && new Date(cs.end) > now;
  const rules = detail ? detail.recurring : [];
  const prev = detail && detail.responses
    .filter((r) => r.week < week && !r.cant && r.blocks.length)
    .sort((a, b) => (a.week < b.week ? 1 : -1))[0];
  const canSame = prev && (status === 'regular' || status === 'waiting');
  const server = cfg.mcServerAddress;

  const grouped = { responded: [], regular: [], cant: [], waiting: [] };
  const inactive = [];
  for (const p of people) (p.active || p.id === me.id ? grouped[p.status] : inactive).push(p);
  const [icon, label] = STATUS_TEXT[status];

  return (
    <div class="wrap" data-testid="week-screen">
      <Header me={me} onSwitch={onSwitch} appName={cfg.appName} />
      {MOCK && <div class="demo" data-testid="demo-note">Demo mode — fake friends, data stays in this browser</div>}
      {err && <div class="banner err">{err} <button class="link" onClick={() => load(weekRef.current, true)}>Retry</button></div>}

      {showBanner && (
        <section class="card banner-session" data-testid="this-week">
          <div>🎮 <b>This week: {cs.label}</b> — {cs.attendees.length} playing</div>
          <div class="row wrapRow">
            <a class="btn" target="_blank" rel="noopener"
              href={googleCalendarUrl({ start: new Date(cs.start), end: new Date(cs.end), title: cfg.appName, details: server ? `Server: ${server}` : '', location: server || '' })}>
              Add to calendar</a>
            {server
              ? <button class="btn" onClick={async () => { if (await copyText(server)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>
                {copied ? 'Copied ✓' : `Copy ${server}`}</button>
              : <span class="muted small">Server address coming soon</span>}
          </div>
        </section>
      )}

      <div class="switcher">
        <button class="btn sq" aria-label="Previous week" disabled={wi <= 0 || busy} onClick={() => goWeek(weeks[wi - 1])}>‹</button>
        <div class="wk" data-testid="week-label">
          <b>{formatWeek(week)}</b>
          <span class="muted small">{st.locked ? 'Locked ✓' : `Decided ${formatLock(st.lockAt, cfg)}`}{week === st.currentWeek ? ' · this week' : ''}</span>
        </div>
        <button class="btn sq" aria-label="Next week" disabled={wi >= weeks.length - 1 || busy} onClick={() => goWeek(weeks[wi + 1])}>›</button>
      </div>

      <section class="card leader" data-testid="leader">
        {st.locked
          ? (st.session && st.session.status === 'scheduled'
            ? <span>🔒 <b>Locked in: {st.session.label}</b> ({st.session.attendees.length} playing)</span>
            : <span>🔒 No session this week — not enough players.</span>)
          : lead && lead.available.length
            ? <span>🏆 <b>Leading so far: {formatSlot(week, lead, cfg)}</b> ({lead.available.length} of {answered.length} who answered)</span>
            : <span>No times yet — be the first!</span>}
      </section>

      <section class={'me-row'} data-testid="status">
        <div class={'pill-status s-' + status}>{icon} {label}</div>
        <div class="row wrapRow">
          {canSame && <button class="btn" data-testid="same-last" onClick={() => sameAsLast(prev)}>Same as last week</button>}
          <button class={'btn' + (cant ? ' danger' : '')} aria-pressed={cant} data-testid="cant" onClick={toggleCant}>
            {cant ? '✓ Can’t play — undo' : 'Can’t play this week'}</button>
        </div>
        {status === 'regular' && <p class="muted small">↻ You're in via your regular times. Different this week? Tweak below.</p>}
        {cant && <p class="muted small">Changed your mind? Tap a time.</p>}
      </section>

      <div class={cant ? 'dim' : ''}>
        {picks.length > 0 && (
          <section class="card" data-testid="quick-picks">
            <h3>Popular times</h3>
            <p class="muted small">Tap the ones that work for you.</p>
            <div class="picks">
              {picks.map((s) => {
                const on = s.blocks.every((b) => mine.has(b));
                return (
                  <button key={s.day + '-' + s.hour} class={'pick' + (on ? ' on' : '')} aria-pressed={on} data-testid="pick"
                    onClick={() => onApply(s.blocks, !on)}>
                    <span class="tick">{on ? '✓' : ''}</span>
                    <span class="pk"><b>{formatSlot(week, s, cfg)}</b>
                      <span class="small">{s.available.length} can play: {namesLine(s.available)}</span></span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {picks.length > 0 && (
          <button class="btn wide" data-testid="toggle-grid" onClick={() => setGridOpen(!showGrid)}>
            {showGrid ? 'Hide full grid ▴' : 'Pick other times ▾'}</button>
        )}
        {showGrid && (
          <section class="gridwrap">
            <Grid cfg={cfg} week={week} now={now} mine={mine} counts={counts} maxCount={maxCount} onApply={onApply} />
            <p class="muted small center">Tap hours you're free · hold &amp; drag to select many</p>
          </section>
        )}
      </div>

      {promptOk && !dismissed && rules.length === 0 && mine.size > 0 && pill !== 'saving' && (
        <div class="card prompt" data-testid="regular-prompt">
          <span>Same every week?</span>
          <button class="btn primary" disabled={busy} onClick={makeRegular}>Make these my regular times</button>
          <button class="x" aria-label="Dismiss" onClick={() => { store.set('mcs_prompt_off', '1'); setDismissed(true); }}>✕</button>
        </div>
      )}

      <RegularCard cfg={cfg} personId={me.id} rules={rules} today={today} onChanged={reloadAll} />

      <section class="card" data-testid="whos-in">
        <h3>Who's in</h3>
        {[['responded', '✅ Answered'], ['regular', '↻ Regular times'], ['cant', '❌ Can’t play'], ['waiting', '⏳ Waiting']].map(([k, t]) =>
          grouped[k].length > 0 && (
            <p key={k} class="who"><b>{t}</b> <span>{grouped[k].map((p) => p.name).join(', ')}</span></p>
          ))}
        {inactive.length > 0 && <details><summary class="muted small">+{inactive.length} others</summary>
          <p class="who small">{inactive.map((p) => p.name).join(', ')}</p></details>}
        <h4>Best times</h4>
        {best3.length === 0 ? <p class="muted small">Nothing yet.</p> : best3.map((s) => (
          <div key={s.day + '-' + s.hour} class="best">
            <b>{formatSlot(week, s, cfg)}</b>
            <div class="small">{s.available.length} can play: {namesLine(s.available, 6)}</div>
            {s.partial.length > 0 && <div class="small muted">partly: {namesLine(s.partial, 6)}</div>}
          </div>
        ))}
      </section>

      <footer class="foot">
        <div>⛏️ Server: {server ? <b>{server}</b> : <span class="muted">Server address coming soon</span>}</div>
        <div>💬 Discord: {cfg.discordInviteUrl ? <a href={cfg.discordInviteUrl} target="_blank" rel="noopener">Join the Discord</a> : <span class="muted">Discord invite coming soon</span>}</div>
        <div class="muted small">{tzNote(cfg.timezone)}</div>
        <div class="small"><a href="#admin">Admin</a></div>
      </footer>

      {pill && (
        <button class={'savepill ' + pill} data-testid="save-pill" onClick={pill === 'error' ? chain : undefined}>
          {pill === 'saving' ? 'Saving…' : pill === 'saved' ? 'Saved ✓' : 'Couldn’t save — retry'}</button>
      )}
    </div>
  );
}

function Header({ me, onSwitch, appName }) {
  return (
    <header class="top">
      <b class="app">⛏️ {appName}</b>
      <span class="who-me" data-testid="me">{me.name} · <button class="link" onClick={onSwitch}>switch</button></span>
    </header>
  );
}
