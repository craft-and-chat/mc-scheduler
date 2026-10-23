import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  addDays, rankSlots, quickPicks, fullHouseNudges, pickSessions, coverageNudges, formatWeek, formatSlot, googleCalendarUrl, blockStart,
} from '../../shared/schedule.js';
import { api, MOCK, store } from './api.js';
import { Grid } from './Grid.jsx';
import { RegularCard } from './Regular.jsx';
import { blocksToRuns, copyText, tzNote } from './util.js';

const STATUS_TEXT = {
  responded: ["✅", "You've answered"],
  regular: ['↻', 'Using your regular times'],
  cant: ['❌', "Can't play this week"],
  waiting: ['⏳', 'Not answered yet'],
};



// "Show list" toggle: everyone, grouped by whether they can make this slot. No "+N" truncation.
function SlotList({ slot, people, testid }) {
  const [open, setOpen] = useState(false);
  const ids = (l) => new Set(l.map((x) => x.id));
  const can = ids(slot.available), maybe = ids(slot.maybe || []), part = ids(slot.partial || []);
  const groups = [['✅ Can make it', []], ['◐ Only part of it', []], ['❌ Can’t make it', []], ['⏳ Not answered yet', []]];
  for (const p of people) {
    const g = can.has(p.id) || maybe.has(p.id) ? 0 : part.has(p.id) ? 1 : p.status === 'waiting' ? 3 : 2;
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
  const brush = 'free'; // the grid only marks free hours; "definitely not" comes from the full-house card
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
    edit(fut(prev.blocks), new Set(), new Set());
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
  const multi = cfg.sessionsPerWeek > 1;
  const planned = pickSessions(ranked, cfg);
  const nudges = st.locked || cant ? [] : multi ? coverageNudges(me.id, people, week, cfg, { notBefore: now }) : fullHouseNudges(me.id, people, week, cfg, { notBefore: now });

  const weeks = [];
  for (let w = st.currentWeek; w <= addDays(st.openWeek, 21); w = addDays(w, 7)) weeks.push(w);
  const wi = weeks.indexOf(week);
  const wdiff = Math.round((Date.parse(week) - Date.parse(st.currentWeek)) / (7 * 864e5));
  const rel = wdiff === 0 ? { label: '📍 THIS WEEK', lower: 'this week', cls: 'this' }
    : wdiff === 1 ? { label: '📅 NEXT WEEK', lower: 'next week', cls: 'next' }
    : wdiff > 1 ? { label: `⏩ IN ${wdiff} WEEKS`, lower: 'that week', cls: 'later' }
    : { label: '⏪ PAST WEEK', lower: 'that week', cls: 'later' };

  const answered = people.filter((p) => (p.status === 'responded' || p.status === 'regular') && p.blocks.length);
  const lockedSessions = (st.sessions || []).filter((x) => x.status === 'scheduled');
  // sessions shown in the leader card: [{ label, count, slot }]
  const shown = st.locked
    ? lockedSessions.map((x) => ({ label: x.label, count: x.attendees.length, names: x.attendees, slot: rankSlots(people, week, cfg).find((r) => r.day === x.day && r.hour === x.hour) }))
    : planned.map((x) => ({ label: formatSlot(week, x, cfg), count: x.available.length, names: x.available.map((p) => p.name), slot: x }));
  const inAny = new Set(shown.flatMap((x) => x.names));
  const allIn = answered.length > 0 && answered.every((p) => inAny.has(p.name));
  const cSessions = (st.currentSessions || []).filter((x) => x.status === 'scheduled' && new Date(x.end) > now);
  const showBanner = cSessions.length > 0;
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
          <span class="when when-this bs-tag">📍 THIS WEEK'S {cSessions.length > 1 ? 'SESSIONS' : 'SESSION'}</span>
          {cSessions.map((x) => (
            <div key={x.start} class="bs-row" data-testid="this-week-session">
              <div>🎮 <b>{x.label}</b> — {x.attendees.length} playing</div>
              <a class="btn" target="_blank" rel="noopener"
                href={googleCalendarUrl({ start: new Date(x.start), end: new Date(x.end), title: cfg.appName, details: server ? `Server: ${server}` : '', location: server || '' })}>
                Add to calendar</a>
            </div>
          ))}
          <div class="row wrapRow">
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
          <span class={'when when-' + rel.cls} data-testid="week-rel">{rel.label}</span>
          {st.locked && <span class="muted small">Locked ✓</span>}
        </div>
        <button class="btn sq" aria-label="Next week" disabled={wi >= weeks.length - 1 || busy} onClick={() => goWeek(weeks[wi + 1])}>›</button>
      </div>

      <section class="card leader" data-testid="leader">
        {shown.length === 0
          ? <span>{st.locked ? '🔒 No session this week — not enough players.' : 'No times yet — be the first!'}</span>
          : (
            <>
              <div class="lead-title"><b>{st.locked ? '🔒 Locked in' : cfg.sessionsPerWeek > 1 ? '🏆 Planned so far' : '🏆 Leading so far'}</b></div>
              <ul class="sessions">
                {shown.map((x, i) => (
                  <li key={x.label} data-testid="leader-session">
                    <div><b>{x.label}</b> <span class="muted">· {x.count} playing</span></div>
                    {x.slot && <SlotList slot={x.slot} people={people} testid={i === 0 ? 'leader-list' : 'leader-list-' + i} />}
                  </li>
                ))}
              </ul>
              {answered.length > 0 && (
                <p class={'small summary' + (allIn ? ' all' : '')} data-testid="leader-summary">
                  {allIn ? '✅ Everyone who answered gets to play'
                    : `${answered.filter((p) => inAny.has(p.name)).length} of ${answered.length} who answered can play${shown.length > 1 || cfg.sessionsPerWeek > 1 ? ' at least once' : ''}`}
                </p>
              )}
            </>
          )}
      </section>

      <section class={'me-row'} data-testid="status">
        <div class={'pill-status s-' + status}>{icon} {label}</div>
        <div class="row wrapRow">
          {canSame && <button class="btn" data-testid="same-last" onClick={() => sameAsLast(prev)}>Same as last week</button>}
          <button class={'btn' + (cant ? ' danger' : '')} aria-pressed={cant} data-testid="cant" onClick={toggleCant}>
            {cant ? '✓ Can’t play — undo' : `Can’t play ${rel.lower}`}</button>
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
          <Grid cfg={cfg} week={week} now={now} states={states} brush={brush} counts={counts} maxCount={maxCount} onApply={onApply}
            fromHour={showMorning ? cfg.dayStartHour : viewStart} />
          <p class="muted small center">Tap hours you're free · hold &amp; drag to select many</p>
        </section>
      </div>

      {multi ? nudges.map((n) => {
        const which = planned.length > 2 ? 'any session' : planned.length === 2 ? 'either session' : 'the planned session';
        return (
          <section key={n.day + '-' + n.hour} class="card nudge" data-testid="nudge">
            <b>⚠️ You're not in {which} yet — can you do {formatSlot(week, n, cfg)}?</b>
            <p class="small">{n.covered} of {n.total} who answered can play so far.</p>
            <div class="row wrapRow">
              <button class="btn primary" data-testid="nudge-yes" onClick={() => onApply(n.blocks, 'free')}>Yes, I can</button>
              <button class="btn danger" data-testid="nudge-no" onClick={() => onApply(n.blocks, 'no')}>Definitely not</button>
            </div>
          </section>
        );
      }) : nudges.map((n) => {
        const others = n.othersMissing.map((p) => p.name);
        return (
          <section key={n.day + '-' + n.hour} class="card nudge" data-testid="nudge">
            <b>⚠️ Can you do {formatSlot(week, n, cfg)}?</b>
            <p class="small">
              {others.length === 0
                ? `You're the only one missing — everyone else (${n.total - 1} of ${n.total}) can make it. Full house!`
                : `Only you and ${others.join(' and ')} are missing for a full house (${n.available.length} of ${n.total}).`}
            </p>
            <div class="row wrapRow">
              <button class="btn primary" data-testid="nudge-yes" onClick={() => onApply(n.blocks, 'free')}>Yes, I can</button>
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
            <div class="small">{s.available.length} can play</div>
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
