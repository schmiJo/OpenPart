// The closed regions of a sketch, each extruded on its own, driven with the mouse in the real app.
// Usage: node scripts/smoke-regions.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-regions';
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
const cmd = (id) => page.$eval(`[data-command="${id}"]`, (e) => e.click());
const clickAt = async (x, y) => { await page.mouse.move(x, y); await wait(16); await page.mouse.down(); await page.mouse.up(); await wait(40); };
const state = () => page.evaluate(() => {
  const d = window.schmishape.doc;
  return {
    features: d.features.map((f) => ({ id: f.id, name: f.name, type: f.type, sketch: typeof f.sketch === 'number' ? f.sketch : undefined })),
    steps: d.steps.map((s) => ({ id: s.id, state: s.state, error: s.error })),
    volume: d.solid?.volume ?? 0,
    valid: d.solid?.valid ?? null,
    failed: d.failed,
    parts: window.schmishape.mesh()?.parts.length ?? 0,
  };
});
const hidden = (s) => s.features.filter((f) => f.name.startsWith('~'));
const ok = () => page.$eval('[data-testid=dialog-ok]', (e) => e.click());
const accept = async () => { await ok(); await settle(500); };
const well = () => page.$eval('[data-testid=pick-well]', (e) => {
  const rows = [...e.querySelectorAll('.pick-row .pick-name')].map((n) => n.textContent);
  if (!rows.length) return e.querySelector('.pick-prompt').textContent;
  return rows[0].startsWith('All of') ? rows[0] : `${rows.length} of ${rows[0].replace('Region of ', '')}`;
});
const typeInto = async (field, text) => { await page.$eval(`[data-field=${field}]`, (e) => { e.focus(); e.select(); }); await page.keyboard.type(text); await settle(350); };
const toScreen = (x, y, z = 0) => page.evaluate((p) => {
  const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
  const q = window.schmishape.view.renderer.camera.project(p);
  return [q[0] + b.left, q[1] + b.top];
}, [x, y, z]);
const clickWorld = async (x, y, z = 0) => { const [a, b] = await toScreen(x, y, z); await clickAt(a, b); await settle(150); };
const hoverWorld = async (x, y, z = 0) => { const [a, b] = await toScreen(x, y, z); await page.mouse.move(a, b); await wait(120); };
const status = () => page.$eval('.status-left', (e) => e.textContent);
const newPart = async () => {
  await page.$eval('[data-testid=file-menu]', (e) => e.click());
  await page.$eval('.menu [data-command="new"]', (e) => e.click());
  await settle(300);
};
const addSketch = (entities, plane = { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }, name = 'Sketch 1') => page.evaluate(async (feature, name) => {
  await window.schmishape.mutate('feature_add', { feature, name });
}, { type: 'constrained_sketch', plane, sketch: { format: 'coreshape-sketch', version: 1, entities, constraints: [] } }, name);
const rect = (x, y, w, h, id) => [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]].map((l, i) => ({ id: id + i, type: 'line', start: [l[0], l[1]], end: [l[2], l[3]] }));
const row = (name) => page.evaluateHandle((n) => [...document.querySelectorAll('.feature-row')].find((r) => r.querySelector('.feature-name')?.textContent === n), name);
const clickRow = async (name) => { await (await row(name)).click(); await settle(200); };
const regionAt = (x, y, z = 0) => page.evaluate((p) => {
  const r = window.schmishape.view.renderer;
  const q = r.camera.project(p);
  return r.pick(q[0], q[1])?.kind ?? null;
}, [x, y, z]);

const DISC = Math.PI * 64;
const RING = 1600 - DISC;
const RECT = 900;

await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=empty]', { timeout: 20000 });
await settle(400);

console.log('drawn with the tools: a rectangle with a circle in it, and a second rectangle');
await cmd('sketch');
await wait(100);
await page.$eval('[data-plane="1"]', (e) => e.click());
await wait(300);
const onSketch = (x, y) => page.evaluate((x, y) => {
  const s = window.schmishape.session();
  const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
  const p = s.screen([x, y]);
  return [p[0] + b.left, p[1] + b.top];
}, x, y);
const clickSketch = async (x, y) => { const [a, b] = await onSketch(x, y); await clickAt(a, b); };
await page.keyboard.press('r');
await clickSketch(-50, -20);
await clickSketch(-10, 20);
await page.keyboard.press('r');
await clickSketch(10, -15);
await clickSketch(40, 15);
await page.keyboard.press('c');
await clickSketch(-30, 0);
await clickSketch(-22, 0);
await wait(300);
await shot('r01-in-the-sketch');
await page.$eval('[data-testid=sketch-done]', (e) => e.click());
await settle(600);
let s = await state();
const regions = () => page.evaluate(() => [...window.schmishape.sketchRegions().values()].flat().map((r) => ({ id: r.id, depth: r.depth, area: r.area })));
let list = await regions();
check('three closed regions', list.length === 3, JSON.stringify(list.map((r) => Math.round(r.area))));
check('each has the right area', [DISC, RING, RECT].every((a) => list.some((r) => near(r.area, a, 2e-3))));
await shot('r02-regions-shaded');

console.log('click one region, then Extrude');
await clickAt(...await toScreen(0, 60));
await settle(150);
await hoverWorld(25, 0);
check('hovering names the region', /^Sketch region {2}Sketch 1 {2}900 mm²/.test(await status()), await status());
await shot('r03-hover');
await clickWorld(25, 0);
check('a click selects one region', (await page.evaluate(() => window.schmishape.selectedRegions()?.ids.length)) === 1);
await shot('r04-selected');
await cmd('extrude');
await settle(500);
check('the dialog starts with that region', /^1 of Sketch 1/.test(await well()), await well());
s = await state();
check('only that region extrudes', near(s.volume, RECT * 20), `${s.volume}`);
check('it builds with no hidden copy of the sketch', hidden(s).length === 0, JSON.stringify(s.features));
await shot('r05-one-region-preview');

console.log('add and drop regions in the dialog');
await clickWorld(-45, 0);
await settle(400);
check('a second click adds the ring, with its hole', near((await state()).volume, (RECT + RING) * 20), `${(await state()).volume}`);
check('those two are all of the sketch, with the circle as a hole', /^All of Sketch 1/.test(await well()), await well());
await shot('r06-two-regions-preview');
await clickWorld(-30, 0);
await settle(400);
check('adding the disc fills the hole', near((await state()).volume, (RECT + RING + DISC) * 20), `${(await state()).volume}`);
check('the well counts them', /^3 of Sketch 1/.test(await well()), await well());
await clickWorld(-30, 0);
await settle(300);
await clickWorld(-45, 0);
await settle(400);
check('clicking again drops them', near((await state()).volume, RECT * 20), `${(await state()).volume}`);
await accept();
s = await state();
check('it goes in as one extrude', s.features.filter((f) => f.type === 'extrude').length === 1 && hidden(s).length === 0, JSON.stringify(s.features));
const titled = await page.$eval('.features h2', (e) => e.textContent);
check('the list has the sketch and the extrude', titled === 'Features (2)', titled);
await shot('r07-first-extruded');

console.log('the rest of the sketch stays there to extrude');
check('its other regions can still be picked', (await regionAt(-45, 0)) === 'region');
await clickWorld(-45, 0);
await cmd('extrude');
await settle(500);
await typeInto('length', '10');
check('another region, at another length', near((await state()).volume, RECT * 20 + RING * 10), `${(await state()).volume}`);
await accept();
check('a region down inside a pocket can’t be clicked through its wall', (await regionAt(-30, 0)) === 'face');
await page.keyboard.press('1');
await wait(500);
check('looking straight down it can', (await regionAt(-30, 0)) === 'region');
await clickWorld(-30, 0);
await cmd('extrude');
await settle(500);
await typeInto('length', '5');
await accept();
await page.keyboard.press('0');
await wait(500);
s = await state();
check('three lengths from one sketch', near(s.volume, RECT * 20 + RING * 10 + DISC * 5) && s.valid, `${s.volume}`);
check('and no hidden copies', hidden(s).length === 0);
check('with every region used, the sketch goes away', (await regionAt(25, 0, 0)) !== 'region');
await shot('r08-three-lengths');

console.log('edit, undo and reload');
await (await row('Extrude 1')).click({ count: 2 });
await settle(500);
check('editing shows what it uses', /^1 of Sketch 1/.test(await well()), await well());
check('the sketch comes back to pick from', (await page.evaluate(() => !!document.querySelector('.feature-row.selected'))));
await shot('r09-editing');
await typeInto('length', '30');
await accept();
s = await state();
check('an edit keeps the regions', near(s.volume, RECT * 30 + RING * 10 + DISC * 5), `${s.volume}`);
check('an edit adds no copies', hidden(s).length === 0);
await page.mouse.move(700, 20);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(400);
check('undo takes the edit back', near((await state()).volume, RECT * 20 + RING * 10 + DISC * 5));
await wait(600);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.schmishape?.doc?.features?.length > 0, { timeout: 15000 });
await settle(500);
s = await state();
check('the regions survive a reload', near(s.volume, RECT * 20 + RING * 10 + DISC * 5) && hidden(s).length === 0, `${s.volume}`);

console.log('the whole sketch');
await newPart();
await addSketch([...rect(-50, -20, 40, 40, 1), { id: 5, type: 'circle', center: [-30, 0], radius: 8 }, ...rect(10, -15, 30, 30, 6)]);
await settle(300);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
check('a sketch chosen in the list brings all of it', /^All of Sketch 1/.test(await well()), await well());
s = await state();
check('all of it keeps its holes', near(s.volume, (RING + RECT) * 20), `${s.volume}`);
check('and needs no copy', hidden(s).length === 0);
await clickWorld(25, 0);
await settle(400);
check('dropping a region makes it a choice', near((await state()).volume, RING * 20) && hidden(await state()).length === 0, `${(await state()).volume}`);
await page.$eval('[data-testid=pick-well] .link', (e) => e.click());
await settle(400);
check('Clear empties it', /^Click flat faces or regions/.test(await well()) && await page.$eval('[data-testid=dialog-ok]', (e) => e.disabled), await well());
await shot('r10-cleared');
await clickRow('Sketch 1');
await settle(300);
check('a sketch in the list fills it again', /^All of Sketch 1/.test(await well()), await well());
await accept();
s = await state();
check('changing its mind leaves no copy behind', hidden(s).length === 0, JSON.stringify(s.features));

console.log('box select and cancel');
await newPart();
await addSketch([...rect(-50, -20, 40, 40, 1), ...rect(10, -15, 30, 30, 5), ...rect(10, 25, 10, 10, 9)]);
await settle(300);
await page.mouse.move(700, 880);
await page.keyboard.press('Escape');
await page.keyboard.press('1');
await wait(500);
await cmd('extrude');
await settle(300);
check('with nothing selected the dialog waits', /^Click flat faces or regions/.test(await well()), await well());
check('and builds nothing', (await state()).features.length === 1);
{
  const [ax, ay] = await toScreen(5, -20);
  const [bx, by] = await toScreen(45, 40);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 6 }); await page.mouse.up();
  await settle(400);
}
check('a box takes what it fully holds', /^2 of Sketch 1/.test(await well()) && near((await state()).volume, (900 + 100) * 20), `${await well()} ${(await state()).volume}`);
check('two regions apart make two parts', (await state()).parts === 2, `${(await state()).parts}`);
await page.keyboard.press('Escape');
await settle(400);
s = await state();
check('Esc takes all of it back', s.features.length === 1 && hidden(s).length === 0, JSON.stringify(s.features));

console.log('crossing shapes');
await newPart();
await addSketch([{ id: 1, type: 'circle', center: [-10, 0], radius: 20 }, { id: 2, type: 'circle', center: [10, 0], radius: 20 }]);
await settle(300);
list = await regions();
check('two crossing circles make three regions', list.length === 3, JSON.stringify(list.map((r) => Math.round(r.area))));
await page.mouse.move(700, 880);
await clickWorld(0, 0);
await cmd('extrude');
await settle(500);
const lens = list.find((r) => near(r.area, 2 * 400 * Math.acos(0.5) - 10 * Math.sqrt(1600 - 400), 1e-2));
check('the piece where they overlap extrudes alone', !!lens && near((await state()).volume, lens.area * 20, 2e-3), `${(await state()).volume}`);
await shot('r11-lens');
await accept();

console.log('the sketch changes under an extrude');
await newPart();
await addSketch([...rect(-50, -20, 40, 40, 1), ...rect(10, -15, 30, 30, 5)]);
await settle(300);
await clickWorld(25, 0);
await cmd('extrude');
await settle(500);
await accept();
await (await row('Sketch 1')).click({ count: 2 });
await wait(500);
check('its sketch opens', await page.evaluate(() => !!window.schmishape.session()));
await page.evaluate(() => window.schmishape.session().change((d) => { d.entities = d.entities.filter((e) => e.id !== 5); d.constraints = []; }));
await wait(300);
await page.$eval('[data-testid=sketch-done]', (e) => e.click());
await settle(700);
s = await state();
const failedRow = await page.$$eval('.feature-row.failed .feature-name', (r) => r.map((x) => x.textContent));
check('the extrude shows the failure', failedRow.join() === 'Extrude 1', failedRow.join());
check('and says why in plain words', /^Extrude 1: A sketch region this used is gone/.test(s.failed ?? ''), s.failed ?? 'nothing');
check('no hidden name shows', !/~regions/.test(await page.$eval('[data-testid=status]', (e) => e.textContent)));
await shot('r12-region-gone');
await (await row('Extrude 1')).click({ count: 2 });
await settle(500);
check('editing asks for regions again', /^Click flat faces or regions/.test(await well()), await well());
await clickWorld(-30, 0);
await settle(400);
check('picking one repairs it', near((await state()).volume, 1600 * 20) && !(await state()).failed, `${(await state()).volume} ${(await state()).failed}`);
await accept();
check('and it stays repaired', !(await state()).failed);

console.log('the sketch behind the copy');
await (await row('Sketch 1')).click();
await settle(150);
await page.keyboard.press('Delete');
await settle(300);
s = await state();
check('a sketch in use can’t be deleted', s.features.some((f) => f.name === 'Sketch 1'));
const toastText = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
check('and says what uses it', /Sketch 1 can't be deleted while Extrude 1 uses it/.test(toastText), toastText);
const menuOn = async (name, item) => {
  const b = await (await row(name)).boundingBox();
  await page.mouse.click(b.x + 40, b.y + 10, { button: 'right' });
  await wait(100);
  await page.$eval(`.menu [data-item="${item}"]`, (e) => e.click());
  await settle(500);
};
await menuOn('Sketch 1', 'Turn off');
s = await state();
check('turning the sketch off turns the extrude off', s.volume === 0 && !!s.failed, `${s.volume} ${s.failed}`);
await menuOn('Sketch 1', 'Turn on');
check('and back on', near((await state()).volume, 1600 * 20), `${(await state()).volume}`);
await menuOn('Extrude 1', 'Delete');
s = await state();
check('deleting the extrude deletes its copy', s.features.length === 1 && hidden(s).length === 0, JSON.stringify(s.features));

console.log('on a part');
await newPart();
await addSketch(rect(-30, -30, 60, 60, 1));
await settle(300);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
await accept();
await addSketch([...rect(-20, -20, 15, 15, 1), ...rect(5, 5, 15, 15, 5)], { origin: [0, 0, 20], z: [0, 0, 1], x: [1, 0, 0] }, 'On top');
await settle(300);
await addSketch(rect(-5, -5, 10, 10, 1), { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] }, 'Inside');
await settle(300);
await page.keyboard.press('0');
await wait(500);
check('a region lying on a face wins over the face', (await regionAt(12, 12, 20)) === 'region');
check('a sketch inside the part stays behind it', (await regionAt(0, 0, 10)) === 'face');
await shot('r13-on-a-part');
await clickWorld(12, 12, 20);
await cmd('extrude');
await settle(500);
await typeInto('length', '7');
s = await state();
check('it grows from the face', near(s.volume, 3600 * 20 + 225 * 7), `${s.volume}`);
await accept();
const b = await (await row('Extrude 1')).boundingBox();
await page.mouse.click(b.x + 40, b.y + 10, { button: 'right' });
await wait(100);
await page.$eval('.menu [data-item="Roll to here"]', (e) => e.click());
await settle(500);
await page.mouse.move(700, 880);
check('a sketch after the rollback bar is gone from the view', (await regionAt(12, 12, 20)) !== 'region');

console.log('the context menu');
await newPart();
await addSketch(rect(-20, -20, 40, 40, 1));
await settle(300);
{
  const [x, y] = await toScreen(0, 0);
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForSelector('.menu [data-command="menu.extrude"]', { timeout: 2000 });
  await shot('r14-context-menu');
  await page.$eval('.menu [data-command="menu.extrude"]', (e) => e.click());
  await settle(500);
  check('right-click, Extrude', /^All of Sketch 1/.test(await well()) && near((await state()).volume, 1600 * 20), `${await well()}`);
  await accept();
}

console.log('seeing the sketch through the preview');
const drawing = () => page.evaluate(() => {
  const r = window.schmishape.view.renderer;
  return { glass: r.ghostPreview, base: !!r.previewBase, onTop: r.regionsOnTop };
});
const drawingNormally = async () => { const d = await drawing(); return !d.glass && !d.base && !d.onTop; };
const tabButton = (label) => page.evaluate((label) => [...document.querySelectorAll('[data-testid=dialog] button')].find((b) => b.textContent.trim() === label)?.click(), label);
const look = (back, target = [-10, 0, 10]) => page.evaluate((back, target) => {
  const c = window.schmishape.view.renderer.camera;
  const n = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = n(back);
  const right = Math.abs(z[2]) > 0.99 ? [1, 0, 0] : n(cross([0, 0, 1], z));
  c.animateTo({ rot: c.rotFromBasis(right, cross(z, right), z), target, halfH: 75 }, 0);
  window.schmishape.view.renderer.invalidate();
}, back, target);
const notched = [[-60, -20], [-20, -20], [-20, -5], [-30, -5], [-30, 5], [-20, 5], [-20, 20], [-60, 20]].map((p, i, all) => ({ id: i + 1, type: 'line', start: p, end: all[(i + 1) % all.length] }));
const hole = { id: 9, type: 'circle', center: [-45, 0], radius: 8 };
const arch = [
  { id: 10, type: 'line', start: [10, -15], end: [30, -15] },
  { id: 11, type: 'arc', center: [30, 0], radius: 15, start: [30, -15], end: [30, 15] },
  { id: 12, type: 'line', start: [30, 15], end: [10, 15] },
  { id: 13, type: 'line', start: [10, 15], end: [10, -15] },
];
const HOLE = Math.PI * 64, PLATE = 1500 - HOLE, ARCH = 600 + (Math.PI * 225) / 2;
await newPart();
await addSketch([...notched, hole, ...arch]);
await settle(300);
check('a notched plate with a hole, and an arch, make three regions', (await regions()).length === 3);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
check('a new extrude is glass too', (await drawing()).glass && (await drawing()).onTop, JSON.stringify(await drawing()));
check('with nothing before it to stand on', !(await drawing()).base);
await accept();
check('accepting draws normally again', await drawingNormally(), JSON.stringify(await drawing()));
await (await row('Extrude 1')).click({ count: 2 });
await settle(600);
check('editing an extrude draws it as glass', (await drawing()).glass, JSON.stringify(await drawing()));
await shot('r15-glass-iso');
for (const [name, back] of [['iso', [1, -1, 0.8]], ['above', [0, 0, 1]], ['underneath', [-0.45, -0.6, -0.66]]]) {
  await look(back);
  await page.mouse.move(700, 880);
  await settle(200);
  await shot(`r16-glass-${name}`);
  check(`from ${name}, every shape can be picked`, (await regionAt(25, 0)) === 'region' && (await regionAt(-55, 0)) === 'region' && (await regionAt(-45, 0)) === 'region', name);
  check(`from ${name}, the notch isn’t a shape`, (await regionAt(-25, 0)) !== 'region');
  await hoverWorld(25, 0);
  check(`from ${name}, hovering names the shape`, /Sketch 1 {2}953\.43 mm²/.test(await status()), await status());
  await clickWorld(25, 0);
  await settle(400);
  check(`from ${name}, clicking the arch drops it`, near((await state()).volume, PLATE * 20), `${(await state()).volume}`);
  await clickWorld(25, 0);
  await settle(400);
  check(`from ${name}, clicking it again brings it back`, near((await state()).volume, (PLATE + ARCH) * 20), `${(await state()).volume}`);
  await clickWorld(-55, 0);
  await settle(400);
  check(`from ${name}, the plate drops`, near((await state()).volume, ARCH * 20), `${(await state()).volume}`);
  await clickWorld(-55, 0);
  await settle(400);
  await clickWorld(-45, 0);
  await settle(400);
  check(`from ${name}, the plate is back and the hole fills`, near((await state()).volume, (PLATE + HOLE + ARCH) * 20), `${(await state()).volume}`);
  await clickWorld(-45, 0);
  await settle(400);
  check(`from ${name}, and the hole opens again`, near((await state()).volume, (PLATE + ARCH) * 20), `${(await state()).volume}`);
}
await look([1, -1, 0.8]);
await typeInto('length', '30');
check('the depth still previews live', near((await state()).volume, (PLATE + ARCH) * 30), `${(await state()).volume}`);
check('and stays glass', (await drawing()).glass);
await clickWorld(25, 0);
await settle(400);
await page.mouse.move(700, 880);
await settle(150);
await shot('r17-glass-one-shape-dropped');
const planeSizes = () => page.evaluate(() => window.schmishape.view.renderer.planes[0]?.half);
const before3 = await planeSizes();
await clickWorld(25, 0);
await settle(400);
check('trying out regions leaves the planes alone', near(await planeSizes(), before3), `${before3} ${await planeSizes()}`);
await page.keyboard.press('Escape');
await settle(500);
check('Esc draws normally again', await drawingNormally(), JSON.stringify(await drawing()));
check('and takes the edit back', near((await state()).volume, (PLATE + ARCH) * 20), `${(await state()).volume}`);
await (await row('Extrude 1')).click({ count: 2 });
await settle(500);
await page.$eval('[data-testid=dialog] [aria-label="Cancel"]', (e) => e.click());
await settle(500);
check('✕ draws normally again', await drawingNormally(), JSON.stringify(await drawing()));

console.log('a preview on an existing part');
await newPart();
await addSketch(rect(-30, -30, 60, 60, 1), undefined, 'Block sketch');
await settle(300);
await clickRow('Block sketch');
await cmd('extrude');
await settle(500);
await accept();
await addSketch(rect(-10, -10, 20, 20, 1), { origin: [0, 0, 10], z: [0, 0, 1], x: [1, 0, 0] }, 'Inside');
await settle(300);
await look([1, -1, 0.8], [0, 0, 10]);
await clickRow('Inside');
await cmd('extrude');
await settle(600);
let d3 = await drawing();
check('the part before it stays solid under the glass', d3.glass && d3.base, JSON.stringify(d3));
check('adding gives the right volume', near((await state()).volume, 3600 * 20 + 400 * 10), `${(await state()).volume}`);
check('a shape inside the part can be picked through it', (await regionAt(0, 0, 10)) === 'region');
await shot('r18-glass-on-a-part');
await tabButton('Remove');
await settle(500);
d3 = await drawing();
check('a cut isn’t glass', !d3.glass && d3.onTop, JSON.stringify(d3));
check('removing gives the right volume', near((await state()).volume, 3600 * 20 - 400 * 10), `${(await state()).volume}`);
check('and its shape can still be picked', (await regionAt(0, 0, 10)) === 'region');
await shot('r19-opaque-cut');
await tabButton('Intersect');
await settle(500);
check('nor is an intersect', !(await drawing()).glass);
check('intersecting gives the right volume', near((await state()).volume, 400 * 10), `${(await state()).volume}`);
await tabButton('Add');
await settle(500);
check('back to Add is glass again', (await drawing()).glass);
await accept();
check('accepting draws normally', await drawingNormally(), JSON.stringify(await drawing()));

console.log('going back, with something after it');
await (await row('Extrude 1')).click({ count: 2 });
await settle(600);
const barAt = () => page.evaluate(() => window.schmishape.doc.rollback);
const editedAt = await page.evaluate(() => window.schmishape.doc.features.findIndex((f) => f.name === 'Extrude 1'));
check('the snapshot leaves the bar on the feature being edited', (await barAt()) === editedAt, `${await barAt()} ${editedAt}`);
d3 = await drawing();
check('the first extrude is glass with nothing under it', d3.glass && !d3.base, JSON.stringify(d3));
check('and has the model as it stood', near((await state()).volume, 3600 * 20), `${(await state()).volume}`);
await page.$eval('[data-testid=dialog-final]', (e) => e.click());
await settle(500);
check('Final turns the glass off', !(await drawing()).glass);
check('and shows the finished model', near((await state()).volume, 3600 * 20 + 400 * 10), `${(await state()).volume}`);
await page.$eval('[data-testid=dialog-final]', (e) => e.click());
await settle(500);
check('and on again', (await drawing()).glass);
await page.keyboard.press('Escape');
await settle(500);
check('leaving Final draws normally', await drawingNormally(), JSON.stringify(await drawing()));
check('with the bar back at the end', (await barAt()) === null, `${await barAt()}`);

console.log('switching tabs from a preview');
await clickRow('Inside');
await cmd('extrude');
await settle(500);
const thisTab = await page.evaluate(() => window.schmishape.tabs.activeTabId());
const otherTab = await page.$$eval('.tabbar .tab[data-kind=part-studio]:not(.on)', (t) => { const b = t[0].getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
await page.mouse.click(otherTab[0], otherTab[1]);
await settle(500);
check('switching tabs draws normally', await drawingNormally(), JSON.stringify(await drawing()));
await page.evaluate((id) => window.schmishape.tabs.activateTab(id), thisTab);
await settle(500);

console.log('a region that has gone');
await newPart();
await addSketch(rect(-30, -30, 60, 60, 1), undefined, 'Block sketch');
await settle(300);
await clickRow('Block sketch');
await cmd('extrude');
await settle(500);
await accept();
await addSketch([...rect(-25, -25, 15, 15, 1), ...rect(5, 5, 15, 15, 5)], { origin: [0, 0, 20], z: [0, 0, 1], x: [1, 0, 0] }, 'On top');
await settle(300);
await look([0, 0, 1], [0, 0, 20]);
await clickWorld(12, 12, 20);
await cmd('extrude');
await settle(500);
await typeInto('length', '7');
await accept();
await (await row('On top')).click({ count: 2 });
await wait(500);
await page.evaluate(() => window.schmishape.session().change((d) => { d.entities = d.entities.filter((e) => e.id !== 5); d.constraints = []; }));
await wait(300);
await page.$eval('[data-testid=sketch-done]', (e) => e.click());
await settle(700);
check('the extrude has failed', /^Extrude 2: A sketch region/.test((await state()).failed ?? ''), (await state()).failed ?? 'nothing');
await (await row('Extrude 2')).click({ count: 2 });
await settle(600);
d3 = await drawing();
check('opening it still shows the part it stands on', d3.glass && d3.base, JSON.stringify(d3));
await clickWorld(-17, -17, 20);
await settle(500);
check('and the leftover shape repairs it', near((await state()).volume, 3600 * 20 + 225 * 7) && !(await state()).failed, `${(await state()).volume} ${(await state()).failed}`);
await accept();
check('leaving draws normally', await drawingNormally());

console.log('a hidden part stays hidden under the preview');
await newPart();
await page.evaluate(async () => {
  await window.schmishape.mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz: 20 } });
  await window.schmishape.mutate('feature_add', { feature: { type: 'solid', shape: 'box', dx: 20, dy: 20, dz: 20, at: { origin: [60, 0, 0] } } });
});
await addSketch(rect(62, 2, 10, 10, 1), { origin: [0, 0, 20], z: [0, 0, 1], x: [1, 0, 0] }, 'On the second');
await settle(300);
await page.$eval('[data-part="0"] .row-eye', (e) => e.click());
await settle(200);
await clickRow('On the second');
await cmd('extrude');
await settle(600);
const hiddenInBase = await page.evaluate(() => [...window.schmishape.view.renderer.previewBase.faceStates.data].filter((v) => v === 4).length);
check('its faces are hidden in the model under the glass', hiddenInBase > 0, `${hiddenInBase}`);
await page.keyboard.press('Escape');
await settle(400);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (problems.length) console.log('Browser errors:\n  ' + [...new Set(problems)].join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
