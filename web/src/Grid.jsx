import { useEffect, useRef } from 'preact/hooks';
import { DAYS, addDays, blockId, blockStart } from '../../shared/schedule.js';

const LONG_PRESS_MS = 250;

// props: cfg, week, now, mine:Set, counts:Map<block,n>, maxCount, onApply(blocks:number[], value:boolean), disabled
export function Grid(props) {
  const { cfg, week, now, mine, counts, maxCount } = props;
  const ref = useRef(null);
  const P = useRef(props);
  P.current = props;

  const hours = [];
  for (let h = cfg.dayStartHour; h < cfg.dayEndHour; h++) hours.push(h);

  const isPast = (b) => blockStart(week, b, cfg) < P.current.now;
  const blockAt = (el) => {
    const c = el && el.closest && el.closest('[data-b]');
    if (!c || c.dataset.past === '1') return null;
    return Number(c.dataset.b);
  };

  useEffect(() => {
    const el = ref.current;
    const st = { timer: null, painting: false, value: true, startX: 0, startY: 0, moved: false, startB: null, lastTouch: 0, mouse: false, lastB: null };
    const apply = (b) => {
      if (b == null || b === st.lastB) return;
      st.lastB = b;
      P.current.onApply([b], st.value);
    };

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      st.lastTouch = Date.now();
      st.painting = false; st.moved = false; st.lastB = null;
      st.startX = t.clientX; st.startY = t.clientY;
      st.startB = blockAt(e.target);
      clearTimeout(st.timer);
      if (st.startB == null) return;
      st.timer = setTimeout(() => {
        st.painting = true;
        st.value = !P.current.mine.has(st.startB);
        try { navigator.vibrate && navigator.vibrate(15); } catch {}
        apply(st.startB);
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e) => {
      const t = e.touches[0];
      if (st.painting) {
        e.preventDefault();
        apply(blockAt(document.elementFromPoint(t.clientX, t.clientY)));
        return;
      }
      if (Math.abs(t.clientX - st.startX) > 8 || Math.abs(t.clientY - st.startY) > 8) {
        st.moved = true; clearTimeout(st.timer);
      }
    };
    const onTouchEnd = (e) => {
      clearTimeout(st.timer);
      st.lastTouch = Date.now();
      if (st.painting) { st.painting = false; e.preventDefault(); return; }
      if (e.type === 'touchend' && !st.moved && st.startB != null) {
        e.preventDefault(); // suppress emulated mouse events
        const b = st.startB;
        P.current.onApply([b], !P.current.mine.has(b));
      }
      st.startB = null;
    };
    const onTouchCancel = () => { clearTimeout(st.timer); st.painting = false; st.startB = null; };

    const recentTouch = () => Date.now() - st.lastTouch < 700;
    const onMouseDown = (e) => {
      if (e.button !== 0 || recentTouch()) return;
      const b = blockAt(e.target);
      if (b == null) return;
      e.preventDefault();
      st.mouse = true; st.lastB = null;
      st.value = !P.current.mine.has(b);
      apply(b);
    };
    const onMouseOver = (e) => { if (st.mouse) apply(blockAt(e.target)); };
    const onMouseUp = () => { st.mouse = false; };
    const onKey = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const b = blockAt(e.target);
      if (b == null) return;
      e.preventDefault();
      P.current.onApply([b], !P.current.mine.has(b));
    };
    const noMenu = (e) => e.preventDefault();

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false }); // preventDefault only while painting
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchCancel);
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mouseover', onMouseOver);
    el.addEventListener('keydown', onKey);
    el.addEventListener('contextmenu', noMenu);
    addEventListener('mouseup', onMouseUp);
    return () => {
      clearTimeout(st.timer);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mouseover', onMouseOver);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('contextmenu', noMenu);
      removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const toggleDay = (d) => {
    const bs = hours.map((h) => blockId(d, h)).filter((b) => !isPast(b));
    if (!bs.length) return;
    const allOn = bs.every((b) => mine.has(b));
    props.onApply(bs, !allOn);
  };

  return (
    <div class="grid" ref={ref} role="grid" data-testid="grid">
      <div class="gcorner" />
      {DAYS.map((d, i) => {
        const date = Number(addDays(week, i).slice(8));
        return (
          <button key={i} type="button" class="ghead" data-testid={`day-${i}`} onClick={() => toggleDay(i)}
            aria-label={`Toggle all of ${d}`}>
            <span>{d}</span><b>{date}</b>
          </button>
        );
      })}
      {hours.map((h) => [
        <div key={'l' + h} class="glabel">{String(h % 24).padStart(2, '0')}</div>,
        ...DAYS.map((_, d) => {
          const b = blockId(d, h);
          const on = mine.has(b);
          const past = isPast(b);
          const n = counts.get(b) || 0;
          const heat = maxCount ? n / maxCount : 0;
          return (
            <div key={b} data-b={b} data-past={past ? '1' : '0'} role="gridcell" tabIndex={past ? -1 : 0}
              aria-pressed={on} aria-disabled={past}
              class={'cell' + (on ? ' on' : '') + (past ? ' past' : '') + (n && !on ? ' heat' : '')}
              style={n && !on ? { '--heat-a': heat.toFixed(2) } : undefined}>
              {on ? '✓' : n > 0 ? <i>{n}</i> : ''}
            </div>
          );
        }),
      ])}
    </div>
  );
}
