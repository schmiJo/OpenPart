import { createEffect, For, onCleanup, Show } from 'solid-js';
import { partLabel } from '../features/words';
import { mesh, partLooks, setPartLook, type ToolError } from '../store/doc';
import { appearanceFor, lookPreview, setAppearanceFor, setLookPreview, toast } from '../store/ui';
import { DialogFrame } from './DialogFrame';
import { Icon } from './icons';

/** Quiet colors that read as materials, with the default alloy grey first. */
const SWATCHES: [string, string][] = [
  ['#c4ccd1', 'Alloy'], ['#e9ecee', 'White'], ['#8a949b', 'Steel'], ['#3d464d', 'Graphite'],
  ['#b5653a', 'Copper'], ['#c9a23f', 'Brass'], ['#b8433a', 'Red'], ['#d9822b', 'Orange'],
  ['#4f8f4a', 'Green'], ['#3a8a8c', 'Teal'], ['#3f6fb0', 'Blue'], ['#6c55a3', 'Violet'],
];

/** Onshape's Edit appearance, for one part: its color, tried on the model as you pick, and kept with ✓. */
export function AppearanceDialog() {
  const body = () => appearanceFor();
  const saved = () => (body() ? partLooks()[body()!]?.color ?? null : null);
  const current = () => {
    const p = lookPreview();
    return p && p.body === body() ? p.color : saved();
  };
  const close = () => {
    setLookPreview(null);
    setAppearanceFor(null);
  };
  const accept = async () => {
    const b = body();
    const color = current();
    close();
    if (!b || color === saved()) return;
    try {
      await setPartLook(b, { color: color ?? '' });
    } catch (e) {
      toast((e as ToolError).message, 'error');
    }
  };
  const tryColor = (color: string | null) => {
    const b = body();
    if (b) setLookPreview({ body: b, color });
  };
  createEffect(() => {
    if (!body()) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement && e.target.type === 'text')) { e.preventDefault(); e.stopPropagation(); void accept(); }
    };
    window.addEventListener('keydown', key, true);
    onCleanup(() => window.removeEventListener('keydown', key, true));
  });
  return (
    <Show when={body()}>
      {(b) => (
        <DialogFrame
          label="Appearance"
          testid="appearance"
          title={`Appearance of ${partLabel(mesh()?.parts ?? [], b(), partLooks())}`}
          actions={
            <>
              <button class="dialog-action ok" aria-label="Keep this appearance" data-tip="Keep this appearance" data-keys="Enter" onClick={() => void accept()} data-testid="appearance-ok"><Icon name="check" /></button>
              <button class="dialog-action" aria-label="Cancel" data-tip="Cancel" data-keys="Esc" onClick={close}><Icon name="close" /></button>
            </>
          }
        >
          <div class="swatches" role="radiogroup" aria-label="Color">
            <For each={SWATCHES}>
              {([hex, name], i) => {
                const on = () => (current() ?? SWATCHES[0][0]) === hex && (i() > 0 || !current());
                return (
                  <button
                    class="swatch"
                    classList={{ on: on() }}
                    style={{ background: hex }}
                    role="radio"
                    aria-checked={on()}
                    aria-label={name}
                    data-tip={name}
                    data-color={hex}
                    onClick={() => tryColor(i() === 0 ? null : hex)}
                  />
                );
              }}
            </For>
          </div>
          <label class="field">
            <span class="field-label">Custom</span>
            <span class="field-control">
              <input class="color-input" type="color" aria-label="Custom color" value={current() ?? SWATCHES[0][0]} onInput={(e) => tryColor(e.currentTarget.value)} />
              <span class="color-hex">{current() ? current()!.toUpperCase() : 'Alloy, the default'}</span>
            </span>
          </label>
        </DialogFrame>
      )}
    </Show>
  );
}
