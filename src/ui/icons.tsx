import { For, Show, type JSX } from 'solid-js';

/**
 * Drawn on a 20-unit grid in the language of a technical drawing: one-pixel lines with square corners, faces as a
 * faint tone, and what the tool acts on in the accent colour. Lines keep their weight at any size.
 *
 * l line, f face tone, n solid ink, d dashed construction line, a accent line, A accent face.
 */
type Part = ['l' | 'f' | 'n' | 'd' | 'a' | 'A', string];

const CIRCLE = (x: number, y: number, r: number) => `M${x} ${y - r}A${r} ${r} 0 1 0 ${x} ${y + r}A${r} ${r} 0 1 0 ${x} ${y - r}Z`;
const NODE = (x: number, y: number) => `M${x - 1} ${y - 1}h2v2h-2z`;
const BLOCK = 'M3 6.5L10 3L17 6.5V13.5L10 17L3 13.5Z';
const BLOCK_Y = 'M3 6.5L10 10L17 6.5M10 10V17';

const ICONS: Record<string, Part[]> = {
  // Modelling
  sketch: [['f', 'M2.5 15.5L7 5.5H17.5L13 15.5Z'], ['l', 'M2.5 15.5L7 5.5H17.5L13 15.5Z'], ['a', 'M6.5 13L9 8.5H13.5']],
  extrude: [['A', 'M3 16.5L6.5 13H17L13.5 16.5Z'], ['a', 'M3 16.5L6.5 13H17L13.5 16.5Z'], ['d', 'M3 16.5V8M13.5 16.5V8M17 13V4.5'], ['l', 'M10 11V3.5M7.5 6L10 3.5L12.5 6']],
  revolve: [['d', 'M4.5 2.5V17.5'], ['A', 'M4.5 7H9V13H4.5Z'], ['a', 'M4.5 7H9V13H4.5Z'], ['l', 'M11.5 3.5A6.5 6.5 0 0 1 11.5 16.5M11.5 16.5L14.5 14.5M11.5 16.5L14.8 17.8']],
  fillet: [['f', 'M3.5 16.5V9A5.5 5.5 0 0 1 9 3.5H16.5V16.5Z'], ['l', 'M3.5 16.5V9M9 3.5H16.5V16.5H3.5'], ['d', 'M3.5 9V3.5H9'], ['a', 'M3.5 9A5.5 5.5 0 0 1 9 3.5']],
  chamfer: [['f', 'M3.5 16.5V9L9 3.5H16.5V16.5Z'], ['l', 'M3.5 16.5V9M9 3.5H16.5V16.5H3.5'], ['d', 'M3.5 9V3.5H9'], ['a', 'M3.5 9L9 3.5']],
  shell: [['f', 'M3 6.5V13.5L10 17V10ZM17 6.5V13.5L10 17V10Z'], ['l', `${BLOCK}M3 6.5L10 10L17 6.5M10 10V17`], ['A', 'M6 6.5L10 4.6L14 6.5L10 8.4Z'], ['a', 'M6 6.5L10 4.6L14 6.5L10 8.4Z']],
  // Shapes, as they appear in the history of a part made by a file or an AI
  box: [['f', BLOCK], ['l', `${BLOCK}${BLOCK_Y}`]],
  iso: [['f', 'M3 6.5L10 10L17 6.5L10 3Z'], ['l', `${BLOCK}${BLOCK_Y}`]],
  cylinder: [['f', 'M4 5.5A6 2.5 0 1 0 16 5.5A6 2.5 0 1 0 4 5.5Z'], ['l', 'M4 5.5A6 2.5 0 1 0 16 5.5A6 2.5 0 1 0 4 5.5ZM4 5.5V14.5A6 2.5 0 0 0 16 14.5V5.5']],
  cone: [['l', 'M10 2.5L4 14.5A6 2.5 0 0 0 16 14.5ZM4 14.5A6 2.5 0 0 1 16 14.5']],
  sphere: [['l', `${CIRCLE(10, 10, 7)}M3 10A7 2.5 0 0 0 17 10`]],
  torus: [['l', 'M2 10A8 5 0 1 0 18 10A8 5 0 1 0 2 10ZM6.5 9.5A3.5 1.5 0 0 0 13.5 9.5A3.5 1.5 0 0 0 6.5 9.5Z']],
  import_step: [['l', `${BLOCK}${BLOCK_Y}`], ['A', 'M10 10L17 6.5V13.5L10 17Z']],
  // Sketching
  select: [['f', 'M5.5 2.5V15.5L8.7 12.6L11 17.5L13 16.6L10.7 11.8H15Z'], ['l', 'M5.5 2.5V15.5L8.7 12.6L11 17.5L13 16.6L10.7 11.8H15Z']],
  line: [['l', 'M5 15L15 5'], ['n', 'M3.5 13.5h3v3h-3zM13.5 3.5h3v3h-3z']],
  rect: [['l', 'M4.5 5.5H15.5V14.5H4.5Z'], ['n', `${NODE(4.5, 5.5)}${NODE(15.5, 5.5)}${NODE(15.5, 14.5)}${NODE(4.5, 14.5)}`]],
  circle: [['l', `${CIRCLE(10, 10, 6.5)}M10 8V12M8 10H12`]],
  arc: [['l', 'M4.5 15.5A11 11 0 0 1 15.5 4.5'], ['d', 'M4.5 15.5H15.5V4.5'], ['n', `${NODE(4.5, 15.5)}${NODE(15.5, 4.5)}`]],
  point: [['l', 'M10 3.5V7M10 13V16.5M3.5 10H7M13 10H16.5'], ['n', 'M8.5 8.5h3v3h-3z']],
  dimension: [['l', 'M3.5 5V15M16.5 5V15M3.5 10H16.5'], ['n', 'M3.5 10L7.5 8.2V11.8ZM16.5 10L12.5 8.2V11.8Z']],
  construction: [['d', 'M5 15L15 5'], ['n', 'M3.5 13.5h3v3h-3zM13.5 3.5h3v3h-3z']],
  // Constraints
  coincident: [['l', 'M3 16.5L10 10L17 13'], ['n', 'M8.5 8.5h3v3h-3z']],
  horizontal: [['l', 'M3.5 10H16.5M3.5 7V13M16.5 7V13']],
  vertical: [['l', 'M10 3.5V16.5M7 3.5H13M7 16.5H13']],
  parallel: [['l', 'M5 16.5L9 3.5M11 16.5L15 3.5']],
  perpendicular: [['l', 'M3.5 16.5H16.5M10 16.5V3.5M10 12.5H14V16.5']],
  equal: [['l', 'M4.5 7.5H15.5M4.5 12.5H15.5']],
  tangent: [['l', `${CIRCLE(10, 7.5, 5)}M3 12.5H17`]],
  concentric: [['l', `${CIRCLE(10, 10, 6.5)}${CIRCLE(10, 10, 3)}`]],
  midpoint: [['l', 'M3 14.5H17'], ['n', 'M10 14.5L6.8 8.5H13.2Z']],
  symmetric: [['d', 'M10 2.5V17.5'], ['l', 'M3.5 6L7.5 10L3.5 14M16.5 6L12.5 10L16.5 14']],
  fix: [['l', `${CIRCLE(10, 6, 2.5)}M10 8.5V12M4 16.5H16M6.5 16.5L10 12L13.5 16.5`]],
  // Interface
  undo: [['l', 'M7.5 4.5L3.5 8.5L7.5 12.5M3.5 8.5H12.5A4 4 0 0 1 12.5 16.5H9']],
  redo: [['l', 'M12.5 4.5L16.5 8.5L12.5 12.5M16.5 8.5H7.5A4 4 0 0 0 7.5 16.5H11']],
  search: [['l', `${CIRCLE(8.5, 8.5, 5)}M12.2 12.2L16.5 16.5`]],
  check: [['l', 'M4.5 10.5L8.5 14.5L15.5 5.5']],
  close: [['l', 'M5 5L15 15M15 5L5 15']],
  snap: [['l', 'M5 4V10A5 5 0 0 0 15 10V4H12V10A2 2 0 0 1 8 10V4Z'], ['n', 'M5 4h3v2.5h-3zM12 4h3v2.5h-3z']],
  plane: [['f', 'M3 14L6.5 6.5H17L13.5 14Z'], ['l', 'M3 14L6.5 6.5H17L13.5 14Z']],
  origin: [['l', `${CIRCLE(10, 10, 4.5)}M10 2.5V5.5M10 14.5V17.5M2.5 10H5.5M14.5 10H17.5`], ['n', 'M9 9h2v2h-2z']],
  part: [['f', BLOCK], ['l', `${BLOCK}${BLOCK_Y}`]],
  eye: [['l', `M2.5 10C5 6 7.5 5 10 5S15 6 17.5 10C15 14 12.5 15 10 15S5 14 2.5 10Z`], ['n', 'M8.5 8.5h3v3h-3z']],
  'eye-off': [['l', 'M2.5 10C5 6 7.5 5 10 5S15 6 17.5 10C15 14 12.5 15 10 15S5 14 2.5 10ZM4 16L16 4']],
  warn: [['l', 'M10 3.5L17.5 16.5H2.5ZM10 8V12.5M10 14V15.5']],
  plus: [['l', 'M10 4.5V15.5M4.5 10H15.5']],
  minus: [['l', 'M4.5 10H15.5']],
  download: [['l', 'M10 3.5V12.5M6.5 9.5L10 13L13.5 9.5M3.5 16.5H16.5']],
  import: [['l', 'M10 13V3.5M6.5 7L10 3.5L13.5 7M3.5 16.5H16.5']],
  fit: [['l', 'M3.5 7V3.5H7M13 3.5H16.5V7M16.5 13V16.5H13M7 16.5H3.5V13']],
  stop: [['n', 'M5.5 5.5h9v9h-9z']],
  caret: [['n', 'M5.5 8H14.5L10 13Z']],
};

const STYLE: Record<Part[0], JSX.PathSVGAttributes<SVGPathElement>> = {
  l: { fill: 'none', stroke: 'currentColor', 'stroke-width': 1 },
  f: { fill: 'currentColor', 'fill-opacity': 0.12 },
  n: { fill: 'currentColor' },
  d: { fill: 'none', stroke: 'currentColor', 'stroke-width': 1, 'stroke-dasharray': '2 1.5', 'stroke-opacity': 0.65 },
  a: { fill: 'none', stroke: 'var(--icon-accent)', 'stroke-width': 1.25 },
  A: { fill: 'var(--icon-accent)', 'fill-opacity': 0.28 },
};

/** The modelling tools' icons, one SVG file each, drawn on a 16-pixel grid so their lines land on whole pixels. */
const TOOL_ICONS = import.meta.glob('./tool-icons/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function Icon(props: { name: string; size?: number }) {
  const art = () => TOOL_ICONS[`./tool-icons/${props.name}.svg`];
  return (
    <Show
      when={art()}
      fallback={
        <svg class="icon" width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 20 20" stroke-linecap="butt" stroke-linejoin="miter" aria-hidden="true">
          <For each={ICONS[props.name] ?? []}>{([kind, d]) => <path d={d} vector-effect="non-scaling-stroke" {...STYLE[kind]} />}</For>
        </svg>
      }
    >
      <span class="icon tool-art" aria-hidden="true" innerHTML={art()} />
    </Show>
  );
}

export const iconForFeature = (f: { type?: string; shape?: string; direction?: unknown }) => {
  if (f.type === 'solid') return f.shape ?? 'box';
  if (f.type === 'constrained_sketch' || f.type === 'sketch') return 'sketch';
  if (f.type === 'pattern') return f.direction ? 'pattern-linear' : 'pattern-circular';
  const named: Record<string, string> = { delete_face: 'delete-face', delete_bodies: 'delete-part', copy_faces: 'copy-faces', fillet_radii: 'fillet', trim: 'trim-surface', import_step: 'import', import_step_parts: 'import' };
  if (f.type && named[f.type]) return named[f.type];
  const name = f.type ?? 'box';
  return TOOL_ICONS[`./tool-icons/${name}.svg`] || ICONS[name] ? name : 'box';
};
