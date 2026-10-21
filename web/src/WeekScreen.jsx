import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  addDays, rankSlots, quickPicks, fullHouseNudges, formatWeek, formatSlot, googleCalendarUrl, blockStart,
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

const BRUSHES = [['free', '✓ Free'], ['maybe', '? Maybe'], ['no', '✗ No']];


// "Show list" toggle: everyone, grouped by whether they can make this slot. No "+N" truncation.
function SlotList({ slot, people, testid }) {
  const [open, setOpen] = useState(false);
  const ids = (l) => new Set(l.map((x) => x.id));
  const can = ids(slot.available), maybe = ids(slot.maybe || []), part = ids(slot.partial || []);
  const groups = [['✅ Can make it', []], ['❔ Maybe', []], ['◐ Only part of it', []], ['❌ Can’t make it', []], ['⏳ Not answered yet', []]];
  for (const p of people) {
    const g = can.has(p.id) ? 0 : maybe.has(p.id) ? 1 : part.has(p.id) ? 2 : p.status === 'waiting' ? 4 : 3;
    groups[g][1].push(p.name);
  }
  return (
    <div class="slotlist">
      <button class="link small" data-testid={testid} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide list ▴' : 'Show list ▾'}</button>
      {open && groups.filter(([, n]) => n.length).map(([t, n]) => (
        <p key={t} class="who small"><b>{t} ({n.length})</b> <span>{n.join(', ')}</span></p>
      ))}
    </div>
  );
}

export function WeekScreen({ me, now, onSwitch }) {
  const [sel, setSel] = useState(null);
  const [st, setSt] = useState(null);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mine, setMineState] = useState(new Set());
  const [maybe, setMaybeState] = useState(new Set());
  const [no, setNoState] = useState(new Set());
  const [brush, setBrush] = useState('free');
  const [cant, setCantState] = useState(false);
  const [status, setStatus] = useState('waiting');
  const [morning, setMorning] = useState(false);
  const [pill, setPill] = useState('');
  const [promptOk, setPromptOk] = useState(false);
  const [dismissed, setDismissed] = useState(() => store.get('mcs_prompt_off') === '1');
  const [copied, setCopied] = useState(false);

  const mineRef = useRef(mine), maybeRef = useRef(maybe), noRef = useRef(no), cantRef = useRef(cant), weekRef = useRef(null);
  const dirty = useRef(false), timer = useRef(null), queue = useRef(Promise.resolve()), fade = useRef(null);
  const nowRef = useRef(now); nowRef.current = now;

  const setMine = (s) => { mineRef.current = s; setMineState(s); };
  const setMaybe = (s) => { maybeRef.current = s; setMaybeState(s); };
  const setNo = (s) => { noRef.current = s; setNoState(s); };
  const setCant = (v) => { cantRef.current = v; setCantState(v); };

  const doSave = async () => {
    if (!dirty.current) return;
    const week = weekRef.current;
    dirty.current = false;
    setPill('saving');
    try {
      const arr = (x) => [...x].sort((a, b) => a - b);
      await api.save(me.id, week, arr(mineRef.current), cantRef.current, arr(maybeRef.current), arr(noRef.current));
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
        setMine(new Set(mePerson.blocks)); setMaybe(new Set(mePerson.maybe || [])); setNo(new Set(mePerson.no || [])); setCant(mePerson.status === 'cant'); setStatus(mePerson.status);
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
    setBusy(true); await flush(); setSel(w); setPromptOk(false);
    await load(w, true); setBusy(false);
  };

  const edit = (nextMine, nextMaybe = maybeRef.current, nextNo = noRef.current) => {
    setMine(nextMine); setMaybe(nextMaybe); setNo(nextNo); setCant(false);
    setStatus(nextMine.size || nextMaybe.size || nextNo.size ? 'responded' : 'waiting'); schedule();
  };
  // value: 'free' | 'maybe' | 'no' | null (clear the hours)
  const onApply = (blocks, value) => {
    const f = new Set(mineRef.current), m = new Set(maybeRef.current), n = new Set(noRef.current);
    for (const b of blocks) {
      f.delete(b); m.delete(b); n.delete(b);
      if (value === 'free') f.add(b); else if (value === 'maybe') m.add(b); else if (value === 'no') n.add(b);
    }
    edit(f, m, n);
  };
  const toggleCant = async () => {
    if (!cantRef.current) {
      setMine(new Set()); setMaybe(new Set()); setNo(new Set()); setCant(true); setStatus('cant'); schedule(); return;
    }
    clearTimeout(timer.current); dirty.current = false; await queue.current;
    setPill('saving');
    try { await api.clear(me.id, weekRef.current); await load(weekRef.current, true); setPill('saved'); setTimeout(() => setPill(''), 2000); }
    catch { setPill('error'); }
  };
  const sameAsLast = (prev) => {
    const fut = (a) => new Set((a || []).filter((b) => blockStart(weekRef.current, b, cfg) >= nowRef.current));
    edit(fut(prev.blocks), fut(prev.maybe), fut(prev.no));
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
  const people = st.people.map((p) => (p.id === me.id ? { ...p, blocks: [...mine], maybe: [...maybe], no: [...no], status } : p));
  const states = new Map();
  for (const b of no) states.set(b, 'no');
  for (const b of maybe) states.set(b, 'maybe');
  for (const b of mine) states.set(b, 'free');
  const others = people.filter((p) => p.id !== me.id);
  const counts = new Map();
  for (const p of others) for (const b of p.blocks) counts.set(b, (counts.get(b) || 0) + 1);
  const maxCount = Math.max(0, ...counts.values());

  const viewStart = Math.max(cfg.dayStartHour, cfg.viewStartHour ?? cfg.dayStartHour);
  const hasEarly = viewStart > cfg.dayStartHour;
  const isEarly = (b) => b % 32 < viewStart;
  const myEarly = [...states.keys()].some(isEarly);
  const othersEarly = others.filter((p) => p.blocks.some(isEarly)).length;
  const showMorning = morning || myEarly;
  const ranked = rankSlots(people, week, cfg, { notBefore: now });
  const best3 = quickPicks(ranked, cfg, 3);
  const nudges = st.locked || cant ? [] : fullHouseNudges(me.id, people, week, cfg, { notBefore: now });

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
  for (const p of people) grouped[p.status].push(p);
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
            ? <span>🏆 <b>Leading so far: {formatSlot(week, lead, cfg)}</b> ({lead.available.length} of {answered.length} who answered{lead.maybe.length ? `, +${lead.maybe.length} maybe` : ''})</span>
            : <span>No times yet — be the first!</span>}
        {(() => {
          const ls = st.locked ? (st.session && st.session.status === 'scheduled' && rankSlots(people, week, cfg).find((r) => r.day === st.session.day && r.hour === st.session.hour)) : (lead && lead.available.length && lead);
          return ls ? <SlotList slot={ls} people={people} testid="leader-list" /> : null;
        })()}
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
        <section class="gridwrap">
          {hasEarly && !myEarly && (
            <button class="btn wide" data-testid="toggle-morning" onClick={() => setMorning(!morning)}>
              {showMorning ? 'Hide morning times ▴' : `Show morning times ▾${othersEarly ? ` (${othersEarly} free)` : ''}`}</button>
          )}
          <div class="brush" role="radiogroup" aria-label="Paint with" data-testid="brush">
            {BRUSHES.map(([k, t]) => (
              <button key={k} type="button" role="radio" aria-checked={brush === k} data-testid={'brush-' + k}
                class={'bt bt-' + k + (brush === k ? ' sel' : '')} onClick={() => setBrush(k)}>{t}</button>
            ))}
          </div>
          <Grid cfg={cfg} week={week} now={now} states={states} brush={brush} counts={counts} maxCount={maxCount} onApply={onApply}
            fromHour={showMorning ? cfg.dayStartHour : viewStart} />
          <p class="muted small center">Pick ✓ ? ✗ above, then tap hours · hold &amp; drag to paint many</p>
        </section>
      </div>

      {nudges.map((n) => {
        const others = n.othersMissing.map((p) => p.name);
        return (
          <section key={n.day + '-' + n.hour} class="card nudge" data-testid="nudge">
            <b>⚠️ Can you do {formatSlot(week, n, cfg)}?</b>
            <p class="small">
              {others.length === 0
                ? `You're the only one missing — everyone else (${n.total - 1} of ${n.total}) can make it. Full house!`
                : `Only you and ${others.join(' and ')} are missing for a full house (${n.available.length} of ${n.total}).`}
              {n.meMaybe ? ' You said maybe — can you confirm?' : ''}
            </p>
            <div class="row wrapRow">
              <button class="btn primary" data-testid="nudge-yes" onClick={() => onApply(n.blocks, 'free')}>Yes, I can</button>
              {!n.meMaybe && <button class="btn" data-testid="nudge-maybe" onClick={() => onApply(n.blocks, 'maybe')}>Maybe</button>}
              <button class="btn danger" data-testid="nudge-no" onClick={() => onApply(n.blocks, 'no')}>Definitely not</button>
            </div>
          </section>
        );
      })}

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
        <h4>Best times</h4>
        {best3.length === 0 ? <p class="muted small">Nothing yet.</p> : best3.map((s) => (
          <div key={s.day + '-' + s.hour} class="best">
            <b>{formatSlot(week, s, cfg)}</b>
            <div class="small">{s.available.length} can play{s.maybe.length ? ` · ${s.maybe.length} maybe` : ''}</div>
            <SlotList slot={s} people={people} testid="best-list" />
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
