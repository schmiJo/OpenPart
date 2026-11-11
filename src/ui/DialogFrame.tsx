import { children, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Icon } from './icons';

const SAVE_KEY = 'schmishape.dialog-frame';
const MIN_W = 240;
const MIN_H = 120;
const DEFAULT = { x: 8, y: 8, w: 288, h: null as number | null };
type Box = typeof DEFAULT;

function loadBox(): Box {
  try {
    const b = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w)) return { x: b.x, y: b.y, w: Math.max(b.w, MIN_W), h: Number.isFinite(b.h) ? b.h : null };
  } catch {
    /* It can't be read, so it's as if there were none. */
  }
  return { ...DEFAULT };
}

/** Where dialogs sit and how big they are. All dialogs share one, as it's how you like your window. */
const [box, setBox] = createSignal<Box>(loadBox());
function saveBox() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(box()));
  } catch {
    /* It only costs remembering this for next time. */
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const GRIPS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * The window every floating dialog sits in. Drag the header to move it, and its edges and corners to resize it. It
 * always stays inside its parent, however that changes size, and a double-click on the header puts it back.
 */
export function DialogFrame(props: {
  label: string;
  testid?: string;
  icon?: string;
  title: JSX.Element;
  /** Buttons at the right of the header. */
  actions?: JSX.Element;
  /** Fixed below the scrolling body, for what must stay in sight. */
  below?: JSX.Element;
  footer?: JSX.Element;
  children: JSX.Element;
}) {
  let el!: HTMLElement;
  const [stage, setStage] = createSignal({ w: Infinity, h: Infinity });
  const foot = children(() => props.footer);

  onMount(() => {
    const parent = el.parentElement!;
    const measure = () => setStage({ w: parent.clientWidth, h: parent.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    onCleanup(() => ro.disconnect());
  });

  /** The box as drawn. What's saved stays as you left it, so a window that shrinks and grows back puts it back. */
  const drawn = () => {
    const b = box(), s = stage();
    const w = Math.min(b.w, s.w);
    const x = clamp(b.x, 0, s.w - w);
    const y = clamp(b.y, 0, s.h - MIN_H);
    return { x, y, w, room: s.h - y, h: b.h === null ? null : Math.min(b.h, s.h - y) };
  };

  const track = (e: PointerEvent, move: (dx: number, dy: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    const onMove = (ev: PointerEvent) => move(ev.clientX - x0, ev.clientY - y0);
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      saveBox();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const startMove = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select, a')) return;
    const from = drawn();
    const h = el.offsetHeight;
    track(e, (dx, dy) => {
      const s = stage();
      setBox({ ...box(), x: clamp(from.x + dx, 0, s.w - from.w), y: clamp(from.y + dy, 0, s.h - h) });
    });
  };

  const startResize = (e: PointerEvent, grip: string) => {
    if (e.button !== 0) return;
    const from = drawn();
    const h0 = el.offsetHeight;
    track(e, (dx, dy) => {
      const s = stage();
      let { x, y, w } = from;
      let h: number | null = box().h;
      if (grip.includes('e')) w = clamp(from.w + dx, MIN_W, s.w - from.x);
      if (grip.includes('w')) {
        const right = from.x + from.w;
        x = clamp(from.x + dx, 0, right - MIN_W);
        w = right - x;
      }
      if (grip.includes('s')) h = clamp(h0 + dy, MIN_H, s.h - from.y);
      if (grip.includes('n')) {
        const bottom = from.y + h0;
        y = clamp(from.y + dy, 0, bottom - MIN_H);
        h = bottom - y;
      }
      setBox({ x, y, w, h });
    });
  };

  const reset = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, a')) return;
    setBox({ ...DEFAULT });
    saveBox();
  };

  return (
    <aside
      ref={el}
      class="dialog"
      classList={{ sized: drawn().h !== null }}
      aria-label={props.label}
      data-testid={props.testid}
      style={{
        left: `${drawn().x}px`,
        top: `${drawn().y}px`,
        width: `${drawn().w}px`,
        height: drawn().h === null ? 'auto' : `${drawn().h}px`,
        'max-height': `${drawn().room}px`,
      }}
    >
      <header onPointerDown={startMove} onDblClick={reset}>
        <Show when={props.icon}>{(name) => <Icon name={name()} size={16} />}</Show>
        <h3>{props.title}</h3>
        {props.actions}
      </header>
      <div class="dialog-body">{props.children}</div>
      {props.below}
      <Show when={foot()}><footer class="dialog-foot">{foot()}</footer></Show>
      <For each={GRIPS}>{(g) => <div class={`dialog-grip ${g}`} data-grip={g} onPointerDown={(e) => startResize(e, g)} />}</For>
    </aside>
  );
}
