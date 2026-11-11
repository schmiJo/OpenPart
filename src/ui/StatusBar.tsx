import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { busy, doc, stopEngine } from '../store/doc';
import { glProblem, hoverText, mode } from '../store/ui';
import { session } from '../sketch/controller';
import { CONSTRAINT_NEEDS } from '../sketch/session';
import { asmHint } from '../assembly/interaction';
import { inAssembly } from '../store/tabs';
import { activeDef, pickKind, regionsTakeFaces } from '../features/dialog';
import { Icon } from './icons';

const n = (v: number, digits = 2) => v.toLocaleString('en', { maximumFractionDigits: digits });

function hint() {
  if (glProblem()) return '';
  const s = session();
  if (s) {
    const waiting = s.constraintTool[0]();
    if (waiting) return `${CONSTRAINT_NEEDS[waiting]}: click them, and it's added as soon as they fit. Part corners and edges count too. Esc stops.`;
    switch (s.tool[0]()) {
      case 'select': return 'Drag geometry or a dimension to move it, double-click a dimension to change it. Right-click for Normal to sketch plane.';
      case 'line': return 'Click to start, click to continue. Lines snap to right angles and show an icon. Hold Shift to ignore snaps. Esc ends the chain.';
      case 'rect': return 'Click one corner, then the other.';
      case 'rect-center': return 'Click the center, then a corner.';
      case 'circle': return 'Click the center, then the rim.';
      case 'circle-3pt': return 'Click three points the circle passes through.';
      case 'arc-tangent': return 'Click the end of a line or arc, then where the arc should finish.';
      case 'arc': return 'Click where it starts, where it ends, then a point it passes through.';
      case 'arc-center': return 'Click the center, then the start, then the end, going counter-clockwise.';
      case 'spline': return 'Click points for the curve to pass through. Press Enter or click the last point again to finish.';
      case 'point': return 'Click to place a point.';
      case 'trim': return 'Click a piece of a curve to remove it, up to where it crosses something.';
      case 'sketch-fillet': return 'Click the corner where two lines meet, then type the radius.';
      case 'dimension': return 'Click something to see its size, pull it where you want it, and click. Click a second thing to measure between them.';
    }
  }
  if (mode() === 'pick-plane') return '';
  if (inAssembly()) return asmHint();
  if (pickKind() === 'regions') return `Click ${regionsTakeFaces() ? 'a flat face or a region' : 'a region'} to add it or drop it, or a sketch in the list for all of it. Right drag rotates, middle drag pans.`;
  if (pickKind() === 'sections') return 'Click profiles in the order the loft passes through them: regions in the view, or sketches in the list. Right drag rotates, middle drag pans.';
  if (pickKind() === 'axis') return 'Click a line of the sketch to turn around it. Right drag rotates, middle drag pans.';
  if (pickKind()) return 'Click to pick, click again to drop it, or drag a box. Right drag rotates, middle drag pans.';
  if (activeDef()) return 'The preview updates as you type. Dimensions can be expressions, like width / 2.';
  return 'Right drag rotates, middle drag pans, scroll zooms. Click to select, right-click for options, ? for keys.';
}

export function StatusBar() {
  const [slow, setSlow] = createSignal(false);
  createEffect(() => {
    if (!busy()) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 700);
    onCleanup(() => clearTimeout(t));
  });
  const size = () => {
    const s = doc.solid;
    if (!s) return '';
    return [0, 1, 2].map((i) => n(s.bounds_max[i] - s.bounds_min[i], 1)).join(' × ');
  };
  return (
    <footer class="statusbar" data-testid="status">
      <span class="status-left">{hoverText() || hint()}</span>
      <Show when={doc.failed}><span class="status-failed" title={doc.failed!}><Icon name="warn" size={13} />{doc.failed}</span></Show>
      <Show when={doc.solid && !doc.solid.valid}><span class="status-failed"><Icon name="warn" size={13} />This solid failed its checks</span></Show>
      <span class="status-right">
        <Show when={doc.solid}>
          <span data-testid="volume"><b>{n(doc.solid!.volume)}</b> mm³</span>
          <span><b>{n(doc.solid!.area)}</b> mm²</span>
          <span><b>{size()}</b> mm</span>
          <span><b>{doc.solid!.faces}</b> faces</span>
        </Show>
        <Show when={slow()} fallback={<span class="status-time">{doc.ms} ms</span>}>
          <button class="btn stop" onClick={stopEngine}><Icon name="stop" size={11} />Stop rebuild</button>
        </Show>
      </span>
    </footer>
  );
}
