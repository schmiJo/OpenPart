import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { COMMANDS } from '../commands';
import { paletteOpen, setPaletteOpen } from '../store/ui';
import { Icon } from './icons';

function score(title: string, q: string) {
  if (!q) return 1;
  const t = title.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  let at = 0;
  for (const c of q) {
    at = t.indexOf(c, at);
    if (at < 0) return 0;
    at++;
  }
  return 10;
}

export function Palette() {
  const [query, setQuery] = createSignal('');
  const [index, setIndex] = createSignal(0);
  let input: HTMLInputElement | undefined;
  const results = createMemo(() => {
    const q = query().trim().toLowerCase();
    return COMMANDS.filter((c) => c.id !== 'palette' && (!c.enabled || c.enabled()))
      .map((c) => ({ c, s: score(c.title, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  });
  createEffect(() => {
    if (paletteOpen()) {
      setQuery('');
      setIndex(0);
      queueMicrotask(() => input?.focus());
    }
  });
  const run = (i: number) => {
    const c = results()[i];
    if (!c) return;
    setPaletteOpen(false);
    void c.run();
  };
  return (
    <Show when={paletteOpen()}>
      <div class="palette-scrim" onPointerDown={() => setPaletteOpen(false)}>
        <div class="palette" role="dialog" aria-label="Search commands" onPointerDown={(e) => e.stopPropagation()} data-testid="palette">
          <div class="palette-input">
            <Icon name="search" size={15} />
            <input
              ref={input}
              placeholder="Search commands"
              value={query()}
              onInput={(e) => { setQuery(e.currentTarget.value); setIndex(0); }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') setPaletteOpen(false);
                if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(Math.min(index() + 1, results().length - 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(Math.max(index() - 1, 0)); }
                if (e.key === 'Enter') run(index());
              }}
            />
          </div>
          <div class="palette-list" role="listbox">
            <For each={results()}>
              {(c, i) => (
                <button role="option" aria-selected={i() === index()} classList={{ on: i() === index() }} onPointerEnter={() => setIndex(i())} onClick={() => run(i())}>
                  <Icon name={c.icon} size={15} />
                  <span>{c.title}</span>
                  <Show when={c.keys}><kbd>{c.keys}</kbd></Show>
                </button>
              )}
            </For>
            <Show when={results().length === 0}><p class="palette-empty">No command matches that.</p></Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
