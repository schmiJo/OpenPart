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

for (const p of problems) console.log(`  problem: ${p}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
await browser.close();
process.exit(failures.length || problems.length ? 1 : 0);
