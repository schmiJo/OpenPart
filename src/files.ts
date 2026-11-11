import { engine } from './engine/client';
import { doc, documentText, insertPosition, mutate, pushUndo, tidyError, UNTITLED } from './store/doc';
import { activeTab, activeTabId, openInTab } from './store/tabs';
import { toast } from './store/ui';

/** The file each Part Studio was opened from or saved to, so saving one never writes over another's. */
const handles = new Map<string, any>();
let lastPicked: any = null;

const safeName = () => [doc.title === UNTITLED ? '' : doc.title, activeTab()?.name].filter(Boolean).join(' - ').replace(/[^\w\- ]+/g, '').trim() || 'part';

async function saveBlob(blob: Blob, name: string, description: string, ext: string) {
  const picker = (window as any).showSaveFilePicker;
  if (picker) {
    try {
      const h = await picker({ suggestedName: name, types: [{ description, accept: { 'application/octet-stream': [ext] } }] });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return h;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return null;
}

function pickFile(accept: string, types: { description: string; accept: Record<string, string[]> }[]): Promise<File | null> {
  const picker = (window as any).showOpenFilePicker;
  if (picker) {
    return picker({ types })
      .then(async ([h]: any[]) => {
        lastPicked = h;
        return h.getFile();
      })
      .catch(() => null);
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export async function saveDocument() {
  const text = documentText();
  const tab = activeTabId();
  const handle = handles.get(tab);
  if (handle) {
    try {
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      toast(`Saved ${handle.name}`);
      return;
    } catch {
      handles.delete(tab);
    }
  }
  const h = await saveBlob(new Blob([text], { type: 'application/json' }), `${safeName()}.coreshape`, 'CoreShape document', '.coreshape');
  if (h) {
    handles.set(tab, h);
    toast(`Saved ${h.name}`);
  }
}

export async function openFile() {
  lastPicked = null;
  const f = await pickFile('.coreshape,.json', [{ description: 'CoreShape document', accept: { 'application/json': ['.coreshape', '.json'] } }]);
  if (!f) return;
  try {
    await openInTab(await f.text(), f.name.replace(/\.[^.]+$/, ''));
    if (lastPicked) handles.set(activeTabId(), lastPicked);
  } catch (e) {
    toast(`${f.name} couldn't be opened. ${(e as Error).message}`, 'error');
  }
}

export async function importStep() {
  const f = await pickFile('.step,.stp', [{ description: 'STEP file', accept: { 'application/step': ['.step', '.stp'] } }]);
  if (!f) return;
  const before = documentText();
  try {
    const r = await mutate('feature_add', { feature: { type: 'import_step', text: await f.text(), mode: 'add' }, name: f.name.replace(/\.[^.]+$/, ''), position: insertPosition() });
    const id = Number(/\(id (\d+)\)/.exec(r.text)?.[1]);
    const step = doc.steps.find((s) => s.id === id);
    if (step?.state === 'failed') toast(`${f.name} couldn't be read. ${tidyError(step.error ?? '')}`, 'error');
    pushUndo(before);
  } catch (e) {
    toast(`${f.name} couldn't be read. ${(e as Error).message}`, 'error');
  }
}

export async function exportStep() {
  const r = await engine.call('export', { format: 'step' });
  if (!r.ok) return toast(r.text, 'error');
  await saveBlob(new Blob([r.text], { type: 'application/step' }), `${safeName()}.step`, 'STEP file', '.step');
}

export async function exportStl() {
  const bytes = await engine.stl();
  if (!bytes.length) return toast('There is no solid to export yet.', 'error');
  await saveBlob(new Blob([bytes as BlobPart], { type: 'model/stl' }), `${safeName()}.stl`, 'STL file', '.stl');
}

/** A small part built only through the tool layer, the same way an AI would build it. */
export async function loadExample() {
  const sketch = {
    format: 'coreshape-sketch',
    version: 1,
    entities: [
      [[0, 0], [40, 0]], [[40, 0], [40, 8]], [[40, 8], [8, 8]], [[8, 8], [8, 45]], [[8, 45], [0, 45]], [[0, 45], [0, 0]],
    ].map(([start, end], i) => ({ id: i + 1, type: 'line', start, end })),
    constraints: [] as any[],
  };
  const add = (c: any) => sketch.constraints.push({ id: sketch.constraints.length + 1, ...c });
  for (let i = 1; i <= 6; i++) add({ type: 'coincident', a: `${i}.end`, b: `${(i % 6) + 1}.start` });
  add({ type: 'coincident', a: '1.start', b: 'origin' });
  [1, 3, 5].forEach((a) => add({ type: 'horizontal', a: String(a) }));
  [2, 4, 6].forEach((a) => add({ type: 'vertical', a: String(a) }));
  add({ type: 'distance', a: '1', value: 'depth' });
  add({ type: 'distance', a: '2', value: 'wall' });
  add({ type: 'distance', a: '5', value: 'wall' });
  add({ type: 'distance', a: '6', value: 'height' });
  const before = documentText();
  await mutate('document_new');
  for (const [name, value] of [['width', 60], ['depth', 40], ['height', 45], ['wall', 8], ['hole', 9]]) await mutate('parameter_set', { name, value });
  await mutate('feature_add', { name: 'Section', feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] }, sketch } });
  await mutate('feature_add', { name: 'Body', feature: { type: 'extrude', sketch: 1, start: '-width', length: 'width' } });
  const edges = JSON.parse((await engine.call('edges_list')).text);
  const inner = edges.find((e: any) => {
    const s = new Set(e.name.split('|'));
    return s.size === 2 && s.has('f2:side.3') && s.has('f2:side.4');
  });
  await mutate('feature_add', { name: 'Inner round', feature: { type: 'fillet', edges: inner.select, radius: 6 } });
  await mutate('feature_add', { name: 'Hole positions', feature: { type: 'sketch', regions: [{ outer: { type: 'circle', cx: 26, cy: 'width * 0.25', r: 'hole / 2' } }, { outer: { type: 'circle', cx: 26, cy: 'width * 0.75', r: 'hole / 2' } }] } });
  await mutate('feature_add', { name: 'Holes', feature: { type: 'extrude', sketch: 4, start: -1, length: 'wall + 2', mode: 'remove' } });
  pushUndo(before);
  handles.delete(activeTabId());
}
