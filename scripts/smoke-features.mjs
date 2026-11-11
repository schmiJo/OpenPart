// The kernel's newer features through their dialogs: extrude ends and regions from several sketches, revolve about a
// line, sweep, helix, transform, boolean, surfaces, and older documents' hidden sketch copies being upgraded.
// Usage: node scripts/smoke-features.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-features';
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`page: ${e.message}`));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const settle = async (ms = 250) => { await wait(ms); await page.waitForFunction(() => !document.querySelector('.spinner')); await wait(60); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const cmd = async (id) => { await page.$eval(`[data-command="${id}"]`, (e) => e.click()); await settle(500); };
const clickAt = async (x, y) => { await page.mouse.move(x, y); await wait(16); await page.mouse.down(); await page.mouse.up(); await wait(40); };
const state = () => page.evaluate(() => {
  const d = window.schmishape.doc;
  return {
    features: JSON.parse(JSON.stringify(d.features)),
    steps: d.steps.map((s) => ({ id: s.id, name: s.name, state: s.state, error: s.error })),
    volume: d.solid?.volume ?? 0,
    valid: d.solid?.valid ?? null,
    failed: d.failed,
    parts: (window.schmishape.mesh()?.parts ?? []).map((p) => ({ name: p.name, sheet: p.sheet })),
  };
});
const last = (s) => s.features[s.features.length - 1];
const ok = () => page.$eval('[data-testid=dialog-ok]', (e) => e.click());
const accept = async () => { await ok(); await settle(500); };
const dialogOpen = () => page.$('[data-testid=dialog]').then((e) => !!e);
const okEnabled = () => page.$eval('[data-testid=dialog-ok]', (e) => !e.disabled);
const dialogError = () => page.$eval('[data-testid=dialog-error]', (e) => e.textContent).catch(() => null);
const mutate = (tool, args) => page.evaluate((t, a) => window.schmishape.mutate(t, a).then((r) => r.text), tool, args);
const select = async (field, value) => { await page.select(`[data-field=${field}]`, value); await settle(450); };
const clickTab = async (name) => { await page.$$eval('.dialog-tabs button', (b, n) => b.find((x) => x.textContent === n).click(), name); await settle(400); };
const clickSegment = async (label, name) => { await page.$$eval(`[aria-label="${label}"] button`, (b, n) => b.find((x) => x.textContent === n).click(), name); await settle(400); };
const typeInto = async (field, text) => { await page.$eval(`[data-field=${field}]`, (e) => { e.focus(); e.select(); }); await page.keyboard.type(text); await settle(400); };
const toScreen = (x, y, z = 0) => page.evaluate((p) => {
  const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
  const q = window.schmishape.view.renderer.camera.project(p);
  return [q[0] + b.left, q[1] + b.top];
}, [x, y, z]);
const clickWorld = async (x, y, z = 0) => { const [a, b] = await toScreen(x, y, z); await clickAt(a, b); await settle(200); };
const activeBox = () => page.$eval('[aria-current=true][data-pick]', (e) => e.dataset.pick).catch(() => null);
const rows = (key) => page.$$eval(`[data-pick=${key}] .pick-row .pick-name`, (n) => n.map((x) => x.textContent));
const fit = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('f'); await settle(400); };

const sketch = (entities, origin = [0, 0, 0]) => ({ type: 'constrained_sketch', plane: { origin }, sketch: { format: 'coreshape-sketch', version: 1, entities, constraints: [] } });
const rect = (id, x, y, w, h) => [
  { id, type: 'line', start: [x, y], end: [x + w, y] }, { id: id + 1, type: 'line', start: [x + w, y], end: [x + w, y + h] },
  { id: id + 2, type: 'line', start: [x + w, y + h], end: [x, y + h] }, { id: id + 3, type: 'line', start: [x, y + h], end: [x, y] },
];
const circle = (id, cx, cy, r) => ({ id, type: 'circle', center: [cx, cy], radius: r });
const fresh = async () => { await mutate('document_new', {}); await settle(300); };

await page.goto(url, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.schmishape?.engine);
await settle(800);

console.log('Older documents with hidden sketch copies');
{
  const ents = [...rect(1, 0, 0, 40, 30), circle(5, 70, 15, 8)];
  const base = sketch(ents);
  const arr = await page.evaluate((s) => window.schmishape.engine.call('sketch_arrangement', { sketch: s }).then((r) => JSON.parse(r.text)), base.sketch);
  const circleId = arr.regions.find((r) => Math.abs(r.area - Math.PI * 64) < 1).id;
  const legacy = {
    format: 'coreshape-document', version: 1, units: 'mm', next_id: 7, parameters: [],
    features: [
      { id: 1, name: 'Sketch 1', ...base },
      { id: 2, name: '~regions:1 1', type: 'constrained_sketch', plane: base.plane, sketch: { ...base.sketch, picked_regions: [circleId] } },
      { id: 3, name: 'Extrude 1', type: 'extrude', sketch: 2, length: 10, mode: 'new_body' },
      { id: 4, name: '~axis:1', type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, 1, 0], x: [1, 0, 0] }, sketch: base.sketch },
      { id: 5, name: 'Revolve 1', type: 'revolve', sketch: 4, degrees: 90, mode: 'new_body' },
      { id: 6, name: 'Fillet 1', type: 'fillet', edges: { between: ['f3:end', 'f3:side.5'] }, radius: 1 },
    ],
  };
  const text = JSON.stringify(legacy);
  const before = await page.evaluate((t) => window.schmishape.engine.call('document_open', { text: t }).then((r) => JSON.parse(r.text.slice(r.text.indexOf('{')))), text);
  check('the old document builds as it is', before.features.every((f) => f.state !== 'failed' && f.state !== 'blocked'), JSON.stringify(before.features.map((f) => f.state)));
  await mutate('document_open', { text });
  await settle(400);
  const s = await state();
  check('opening it leaves no hidden copies', !s.features.some((f) => f.name.startsWith('~')), s.features.map((f) => f.name).join(', '));
  const ex = s.features.find((f) => f.name === 'Extrude 1');
  check('the extrude takes its region from the sketch itself', ex?.sketch === 1 && JSON.stringify(ex.regions) === JSON.stringify([circleId]), JSON.stringify(ex));
  const rv = s.features.find((f) => f.name === 'Revolve 1');
  check('the revolve turns about the sketch’s vertical axis', rv?.sketch === 1 && JSON.stringify(rv.axis) === JSON.stringify({ point: [0, 0], direction: [0, 1] }), JSON.stringify(rv));
  check('the shape is the same', near(s.volume, before.solid.volume, 1e-6), `${s.volume} vs ${before.solid.volume}`);
  check('and the fillet still finds its edge', s.steps.every((x) => x.state !== 'failed' && x.state !== 'blocked'), JSON.stringify(s.steps));
}

const edit = async (id) => { await page.$eval(`[data-feature="${id}"]`, (e) => e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle(700); };
const regionId = (s, sketchId, area) => page.evaluate((id, a) => window.schmishape.sketchRegions().get(id).find((r) => Math.abs(r.area - a) < 1).id, sketchId, area);

console.log('Extrude: regions of two sketches, and where it ends');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 100, dy: 60, dz: 10, at: { origin: [0, 0, 30] }, mode: 'new_body' }, name: 'Ceiling' });
  await mutate('feature_add', { feature: sketch([...rect(1, 0, 0, 40, 30), circle(5, 70, 15, 8)]), name: 'Sketch 1' });
  await mutate('feature_add', { feature: sketch([circle(1, 20, 45, 5)]), name: 'Sketch 2' });
  await settle(300);
  await fit();
  await cmd('extrude');
  check('the dialog opens with the regions box taking clicks', (await activeBox()) === 'regions', `${await activeBox()}`);
  check('Solid and Surface are the top tabs', JSON.stringify(await page.$$eval('.dialog-tabs button', (b) => b.map((x) => x.textContent))) === '["Solid","Surface"]');
  const crowded = await page.$$eval('[aria-label=Result] button', (b) => b.filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent));
  check('every Result button has room for its word', crowded.length === 0, JSON.stringify(crowded));
  // New, so that each one's volume counts on its own and the ends can be told apart.
  await clickSegment('Result', 'New');
  await clickWorld(70, 15, 0);
  await clickWorld(20, 45, 0);
  let r = await rows('regions');
  check('a region of each sketch is picked', r.length === 2 && r[0] === 'Region of Sketch 1' && r[1] === 'All of Sketch 2', JSON.stringify(r));
  await select('end', 'up_to_face');
  check('choosing Up to face hands the clicks to its box', (await activeBox()) === 'endFace', `${await activeBox()}`);
  check('and it can’t be added until a face is picked', !(await okEnabled()));
  await shot('extrude-up-to-face-waiting');
  await clickWorld(50, 30, 40);
  r = await rows('endFace');
  check('a click on the top of the box picks it', r.length === 1 && r[0] === 'Flat face', JSON.stringify(r));
  await shot('extrude-up-to-face');
  await accept();
  let s = await state();
  const ex = last(s);
  const a = await regionId(s, 2, Math.PI * 64), b = await regionId(s, 3, Math.PI * 25);
  check('the extrude lists both sketches’ regions', ex.sketch === 2 && JSON.stringify(ex.regions) === JSON.stringify([a, { sketch: 3, region: b }]), JSON.stringify(ex.regions));
  check('and ends at the face', JSON.stringify(ex.end) === JSON.stringify({ type: 'up_to_face', face: 'f1:end' }), JSON.stringify(ex.end));
  const box = 100 * 60 * 10;
  const want = box + Math.PI * (64 + 25) * 40;
  check('both reach the top of the box', near(s.volume, want, 2e-3) && !s.failed, `${s.volume} vs ${want}`);
  check('no hidden sketches were made', !s.features.some((f) => f.name.startsWith('~')));

  await edit(ex.id);
  check('editing reads it back', JSON.stringify(await rows('regions')) === JSON.stringify(['Region of Sketch 1', 'All of Sketch 2']) && (await page.$eval('[data-field=end]', (e) => e.value)) === 'up_to_face', JSON.stringify(await rows('regions')));
  await select('end', 'through_all');
  check('Through all needs nothing more', await okEnabled());
  s = await state();
  check('and goes through the box', near(s.volume, 100 * 60 * 10 + Math.PI * (64 + 25) * 40, 2e-3), `${s.volume}`);
  await select('end', 'up_to_part');
  check('Up to part takes the clicks', (await activeBox()) === 'endPart');
  await clickWorld(50, 30, 40);
  r = await rows('endPart');
  check('a click on the box picks the part', JSON.stringify(r) === '["Part 1"]', JSON.stringify(r));
  s = await state();
  check('which stops at its near side', near(s.volume, 100 * 60 * 10 + Math.PI * (64 + 25) * 30, 2e-3) && JSON.stringify(last(s).end) === JSON.stringify({ type: 'up_to_part', part: 'f1' }), `${s.volume} ${JSON.stringify(last(s).end)}`);
  await select('end', 'up_to_vertex');
  await clickWorld(97, 60, 40);
  r = await rows('endVertex');
  s = await state();
  check('Up to vertex picks the corner nearest the click', r.length === 1 && JSON.stringify(last(s).end?.vertex?.near) === '[100,60,40]', `${JSON.stringify(r)} ${JSON.stringify(last(s).end)}`);
  check('and stops level with it', near(s.volume, 100 * 60 * 10 + Math.PI * (64 + 25) * 40, 2e-3), `${s.volume}`);
  await select('end', 'blind');
  await page.$eval('[data-pick=regions]', (e) => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle(200);
  check('clicking the regions box gives it the clicks back', (await activeBox()) === 'regions');
  await clickWorld(20, 45, 0);
  r = await rows('regions');
  check('so a click drops Sketch 2', JSON.stringify(r) === '["Region of Sketch 1"]', JSON.stringify(r));
  await accept();
  s = await state();
  check('a blind extrude of one region has no end written', last(s).end === undefined && JSON.stringify(last(s).regions) === JSON.stringify([a]), JSON.stringify(last(s)));
}

console.log('Revolve about a line of the sketch');
{
  await fresh();
  const ents = [...rect(1, 10, 0, 20, 30), { id: 9, type: 'line', start: [-5, 0], end: [-5, 30], construction: true }];
  await mutate('feature_add', { feature: sketch(ents), name: 'Profile' });
  await settle(300);
  await fit();
  await cmd('revolve');
  let s = await state();
  check('a revolve starts about the sketch’s vertical axis', near(s.volume, Math.PI * (30 ** 2 - 10 ** 2) * 30, 1e-3), `${s.volume}`);
  await shot('revolve-default');
  await clickWorld(-5, 15, 0);
  s = await state();
  check('clicking the line makes it the axis', last(s).app?.axis === 'line:9' && JSON.stringify(last(s).axis) === JSON.stringify({ point: [-5, 0], direction: [0, 30] }), JSON.stringify(last(s).axis));
  check('which makes a bigger ring', near(s.volume, Math.PI * (35 ** 2 - 15 ** 2) * 30, 1e-3), `${s.volume}`);
  check('the dropdown says which line', (await page.$eval('[data-field=axis]', (e) => e.selectedOptions[0].textContent)).startsWith('Construction line'));
  await shot('revolve-line');
  await accept();
  const moved = [...rect(1, 10, 0, 20, 30), { id: 9, type: 'line', start: [-10, 0], end: [-10, 30], construction: true }];
  await mutate('feature_edit', { id: 1, feature: sketch(moved) });
  await settle(300);
  s = await state();
  check('moving the line takes the axis with it', JSON.stringify(last(s).axis) === JSON.stringify({ point: [-10, 0], direction: [0, 30] }) && near(s.volume, Math.PI * (40 ** 2 - 20 ** 2) * 30, 1e-3), `${JSON.stringify(last(s).axis)} ${s.volume}`);
  await edit(last(s).id);
  check('editing it shows the line', (await page.$eval('[data-field=axis]', (e) => e.value)) === 'line:9');
  await select('axis', 'x_axis');
  s = await state();
  check('the horizontal axis can be chosen instead', JSON.stringify(last(s).axis) === JSON.stringify({ point: [0, 0], direction: [1, 0] }), JSON.stringify(last(s).axis));
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log('Sweep and helix');
{
  await fresh();
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 3)]), name: 'Profile' });
  await settle(300);
  await cmd('sweep');
  let s = await state();
  const length = 30 + 20 * Math.PI / 2;
  check('a sweep goes straight on and bends', near(s.volume, Math.PI * 9 * length, 5e-3) && s.valid, `${s.volume} vs ${Math.PI * 9 * length}`);
  await page.$$eval('.step-add button', (b) => b.find((x) => x.textContent === 'Add straight').click());
  await settle(500);
  await page.$eval('[data-step="2.length"]', (e) => { e.focus(); e.select(); });
  await page.keyboard.type('15');
  await settle(500);
  s = await state();
  check('a step added to the path carries it on', JSON.stringify(last(s).path[2]) === JSON.stringify({ line: 15 }) && near(s.volume, Math.PI * 9 * (length + 15), 5e-3), `${JSON.stringify(last(s).path)} ${s.volume}`);
  await shot('sweep');
  const squeezed = await page.$$eval('.step-input input', (i) => i.filter((x) => x.clientWidth < 18).length);
  check('every step’s boxes have room for a number', squeezed === 0, `${squeezed} too narrow`);
  await accept();

  await fresh();
  await mutate('feature_add', { feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, -1, 0], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [circle(1, 10, 0, 1)], constraints: [] } }, name: 'Wire' });
  await settle(300);
  await cmd('helix');
  await typeInto('pitch', '6');
  s = await state();
  const turn = Math.hypot(2 * Math.PI * 10, 6);
  check('a helix winds the sketch round the axis', last(s).type === 'helix' && near(s.volume, Math.PI * 4 * turn, 0.02) && s.valid, `${s.volume} vs ${Math.PI * 4 * turn}`);
  await fit();
  await shot('helix');
  await accept();
  check('the helix is added', !(await dialogOpen()) && last(await state()).type === 'helix');
}

console.log('Surfaces');
{
  await fresh();
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 20, 20)), name: 'Bottom' });
  await mutate('feature_add', { feature: sketch(rect(1, 0, 0, 20, 20), [0, 0, 10]), name: 'Top' });
  await settle(300);
  await page.evaluate(() => window.schmishape.startFeature('extrude'));
  await settle(500);
  await fit();
  await clickWorld(10, 10, 0);
  await clickTab('Surface');
  await shot('surface-dialog');
  check('a surface has no Result to choose', !(await page.$('[aria-label=Result]')));
  check('and only Blind as an end', await page.$eval('[data-field=end]', (e) => [...e.options].filter((o) => !o.disabled).map((o) => o.value).join()) === 'blind');
  await typeInto('length', '10');
  await accept();
  let s = await state();
  check('the extrude made a surface', last(s).mode === 'surface' && s.parts.length === 1 && s.parts[0].sheet, JSON.stringify(s.parts));
  check('which the parts list calls Surface 1', (await page.$$eval('.parts .geo-row .feature-name', (n) => n.map((x) => x.textContent))).includes('Surface 1'));
  for (const name of ['Bottom', 'Top']) {
    await cmd('fill');
    const id = s.features.find((f) => f.name === name).id;
    await page.select('.dialog .select', String(id));
    await settle(400);
    await accept();
  }
  s = await state();
  check('two fills add a surface each', s.parts.filter((p) => p.sheet).length === 3, JSON.stringify(s.parts));
  await page.mouse.move(700, 700);
  await fit();
  await shot('surfaces');
  await cmd('sew');
  await accept();
  s = await state();
  check('sewing closes them into a solid', s.parts.length === 1 && !s.parts[0].sheet && near(s.volume, 4000, 1e-3), `${JSON.stringify(s.parts)} ${s.volume}`);
  await shot('sewn');
}

console.log('Transform, boolean and delete part');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz: 20, mode: 'new_body' }, name: 'Block' });
  await settle(300);
  await fit();
  await cmd('transform');
  await clickWorld(5, 0, 10);
  check('a click picks the part to move', JSON.stringify(await rows('bodies')) === '["Part 1"]', JSON.stringify(await rows('bodies')));
  await typeInto('dx', '10');
  await typeInto('dz', '0');
  await page.$eval('[data-field=copy]', (e) => e.click());
  await settle(500);
  await accept();
  let s = await state();
  check('a copy moved along x is a second part', s.parts.length === 2 && near(s.volume, 16000, 1e-3), `${s.parts.length} ${s.volume}`);
  await cmd('boolean');
  await clickWorld(5, 0, 10);
  await clickWorld(25, 0, 10);
  check('both parts are picked', (await rows('tools')).length === 2, JSON.stringify(await rows('tools')));
  await accept();
  s = await state();
  check('union makes one part of them', s.parts.length === 1 && near(s.volume, 12000, 1e-3), `${s.parts.length} ${s.volume}`);
  await mutate('feature_add', { feature: { type: 'solid', shape: 'sphere', radius: 5, at: { origin: [60, 0, 0] }, mode: 'new_body' }, name: 'Ball' });
  await settle(300);
  await fit();
  await cmd('delete-bodies');
  await clickWorld(60, -4.9, 0);
  await accept();
  s = await state();
  check('Delete part takes the ball away', s.parts.length === 1 && near(s.volume, 12000, 1e-3) && last(s).type === 'delete_bodies', `${s.parts.length} ${s.volume}`);
}

console.log('Variable fillet');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 20, dz: 20 }, name: 'Block' });
  await settle(300);
  await fit();
  await cmd('fillet');
  await clickWorld(20, 0, 20);
  await page.$eval('[data-field=variable]', (e) => e.click());
  await settle(600);
  let s = await state();
  check('Variable radius writes a fillet that changes along the edge', last(s).type === 'fillet_radii' && last(s).sets[0].along.length === 2 && s.valid && !s.failed, `${JSON.stringify(last(s))} ${s.failed}`);
  await accept();
  await edit(last(s).id);
  check('and reads back as one', (await page.$eval('[data-field=variable]', (e) => e.checked)) && (await rows('edges')).length === 1);
  await page.keyboard.press('Escape');
  await settle(300);
}

console.log('Extrude a part’s flat faces');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'cylinder', radius: 5, height: 10, at: { origin: [60, 15, 0] }, mode: 'new_body' }, name: 'Peg' });
  await settle(300);
  await fit();
  await cmd('extrude');
  check('Extrude opens with no sketch in the document', await dialogOpen());
  check('its box takes faces and regions', (await page.$eval('[data-pick=regions] .pick-label', (e) => e.textContent)) === 'Faces and sketch regions to extrude');
  await clickWorld(20, 15, 10);
  let r = await rows('regions');
  let s = await state();
  check('a click on the top picks it', JSON.stringify(r) === '["Flat face"]' && JSON.stringify(last(s).faces) === '["f1:end"]' && last(s).sketch === undefined, `${JSON.stringify(r)} ${JSON.stringify(last(s))}`);
  check('and it grows up from there', near(s.volume, 40 * 30 * 30 + Math.PI * 25 * 10, 1e-3), `${s.volume}`);
  await shot('face-extrude');
  await clickWorld(65, 15, 5);
  r = await rows('regions');
  check('a curved face isn’t taken', JSON.stringify(r) === '["Flat face"]', JSON.stringify(r));
  await clickSegment('Result', 'Remove');
  await page.$eval('[data-testid=flip-direction]', (e) => e.click());
  await settle(500);
  await typeInto('length', '4');
  s = await state();
  check('flipped and Remove, it cuts down into the part', near(s.volume, 40 * 30 * 6 + Math.PI * 25 * 10, 1e-3) && !s.failed, `${s.volume} ${s.failed}`);
  await accept();
  s = await state();
  check('it goes in with no sketch', last(s).type === 'extrude' && last(s).sketch === undefined && last(s).mode === 'remove', JSON.stringify(last(s)));
  await edit(last(s).id);
  r = await rows('regions');
  check('editing shows the face', JSON.stringify(r) === '["Flat face"]', JSON.stringify(r));
  await page.keyboard.press('Escape');
  await settle(400);

  await clickWorld(20, 0, 3);
  await settle(200);
  await cmd('extrude');
  r = await rows('regions');
  s = await state();
  check('a face selected first is what Extrude takes', JSON.stringify(r) === '["Flat face"]' && JSON.stringify(last(s).faces) === '["f1:side.0"]', `${JSON.stringify(r)} ${JSON.stringify(last(s).faces)}`);
  await page.keyboard.press('Escape');
  await settle(400);
  {
    const [x, y] = await toScreen(20, 15, 6);
    await page.mouse.click(x, y, { button: 'right' });
    await wait(200);
    const items = await page.$$eval('.menu [data-item]', (m) => m.map((x) => [x.dataset.item, x.disabled ?? false]));
    check('right-clicking a flat face offers Extrude', items.some(([n, off]) => n === 'Extrude' && !off), JSON.stringify(items));
    await page.keyboard.press('Escape');
    await settle(200);
  }
}

console.log('A part’s corners and edges while sketching');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await settle(300);
  await fit();
  await page.evaluate(() => document.querySelector('[data-command="sketch"]').click());
  await settle(300);
  await clickWorld(20, 15, 10);
  await settle(600);
  check('a sketch opens on the top', await page.evaluate(() => !!window.schmishape.session()));
  await page.keyboard.press('v');
  await page.waitForFunction(() => !!window.schmishape.session()?.part, { timeout: 5000 }).catch(() => {});
  const hoverAt = async (x, y, z) => { const [a, b] = await toScreen(x, y, z); await page.mouse.move(a + 1, b + 1); await wait(150); return page.evaluate(() => window.schmishape.session().hover); };
  const corner = await hoverAt(40, 0, 10);
  check('hovering a corner of the block finds it', /^pv\d+$/.test(corner ?? ''), `${corner}`);
  await shot('sketch-part-corner');
  const edge = await hoverAt(20, 0, 10);
  check('hovering an edge of the block finds it', /^pe\d+$/.test(edge ?? ''), `${edge}`);
  check('a corner hidden behind the block can’t be picked', !/^p/.test((await hoverAt(0, 30, 0)) ?? ''), `${await hoverAt(0, 30, 0)}`);
  await page.keyboard.press('l');
  await clickWorld(10, 10, 10);
  await clickWorld(30, 10, 10);
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await settle(400);
  await clickWorld(30, 10, 10);
  { const [a, b] = await toScreen(40, 0, 10); await page.keyboard.down('Shift'); await clickAt(a + 1, b + 1); await page.keyboard.up('Shift'); }
  await settle(200);
  const sel = await page.evaluate(() => window.schmishape.session().selection[0]());
  check('a line’s end and the corner can be selected together', sel.length === 2 && sel.some((k) => /^pv/.test(k)), JSON.stringify(sel));
  check('which turns Coincident on', await page.$eval('[data-constraint=coincident]', (e) => !e.disabled));
  await shot('sketch-part-selected');
  await page.$eval('[data-constraint=coincident]', (e) => e.click());
  await settle(500);
  let sk = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.session().data)));
  const linkedPoint = sk.entities.find((e) => e.type === 'projected' && e.from?.vertex);
  const lineEnd = sk.entities.find((e) => e.id === 1)?.end;
  check('Coincident brings the corner in as a linked point', !!linkedPoint && sk.constraints.some((c) => c.type === 'coincident' && c.b === String(linkedPoint.id)), JSON.stringify(sk.entities.map((e) => e.type)));
  check('and the line’s end moves onto it', lineEnd && Math.hypot(lineEnd[0] - 40, lineEnd[1] - 0) < 1e-6, JSON.stringify(lineEnd));
  await shot('sketch-linked-corner');
  // Use: the block's back edge, as a curve of the sketch.
  { const [a, b] = await toScreen(20, 30, 10); await clickAt(a, b - 1); }
  await settle(200);
  const usable = await page.$eval('[data-tool=use]', (e) => !e.disabled);
  await page.keyboard.press('u');
  await settle(500);
  sk = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.session().data)));
  const used = sk.entities.find((e) => e.type === 'projected' && e.from?.edge);
  check('Use brings a part’s edge in as a curve of the sketch', usable && !!used && used.construction === false && used.geometry?.type === 'line', JSON.stringify(used));
  // Drawing onto a corner ties to it, as Onshape's snapping does.
  await page.keyboard.press('l');
  await clickWorld(0, 30, 10);
  await clickWorld(10, 25, 10);
  await page.keyboard.press('Escape');
  await settle(500);
  sk = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.session().data)));
  // There the corner is also the end of the edge Use brought in, which follows the part just the same.
  const linkedIds = sk.entities.filter((e) => e.type === 'projected').map((e) => String(e.id));
  const newLine = Math.max(...sk.entities.filter((e) => e.type === 'line').map((e) => e.id));
  const tie = sk.constraints.find((c) => c.type === 'coincident' && [c.a, c.b].includes(`${newLine}.start`));
  check('a line started on a corner is tied to it', !!tie && [tie.a, tie.b].some((r) => linkedIds.includes(r.split('.')[0])), JSON.stringify(sk.constraints));
  // The kernel builds a sketch only if something in it closes, so a circle gives it one.
  await page.keyboard.press('c');
  await clickWorld(20, 15, 10);
  await clickWorld(24, 15, 10);
  await page.keyboard.press('Escape');
  await settle(500);
  await page.$eval('[data-testid=sketch-done]', (e) => e.click());
  await settle(800);
  let s = await state();
  const sketchFeature = s.features.find((f) => f.type === 'constrained_sketch');
  check('the sketch keeps its links', !!sketchFeature && sketchFeature.sketch.entities.filter((e) => e.type === 'projected').length === 2 && !s.failed, `${JSON.stringify(sketchFeature?.sketch.entities.map((e) => e.type))} ${s.failed}`);
  // Make the block longer: the tied end goes with its corner.
  await mutate('feature_edit', { id: 1, feature: { type: 'solid', shape: 'box', dx: 60, dy: 30, dz: 10 } });
  await settle(400);
  s = await state();
  const sf = s.features.find((f) => f.type === 'constrained_sketch');
  const solved = await page.evaluate((f, i) => window.schmishape.engine.call('sketch_solve', { sketch: f.sketch, context: { plane: f.plane, position: i } }).then((r) => JSON.parse(r.text).sketch), sf, s.features.indexOf(sf));
  const end = solved.entities.find((e) => e.id === 1)?.end;
  check('when the block grows, the tied point follows its corner', end && Math.hypot(end[0] - 60, end[1]) < 1e-6 && !s.failed, `${JSON.stringify(end)} ${s.failed}`);
}

console.log('Renaming and coloring parts');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await mutate('feature_add', { feature: { type: 'solid', shape: 'sphere', radius: 8, at: { origin: [60, 15, 8] }, mode: 'new_body' }, name: 'Ball' });
  await settle(300);
  await fit();
  const partRow = (body) => page.$(`.parts [data-body="${body}"]`);
  const rowName = (body) => page.$eval(`.parts [data-body="${body}"] .feature-name`, (e) => e.textContent);
  const menuOn = async (body, item) => {
    const b = await (await partRow(body)).boundingBox();
    await page.mouse.click(b.x + 40, b.y + 10, { button: 'right' });
    await wait(150);
    const items = await page.$$eval('.menu [data-item]', (m) => m.map((x) => x.dataset.item));
    if (item) { await page.$eval(`.menu [data-item="${item}"]`, (e) => e.click()); await settle(300); }
    return items;
  };
  const items = await menuOn('f1');
  check('a part’s menu has Rename and Edit appearance', items.includes('Rename') && items.includes('Edit appearance…'), JSON.stringify(items));
  await page.keyboard.press('Escape');
  await menuOn('f1', 'Rename');
  await page.keyboard.type('Bracket');
  await page.keyboard.press('Enter');
  await settle(400);
  let app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('Rename gives the part a name of its own', (await rowName('f1')) === 'Bracket' && app.parts?.f1?.name === 'Bracket', `${await rowName('f1')} ${JSON.stringify(app)}`);
  await menuOn('f2', 'Edit appearance…');
  check('Edit appearance opens a dialog for that part', (await page.$eval('[data-testid=appearance] h3', (e) => e.textContent)) === 'Appearance of Part 2');
  await page.$eval('[data-color="#3f6fb0"]', (e) => e.click());
  await settle(200);
  await shot('appearance-trying');
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('trying a color doesn’t keep it yet', !app.parts?.f2?.color, JSON.stringify(app));
  await page.$eval('[data-testid=appearance-ok]', (e) => e.click());
  await settle(400);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('✓ keeps it with the document', app.parts?.f2?.color === '#3f6fb0' && app.parts?.f1?.name === 'Bracket', JSON.stringify(app));
  check('and the list shows it on the icon', !!(await page.$('.parts [data-body="f2"] .part-icon.tinted')));
  await page.mouse.move(700, 600);
  await shot('appearance-kept');
  await page.mouse.move(700, 20);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await settle(400);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('undo takes the color back', !app.parts?.f2?.color && app.parts?.f1?.name === 'Bracket', JSON.stringify(app));
  await menuOn('f2', 'Edit appearance…');
  await page.$eval('[data-color="#b8433a"]', (e) => e.click());
  await page.keyboard.press('Escape');
  await settle(300);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('Esc leaves it as it was', !(await page.$('[data-testid=appearance]')) && !app.parts?.f2?.color, JSON.stringify(app));
  await (await partRow('f1')).click({ count: 2 });
  await settle(200);
  await page.$eval('.parts .feature-rename', (e) => { e.focus(); e.select(); });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await settle(400);
  app = await page.evaluate(() => JSON.parse(JSON.stringify(window.schmishape.doc.app)));
  check('clearing the name, from a double-click, goes back to Part 1', (await rowName('f1')) === 'Part 1' && !app.parts, `${await rowName('f1')} ${JSON.stringify(app)}`);
}

console.log('Revolve and loft take regions');
{
  await fresh();
  await mutate('feature_add', { feature: sketch([...rect(1, 10, 0, 10, 30), ...rect(5, 30, 0, 10, 30)]), name: 'Sketch 1' });
  await settle(300);
  await fit();
  await cmd('revolve');
  let s = await state();
  const ring = (a, b) => Math.PI * (b * b - a * a) * 30;
  check('a revolve starts with all of the last sketch', near(s.volume, ring(10, 20) + ring(30, 40), 1e-3), `${s.volume}`);
  check('and, with its regions there, the axis box takes the clicks', (await activeBox()) === 'axis', `${await activeBox()}`);
  await page.$eval('[data-pick=regions]', (e) => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle(200);
  await clickWorld(35, 15, 0);
  s = await state();
  check('a click drops one region', near(s.volume, ring(10, 20), 1e-3) && JSON.stringify(await rows('regions')) === '["Region of Sketch 1"]', `${s.volume} ${JSON.stringify(await rows('regions'))}`);
  await accept();
  s = await state();
  const idA = await regionId(s, 1, 300);
  check('the revolve lists its region', last(s).sketch === 1 && JSON.stringify(last(s).regions) === JSON.stringify([idA]), JSON.stringify(last(s)));
  await mutate('feature_add', { feature: sketch(rect(1, 50, 0, 10, 30)), name: 'Sketch 2', position: 1 });
  await settle(300);
  await fit();
  s = await state();
  await edit(last(s).id);
  await clickWorld(55, 15, 0);
  s = await state();
  const idC = await regionId(s, s.features.find((f) => f.name === 'Sketch 2').id, 300);
  check('a region of another sketch in the same plane joins it', JSON.stringify(last(s).regions) === JSON.stringify([idA, { sketch: s.features.find((f) => f.name === 'Sketch 2').id, region: idC }]) && near(s.volume, ring(10, 20) + ring(50, 60), 1e-3), `${JSON.stringify(last(s).regions)} ${s.volume}`);
  await shot('revolve-regions');
  await accept();

  await fresh();
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 10), circle(2, 50, 0, 10)]), name: 'Base' });
  await mutate('feature_add', { feature: sketch([circle(1, 0, 0, 5)], [0, 0, 30]), name: 'Top' });
  await settle(300);
  await fit();
  await cmd('loft');
  check('a loft’s profiles box takes the clicks', (await activeBox()) === 'sections', `${await activeBox()}`);
  await clickWorld(0, 0, 0);
  await clickWorld(0, 0, 30);
  s = await state();
  const r = await rows('sections');
  check('profiles are listed in the order they’re clicked', JSON.stringify(r) === '["1. Region of Base","2. Region of Top"]', JSON.stringify(r));
  const base = await regionId(s, 1, Math.PI * 100);
  check('one region of a sketch with two outlines can be a profile', JSON.stringify(last(s).sections) === JSON.stringify([{ sketch: 1, region: base }, 2]), JSON.stringify(last(s).sections));
  const frustum = Math.PI * 30 / 3 * (100 + 50 + 25);
  check('and the loft runs between them', near(s.volume, frustum, 1e-2) && s.valid, `${s.volume} vs ${frustum}`);
  await shot('loft-regions');
  await clickWorld(0, 0, 0);
  check('clicking a profile again drops it', JSON.stringify(await rows('sections')) === '["1. Region of Top"]', JSON.stringify(await rows('sections')));
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log('Constraint tools wait for their picks');
{
  await fresh();
  await mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 10 }, name: 'Block' });
  await settle(300);
  await fit();
  await page.evaluate(() => document.querySelector('[data-command="sketch"]').click());
  await settle(300);
  await clickWorld(20, 15, 10);
  await settle(600);
  await page.waitForFunction(() => !!window.schmishape.session()?.part, { timeout: 5000 }).catch(() => {});
  await page.keyboard.press('l');
  await clickWorld(5, 5, 10);
  await clickWorld(15, 8, 10);
  await page.keyboard.press('Escape');
  await clickWorld(25, 12, 10);
  await clickWorld(32, 20, 10);
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await settle(400);
  const sess = () => page.evaluate(() => { const s = window.schmishape.session(); return { tool: s.constraintTool[0](), sel: s.selection[0](), data: JSON.parse(JSON.stringify(s.data)) }; });
  const pressed = () => page.$eval('[data-constraint=coincident]', (e) => e.getAttribute('aria-pressed'));
  check('Coincident can be clicked with nothing selected', await page.$eval('[data-constraint=coincident]', (e) => !e.disabled));
  await page.$eval('[data-constraint=coincident]', (e) => e.click());
  await settle(150);
  check('and then it stays on, waiting for picks', (await pressed()) === 'true' && (await sess()).tool === 'coincident');
  check('the status bar says what it takes', /^Coincident takes two points/.test(await page.$eval('.status-left', (e) => e.textContent)), await page.$eval('.status-left', (e) => e.textContent));
  const before = (await sess()).data.constraints.length;
  await clickWorld(15, 8, 10);
  check('one pick waits for the second', (await sess()).sel.length === 1 && (await sess()).data.constraints.length === before);
  await clickWorld(25, 12, 10);
  await settle(500);
  let st = await sess();
  const made = st.data.constraints.slice(before);
  check('the second makes them coincident', made.length === 1 && made[0].type === 'coincident' && st.sel.length === 0, JSON.stringify(made));
  check('and the tool stays on for the next pair', (await pressed()) === 'true');
  await shot('coincident-tool');
  // A line's end and a part's corner.
  await clickWorld(32, 20, 10);
  { const [a, b] = await toScreen(40, 30, 10); await clickAt(a - 1, b + 1); }
  await settle(500);
  st = await sess();
  const linked = st.data.entities.find((e) => e.type === 'projected');
  const end = st.data.entities.find((e) => e.type === 'line' && Math.hypot(e.end[0] - 40, e.end[1] - 30) < 1e-6);
  check('a point and a part’s corner work the same way', !!linked && !!end, JSON.stringify(st.data.entities.map((e) => [e.type, e.end])));
  // Two lines can't be coincident: it says why and starts again from the last pick.
  const lines = st.data.entities.filter((e) => e.type === 'line');
  const mid = (e) => [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2];
  await clickWorld(...mid(lines[0]), 10);
  await clickWorld(...mid(lines[1]), 10);
  await settle(200);
  const said = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
  check('two lines say what Coincident takes', /Coincident takes two points, or a point and a curve/.test(said) && (await sess()).sel.length === 1, `${said} ${JSON.stringify((await sess()).sel)}`);
  await page.keyboard.press('Escape');
  await settle(150);
  check('Esc turns the tool off', (await pressed()) === 'false' && (await sess()).tool === null);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await settle(300);
}

for (const p of problems) console.log(`  problem: ${p}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
await browser.close();
process.exit(failures.length || problems.length ? 1 : 0);
