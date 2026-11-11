import { acceptDialog, activeDef, cancelDialog, startFeature } from './features/dialog';
import { exportStep, exportStl, importStep, loadExample, openFile, saveDocument } from './files';
import { finishSketch, looksAtSketch, normalTo, session, startSketch } from './sketch/controller';
import { PLANES, planeFromPlacement, planeOnFace, type Plane } from './sketch/geometry';
import { asmKey } from './assembly/interaction';
import { MATE_TYPES } from './assembly/model';
import { asm, asmCanRedo, asmCanUndo, asmRedo, asmUndo, openInsert, startMate } from './assembly/store';
import { mateTypeName } from './assembly/solver';
import { canRedo, canUndo, deleteFeature, doc, faceList, mesh, redo, undo } from './store/doc';
import { createTab, inAssembly, openBlankStudio, toggleTabManager } from './store/tabs';
import { clearSelection, glProblem, mode, paletteOpen, selectedFeature, selectedGeometry, selectedRegions, selection, setMode, setPaletteOpen, setShortcutsOpen, setSketchesHidden, shortcutsOpen, sketchesHidden, toast, togglePlanes, toggleSnaps } from './store/ui';
import { view } from './viewport/instance';
import { cross, normalize, type V3 } from './viewport/math';

export interface Command {
  id: string;
  title: string;
  icon: string;
  keys?: string;
  group: string;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

const notSketching = () => mode() !== 'sketch' && !glProblem();
const inPart = () => notSketching() && !inAssembly();
const inAsm = () => notSketching() && inAssembly();
const hasSolid = () => doc.solid !== null;
const sketchCount = () => doc.features.filter((f) => (f.type === 'constrained_sketch' || f.type === 'sketch') && !(f.name ?? '').startsWith('~')).length;
const hasSketch = () => sketchCount() > 0;
const hasSheet = () => !!mesh()?.parts.some((p) => p.sheet);
const partCount = () => mesh()?.parts.length ?? 0;

export function fitView() {
  const r = view.renderer;
  const m = mesh();
  if (!r) return;
  if (m && m.indices.length) r.camera.fitBox(m.min, m.max);
  else r.camera.animateTo({ target: [0, 0, 0], halfH: 70 });
}

export function setView(name: string) {
  const r = view.renderer;
  if (!r) return;
  const rot = r.camera.viewRot(name);
  const m = mesh();
  if (m && m.indices.length) r.camera.fitBox(m.min, m.max, 340, rot);
  else r.camera.animateTo({ rot }, 340);
}

/** Looks along a direction with Z up, for the cube's edges and corners. */
export function setViewDirection(back: V3) {
  const r = view.renderer;
  if (!r) return;
  const right = normalize(cross([0, 0, 1], back));
  const rot = r.camera.rotFromBasis(right, cross(back, right), back);
  const m = mesh();
  if (m && m.indices.length) r.camera.fitBox(m.min, m.max, 340, rot);
  else r.camera.animateTo({ rot }, 340);
}

/** The plane a sketch or a normal view would use, from what's selected. */
async function selectedPlane(): Promise<Plane | null> {
  const g = selectedGeometry();
  if (typeof g === 'number') return PLANES[g - 1]?.plane ?? null;
  const picked = selectedRegions();
  if (picked) return planeFromPlacement(doc.features.find((f) => f.id === picked.sketch)?.plane, doc.env);
  const sel = selection();
  if (sel.faces.length === 1) {
    const f = (await faceList())[sel.faces[0]];
    if (f?.surface === 'plane') return planeOnFace(f.center, f.normal);
  }
  return null;
}

/** Starts a sketch on what's selected, or asks for a plane. */
export async function beginSketch() {
  const plane = await selectedPlane();
  if (plane) return startSketch(plane);
  await cancelDialog();
  setMode('pick-plane');
}

export async function viewNormal() {
  if (session()) return looksAtSketch();
  const plane = await selectedPlane();
  if (plane) normalTo(plane);
  else toast('Select a plane or a flat face first.');
}

export const COMMANDS: Command[] = [
  { id: 'sketch', title: 'Sketch', icon: 'sketch', keys: 'Shift S', group: 'Model', enabled: inPart, run: beginSketch },
  { id: 'extrude', title: 'Extrude', icon: 'extrude', keys: 'Shift E', group: 'Model', enabled: () => inPart() && hasSketch(), run: () => startFeature('extrude') },
  { id: 'revolve', title: 'Revolve', icon: 'revolve', group: 'Model', enabled: () => inPart() && hasSketch(), run: () => startFeature('revolve') },
  { id: 'fillet', title: 'Fillet', icon: 'fillet', keys: 'G', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('fillet') },
  { id: 'chamfer', title: 'Chamfer', icon: 'chamfer', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('chamfer') },
  { id: 'shell', title: 'Shell', icon: 'shell', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('shell') },
  { id: 'sweep', title: 'Sweep', icon: 'sweep', group: 'Model', enabled: () => inPart() && hasSketch(), run: () => startFeature('sweep') },
  { id: 'helix', title: 'Helix', icon: 'helix', group: 'Model', enabled: () => inPart() && hasSketch(), run: () => startFeature('helix') },
  { id: 'loft', title: 'Loft', icon: 'loft', group: 'Model', enabled: () => inPart() && sketchCount() >= 2, run: () => startFeature('loft') },
  { id: 'draft', title: 'Draft', icon: 'draft', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('draft') },
  { id: 'offset', title: 'Offset', icon: 'offset', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('offset') },
  { id: 'thicken', title: 'Thicken', icon: 'thicken', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('thicken') },
  { id: 'delete-face', title: 'Delete face', icon: 'delete-face', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('delete-face') },
  { id: 'mirror', title: 'Mirror', icon: 'mirror', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('mirror') },
  { id: 'pattern-linear', title: 'Linear pattern', icon: 'pattern-linear', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('pattern-linear') },
  { id: 'pattern-circular', title: 'Circular pattern', icon: 'pattern-circular', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('pattern-circular') },
  { id: 'copy-faces', title: 'Copy faces', icon: 'copy-faces', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('copy-faces') },
  { id: 'transform', title: 'Transform', icon: 'transform', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('transform') },
  { id: 'boolean', title: 'Boolean', icon: 'boolean', group: 'Model', enabled: () => inPart() && partCount() >= 2, run: () => startFeature('boolean') },
  { id: 'delete-bodies', title: 'Delete part', icon: 'delete-part', group: 'Model', enabled: () => inPart() && hasSolid(), run: () => startFeature('delete-bodies') },
  { id: 'fill', title: 'Fill', icon: 'fill', group: 'Surface', enabled: () => inPart() && hasSketch(), run: () => startFeature('fill') },
  { id: 'sew', title: 'Sew', icon: 'sew', group: 'Surface', enabled: () => inPart() && hasSheet(), run: () => startFeature('sew') },
  { id: 'trim-surface', title: 'Trim surface', icon: 'trim-surface', group: 'Surface', enabled: () => inPart() && hasSheet(), run: () => startFeature('trim') },
  { id: 'undo', title: 'Undo', icon: 'undo', keys: 'Ctrl Z', group: 'Edit', enabled: () => (inAssembly() ? asmCanUndo() : session() ? session()!.canUndo[0]() : canUndo()), run: () => (inAssembly() ? asmUndo() : session() ? session()!.undo() : undo()) },
  { id: 'redo', title: 'Redo', icon: 'redo', keys: 'Ctrl Shift Z', group: 'Edit', enabled: () => (inAssembly() ? asmCanRedo() : session() ? session()!.canRedo[0]() : canRedo()), run: () => (inAssembly() ? asmRedo() : session() ? session()!.redo() : redo()) },
  { id: 'new', title: 'Create Part Studio', icon: 'part-studio', group: 'File', enabled: notSketching, run: () => createTab('part-studio') },
  { id: 'tab.assembly', title: 'Create Assembly', icon: 'assembly', group: 'File', enabled: notSketching, run: () => createTab('assembly') },
  { id: 'tab.folder', title: 'Create folder', icon: 'folder', group: 'File', enabled: notSketching, run: () => createTab('folder') },
  { id: 'open', title: 'Open file as a Part Studio', icon: 'import', keys: 'Ctrl O', group: 'File', enabled: notSketching, run: openFile },
  { id: 'save', title: 'Save this Part Studio to a file', icon: 'download', keys: 'Ctrl S', group: 'File', enabled: inPart, run: saveDocument },
  { id: 'import', title: 'Import STEP', icon: 'import', group: 'File', enabled: inPart, run: importStep },
  { id: 'export.step', title: 'Export STEP', icon: 'download', group: 'File', enabled: () => inPart() && hasSolid(), run: exportStep },
  { id: 'export.stl', title: 'Export STL', icon: 'download', group: 'File', enabled: () => inPart() && hasSolid(), run: exportStl },
  { id: 'example', title: 'Open the example bracket', icon: 'iso', group: 'File', enabled: notSketching, run: async () => { await openBlankStudio('Angle bracket'); await loadExample(); setView('iso'); } },
  { id: 'fit', title: 'Fit to window', icon: 'fit', keys: 'F', group: 'View', run: fitView },
  { id: 'view.iso', title: 'Isometric view', icon: 'iso', keys: '0', group: 'View', run: () => setView('iso') },
  { id: 'view.top', title: 'Top view', icon: 'plane', keys: '1', group: 'View', run: () => setView('top') },
  { id: 'view.front', title: 'Front view', icon: 'plane', keys: '2', group: 'View', run: () => setView('front') },
  { id: 'view.right', title: 'Right view', icon: 'plane', keys: '3', group: 'View', run: () => setView('right') },
  { id: 'view.back', title: 'Back view', icon: 'plane', group: 'View', run: () => setView('back') },
  { id: 'view.left', title: 'Left view', icon: 'plane', group: 'View', run: () => setView('left') },
  { id: 'view.bottom', title: 'Bottom view', icon: 'plane', group: 'View', run: () => setView('bottom') },
  { id: 'view.normal', title: 'Normal to sketch, plane or face', icon: 'plane', keys: 'N', group: 'View', run: viewNormal },
  { id: 'view.planes', title: 'Show or hide planes', icon: 'plane', keys: 'P', group: 'View', run: togglePlanes },
  { id: 'view.sketches', title: 'Show or hide sketches', icon: 'sketch', keys: 'Shift H', group: 'View', run: () => setSketchesHidden(!sketchesHidden()) },
  { id: 'tab.manager', title: 'Tab manager', icon: 'tab-manager', group: 'View', run: toggleTabManager },
  { id: 'asm.insert', title: 'Insert parts', icon: 'insert', keys: 'I', group: 'Assembly', enabled: inAsm, run: openInsert },
  ...MATE_TYPES.map((t): Command => ({ id: `asm.mate.${t}`, title: `${mateTypeName(t)} mate`, icon: `mate-${t}`, keys: t === 'fastened' ? 'M' : undefined, group: 'Assembly', enabled: () => inAsm() && asm().instances.length >= 2, run: () => startMate(t) })),
  { id: 'shortcuts', title: 'Keyboard shortcuts', icon: 'search', keys: '?', group: 'View', run: () => setShortcutsOpen(true) },
  { id: 'palette', title: 'Search commands', icon: 'search', keys: 'Ctrl K', group: 'View', run: () => setPaletteOpen(true) },
];

export const command = (id: string) => COMMANDS.find((c) => c.id === id)!;

function typing(target: EventTarget | null) {
  const t = target as HTMLElement | null;
  if (t?.tagName === 'INPUT' && ['checkbox', 'range'].includes((t as HTMLInputElement).type)) return false;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

const runIfAllowed = (id: string) => {
  const c = command(id);
  if (!c.enabled || c.enabled()) void c.run();
};

export function handleKey(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (paletteOpen() || shortcutsOpen()) return;
  if (ctrl && key === 'k') {
    e.preventDefault();
    setPaletteOpen(true);
    return;
  }
  if (ctrl && key === 's') {
    e.preventDefault();
    if (inPart()) void saveDocument();
    return;
  }
  if (ctrl && key === 'o') {
    e.preventDefault();
    if (notSketching()) void openFile();
    return;
  }
  if (typing(e.target)) return;
  if (ctrl && key === 'z') {
    e.preventDefault();
    runIfAllowed(e.shiftKey ? 'redo' : 'undo');
    return;
  }
  if (ctrl && key === 'y') {
    e.preventDefault();
    runIfAllowed('redo');
    return;
  }
  if (e.key === '?') {
    setShortcutsOpen(true);
    return;
  }
  const s = session();
  if (s) {
    if (ctrl && key === 'enter') {
      e.preventDefault();
      void finishSketch();
      return;
    }
    if (ctrl || e.altKey) return;
    if (e.shiftKey && key === 'e') {
      void finishSketch().then(() => startFeature('extrude'));
      return;
    }
    if (e.shiftKey && key === 'h') {
      setSketchesHidden(!sketchesHidden());
      return;
    }
    if (e.shiftKey) {
      const shifted: Record<string, Parameters<typeof s.setTool>[0]> = { r: 'rect-center', c: 'circle-3pt', a: 'arc-center', t: 'arc-tangent', f: 'sketch-fillet' };
      if (shifted[key]) return s.setTool(shifted[key]);
    }
    const tools: Record<string, Parameters<typeof s.setTool>[0]> = { v: 'select', l: 'line', r: 'rect', c: 'circle', a: 'arc', s: 'spline', p: 'point', t: 'trim', d: 'dimension' };
    if (tools[key]) return s.setTool(tools[key]);
    if (key === 'm') return toggleSnaps();
    if (key === 'enter') return s.enterKey();
    if (key === 'escape') {
      if (!s.escape()) void finishSketch();
      return;
    }
    if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      s.deleteSelection();
      return;
    }
    if (key === 'q') return s.toggleConstruction();
    if (key === 'h') return s.addConstraint('horizontal');
    if (key === 'i') return s.addConstraint('vertical');
    if (key === 'f') return fitView();
    if (key === 'n') return looksAtSketch();
    return;
  }
  if (inAssembly() && asmKey(key)) {
    e.preventDefault();
    return;
  }
  if (key === 'escape') {
    if (mode() === 'pick-plane') setMode('part');
    else if (activeDef()) void cancelDialog();
    else clearSelection();
    return;
  }
  if (key === 'enter' && activeDef()) {
    void acceptDialog();
    return;
  }
  if (ctrl || e.altKey) return;
  if ((key === 'delete' || key === 'backspace') && !activeDef()) {
    const id = selectedFeature();
    if (id !== null) {
      e.preventDefault();
      deleteFeature(id).then(clearSelection).catch((err) => toast((err as Error).message, 'error'));
    }
    return;
  }
  if (e.shiftKey && key === 'h') return runIfAllowed('view.sketches');
  if (inAssembly() && key === 'i') return runIfAllowed('asm.insert');
  if (inAssembly() && key === 'm') return runIfAllowed('asm.mate.fastened');
  const single: Record<string, string> = { s: 'sketch', e: 'extrude', g: 'fillet', f: 'fit', n: 'view.normal', p: 'view.planes', '0': 'view.iso', '1': 'view.top', '2': 'view.front', '3': 'view.right' };
  if (single[key]) runIfAllowed(single[key]);
}
