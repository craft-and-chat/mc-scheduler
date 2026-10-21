// "now" for the app. In mock mode ?now=ISO freezes-and-ticks from that instant (for tests/screenshots).
let offset = 0;
try {
  const q = new URLSearchParams(location.search);
  if (q.get('mock') === '1' || import.meta.env.VITE_MOCK === '1') {
    const n = Date.parse(q.get('now') || '');
    if (!Number.isNaN(n)) offset = n - Date.now();
  }
} catch {}
export const getNow = () => new Date(Date.now() + offset);
