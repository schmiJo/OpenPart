import { For, Show } from 'solid-js';
import { closeOnEscape } from './ContextMenu';
import { setShortcutsOpen, shortcutsOpen } from '../store/ui';

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Part',
    keys: [
      ['Shift S', 'Sketch'],
      ['Shift E', 'Extrude'],
      ['G', 'Fillet'],
      ['Delete', 'Delete the selected feature'],
      ['↑ ↓', 'Move the rollback bar a step, once it has focus'],
      ['Enter', 'Accept the dialog'],
      ['Esc', 'Cancel, then clear the selection'],
    ],
  },
  {
    title: 'Assembly',
    keys: [
      ['I', 'Insert parts'],
      ['M', 'Mate'],
      ['Shift', 'While picking a connector, stay on this face or edge'],
      ['Delete', 'Delete the selected instances or mate'],
    ],
  },
  {
    title: 'Sketch',
    keys: [
      ['V', 'Select'],
      ['L', 'Line'],
      ['R', 'Corner rectangle'],
      ['Shift R', 'Center rectangle'],
      ['C', 'Center circle'],
      ['Shift C', '3-point circle'],
      ['A', '3-point arc'],
      ['Shift A', 'Center arc'],
      ['Shift T', 'Tangent arc'],
      ['S', 'Spline'],
      ['P', 'Point'],
      ['T', 'Trim'],
      ['Shift F', 'Round a corner'],
      ['D', 'Dimension'],
      ['Q', 'Construction lines: draw them, or switch the selection'],
      ['M', 'Snapping on or off'],
      ['Hold Shift', 'Ignore snaps for a moment'],
      ['Enter', 'Finish a spline'],
      ['H', 'Horizontal'],
      ['I', 'Vertical'],
      ['Delete', 'Delete the selection'],
      ['Esc', 'Stop the tool, clear the selection, then leave the sketch'],
      ['Ctrl Enter', 'Finish the sketch'],
      ['Shift E', 'Finish the sketch and extrude it'],
    ],
  },
  {
    title: 'View',
    keys: [
      ['F', 'Fit to window'],
      ['N', 'Normal to the sketch, plane or flat face'],
      ['P', 'Show or hide planes, outside a sketch'],
      ['Shift H', 'Show or hide sketches'],
      ['0', 'Isometric'],
      ['1', 'Top'],
      ['2', 'Front'],
      ['3', 'Right'],
    ],
  },
  {
    title: 'App',
    keys: [
      ['Ctrl K', 'Search commands'],
      ['Ctrl Z', 'Undo'],
      ['Ctrl Shift Z', 'Redo'],
      ['Ctrl S', 'Save file'],
      ['Ctrl O', 'Open file'],
      ['?', 'This list'],
    ],
  },
];

export function Shortcuts() {
  closeOnEscape(shortcutsOpen, () => setShortcutsOpen(false));
  return (
    <Show when={shortcutsOpen()}>
      <div class="palette-scrim" onPointerDown={() => setShortcutsOpen(false)}>
        <div class="shortcuts" role="dialog" aria-label="Keyboard shortcuts" data-testid="shortcuts" onPointerDown={(e) => e.stopPropagation()}>
          <For each={GROUPS}>
            {(g) => (
              <div>
                <h3>{g.title}</h3>
                <For each={g.keys}>{([key, what]) => <div class="shortcut"><kbd>{key}</kbd><span>{what}</span></div>}</For>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
