import { createSignal, onCleanup, onMount, Show } from 'solid-js';

/**
 * Any element with data-tip gets one, with data-keys for its shortcut. It lives outside the toolbar, which scrolls and
 * would clip it, and appears quickly, since with no words on the buttons these are how a tool says what it is.
 */
export function Tooltip() {
  const [tip, setTip] = createSignal<{ text: string; keys?: string; x: number; y: number } | null>(null);
  let current: Element | null = null;
  let timer = 0;
  const hide = () => {
    clearTimeout(timer);
    setTip(null);
  };
  const over = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
    if (el === current) return;
    current = el;
    hide();
    if (!el) return;
    timer = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const data = (el as HTMLElement).dataset;
      setTip({ text: data.tip ?? '', keys: data.keys, x: Math.max(70, Math.min(innerWidth - 70, r.left + r.width / 2)), y: r.bottom + 5 });
    }, 260);
  };
  onMount(() => {
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide);
    onCleanup(() => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide);
    });
  });
  return (
    <Show when={tip()}>
      {(t) => (
        <div class="tooltip" role="tooltip" style={{ left: `${t().x}px`, top: `${t().y}px` }}>
          {t().text}
          <Show when={t().keys}><kbd>{t().keys}</kbd></Show>
        </div>
      )}
    </Show>
  );
}
