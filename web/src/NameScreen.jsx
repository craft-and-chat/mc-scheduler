import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';

export function NameScreen({ onChoose }) {
  const [people, setPeople] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [appName, setAppName] = useState('Craft & Chat');

  const load = () => {
    setErr('');
    api.state().then((s) => { setPeople(s.people); if (s.config?.appName) setAppName(s.config.appName); })
      .catch((e) => setErr(e.network ? "Couldn't reach the server." : e.message));
  };
  useEffect(load, []);

  const create = async (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true); setErr('');
    try { const p = await api.addPerson(n); onChoose({ id: p.id, name: p.name }); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  };

  return (
    <div class="wrap">
      <h1 class="title">⛏️ {appName}</h1>
      <p class="lead">Pick your name so your friends know who's free.</p>
      {err && <div class="banner err">{err} <button class="link" onClick={load}>Retry</button></div>}
      {!people && !err && <div class="chips"><div class="skel chip-skel" /><div class="skel chip-skel" /><div class="skel chip-skel" /></div>}
      {people && people.length > 0 && (
        <div class="chips" data-testid="name-chips">
          {people.map((p) => (
            <button key={p.id} class="chip big" onClick={() => onChoose({ id: p.id, name: p.name })}>{p.name}</button>
          ))}
        </div>
      )}
      <form class="card newname" onSubmit={create}>
        <label for="newname"><b>New here?</b></label>
        <div class="row">
          <input id="newname" class="input" placeholder="Your name, e.g. Tom M" maxLength={40} autoComplete="off"
            value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <button class="btn primary" type="submit" disabled={!name.trim() || busy}>Let's go</button>
        </div>
      </form>
    </div>
  );
}
