import { useEffect, useState } from 'preact/hooks';
import { configured, store } from './api.js';
import { getNow } from './clock.js';
import { NameScreen } from './NameScreen.jsx';
import { WeekScreen } from './WeekScreen.jsx';
import { Admin } from './Admin.jsx';

function loadMe() {
  try { const m = JSON.parse(store.get('mcs_me')); if (m && m.id) return m; } catch {}
  return null;
}

export function App() {
  const [me, setMe] = useState(loadMe);
  const [hash, setHash] = useState(location.hash);
  const [now, setNow] = useState(getNow);
  useEffect(() => {
    const h = () => setHash(location.hash);
    addEventListener('hashchange', h);
    const t = setInterval(() => setNow(getNow()), 30000);
    return () => { removeEventListener('hashchange', h); clearInterval(t); };
  }, []);

  const choose = (m) => { store.set('mcs_me', JSON.stringify(m)); setMe(m); };
  const logout = () => { store.del('mcs_me'); setMe(null); };

  if (!configured) {
    return (
      <div class="wrap"><div class="card center">
        <h2>Backend not configured yet</h2>
        <p class="muted">Set <code>VITE_API_URL</code> when building, or try the demo with <a href="?mock=1">?mock=1</a>.</p>
      </div></div>
    );
  }
  if (hash === '#admin') return <Admin now={now} />;
  if (!me) return <NameScreen onChoose={choose} />;
  return <WeekScreen me={me} now={now} onSwitch={logout} onRenamed={choose} />;
}
