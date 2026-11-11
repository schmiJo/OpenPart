import { For, onCleanup, onMount, Show } from 'solid-js';
import { toast } from '../store/ui';

export interface MenuItem {
  label: string;
  keys?: string;
  /** The command this runs, for anything that wants to find it. */
  command?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => unknown;
}

/** Closes a menu or sheet on Esc, ahead of what Esc would otherwise do. */
export function closeOnEscape(isOpen: () => boolean, close: () => void) {
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };
  onMount(() => window.addEventListener('keydown', key, true));
  onCleanup(() => window.removeEventListener('keydown', key, true));
}

export function ContextMenu(props: { x: number; y: number; items: (MenuItem | null)[]; close: () => void }) {
  closeOnEscape(() => true, () => props.close());
  const stop = (e: Event) => e.stopPropagation();
  const left = () => Math.min(props.x, innerWidth - 220);
  const top = () => Math.min(props.y, innerHeight - 24 * props.items.length - 12);
  return (
    <div onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onContextMenu={(e) => e.preventDefault()}>
      <div class="menu-scrim" onPointerDown={() => props.close()} />
      <div class="menu" role="menu" data-testid="context-menu" style={{ left: `${left()}px`, top: `${top()}px` }}>
        <For each={props.items}>
          {(item) => (
            <Show when={item} fallback={<div class="menu-rule" />}>
              {(it) => (
                <button
                  role="menuitem"
                  classList={{ danger: !!it().danger }}
                  disabled={it().disabled}
                  data-command={it().command}
                  data-item={it().label}
                  onClick={() => {
                    props.close();
                    Promise.resolve()
                      .then(() => it().run())
                      .catch((e) => toast((e as Error).message, 'error'));
                  }}
                >
                  {it().label}
                  <Show when={it().keys}><kbd>{it().keys}</kbd></Show>
                </button>
              )}
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}
