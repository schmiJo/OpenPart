// The feature dialogs: moving and resizing them, the result tabs, the selection box and extrude's options, in the real app.
// Usage: node scripts/smoke-dialog.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-dialog';
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
const settle = async (ms = 300) => { await wait(ms); await page.waitForFunction(() => !document.querySelector('.spinner')); await wait(60); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const cmd = (id) => page.$eval(`[data-command="${id}"]`, (e) => e.click());
const state = () => page.evaluate(() => {
  const d = window.schmishape.doc;
  return { volume: d.solid?.volume ?? 0, z0: d.solid?.bounds_min[2] ?? null, z1: d.solid?.bounds_max[2] ?? null, valid: d.solid?.valid ?? null, failed: d.failed, parts: window.schmishape.mesh()?.parts.length ?? 0, features: d.features.map((f) => f.name) };
});
const rect = (x, y, w, h, id) => [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]].map((l, i) => ({ id: id + i, type: 'line', start: [l[0], l[1]], end: [l[2], l[3]] }));
const addSketch = (entities, name = 'Sketch 1', z = 0) => page.evaluate(async (feature, name) => {
  await window.schmishape.mutate('feature_add', { feature, name });
}, { type: 'constrained_sketch', plane: { origin: [0, 0, z], z: [0, 0, 1], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities, constraints: [] } }, name);
const row = (name) => page.evaluateHandle((n) => [...document.querySelectorAll('.feature-row')].find((r) => r.querySelector('.feature-name')?.textContent === n), name);
const clickRow = async (name) => { await (await row(name)).click(); await settle(200); };
const openRow = async (name) => { await (await row(name)).click({ count: 2 }); await settle(500); };
const accept = async () => { await page.$eval('[data-testid=dialog-ok]', (e) => e.click()); await settle(500); };
const typeInto = async (field, text) => { await page.$eval(`[data-field=${field}]`, (e) => { e.focus(); e.select(); }); await page.keyboard.type(text); await settle(350); };
const dlg = () => page.$eval('[data-testid=dialog]', (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; });
const stage = () => page.$eval('.stage', (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; });
const tabOn = () => page.$$eval('.dialog-tabs button.on', (b) => b[0]?.textContent ?? null);
const clickTab = async (name) => { await page.$$eval('.dialog-tabs button', (b, n) => b.find((x) => x.textContent === n).click(), name); await settle(400); };
const drag = async (from, to) => {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 6 });
  await wait(30);
  await page.mouse.up();
  await wait(60);
};
const headerSpot = async () => { const d = await dlg(); return [d.x + 70, d.y + 17]; };
const inStage = (d, s) => d.x >= s.x - 0.5 && d.y >= s.y - 0.5 && d.r <= s.r + 0.5 && d.b <= s.b + 0.5;
const grip = (name) => page.$eval(`[data-grip="${name}"]`, (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
const zIs = (s, a, b) => near(s.z0, a) && near(s.z1, b);
const newPart = async () => { await page.evaluate(() => window.schmishape.tabs.createTab('part-studio')); await settle(500); };

const AREA = 40 * 30;
const base = rect(-20, -15, 40, 30, 1);

await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=empty]', { timeout: 20000 });
await settle(400);

console.log('as in the reference');
await addSketch(base);
await settle(300);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
check('the title is the feature’s name', (await page.$eval('[data-testid=dialog] h3', (e) => e.textContent)) === 'Extrude 1');
check('a first feature is New', (await tabOn()) === 'New', `${await tabOn()}`);
const tabLabels = await page.$$eval('.dialog-tabs button', (b) => b.map((x) => [x.textContent, x.disabled]));
check('all four results are there', tabLabels.map((t) => t[0]).join() === 'New,Add,Remove,Intersect', JSON.stringify(tabLabels));
check('and a first feature can’t choose Remove', tabLabels.filter((t) => t[1]).map((t) => t[0]).join() === 'Add,Remove,Intersect', JSON.stringify(tabLabels));
await page.$$eval('.dialog-tabs button', (b) => b.find((x) => x.textContent === 'Remove').click());
await settle(200);
check('clicking it does nothing', (await tabOn()) === 'New' && near((await state()).volume, AREA * 20));
check('the box shows the pick as a row', (await page.$eval('.pick-name', (e) => e.textContent)) === 'All of Sketch 1');
check('with its size', (await page.$eval('.pick-size', (e) => e.textContent)) === '1,200 mm²', await page.$eval('.pick-size', (e) => e.textContent));
check('Depth is the label', await page.$$eval('.field-label', (l) => l.some((x) => x.textContent === 'Depth')));
check('at the end of the history there’s no Final to show', !(await page.$('[data-testid=dialog-final]')));
await shot('d01-extrude');

console.log('moving');
const home = await dlg();
const s0 = await stage();
check('it starts at the top left of the view', near(home.x, s0.x + 8) && near(home.y, s0.y + 8) && near(home.w, 288), JSON.stringify(home));
{
  const [hx, hy] = await headerSpot();
  await drag([hx, hy], [hx + 200, hy + 120]);
}
let d = await dlg();
check('dragging the header moves it', near(d.x, home.x + 200, 1e-2) && near(d.y, home.y + 120, 1e-2), JSON.stringify(d));
check('and the model didn’t turn', near((await state()).volume, AREA * 20));
await shot('d02-moved');
{
  const [hx, hy] = await headerSpot();
  await drag([hx, hy], [3000, 3000]);
}
d = await dlg();
const s1 = await stage();
check('it stops at the bottom right of the view', near(d.r, s1.r, 1e-2) && near(d.b, s1.b, 1e-2), JSON.stringify({ d, s1 }));
{
  const [hx, hy] = await headerSpot();
  await drag([hx, hy], [-500, -500]);
}
d = await dlg();
check('and at the top left', near(d.x, s1.x, 1e-2) && near(d.y, s1.y, 1e-2), JSON.stringify(d));
{
  const before = await dlg();
  const b = await page.$eval('[data-testid=dialog-ok]', (e) => { const r = e.getBoundingClientRect(); return [r.left + 5, r.top + 5]; });
  await page.mouse.move(b[0], b[1]);
  await page.mouse.down();
  await page.mouse.move(b[0] + 80, b[1] + 80, { steps: 4 });
  await page.mouse.up();
  await wait(60);
  const after = await dlg();
  check('a button in the header doesn’t start a drag', after.x === before.x && after.y === before.y, JSON.stringify(after));
}

console.log('resizing');
{
  const [hx, hy] = await headerSpot();
  await drag([hx, hy], [hx + 150, hy + 100]);
}
const r0 = await dlg();
await drag(await grip('se'), [r0.r + 120, r0.b + 160]);
let r1 = await dlg();
check('the corner resizes both ways', near(r1.w, r0.w + 120, 2e-2) && near(r1.h, r0.h + 160, 2e-2), JSON.stringify({ r0, r1 }));
check('without moving it', near(r1.x, r0.x, 1e-2) && near(r1.y, r0.y, 1e-2));
await shot('d03-resized');
await drag(await grip('w'), [r1.x - 40, r1.y + 50]);
const r2 = await dlg();
check('the left edge moves the left side', near(r2.x, r1.x - 40, 2e-2) && near(r2.r, r1.r, 1e-2) && near(r2.w, r1.w + 40, 2e-2), JSON.stringify(r2));
await drag(await grip('n'), [r2.x + 50, r2.y + 30]);
const r3 = await dlg();
check('the top edge moves the top', near(r3.y, r2.y + 30, 2e-2) && near(r3.b, r2.b, 1e-2), JSON.stringify(r3));
await drag(await grip('e'), [r3.x - 400, r3.y + 40]);
const r4 = await dlg();
check('it won’t go narrower than its minimum', near(r4.w, 240, 1e-2), JSON.stringify(r4));
await drag(await grip('s'), [r4.x + 40, r4.y - 400]);
const r5 = await dlg();
check('or shorter', near(r5.h, 120, 1e-2), JSON.stringify(r5));
const bodyScrolls = await page.$eval('.dialog-body', (e) => e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY === 'auto');
check('with too little room, the body scrolls', bodyScrolls);
await shot('d04-short');
const hdr = await page.$eval('[data-testid=dialog] header', (e) => { const b = e.getBoundingClientRect(); return [b.height, b.width]; });
check('and the header stays whole', hdr[0] === 34, JSON.stringify(hdr));
await drag(await grip('e'), [r5.r + 3000, r5.y + 40]);
const s2 = await stage();
check('nor wider than the view', (await dlg()).r <= s2.r + 0.5, JSON.stringify(await dlg()));
await drag(await grip('e'), [r5.x + 300, r5.y + 40]);
await drag(await grip('s'), [r5.x + 40, r5.y + 330]);
const kept = await dlg();

console.log('remembered');
await page.keyboard.press('Escape');
await settle(400);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
const again = await dlg();
check('the next dialog opens in the same place and size', near(again.x, kept.x, 1e-3) && near(again.y, kept.y, 1e-3) && near(again.w, kept.w, 1e-3) && near(again.h, kept.h, 1e-3), JSON.stringify({ kept, again }));
await page.keyboard.press('Escape');
await settle(300);
await wait(600);
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.schmishape?.doc?.features?.length > 0, { timeout: 15000 });
await settle(500);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
const afterReload = await dlg();
check('and it survives a reload', near(afterReload.x, kept.x, 1e-3) && near(afterReload.y, kept.y, 1e-3) && near(afterReload.w, kept.w, 1e-3) && near(afterReload.h, kept.h, 1e-3), JSON.stringify({ kept, afterReload }));

console.log('stays in the view');
await page.$eval('[data-testid=tab-manager-toggle]', (e) => e.click());
await settle(200);
check('with the tab manager open, it’s inside', inStage(await dlg(), await stage()), JSON.stringify(await dlg()));
await page.$eval('[data-testid=tab-manager-toggle]', (e) => e.click());
await settle(200);
{
  const [hx, hy] = await headerSpot();
  await drag([hx, hy], [3000, 3000]);
}
await page.setViewport({ width: 800, height: 500 });
await settle(300);
d = await dlg();
const small = await stage();
check('with a small window, it’s inside', inStage(d, small), JSON.stringify({ d, small }));
const head = await page.$eval('[data-testid=dialog] header', (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
check('so the header can’t be lost', head[0] >= small.x && head[1] >= small.y && head[2] <= small.r && head[3] <= small.b, JSON.stringify(head));
await page.setViewport({ width: 1440, height: 900 });
await settle(300);
check('and back at full size it’s where it was asked to be', inStage(await dlg(), await stage()));

console.log('double-click puts it back');
{
  const [hx, hy] = await headerSpot();
  await page.mouse.move(hx, hy);
  await page.mouse.click(hx, hy, { count: 2 });
  await wait(100);
}
d = await dlg();
const s3 = await stage();
check('to the default place and size', near(d.x, s3.x + 8) && near(d.y, s3.y + 8) && near(d.w, 288), JSON.stringify(d));
check('with its height following its content', (await page.$eval('[data-testid=dialog]', (e) => e.style.height)) === 'auto');
await page.keyboard.press('Escape');
await settle(400);

console.log('extrude’s options');
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
let s = await state();
check('forward', near(s.volume, AREA * 20) && zIs(s, 0, 20), JSON.stringify(s));
await page.click('[data-testid=flip-direction]');
await settle(350);
s = await state();
check('flip', near(s.volume, AREA * 20) && zIs(s, -20, 0), JSON.stringify(s));
await page.click('[data-field=symmetric]');
await settle(350);
s = await state();
check('symmetric, whose depth is the total', near(s.volume, AREA * 20) && zIs(s, -10, 10), JSON.stringify(s));
check('symmetric turns flip off', await page.$eval('[data-testid=flip-direction]', (e) => e.disabled));
check('and the second end', await page.$eval('[data-field=secondOn]', (e) => e.disabled));
await page.click('[data-field=symmetric]');
await settle(250);
await page.click('[data-testid=flip-direction]');
await settle(350);
await page.click('[data-field=offsetOn]');
await settle(350);
check('ticking an option opens it', !!(await page.$('[data-field=offset]')));
s = await state();
check('a starting offset of 5', near(s.volume, AREA * 20) && zIs(s, 5, 25), JSON.stringify(s));
await typeInto('offset', '7');
s = await state();
check('of 7', near(s.volume, AREA * 20) && zIs(s, 7, 27), JSON.stringify(s));
await page.click('[data-testid=flip-direction]');
await settle(350);
s = await state();
check('and flipped', near(s.volume, AREA * 20) && zIs(s, -27, -7), JSON.stringify(s));
await page.click('[data-testid=flip-direction]');
await settle(250);
await page.click('[data-field=offsetOn]');
await settle(350);
s = await state();
check('unticking takes the offset off', zIs(s, 0, 20), JSON.stringify(s));
await page.click('[data-field=secondOn]');
await settle(350);
check('the second end opens with its own depth', !!(await page.$('[data-field=second]')));
s = await state();
check('a second end of 10', near(s.volume, AREA * 30) && zIs(s, -10, 20), JSON.stringify(s));
await shot('d05-options');
await page.click('[data-testid=flip-direction]');
await settle(350);
s = await state();
check('flipped, it swaps sides', near(s.volume, AREA * 30) && zIs(s, -20, 10), JSON.stringify(s));
await page.click('[data-testid=flip-direction]');
await settle(250);
await page.click('[data-field=offsetOn]');
await settle(350);
s = await state();
check('with an offset, both ends move, and it remembered 7 while unticked', near(s.volume, AREA * 30) && zIs(s, -3, 27), JSON.stringify(s));
await accept();

console.log('read back');
await openRow('Extrude 1');
const inputs = () => page.evaluate(() => {
  const val = (k) => document.querySelector(`[data-field=${k}]`);
  return { length: val('length')?.value, offsetOn: val('offsetOn')?.checked, offset: val('offset')?.value, secondOn: val('secondOn')?.checked, second: val('second')?.value, symmetric: val('symmetric')?.checked, flip: document.querySelector('[data-testid=flip-direction]')?.getAttribute('aria-pressed') };
});
let v = await inputs();
check('reopening shows what was set', v.length === '20' && v.offsetOn && v.offset === '7' && v.secondOn && v.second === '10' && !v.symmetric && v.flip === 'false', JSON.stringify(v));
s = await state();
check('without changing the model', near(s.volume, AREA * 30) && zIs(s, -3, 27), JSON.stringify(s));
await shot('d06-reopened');
await accept();
s = await state();
check('saving it unchanged leaves it the same', near(s.volume, AREA * 30) && zIs(s, -3, 27), JSON.stringify(s));
await openRow('Extrude 1');
await page.click('[data-field=offsetOn]');
await settle(250);
await page.click('[data-field=secondOn]');
await settle(250);
await page.click('[data-testid=flip-direction]');
await settle(350);
await accept();
await openRow('Extrude 1');
v = await inputs();
check('flip reads back', v.flip === 'true' && !v.offsetOn && !v.secondOn, JSON.stringify(v));
await page.click('[data-field=symmetric]');
await settle(350);
await accept();
await openRow('Extrude 1');
v = await inputs();
check('symmetric reads back', v.symmetric === true, JSON.stringify(v));
s = await state();
check('and is still centred', zIs(s, -10, 10), JSON.stringify(s));
await page.keyboard.press('Escape');
await settle(400);

console.log('expressions');
await page.evaluate(() => window.schmishape.mutate('parameter_set', { name: 'w', value: 12 }));
await settle(300);
await openRow('Extrude 1');
await page.click('[data-field=symmetric]');
await settle(300);
await page.click('[data-testid=flip-direction]');
await settle(300);
await typeInto('length', 'w / 2');
s = await state();
check('a depth by expression', near(s.volume, AREA * 6) && zIs(s, 0, 6) && !s.failed, JSON.stringify(s));
await page.click('[data-testid=flip-direction]');
await settle(350);
s = await state();
check('flipped', zIs(s, -6, 0) && !s.failed, JSON.stringify(s));
await page.click('[data-field=symmetric]');
await settle(350);
s = await state();
check('symmetric', zIs(s, -3, 3) && !s.failed, JSON.stringify(s));
await page.click('[data-field=symmetric]');
await settle(250);
await page.click('[data-testid=flip-direction]');
await settle(250);
await page.click('[data-field=offsetOn]');
await settle(250);
await typeInto('offset', 'w');
s = await state();
check('an offset by expression', zIs(s, 12, 18) && !s.failed, JSON.stringify(s));
await page.click('[data-field=secondOn]');
await settle(250);
await typeInto('second', 'w - 2');
s = await state();
check('and a second end by expression', zIs(s, 2, 18) && near(s.volume, AREA * 16) && !s.failed, JSON.stringify(s));
await accept();
await openRow('Extrude 1');
v = await inputs();
check('expressions read back as typed', v.length === 'w / 2' && v.offset === 'w' && v.second === 'w - 2' && v.offsetOn && v.secondOn, JSON.stringify(v));
await page.keyboard.press('Escape');
await settle(400);
await page.evaluate(() => window.schmishape.mutate('parameter_set', { name: 'w', value: 20 }));
await settle(300);
s = await state();
check('and they follow the variable', zIs(s, 2, 30) && near(s.volume, AREA * 28), JSON.stringify(s));

console.log('from a file or an AI');
const featureId = () => page.evaluate(() => window.schmishape.doc.features.find((f) => f.name === 'Extrude 1').id);
const edit = (id, feature) => page.evaluate(async (id, feature) => { await window.schmishape.mutate('feature_edit', { id, feature }); }, id, feature);
const id = await featureId();
await edit(id, { type: 'extrude', sketch: 1, start: 3, length: 8, mode: 'new_body', app: {} });
await settle(300);
await openRow('Extrude 1');
v = await inputs();
check('a start the dialog can’t name becomes an offset', v.offsetOn && v.offset === '3' && v.length === '8' && !v.secondOn, JSON.stringify(v));
await accept();
s = await state();
check('and saving it changes nothing', zIs(s, 3, 11), JSON.stringify(s));
await page.evaluate(async (id) => {
  const f = window.schmishape.doc.features.find((x) => x.id === id);
  await window.schmishape.mutate('feature_edit', { id, feature: { type: 'extrude', sketch: 1, start: -9, length: 2, mode: f.mode } });
}, id);
await settle(300);
await openRow('Extrude 1');
v = await inputs();
check('a record that no longer fits the feature is ignored', v.offsetOn && v.offset === '-9' && v.length === '2', JSON.stringify(v));
await accept();
s = await state();
check('so an AI’s edit survives opening it', zIs(s, -9, -7), JSON.stringify(s));
for (const [start, length, want] of [[-8, 8, 'flip'], [-4, 8, 'symmetric']]) {
  await edit(id, { type: 'extrude', sketch: 1, start, length, mode: 'new_body', app: {} });
  await settle(300);
  await openRow('Extrude 1');
  v = await inputs();
  check(`${want} is recognised`, want === 'flip' ? v.flip === 'true' : v.symmetric === true, JSON.stringify(v));
  await page.keyboard.press('Escape');
  await settle(400);
}
await newPart();
await page.evaluate(() => document.querySelector('[data-testid=empty] .link').click());
await page.waitForFunction(() => window.schmishape.doc.features.some((f) => f.name === 'Holes'), { timeout: 15000 });
await settle(600);
const bracket = (await state()).volume;
await openRow('Holes');
await accept();
check('the example’s holes come through opening and saving', near((await state()).volume, bracket), `${bracket} ${(await state()).volume}`);
await openRow('Body');
v = await inputs();
check('its body reads as flipped', v.flip === 'true' && v.length === 'width', JSON.stringify(v));
await accept();
check('and comes through too', near((await state()).volume, bracket) && !(await state()).failed);

console.log('result tabs');
await newPart();
await addSketch(base);
await settle(300);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(400);
await accept();
const baseVol = AREA * 20;
await addSketch(rect(-5, -5, 10, 10, 1), 'Top', 20);
await settle(300);
await clickRow('Top');
await cmd('extrude');
await settle(500);
check('with a solid, Add is the default', (await tabOn()) === 'Add', `${await tabOn()}`);
const enabled = await page.$$eval('.dialog-tabs button', (b) => b.every((x) => !x.disabled));
check('and all four are open', enabled);
await typeInto('length', '10');
s = await state();
check('Add adds', near(s.volume, baseVol + 1000) && s.parts === 1, JSON.stringify(s));
await page.click('[data-testid=flip-direction]');
await settle(250);
await clickTab('Remove');
s = await state();
check('Remove cuts', near(s.volume, baseVol - 1000) && s.parts === 1, JSON.stringify(s));
await clickTab('Intersect');
s = await state();
check('Intersect keeps the overlap', near(s.volume, 1000), JSON.stringify(s));
await page.click('[data-testid=flip-direction]');
await settle(250);
await clickTab('New');
s = await state();
check('New makes a part of its own', near(s.volume, baseVol + 1000) && s.parts === 2, JSON.stringify(s));
await shot('d07-new-part');
await accept();
await openRow('Extrude 2');
check('and reads back', (await tabOn()) === 'New', `${await tabOn()}`);
await page.keyboard.press('Escape');
await settle(400);

console.log('rows');
await newPart();
await addSketch([...rect(-30, -5, 10, 10, 1), ...rect(-5, -5, 10, 10, 5), ...rect(20, -5, 10, 10, 9)]);
await settle(300);
await page.keyboard.press('1');
await wait(450);
await cmd('extrude');
await settle(300);
check('the box asks for regions', (await page.$eval('.pick-prompt', (e) => e.textContent)) === 'Click regions in the view');
const click3d = async (x, y) => {
  const p = await page.evaluate((x, y) => {
    const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
    const q = window.schmishape.view.renderer.camera.project([x, y, 0]);
    return [q[0] + b.left, q[1] + b.top];
  }, x, y);
  await page.mouse.move(p[0], p[1]);
  await wait(16);
  await page.mouse.down();
  await page.mouse.up();
  await settle(350);
};
await click3d(-25, 0);
await click3d(0, 0);
const names = () => page.$$eval('.pick-name', (r) => r.map((x) => x.textContent));
check('each pick is a row', (await names()).join() === 'Region of Sketch 1,Region of Sketch 1', (await names()).join());
check('the model has both', near((await state()).volume, 200 * 20), `${(await state()).volume}`);
await shot('d08-rows');
await page.$eval('.pick-remove', (e) => e.click());
await settle(400);
check('× drops one', (await names()).length === 1 && near((await state()).volume, 100 * 20), `${(await names()).length} ${(await state()).volume}`);
await page.$eval('.pick-remove', (e) => e.click());
await settle(400);
check('× on the last empties it', !!(await page.$('.pick-prompt')));
check('and there’s nothing to add', await page.$eval('[data-testid=dialog-ok]', (e) => e.disabled));
await clickRow('Sketch 1');
await settle(300);
check('all of a sketch is one row', (await names()).join() === 'All of Sketch 1', (await names()).join());
await page.$eval('.pick-remove', (e) => e.click());
await settle(400);
check('and × clears it', !!(await page.$('.pick-prompt')));
await page.keyboard.press('Escape');
await settle(400);

console.log('edges and faces');
await newPart();
await page.evaluate(async () => {
  await window.schmishape.mutate('feature_add', { name: 'Block', feature: { type: 'solid', shape: 'box', dx: 40, dy: 30, dz: 20 } });
  // Steps along the top give more edges than the list has room to show.
  for (let i = 0; i < 4; i++) await window.schmishape.mutate('feature_add', { name: `Notch ${i}`, feature: { type: 'solid', shape: 'box', dx: 4, dy: 30, dz: 4, mode: 'remove', at: { origin: [4 + i * 8, 0, 16] } } });
});
await settle(500);
await page.keyboard.press('f');
await settle(450);
await cmd('fillet');
await settle(600);
check('fillet’s box says what it’s for', (await page.$eval('.pick-label', (e) => e.textContent)) === 'Edges to fillet');
const allEdges = await page.evaluate(async () => (JSON.parse((await window.schmishape.engine.call('edges_list')).text)));
const lines = allEdges.filter((e) => e.curve === 'line').map((e) => e.select);
await page.evaluate((list) => window.schmishape.dialogSetValue('edges', list), lines.slice(0, 9));
await settle(700);
const rowText = await page.$$eval('.pick-row', (r) => r.slice(0, 2).map((x) => x.querySelector('.pick-name').textContent + '|' + (x.querySelector('.pick-size')?.textContent ?? '')));
check('edges have plain names and lengths', rowText.every((t) => /^Straight edge\|[\d.]+ mm$/.test(t)), rowText.join());
const list = await page.$eval('.pick-rows', (e) => ({ scroll: e.scrollHeight, client: e.clientHeight, rows: e.querySelectorAll('.pick-row').length }));
check('a long list scrolls inside the box', list.rows === 9 && list.scroll > list.client && list.client < 125, JSON.stringify(list));
const inside = await page.$eval('[data-testid=dialog]', (e) => { const b = e.getBoundingClientRect(), s = document.querySelector('.stage').getBoundingClientRect(); return b.bottom <= s.bottom; });
check('and the dialog stays in the view', inside);
await shot('d09-long-list');
await page.$eval('[data-testid=pick-well] .link', (e) => e.click());
await settle(400);
check('Clear empties it', !!(await page.$('.pick-prompt')));
await page.keyboard.press('Escape');
await settle(400);
await cmd('shell');
await settle(600);
const allFaces = await page.evaluate(async () => (JSON.parse((await window.schmishape.engine.call('faces_list')).text)));
await page.evaluate((name) => window.schmishape.dialogSetValue('open', [name]), allFaces.find((f) => f.surface === 'plane').name);
await settle(600);
const faceRow = await page.$eval('.pick-row', (x) => x.querySelector('.pick-name').textContent + '|' + (x.querySelector('.pick-size')?.textContent ?? ''));
check('faces too', /^Flat face\|[\d.,]+ mm²$/.test(faceRow), faceRow);
await page.keyboard.press('Escape');
await settle(400);

console.log('every dialog');
const crowded = () => page.evaluate(() => [...document.querySelectorAll('[data-testid=dialog] .dialog-tabs button, [data-testid=dialog] .segment button, [data-testid=dialog] .field-label, [data-testid=dialog] .check span')].filter((b) => b.scrollWidth > b.clientWidth + 1 && b.clientWidth > 0).map((b) => b.textContent));
await addSketch(rect(50, 0, 10, 10, 1), 'Profile', 0);
await settle(300);
await addSketch(rect(50, 0, 6, 6, 1), 'Higher', 40);
await settle(300);
for (const id of ['extrude', 'revolve', 'loft', 'fillet', 'chamfer', 'shell', 'draft', 'offset', 'thicken', 'delete-face', 'mirror', 'pattern-linear', 'pattern-circular']) {
  await cmd(id);
  await settle(600);
  const present = !!(await page.$('[data-testid=dialog]'));
  const tight = present ? await crowded() : ['no dialog'];
  check(`${id} fits`, present && tight.length === 0, tight.join());
  await shot(`d20-${id}`);
  await page.keyboard.press('Escape');
  await settle(400);
}

console.log('New on other features');
await newPart();
await addSketch(rect(10, 0, 10, 20, 1), 'Side');
await settle(300);
await cmd('revolve');
await settle(700);
s = await state();
check('a first revolve is New and builds', (await tabOn()) === 'New' && s.valid && !s.failed, JSON.stringify(s));
await accept();
await page.evaluate(async () => {
  await window.schmishape.mutate('feature_add', { name: 'A', feature: { type: 'constrained_sketch', plane: { origin: [100, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [{ id: 1, type: 'circle', center: [0, 0], radius: 5 }], constraints: [] } } });
  await window.schmishape.mutate('feature_add', { name: 'B', feature: { type: 'constrained_sketch', plane: { origin: [100, 0, 20], z: [0, 0, 1], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [{ id: 1, type: 'circle', center: [0, 0], radius: 3 }], constraints: [] } } });
});
await settle(300);
await cmd('loft');
await settle(300);
const sketchBoxes = await page.$$eval('[data-sketch]', (b) => b.map((x) => x.dataset.sketch));
for (const id of sketchBoxes.slice(-2)) { await page.$eval(`[data-sketch="${id}"]`, (e) => e.click()); await settle(250); }
await clickTab('New');
s = await state();
check('a loft can be New', s.valid && !s.failed && s.parts >= 2, JSON.stringify(s));
await page.keyboard.press('Escape');
await settle(400);
await cmd('thicken');
await settle(600);
const someFace = await page.evaluate(async () => JSON.parse((await window.schmishape.engine.call('faces_list')).text).find((f) => f.surface === 'plane').name);
await page.evaluate((name) => window.schmishape.dialogSetValue('faces', [name]), someFace);
await settle(600);
await clickTab('New');
const thick = await state();
const err = await page.$eval('[data-testid=dialog-error]', (e) => e.textContent).catch(() => null);
check('a thicken can be New', !err && thick.parts >= 2, JSON.stringify({ err, thick }));
await page.keyboard.press('Escape');
await settle(400);

console.log('checkbox focus');
await newPart();
await addSketch(base);
await settle(300);
await clickRow('Sketch 1');
await cmd('extrude');
await settle(500);
await page.click('[data-field=symmetric]');
await settle(300);
await page.keyboard.press('Escape');
await settle(400);
check('Esc still cancels with a checkbox focused', !(await page.$('[data-testid=dialog]')));

console.log('the preview slider');
await cmd('extrude');
await settle(500);
const opacity = () => page.evaluate(() => window.schmishape.view.renderer.previewOpacity);
const slider = () => page.$('[data-testid=preview-slider]');
check('an added extrude has it', !!(await slider()));
check('it starts see-through', near(await opacity(), 0.35), `${await opacity()}`);
{
  const b = await (await slider()).boundingBox();
  await page.mouse.click(b.x + b.width * 0.8, b.y + b.height / 2);
  await settle(150);
  check('dragging it changes how solid the preview is', (await opacity()) > 0.7 && (await opacity()) < 0.9, `${await opacity()}`);
  await page.mouse.click(b.x + 1, b.y + b.height / 2);
  await settle(150);
  check('all the way down is the model before it', (await opacity()) < 0.06, `${await opacity()}`);
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height / 2);
  await settle(150);
}
await page.keyboard.press('Enter');
await settle(500);
check('Enter still accepts with it focused', !(await page.$('[data-testid=dialog]')));
const remembered = await opacity();
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.schmishape?.doc?.features?.length > 0, { timeout: 15000 });
await settle(500);
await addSketch(rect(-5, -5, 10, 10, 1), 'Sketch 2', 20);
await settle(300);
await clickRow('Sketch 2');
await cmd('extrude');
await settle(500);
check('it stays where you left it', near(await opacity(), remembered, 1e-2), `${await opacity()}`);
await page.$$eval('[data-testid=dialog] button', (b) => b.find((x) => x.textContent === 'Remove').click());
await settle(400);
check('a cut has none, since it stays solid', !(await slider()));
check('and with nothing to put in it there’s no footer', !(await page.$('.dialog-foot')));
await page.keyboard.press('Escape');
await settle(400);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (problems.length) console.log('Browser errors:\n  ' + [...new Set(problems)].join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
