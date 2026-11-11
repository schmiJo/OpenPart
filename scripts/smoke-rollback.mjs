// Going back to an earlier feature, as in Onshape: editing one shows the model as it stood then, with the camera left
// alone, and the bar goes back afterwards. Driven with the mouse in the real app.
// Usage: node scripts/smoke-rollback.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-rollback';
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
const settle = async (ms = 350) => { await wait(ms); await page.waitForFunction(() => !document.querySelector('.spinner')); await wait(80); };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const cmd = (id) => page.$eval(`[data-command="${id}"]`, (e) => e.click());
const clickAt = async (x, y) => { await page.mouse.move(x, y); await wait(16); await page.mouse.down(); await page.mouse.up(); await wait(40); };

const state = () => page.evaluate(() => {
  const d = window.schmishape.doc;
  return {
    volume: d.solid?.volume ?? 0,
    rollback: d.rollback,
    barOn: d.rollback === null ? null : d.features[d.rollback]?.name,
    names: d.features.map((f) => f.name),
    failed: d.failed,
  };
});
const faded = () => page.$$eval('.feature-row.off .feature-name', (r) => r.map((x) => x.textContent));
/** The row the bar is drawn under, which is what you actually see. */
const barUnder = () => page.evaluate(() => document.querySelector('.rollback')?.previousElementSibling?.querySelector('.feature-name')?.textContent ?? null);
const camera = () => page.evaluate(() => { const c = window.schmishape.view.renderer.camera; return JSON.stringify([c.target, c.rot, c.halfH].flat().map((v) => Number(v.toFixed(6)))); });
const planes = () => page.evaluate(() => window.schmishape.view.renderer.planes.length);
const planeSize = () => page.evaluate(() => window.schmishape.view.renderer.planes[0]?.half);
const hiddenCount = () => page.evaluate(() => window.schmishape.doc.features.filter((f) => f.name.startsWith('~')).length);
const row = async (name) => {
  const h = await page.evaluateHandle((n) => [...document.querySelectorAll('.feature-row')].find((r) => r.querySelector('.feature-name')?.textContent === n), name);
  const b = await h.asElement()?.boundingBox();
  if (!b) throw new Error(`no row named ${name}`);
  return [b.x + 40, b.y + b.height / 2];
};
const clickRow = async (name) => { await page.mouse.click(...await row(name)); await settle(150); };
const openRow = async (name) => { await page.mouse.click(...await row(name), { count: 2 }); await settle(500); };
const rowMenu = async (name, item) => {
  await page.mouse.click(...await row(name), { button: 'right' });
  await wait(100);
  await page.$eval(`.menu [data-item="${item}"]`, (e) => e.click());
  await settle(450);
};
const accept = async () => { await page.$eval('[data-testid=dialog-ok]', (e) => e.click()); await settle(500); };
const typeLength = async (text) => { await page.$eval('[data-field=length]', (e) => { e.focus(); e.select(); }); await page.keyboard.type(text); await settle(400); };
const toScreen = (x, y, z = 0) => page.evaluate((p) => {
  const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
  const q = window.schmishape.view.renderer.camera.project(p);
  return [q[0] + b.left, q[1] + b.top];
}, [x, y, z]);
const clickWorld = async (x, y, z = 0) => { await clickAt(...await toScreen(x, y, z)); await settle(150); };
const regionAt = (x, y, z = 0) => page.evaluate((p) => {
  const r = window.schmishape.view.renderer;
  const q = r.camera.project(p);
  return r.pick(q[0], q[1])?.kind ?? null;
}, [x, y, z]);
const rect = (x, y, w, h, id) => [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]].map((l, i) => ({ id: id + i, type: 'line', start: [l[0], l[1]], end: [l[2], l[3]] }));
const addSketch = (entities, z, name) => page.evaluate(async (feature, name) => {
  const bar = window.schmishape.doc.rollback;
  await window.schmishape.mutate('feature_add', { feature, name, ...(bar === null ? {} : { position: bar + 1 }) });
}, { type: 'constrained_sketch', plane: { origin: [0, 0, z], z: [0, 0, 1], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities, constraints: [] } }, name);

await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=empty]', { timeout: 20000 });
await settle(400);

// A plate, then a boss from one region of a second sketch (which goes through a hidden copy), then a third block.
const PLATE = 60 * 40 * 10;
await addSketch(rect(-30, -20, 60, 40, 1), 0, 'Plate sketch');
await settle();
await clickRow('Plate sketch');
await cmd('extrude');
await settle(500);
await typeLength('10');
await accept();
const BOSS = 10 * 10 * 5;
await addSketch([...rect(-25, -15, 10, 10, 1), ...rect(5, 5, 20, 10, 5)], 10, 'Boss sketch');
await settle();
await page.keyboard.press('1');
await wait(500);
await clickWorld(-20, -10, 10);
await cmd('extrude');
await settle(500);
await typeLength('5');
await accept();
const TOP = 6 * 6 * 3;
await addSketch(rect(-3, -3, 6, 6, 1), 10, 'Top sketch');
await settle();
await clickRow('Top sketch');
await cmd('extrude');
await settle(500);
await typeLength('3');
await accept();
await page.keyboard.press('0');
await wait(500);
await page.mouse.move(800, 880);
await page.mouse.click(800, 880);
await settle(150);
const FULL = PLATE + BOSS + TOP;
let s = await state();
check('the part is built', near(s.volume, FULL) && s.rollback === null, `${s.volume} ${s.names.join()}`);
check('one extrude goes through a hidden copy', (await hiddenCount()) === 1);
await shot('b01-finished');

console.log('a click only selects');
const view0 = await camera();
await clickRow('Extrude 1');
s = await state();
check('a single click leaves the model alone', s.rollback === null && near(s.volume, FULL), `${s.volume}`);

console.log('double-click an old extrude');
await openRow('Extrude 1');
s = await state();
check('the model goes back to that step', near(s.volume, PLATE), `${s.volume}`);
check('the bar sits on it', s.barOn === 'Extrude 1' && (await barUnder()) === 'Extrude 1', `${s.barOn} / ${await barUnder()}`);
check('everything after it is out of the list’s way', (await faded()).join() === 'Boss sketch,Extrude 2,Top sketch,Extrude 3', (await faded()).join());
check('the camera hasn’t moved', (await camera()) === view0);
check('the planes stay', (await planes()) === 3);
check('there’s a Final button', !!(await page.$('[data-testid=dialog-final]')));
check('the regions well stays inside the dialog', await page.evaluate(() => document.querySelector('[data-testid=pick-well]').getBoundingClientRect().right <= document.querySelector('[data-testid=dialog]').getBoundingClientRect().right - 8));
await shot('b02-editing-old-extrude');

console.log('Final');
await page.$eval('[data-testid=dialog-final]', (e) => e.click());
await settle(450);
s = await state();
check('Final shows the finished model', near(s.volume, FULL) && s.rollback === null, `${s.volume}`);
await shot('b03-final');
await typeLength('20');
s = await state();
check('the edit previews in the finished model, where the plate now swallows the rest', near(s.volume, PLATE * 2) && s.rollback === null, `${s.volume}`);
await page.$eval('[data-testid=dialog-final]', (e) => e.click());
await settle(450);
s = await state();
check('turning it off goes back to the step, with the edit', near(s.volume, PLATE * 2) && s.barOn === 'Extrude 1', `${s.volume} ${s.barOn}`);

console.log('Esc');
await page.keyboard.press('Escape');
await settle(500);
s = await state();
check('Esc restores the model and the bar', near(s.volume, FULL) && s.rollback === null, `${s.volume} ${s.rollback}`);
check('nothing is faded any more', (await faded()).length === 0, (await faded()).join());
check('the camera still hasn’t moved', (await camera()) === view0);

console.log('accept');
await openRow('Extrude 1');
await typeLength('20');
s = await state();
check('the preview shows only that step', near(s.volume, PLATE * 2) && s.barOn === 'Extrude 1', `${s.volume}`);
await accept();
s = await state();
check('accepting puts the bar back at the end, with the edit', s.rollback === null && near(s.volume, PLATE * 2), `${s.volume} ${s.rollback}`);
const editedVolume = s.volume;
await page.mouse.move(800, 20);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(500);
s = await state();
check('undo takes back the edit, not a bar position', near(s.volume, FULL) && s.rollback === null, `${s.volume} ${s.rollback}`);
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await settle(500);
check('redo brings it back', near((await state()).volume, editedVolume));
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(500);

console.log('other ways in');
await rowMenu('Extrude 1', 'Edit');
await settle(300);
check('the menu’s Edit goes back too', (await state()).barOn === 'Extrude 1');
await page.keyboard.press('Escape');
await settle(500);
await page.$eval('.feature-row[data-index="1"]', (e) => e.focus());
await page.keyboard.press('Enter');
await settle(500);
check('Enter on a row goes back too', (await state()).barOn === 'Extrude 1' && !!(await page.$('[data-testid=dialog]')), `${(await state()).barOn}`);
await page.keyboard.press('Escape');
await settle(500);

console.log('an extrude with a hidden copy before it');
const copies = await hiddenCount();
await openRow('Extrude 2');
s = await state();
check('it goes back to the right feature', s.barOn === 'Extrude 2' && near(s.volume, PLATE + BOSS), `${s.barOn} ${s.volume}`);
check('the sketch it uses shows its regions', (await regionAt(15, 10, 10)) === 'region');
await shot('b04-editing-with-copy');
await clickWorld(15, 10, 10);
await settle(450);
s = await state();
check('clicking the other region previews whole sketch', near(s.volume, PLATE + BOSS + 20 * 10 * 5), `${s.volume}`);
check('that takes the copy away, and the bar stays on the feature', (await hiddenCount()) === copies - 1 && s.barOn === 'Extrude 2', `${await hiddenCount()} ${s.barOn}`);
await clickWorld(15, 10, 10);
await settle(450);
s = await state();
check('clicking it off brings a copy back, and the bar stays', (await hiddenCount()) === copies && s.barOn === 'Extrude 2' && near(s.volume, PLATE + BOSS), `${await hiddenCount()} ${s.barOn} ${s.volume}`);
await clickWorld(15, 10, 10);
await settle(450);
await accept();
s = await state();
check('accepted with the copy gone, the bar is back at the end', s.rollback === null && near(s.volume, FULL + 20 * 10 * 5), `${s.volume} ${s.rollback}`);
await page.mouse.move(800, 20);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(500);
check('undo brings the copy back', (await hiddenCount()) === copies && near((await state()).volume, FULL), `${(await state()).volume}`);

console.log('with the bar already rolled back');
await rowMenu('Extrude 2', 'Roll to here');
s = await state();
check('Roll to here', s.barOn === 'Extrude 2' && near(s.volume, PLATE + BOSS) && (await barUnder()) === 'Extrude 2', `${s.barOn} ${s.volume}`);
await openRow('Extrude 1');
check('editing an earlier feature goes further back', near((await state()).volume, PLATE) && (await state()).barOn === 'Extrude 1');
await page.keyboard.press('Escape');
await settle(500);
s = await state();
check('Esc returns to where the bar was, not the end', s.barOn === 'Extrude 2' && near(s.volume, PLATE + BOSS), `${s.barOn} ${s.volume}`);
await openRow('Extrude 1');
await typeLength('12');
await accept();
s = await state();
check('accepting does too', s.barOn === 'Extrude 2', `${s.barOn}`);
await page.mouse.move(800, 20);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(500);
// Now change how many hidden features come before the bar. The bar has to stay on its feature, not its position.
await rowMenu('Extrude 3', 'Roll to here');
await rowMenu('Top sketch', 'Roll to here');
await openRow('Extrude 2');
await clickWorld(15, 10, 10);
await settle(450);
await accept();
s = await state();
check('with a hidden copy gone from under it, the bar stays on its feature', s.barOn === 'Top sketch' && (await barUnder()) === 'Top sketch', `${s.barOn} / ${await barUnder()}`);
await page.mouse.move(800, 20);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(500);

console.log('rolled past the feature being edited');
await rowMenu('Extrude 1', 'Roll to here');
await openRow('Extrude 3');
s = await state();
check('editing a later one shows its step', s.rollback === null && near(s.volume, FULL), `${s.barOn} ${s.volume}`);
await page.keyboard.press('Escape');
await settle(500);
check('and the bar goes back after', (await state()).barOn === 'Extrude 1', `${(await state()).barOn}`);

console.log('the bar');
const barBox = async () => (await page.$('.rollback')).boundingBox();
const bb = await barBox();
await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: 'right' });
await wait(100);
await shot('b05-bar-menu');
await page.$eval('.menu [data-item="Roll to end"]', (e) => e.click());
await settle(450);
s = await state();
check('Roll to end', s.rollback === null && near(s.volume, FULL), `${s.rollback}`);
const end = await barBox();
await page.mouse.click(end.x + end.width / 2, end.y + end.height / 2);
await wait(100);
const steps = [];
for (let i = 0; i < 5; i++) {
  await page.keyboard.press('ArrowUp');
  await settle(350);
  steps.push((await state()).barOn);
}
check('↑ steps one visible feature at a time, skipping the hidden one', steps.join() === 'Top sketch,Extrude 2,Boss sketch,Extrude 1,Plate sketch', steps.join());
await page.keyboard.press('ArrowUp');
await settle(250);
check('and stops at the first', (await state()).barOn === 'Plate sketch');
const down = [];
for (let i = 0; i < 5; i++) {
  await page.keyboard.press('ArrowDown');
  await settle(350);
  down.push((await state()).barOn);
}
check('↓ comes back the same way, to the end', down.join() === 'Extrude 1,Boss sketch,Extrude 2,Top sketch,', down.join());
check('and the model is whole', near((await state()).volume, FULL));
check('the camera never moved through all that', (await camera()) === view0);

console.log('the last feature');
await openRow('Extrude 3');
check('it has no Final, with nothing after it', !(await page.$('[data-testid=dialog-final]')));
check('and nothing goes anywhere', (await state()).rollback === null && near((await state()).volume, FULL));
await page.keyboard.press('Escape');
await settle(500);
await page.mouse.click(800, 880);
await settle(150);

console.log('a new feature');
await clickRow('Top sketch');
await cmd('extrude');
await settle(500);
check('at the end there’s no Final', !(await page.$('[data-testid=dialog-final]')));
await page.keyboard.press('Escape');
await settle(500);
await rowMenu('Extrude 1', 'Roll to here');
await addSketch(rect(-29, -19, 4, 4, 1), 10, 'Inserted sketch');
await settle();
s = await state();
check('a feature added at the bar goes in there, with the bar after it', s.barOn === 'Inserted sketch' && s.names.indexOf('Inserted sketch') === 2, `${s.barOn} ${s.names.join()}`);
await clickRow('Inserted sketch');
await cmd('extrude');
await settle(500);
check('in mid-history a new feature has Final', !!(await page.$('[data-testid=dialog-final]')));
await page.$eval('[data-testid=dialog-final]', (e) => e.click());
await settle(450);
check('and it shows the rest', (await state()).rollback === null);
await accept();
s = await state();
check('accepting leaves the bar on the new feature', s.barOn === 'Extrude 4', `${s.barOn} ${s.names.join()}`);
await rowMenu('Extrude 3', 'Delete');
await rowMenu('Top sketch', 'Delete');
await rowMenu('Extrude 4', 'Delete');
await rowMenu('Inserted sketch', 'Delete');
const b2 = await barBox();
await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2, { button: 'right' });
await wait(100);
await page.$('.menu [data-item="Roll to end"]:not([disabled])').then((h) => h?.click());
await settle(450);

console.log('open an old sketch');
const FULL2 = PLATE + BOSS;
s = await state();
check('down to a plate and a boss', near(s.volume, FULL2) && s.rollback === null, `${s.volume} ${s.names.join()}`);
const view1 = await camera();
const planeSize1 = await planeSize();
await openRow('Plate sketch');
check('it opens', await page.evaluate(() => !!window.schmishape.session()));
s = await state();
check('the model goes back to before any solid', s.volume === 0 && s.barOn === 'Plate sketch', `${s.volume} ${s.barOn}`);
check('the mesh is really gone', await page.evaluate(() => window.schmishape.mesh().indices.length === 0));
check('the camera hasn’t moved', (await camera()) === view1);
check('the planes stay', (await planes()) === 3);
check('at the same size', (await planeSize()) === planeSize1, `${await planeSize()} vs ${planeSize1}`);
await wait(200);
await shot('b06-editing-old-sketch');
await page.$eval('[data-testid=sketch-done]', (e) => e.click());
await settle(600);
s = await state();
check('finishing unchanged puts it all back', near(s.volume, FULL2) && s.rollback === null, `${s.volume}`);
check('without moving the camera', (await camera()) === view1, await camera());
await openRow('Plate sketch');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await settle(600);
s = await state();
check('Esc out of the sketch too', near(s.volume, FULL2) && s.rollback === null && !(await page.evaluate(() => !!window.schmishape.session())), `${s.volume}`);
await openRow('Plate sketch');
await page.$eval('[data-testid=sketch-cancel]', (e) => e.click());
await settle(600);
s = await state();
check('Discard too', near(s.volume, FULL2) && s.rollback === null, `${s.volume}`);
await openRow('Plate sketch');
await page.evaluate(() => window.schmishape.session().change((d) => {
  const e = d.entities.find((x) => x.id === 2);
  e.start[0] = 40; e.end[0] = 40;
  d.entities.find((x) => x.id === 1).end[0] = 40;
  d.entities.find((x) => x.id === 3).start[0] = 40;
}));
await wait(300);
await page.$eval('[data-testid=sketch-done]', (e) => e.click());
await settle(700);
s = await state();
check('an edit to the sketch reaches the rest of the model', s.rollback === null && near(s.volume, 70 * 40 * 10 + BOSS), `${s.volume} ${s.failed}`);
check('still without moving the camera', (await camera()) === view1);
await page.mouse.move(800, 20);
await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
await settle(500);
check('one undo takes it back', near((await state()).volume, FULL2), `${(await state()).volume}`);

console.log('open a sketch with a hidden copy after it');
await openRow('Boss sketch');
s = await state();
check('its extrude and copy are gone', s.barOn === 'Boss sketch' && near(s.volume, PLATE), `${s.barOn} ${s.volume}`);
await page.$eval('[data-testid=sketch-done]', (e) => e.click());
await settle(600);
s = await state();
check('and back', s.rollback === null && near(s.volume, FULL2), `${s.volume}`);

console.log('opening one thing from another');
await openRow('Extrude 1');
await openRow('Plate sketch');
check('with a dialog waiting for regions, a sketch’s row chooses it instead', !(await page.evaluate(() => !!window.schmishape.session())) && !!(await page.$('[data-testid=dialog]')));
await page.keyboard.press('Escape');
await settle(500);
await page.evaluate(() => window.schmishape.startFeature('fillet'));
await settle(500);
await openRow('Plate sketch');
check('a sketch opens from any other dialog', await page.evaluate(() => !!window.schmishape.session()) && !(await page.$('[data-testid=dialog]')));
await openRow('Extrude 1');
s = await state();
check('a dialog opens from a sketch', !(await page.evaluate(() => !!window.schmishape.session())) && !!(await page.$('[data-testid=dialog]')) && s.barOn === 'Extrude 1', `${s.barOn}`);
await page.keyboard.press('Escape');
await settle(500);
s = await state();
check('and the bar still goes all the way back', s.rollback === null && near(s.volume, FULL2), `${s.rollback} ${s.volume}`);

console.log('a feature with no dialog');
await page.evaluate(async () => {
  await window.schmishape.mutate('feature_add', { name: 'Moved', feature: { type: 'transform', motion: { type: 'translate', by: [0, 0, 1] }, bodies: ['f2'] } });
  await window.schmishape.mutate('feature_add', { name: 'Last sketch', feature: { type: 'constrained_sketch', plane: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] }, sketch: { format: 'coreshape-sketch', version: 1, entities: [], constraints: [] } } });
});
await settle(400);
await openRow('Moved');
s = await state();
const said = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
check('it says so and doesn’t roll back', s.rollback === null && /has no dialog/.test(said), `${s.rollback} ${said}`);
await page.evaluate(async () => {
  const d = window.schmishape.doc;
  for (const n of ['Last sketch', 'Moved']) await window.schmishape.mutate('feature_delete', { id: d.features.find((f) => f.name === n).id });
});
await settle(400);

console.log('switching tabs while editing');
const tabs = (fn, ...a) => page.evaluate((fn, a) => window.schmishape.tabs[fn](...a), fn, a);
const studio = await page.evaluate(() => window.schmishape.tabs.activeTabId());
const other = await page.evaluate(() => window.schmishape.tabs.tabs().find((t) => t.kind !== 'folder' && t.id !== window.schmishape.tabs.activeTabId()).id);
await openRow('Extrude 1');
check('the dialog has rolled back', (await state()).barOn === 'Extrude 1');
await tabs('activateTab', other);
await settle(500);
await tabs('activateTab', studio);
await settle(600);
s = await state();
check('leaving cancels the edit and keeps the real bar', s.rollback === null && near(s.volume, FULL2), `${s.rollback} ${s.volume}`);
await rowMenu('Extrude 1', 'Roll to here');
await openRow('Plate sketch');
check('a sketch has rolled back', (await state()).barOn === 'Plate sketch');
await tabs('activateTab', other);
await settle(500);
await tabs('activateTab', studio);
await settle(600);
s = await state();
check('leaving keeps the sketch and the bar it had before', s.barOn === 'Extrude 1' && !(await page.evaluate(() => !!window.schmishape.session())), `${s.barOn}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (problems.length) console.log('Browser errors:\n  ' + [...new Set(problems)].join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
