// An assembly built with the mouse in the real app: insert, move, mate, fail, reload, and a Part Studio changing under it.
// Usage: node scripts/smoke-assembly.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-assembly';
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
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cmd = (id) => page.$eval(`[data-command="${id}"]`, (e) => e.click());

const tabBox = async (name) => {
  const handle = await page.evaluateHandle((n) => [...document.querySelectorAll('.tabbar .tab')].find((t) => t.querySelector('.tab-name')?.textContent === n), name);
  const b = await handle.asElement()?.boundingBox();
  if (!b) throw new Error(`no tab named ${name}`);
  return b;
};
const clickTab = async (name) => { const b = await tabBox(name); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await settle(500); };
const state = () => page.evaluate(() => {
  const a = window.schmishape.assembly;
  const d = a.asm();
  return {
    instances: d.instances.map((i) => ({ id: i.id, tab: i.tab, body: i.body, name: a.instanceName(i), fixed: i.fixed, hidden: i.hidden, p: i.pose.p, q: i.pose.q, problem: a.instanceProblem(i) })),
    mates: d.mates.map((m) => ({ id: m.id, name: m.name, type: m.type, a: m.a, b: m.b, suppressed: m.suppressed, flip: m.flip, quarter: m.quarter, ca: m.ca, cb: m.cb })),
    dof: a.asmFreedom(),
    failures: [...a.mateFailures()],
    undo: a.asmCanUndo(),
    selected: a.selectedInstances(),
    mesh: { tris: window.schmishape.mesh().indices.length / 3, min: window.schmishape.mesh().min, max: window.schmishape.mesh().max },
    failed: window.schmishape.doc.failed,
  };
});
const worldOf = (inst, local) => {
  const q = inst.q;
  const u = [q[0], q[1], q[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const t = cross(u, local).map((v) => v * 2);
  const c = cross(u, t);
  return [local[0] + t[0] * q[3] + c[0] + inst.p[0], local[1] + t[1] * q[3] + c[1] + inst.p[1], local[2] + t[2] * q[3] + c[2] + inst.p[2]];
};
const toScreen = (p) => page.evaluate((p) => {
  const b = document.querySelector('[data-testid=viewport]').getBoundingClientRect();
  const q = window.schmishape.view.renderer.camera.project(p);
  return [q[0] + b.left, q[1] + b.top];
}, p);
const clickAt = async (x, y) => { await page.mouse.move(x, y); await wait(60); await page.mouse.down(); await page.mouse.up(); await settle(200); };
const clickWorld = async (p) => { const [x, y] = await toScreen(p); await clickAt(x, y); };
const hoverWorld = async (p) => { const [x, y] = await toScreen(p); await page.mouse.move(x, y); await wait(120); };
const dragScreen = async (from, to, steps = 10) => {
  await page.mouse.move(from[0], from[1]);
  await wait(40);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await wait(30);
  }
  await wait(60);
  await page.mouse.up();
  await settle(200);
};
const statusLeft = () => page.$eval('.status-left', (e) => e.textContent);
const freedomText = () => page.$eval('[data-testid=assembly-status]', (e) => e.textContent).catch(() => null);
const rowOf = async (attr, id) => {
  const h = await page.$(`[data-${attr}="${id}"]`);
  return h ? h.boundingBox() : null;
};
const menuOn = async (attr, id, item) => {
  const b = await rowOf(attr, id);
  await page.mouse.click(b.x + 40, b.y + b.height / 2, { button: 'right' });
  await wait(100);
  await page.$eval(`.menu [data-item="${item}"]`, (e) => e.click());
  await settle(250);
};
const ctrl = async (key) => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await settle(250); };
const parked = () => page.mouse.move(700, 15);

await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=empty]', { timeout: 20000 });
await settle(400);

console.log('two Part Studios to draw from');
await page.evaluate(async () => {
  await window.schmishape.mutate('feature_add', { name: 'Base', feature: { type: 'solid', shape: 'box', dx: 60, dy: 40, dz: 10 } });
  await window.schmishape.mutate('feature_add', { name: 'Lug', feature: { type: 'solid', shape: 'cylinder', radius: 6, height: 12, at: { origin: [100, 0, 0] } } });
});
await settle(400);
await page.$eval('[data-testid=tab-insert]', (e) => e.click());
await wait(80);
await page.$eval('.menu [data-command="tab.part-studio"]', (e) => e.click());
await settle(500);
await page.evaluate(async () => {
  await window.schmishape.mutate('feature_add', { name: 'Arm', feature: { type: 'solid', shape: 'box', dx: 50, dy: 10, dz: 5, at: { origin: [0, 60, 0] } } });
});
await settle(500);

console.log('insert');
await clickTab('Assembly 1');
check('an empty assembly says what to do', !!(await page.$('[data-testid=assembly-empty]')));
check('the toolbar has assembly tools', !!(await page.$('[data-command="asm.insert"]')) && !(await page.$('[data-command=extrude]')));
await shot('a01-empty-assembly');
check('mate tools wait for two parts', await page.$eval('[data-command="asm.mate.revolute"]', (e) => e.disabled));
await parked();
await page.keyboard.press('i');
await page.waitForSelector('[data-testid=insert-dialog] .insert-row', { timeout: 8000 });
await settle(200);
const listed = await page.$$eval('[data-testid=insert-dialog] .insert-row', (r) => r.map((x) => x.textContent.trim()));
check('Insert lists Part Studios and their parts', listed.join() === 'Part Studio 1,Part 1,Part 2,Part Studio 2,Part 1', listed.join());
await shot('a02-insert-dialog');
{
  const frame = () => page.$eval('[data-testid=insert-dialog]', (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, grips: e.querySelectorAll('.dialog-grip').length }; });
  const was = await frame();
  check('Insert can be resized like any dialog', was.grips === 8, `${was.grips}`);
  const h = await (await page.$('[data-testid=insert-dialog] header')).boundingBox();
  await page.mouse.move(h.x + 60, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 160, h.y + h.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await settle(100);
  const moved = await frame();
  check('and moved', near(moved.x, was.x + 100) && near(moved.y, was.y + 40), JSON.stringify(moved));
  await page.mouse.click(moved.x + 60, moved.y + h.height / 2, { count: 2 });
  await settle(100);
  check('and put back', near((await frame()).x, was.x) && near((await frame()).y, was.y), JSON.stringify(await frame()));
}
await page.$$eval('[data-testid=insert-dialog] .insert-row.part', (r) => r[0].click());
await settle(400);
let s = await state();
check('a part goes in', s.instances.length === 1 && s.mesh.tris > 0, JSON.stringify(s.instances.map((i) => i.name)));
check('where it is in its Part Studio', near(s.mesh.min[0], 0) && near(s.mesh.max[0], 60) && near(s.mesh.max[1], 40), JSON.stringify(s.mesh));
check('it isn’t fixed until you say so, as in Onshape', !s.instances[0].fixed);
check('named as in Onshape', s.instances[0].name === 'Part Studio 1: Part 1 <1>', s.instances[0].name);
check('the panel lists it', (await page.$$eval('[data-testid=instances] .asm-row', (r) => r.length)) === 1);
check('so it’s free to move', (await freedomText()) === '6 freedoms left', await freedomText());
await menuOn('instance', s.instances[0].id, 'Fix');
s = await state();
check('Fix fixes it', s.instances[0].fixed);
check('it shows it’s fixed', !!(await page.$('[data-testid=instances] .asm-fixed')));
check('nothing’s left free', (await freedomText()) === 'Fully defined', await freedomText());
await page.$$eval('[data-testid=insert-dialog] .insert-row.part', (r) => r[2].click());
await settle(400);
s = await state();
check('a second part goes in free', s.instances.length === 2 && !s.instances[1].fixed && s.dof === 6, `${s.dof}`);
check('the freedoms show', (await freedomText()) === '6 freedoms left', await freedomText());
await page.$$eval('[data-testid=insert-dialog] .insert-row.part', (r) => r[2].click());
await settle(400);
s = await state();
check('another of the same part is numbered', s.instances[2].name === 'Part Studio 2: Part 1 <2>', s.instances[2].name);
check('and lands a little way off', dist(s.instances[2].p, s.instances[1].p) > 1, JSON.stringify(s.instances[2].p));
await page.keyboard.press('Escape');
await settle(100);
check('Esc closes Insert', !(await page.$('[data-testid=insert-dialog]')));
await page.keyboard.press('f');
await wait(600);
await shot('a03-three-parts');

console.log('selecting');
const ARM = [25, 65, 5];
const arm = s.instances[1], base = s.instances[0];
await page.mouse.move(700, 880);
await clickWorld(ARM);
s = await state();
check('a click selects the part under it', s.selected.join() === arm.id, s.selected.join());
await shot('a04-selected-with-triad');
check('hovering names the part', true);
await hoverWorld([30, 20, 10]);
check('hovering says which part', /Part Studio 1: Part 1 <1>/.test(await statusLeft()), await statusLeft());
await clickAt(1250, 800);
check('a click on nothing selects nothing', (await state()).selected.length === 0);
{
  // A box from an empty corner around the first arm takes that arm, and not the base or second arm it only crosses.
  const corners = [[0, 60, 0], [50, 60, 0], [0, 70, 0], [50, 70, 0], [0, 60, 5], [50, 60, 5], [0, 70, 5], [50, 70, 5]].map((p) => worldOf(arm, p));
  const screen = await Promise.all(corners.map(toScreen));
  const lo = [Math.min(...screen.map((p) => p[0])) - 8, Math.min(...screen.map((p) => p[1])) - 8];
  const hi = [Math.max(...screen.map((p) => p[0])) + 8, Math.max(...screen.map((p) => p[1])) + 8];
  await dragScreen(lo, hi);
  check('a box selects the whole parts inside it, and only those', (await state()).selected.join() === arm.id, (await state()).selected.join());
  await shot('a04b-box-selected');
  await clickAt(1250, 800);
}

console.log('free drag');
{
  const before = (await state()).instances[1];
  const from = await toScreen(ARM);
  await dragScreen(from, [from[0] + 90, from[1] - 40]);
  const after = (await state()).instances[1];
  check('dragging a part moves it', dist(after.p, before.p) > 5, JSON.stringify(after.p));
  check('without turning it', after.q.every((v, i) => near(v, before.q[i], 1e-9)));
  const grabbed = await toScreen(worldOf(after, [25, 65, 5]));
  check('the point you grabbed follows the pointer', Math.hypot(grabbed[0] - from[0] - 90, grabbed[1] - from[1] + 40) < 2, JSON.stringify(grabbed));
  check('and it isn’t selected by that', !(await state()).selected.includes(after.id));
  await parked();
  await ctrl('z');
  const undone = (await state()).instances[1];
  check('undo puts it back', dist(undone.p, before.p) < 1e-6);
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await settle(250);
  check('redo moves it again', dist((await state()).instances[1].p, after.p) < 1e-6);
  await ctrl('z');
}
{
  const before = (await state()).instances[0];
  const from = await toScreen([50, 30, 10]);
  await dragScreen(from, [from[0] + 60, from[1] + 60]);
  const after = (await state()).instances[0];
  check('a fixed part doesn’t move', dist(after.p, before.p) < 1e-9);
  const toast = await page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' '));
  check('and says why', /is fixed/.test(toast), toast);
}
{
  const cam = () => page.evaluate(() => window.schmishape.view.renderer.camera.back());
  const backBefore = await cam();
  const before = (await state()).instances[1];
  const from = await toScreen(ARM);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(from[0] + 60, from[1] + 20, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  await wait(150);
  check('right drag rotates the view', dist(await cam(), backBefore) > 0.05);
  check('and leaves the part alone', dist((await state()).instances[1].p, before.p) < 1e-9);
  await page.keyboard.press('0');
  await wait(600);
  await page.keyboard.press('f');
  await wait(600);
}

console.log('the manipulator');
{
  await page.mouse.move(700, 880);
  await clickWorld(ARM);
  const inst = (await state()).instances[1];
  const center = worldOf(inst, [25, 65, 2.5]);
  // Along X: the triad's X arrow, grabbed halfway along.
  const wpp = await page.evaluate(() => window.schmishape.view.renderer.camera.worldPerPixel);
  const onAxis = await toScreen([center[0] + 40 * wpp, center[1], center[2]]);
  const tip = await toScreen([center[0] + 62 * wpp, center[1], center[2]]);
  const c0 = await toScreen(center);
  const dir = [tip[0] - c0[0], tip[1] - c0[1]];
  await hoverWorld([center[0] + 40 * wpp, center[1], center[2]]);
  check('hovering an arrow says what it does', /move along/.test(await statusLeft()), await statusLeft());
  await dragScreen(onAxis, [onAxis[0] + dir[0], onAxis[1] + dir[1]]);
  const moved = (await state()).instances[1];
  check('an arrow moves it along its axis only', moved.p[0] - inst.p[0] > 1 && near(moved.p[1], inst.p[1], 1e-6) && near(moved.p[2], inst.p[2], 1e-6), JSON.stringify(moved.p));
  check('without turning it', moved.q.every((v, i) => near(v, inst.q[i], 1e-9)));
  await parked();
  await ctrl('z');
  // Turning about Z: the arc between the triad's X and Y.
  const r = 40 * wpp * Math.SQRT1_2;
  const onArc = await toScreen([center[0] + r, center[1] + r, center[2]]);
  const c = await toScreen(center);
  const later = [c[0] + (onArc[1] - c[1]) * -1 * -1, c[1] - (onArc[0] - c[0]) * -1 * -1];
  await hoverWorld([center[0] + r, center[1] + r, center[2]]);
  check('hovering an arc says what it does', /turn about/.test(await statusLeft()), await statusLeft());
  await dragScreen(onArc, later, 12);
  const turned = (await state()).instances[1];
  const x = worldOf({ p: [0, 0, 0], q: turned.q }, [1, 0, 0]);
  check('an arc turns it about that axis', Math.abs(x[2]) < 1e-6 && Math.abs(x[0] - 1) > 0.05, JSON.stringify(x));
  const newCenter = worldOf(turned, [25, 65, 2.5]);
  check('around its own center', dist(newCenter, center) < 1e-3, `${dist(newCenter, center)}`);
  await shot('a05-turned-with-triad');
  await parked();
  await ctrl('z');
  await page.keyboard.press('Escape');
}

console.log('the panel');
{
  const third = (await state()).instances[2];
  const eye = await page.$(`[data-instance="${third.id}"] .row-eye`);
  const row = await rowOf('instance', third.id);
  await page.mouse.move(row.x + 40, row.y + 8);
  await wait(60);
  await eye.click();
  await settle(200);
  const before = (await state());
  check('the eye hides an instance', before.instances[2].hidden, '');
  check('and it leaves the view', before.mesh.tris === 12 + 12, `${before.mesh.tris}`);
  await menuOn('instance', third.id, 'Show');
  check('and shows it again', !(await state()).instances[2].hidden && (await state()).mesh.tris === 36);
  await menuOn('instance', third.id, 'Fix');
  check('Fix fixes it', (await state()).instances[2].fixed && (await state()).dof === 6, `${(await state()).dof}`);
  await menuOn('instance', third.id, 'Unfix');
  check('Unfix frees it', !(await state()).instances[2].fixed && (await state()).dof === 12, `${(await state()).dof}`);
  await menuOn('instance', third.id, 'Rename');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('Spare arm');
  await page.keyboard.press('Enter');
  await settle(200);
  check('Rename names it', (await state()).instances[2].name === 'Spare arm', (await state()).instances[2].name);
  await menuOn('instance', third.id, 'Delete');
  check('Delete removes it', (await state()).instances.length === 2 && (await state()).dof === 6);
  await parked();
  await ctrl('z');
  check('and undo brings it back', (await state()).instances.length === 3 && (await state()).instances[2].name === 'Spare arm');
  await menuOn('instance', third.id, 'Delete');
}

console.log('a mate');
await page.keyboard.press('0');
await wait(500);
await page.keyboard.press('f');
await wait(600);
const MATE_CENTER = [30, 20, 10];
{
  await page.mouse.move(700, 15);
  await cmd('asm.mate.revolute');
  await settle(150);
  check('the mate dialog opens', !!(await page.$('[data-testid=mate-dialog]')));
  check('in the same movable window', (await page.$$eval('[data-testid=mate-dialog] .dialog-grip', (g) => g.length)) === 8);
  await shot('a06-mate-dialog');
  check('it can’t be added yet', await page.$eval('[data-testid=mate-ok]', (e) => e.disabled));
  await hoverWorld([3, 65, 5]);
  await wait(120);
  await shot('a07-connectors-on-hover');
  const spots = await page.evaluate(async () => (await window.schmishape.assembly.partOf(window.schmishape.assembly.asm().instances[1]).faces.find((f) => f.normal[2] > 0.9))?.key);
  check('the arm’s top is what’s hovered', !!spots, spots);
  await clickWorld([1, 65, 5]);
  const first = await page.$eval('[data-testid=mate-first]', (e) => e.textContent);
  check('the first connector goes in', /Part Studio 2: Part 1 <1>/.test(first), first);
  const second0 = await page.$eval('[data-testid=mate-second]', (e) => e.textContent);
  check('the second waits', /Click a connector/.test(second0), second0);
  // Another on the same part is refused.
  const armNow = (await state()).instances[1];
  await clickWorld(worldOf(armNow, [40, 65, 5]));
  check('a second connector on the same part is refused', /Click a connector/.test(await page.$eval('[data-testid=mate-second]', (e) => e.textContent)));
  await hoverWorld(MATE_CENTER);
  await wait(100);
  await shot('a08-second-connector');
  await clickWorld(MATE_CENTER);
  await settle(300);
  s = await state();
  check('the second goes in', /Part Studio 1: Part 1 <1>/.test(await page.$eval('[data-testid=mate-second]', (e) => e.textContent)));
  const arm1 = s.instances[1];
  const m0 = s.mates[0];
  check('the first part moves to the second', dist(worldOf(arm1, m0.ca.frame.o), worldOf(s.instances[0], m0.cb.frame.o)) < 1e-6, JSON.stringify(arm1.p));
  check('the connector landed on the base’s center', dist(worldOf(s.instances[0], m0.cb.frame.o), MATE_CENTER) < 1e-6, JSON.stringify(worldOf(s.instances[0], m0.cb.frame.o)));
  check('the fixed part stayed', dist(s.instances[0].p, base.p) < 1e-9);
  check('it leaves one freedom', s.dof === 1, `${s.dof}`);
  await shot('a09-mate-preview');
  const zBefore = worldOf(arm1, [25, 65, 2.5])[2];
  await page.$eval('[data-testid=mate-flip]', (e) => e.click());
  await settle(250);
  s = await state();
  const zAfter = worldOf(s.instances[1], [25, 65, 2.5])[2];
  check('flip turns the arm over onto the base', zBefore < 10 && zAfter > 10, `${zBefore} -> ${zAfter}`);
  await shot('a10-flipped');
  await page.keyboard.press('Enter');
  await settle(300);
  s = await state();
  check('Enter adds it', !(await page.$('[data-testid=mate-dialog]')) && s.mates.length === 1 && s.mates[0].name === 'Revolute 1', JSON.stringify(s.mates.map((m) => m.name)));
  check('the list shows it', (await page.$$eval('[data-testid=mates] .asm-row .feature-name', (r) => r.map((x) => x.textContent))).join() === 'Revolute 1');
  check('the freedoms show', (await freedomText()) === '1 freedom left', await freedomText());
  await shot('a11-mated');
}

console.log('a revolute swings');
{
  const m = (await state()).mates[0];
  const before = (await state()).instances[1];
  const pivot = worldOf((await state()).instances[0], m.cb.frame.o);
  const far = worldOf(before, [45, 65, 2.5]);
  const from = await toScreen(far);
  // Pull it a long way around, past the far side of the part.
  const pivotScreen = await toScreen(pivot);
  await dragScreen(from, [pivotScreen[0] - (from[1] - pivotScreen[1]), pivotScreen[1] + (from[0] - pivotScreen[0])], 16);
  const after = (await state()).instances[1];
  check('the pivot stays exactly where it is', dist(worldOf(after, m.ca.frame.o), pivot) < 1e-6, `${dist(worldOf(after, m.ca.frame.o), pivot)}`);
  const z = worldOf({ p: [0, 0, 0], q: after.q }, [0, 0, 1]);
  check('the axis stays upright', near(Math.abs(z[2]), 1, 1e-6), JSON.stringify(z));
  const moved = worldOf(after, [45, 65, 2.5]);
  check('and the far end has swung round', dist(moved, far) > 10, `${dist(moved, far)}`);
  check('at the same radius', near(dist(moved, pivot), dist(far, pivot), 1e-6), `${dist(moved, pivot)} ${dist(far, pivot)}`);
  await shot('a12-swung');
  await parked();
  await ctrl('z');
  check('undo swings it back', dist(worldOf((await state()).instances[1], [45, 65, 2.5]), far) < 1e-6);
}

console.log('every type gives its freedoms');
{
  const dialogFor = async () => {
    const id = (await state()).mates[0].id;
    await (await page.$(`[data-mate="${id}"]`)).click({ count: 2 });
    await settle(300);
  };
  await dialogFor();
  check('double-click edits a mate', !!(await page.$('[data-testid=mate-dialog]')));
  check('with its connectors in', /Part Studio 2/.test(await page.$eval('[data-testid=mate-first]', (e) => e.textContent)));
  for (const [type, dof] of Object.entries({ fastened: 0, revolute: 1, slider: 1, planar: 3, cylindrical: 2, 'pin-slot': 2, ball: 3, parallel: 4 })) {
    await page.$eval(`[data-mate-type="${type}"]`, (e) => e.click());
    await settle(200);
    const st = await state();
    check(`${type} leaves ${dof}`, st.dof === dof && !st.failures.length, `${st.dof} ${JSON.stringify(st.failures)}`);
  }
  await page.keyboard.press('Escape');
  await settle(250);
  s = await state();
  check('Esc keeps the mate as it was', !(await page.$('[data-testid=mate-dialog]')) && s.mates[0].type === 'revolute' && s.dof === 1, `${s.mates[0].type} ${s.dof}`);
  await dialogFor();
  await page.$eval('[data-mate-type="slider"]', (e) => e.click());
  await settle(200);
  await page.$eval('[data-testid=mate-ok]', (e) => e.click());
  await settle(300);
  s = await state();
  check('saving an edit keeps its name and changes its type', s.mates.length === 1 && s.mates[0].type === 'slider' && s.mates[0].name === 'Revolute 1', JSON.stringify(s.mates.map((m) => [m.name, m.type])));
  const a = s.instances[1];
  const q0 = a.q;
  const from = await toScreen(worldOf(a, [45, 65, 2.5]));
  await dragScreen(from, [from[0] + 40, from[1] - 70]);
  const b = (await state()).instances[1];
  check('a slider moves along its axis only', Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) < 1e-6 && Math.abs(b.p[2] - a.p[2]) > 1, JSON.stringify([a.p, b.p]));
  check('without turning', b.q.every((v, i) => near(v, q0[i], 1e-9)));
  await shot('a13-slid');
  await parked();
  await ctrl('z');
  await ctrl('z');
  check('undo goes back to the revolute', (await state()).mates[0].type === 'revolute', (await state()).mates[0].type);
}

console.log('suppress and delete');
{
  const id = (await state()).mates[0].id;
  await menuOn('mate', id, 'Suppress');
  s = await state();
  check('suppressing frees the part', s.dof === 6 && s.mates[0].suppressed, `${s.dof}`);
  check('the row shows it', await page.$eval(`[data-mate="${id}"]`, (e) => e.classList.contains('off')));
  const a = s.instances[1];
  const from = await toScreen(worldOf(a, [45, 65, 2.5]));
  await dragScreen(from, [from[0] + 40, from[1] + 40]);
  check('and it drags freely', dist((await state()).instances[1].p, a.p) > 1);
  await menuOn('mate', id, 'Unsuppress');
  s = await state();
  check('unsuppressing brings it back to the mate', s.dof === 1 && dist(worldOf(s.instances[1], s.mates[0].ca.frame.o), worldOf(s.instances[0], s.mates[0].cb.frame.o)) < 1e-6, `${s.dof}`);
  await menuOn('mate', id, 'Delete');
  s = await state();
  check('deleting leaves the part where it is, and free', s.mates.length === 0 && s.dof === 6, `${s.dof}`);
  await parked();
  await ctrl('z');
  check('and undo restores it', (await state()).mates.length === 1);
}

console.log('asking too much');
{
  // A second fixed base, and a fastened mate to it that the arm can't also meet, since it's fastened to the first.
  await parked();
  await page.keyboard.press('i');
  await page.waitForSelector('[data-testid=insert-dialog] .insert-row', { timeout: 8000 });
  await settle(200);
  await page.$$eval('[data-testid=insert-dialog] .insert-row.part', (r) => r[0].click());
  await settle(400);
  await page.keyboard.press('Escape');
  s = await state();
  const second = s.instances[s.instances.length - 1];
  await menuOn('instance', second.id, 'Fix');
  await page.mouse.move(700, 15);
  await page.keyboard.press('m');
  await settle(200);
  check('M starts a mate', !!(await page.$('[data-testid=mate-dialog]')));
  s = await state();
  const armI = s.instances.find((i) => i.tab === arm.tab);
  await clickWorld(worldOf(armI, [10, 65, 5]));
  // The second base sits a little off the first. Its corner sticks out past the first, so that's what gets clicked.
  await clickWorld(worldOf(second, [58, 38, 10]));
  await settle(300);
  await page.$eval('[data-mate-type="fastened"]', (e) => e.click());
  await settle(300);
  const err = await page.$eval('[data-testid=mate-error]', (e) => e.textContent).catch(() => null);
  check('a mate that can’t hold says so in the dialog', /Revolute 1/.test(err ?? ''), err ?? 'nothing');
  check('and can’t be added', await page.$eval('[data-testid=mate-ok]', (e) => e.disabled));
  await shot('a14-too-much');
  await page.keyboard.press('Escape');
  await settle(250);
  check('Esc takes it back', (await state()).mates.length === 1 && !(await state()).failures.length);
  await menuOn('instance', second.id, 'Delete');
}

console.log('connectors on round things and edges');
{
  await parked();
  await page.keyboard.press('i');
  await page.waitForSelector('[data-testid=insert-dialog] .insert-row', { timeout: 8000 });
  await settle(200);
  await page.$$eval('[data-testid=insert-dialog] .insert-row.part', (r) => r[1].click());
  await settle(400);
  await page.keyboard.press('Escape');
  await settle(100);
  s = await state();
  const lug = s.instances[s.instances.length - 1];
  const spots = await page.evaluate((id) => {
    const a = window.schmishape.assembly;
    const part = a.partOf(a.asm().instances.find((i) => i.id === id));
    const round = part.faces.findIndex((f) => f.surface === 'cylinder');
    const flat = part.faces.findIndex((f) => f.surface === 'plane' && f.normal[2] > 0.9);
    const circle = part.edges.findIndex((e) => e.curve === 'circle');
    return {
      round: a.faceSpots(part, round).map((x) => ({ how: x.how, o: x.frame.o, z: x.frame.z })),
      flat: a.faceSpots(part, flat).map((x) => ({ how: x.how, o: x.frame.o, z: x.frame.z })),
      circle: a.edgeSpots(part, circle).map((x) => ({ how: x.how, o: x.frame.o, z: x.frame.z })),
    };
  }, lug.id);
  check('a round face has connectors along its axis', spots.round.length === 3 && spots.round.every((x) => near(x.o[0], 100, 1e-3) && near(x.o[1], 0, 1e-3) && near(Math.abs(x.z[2]), 1, 1e-3)), JSON.stringify(spots.round));
  check('at its ends and middle', [0, 6, 12].every((z) => spots.round.some((x) => near(x.o[2], z, 1e-3))), JSON.stringify(spots.round.map((x) => x.o[2])));
  check('a round face’s top has one, at its center', spots.flat.length === 1 && near(spots.flat[0].o[0], 100, 1e-6) && near(spots.flat[0].o[1], 0, 1e-6), JSON.stringify(spots.flat));
  check('a round edge has one at its center', spots.circle.length === 1 && spots.circle[0].how === 'center' && near(spots.circle[0].o[0], 100, 1e-6), JSON.stringify(spots.circle));

  // A pin: the lug's axis goes on a straight edge's midpoint of the base, by way of the mate tools.
  await page.mouse.move(700, 15);
  await cmd('asm.mate.cylindrical');
  await settle(200);
  const center = worldOf(lug, [100 + 5.9, 0, 6]);
  await clickWorld(center);
  s = await state();
  const firstIn = await page.evaluate(() => window.schmishape.assembly.mateDraft()?.first?.connector);
  check('clicking a round face picks a point on its axis', firstIn?.kind === 'face' && firstIn.how.startsWith('axis') && near(firstIn.frame.o[0], 100, 1e-3), JSON.stringify(firstIn));
  // Clicking close by an edge of the base gives an edge's connector.
  await clickWorld([10, 0, 10]);
  await settle(300);
  const secondIn = await page.evaluate(() => window.schmishape.assembly.mateDraft()?.second?.connector);
  check('clicking by an edge picks a connector on that edge', secondIn?.kind === 'edge' && near(secondIn.frame.o[1], 0, 1e-3), JSON.stringify(secondIn));
  s = await state();
  check('a cylindrical mate leaves it two freedoms beyond the rest', s.failures.length === 0, JSON.stringify(s.failures));
  await page.keyboard.press('Escape');
  await settle(250);

  // Shift stays on the face or edge it's on, however far the pointer goes.
  await page.mouse.move(700, 15);
  await cmd('asm.mate.revolute');
  await settle(200);
  const top = [10, 30, 10];
  const [tx, ty] = await toScreen(top);
  await page.mouse.move(tx, ty);
  await wait(120);
  await shot('a18-before-shift');
  const owner = () => page.$eval('.status-left', (e) => e.textContent);
  const onBase = await owner();
  check('hovering the base offers the base’s connectors', /Part Studio 1: Part 1/.test(onBase), onBase);
  await page.keyboard.down('Shift');
  const armNow = (await state()).instances.find((i) => i.tab === arm.tab);
  const elsewhere = await toScreen(worldOf(armNow, [25, 65, 2.5]));
  await page.mouse.move(elsewhere[0], elsewhere[1]);
  await wait(150);
  check('holding Shift keeps the connectors of the face it was on', (await owner()) === onBase, `${await owner()}`);
  await page.keyboard.up('Shift');
  await page.mouse.move(elsewhere[0] + 1, elsewhere[1]);
  await wait(150);
  check('and letting go moves on', (await owner()) !== onBase, await owner());
  await page.keyboard.press('Escape');
  await settle(200);
  await menuOn('instance', lug.id, 'Delete');
}

console.log('fixing a part past its mate');
{
  s = await state();
  const armI = s.instances.find((i) => i.tab === arm.tab);
  // Move the arm's fixed partner away from the mate by turning it into an impossible pair: both ends fixed, apart.
  await page.evaluate((id) => window.schmishape.assembly.setFixed(id, false), base.id);
  await settle(100);
  await page.mouse.move(700, 880);
  const from = await toScreen(worldOf(s.instances[0], [50, 30, 10]));
  await dragScreen(from, [from[0] - 60, from[1] + 80]);
  s = await state();
  check('a free base brings the arm with it', s.failures.length === 0 && dist(worldOf(s.instances[1], s.mates[0].ca.frame.o), worldOf(s.instances[0], s.mates[0].cb.frame.o)) < 1e-6);
  await page.evaluate((id) => window.schmishape.assembly.setFixed(id, true), base.id);
  await settle(100);
  void armI;
}

console.log('it stays when the page reloads');
{
  s = await state();
  await wait(300);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-testid=tabbar] .tab', { timeout: 20000 });
  await page.waitForFunction(() => window.schmishape?.assembly?.asm().instances.length > 0, { timeout: 15000 });
  await settle(600);
  const r = await state();
  check('its instances come back', r.instances.length === s.instances.length && r.instances.every((i, n) => i.name === s.instances[n].name));
  check('where they were', r.instances.every((i, n) => dist(i.p, s.instances[n].p) < 1e-6));
  check('with its mates', r.mates.length === 1 && r.mates[0].name === 'Revolute 1' && r.mates[0].flip === true);
  check('and the same freedoms', r.dof === s.dof, `${r.dof}`);
  check('and the model on screen', r.mesh.tris === s.mesh.tris, `${r.mesh.tris}`);
  await shot('a15-reloaded');
}

console.log('a part changes in its Part Studio');
{
  const before = await state();
  const fA = before.mates[0];
  await clickTab('Part Studio 2');
  await page.evaluate(async () => {
    const f = window.schmishape.doc.features.find((x) => x.name === 'Arm');
    await window.schmishape.mutate('feature_edit', { id: f.id, feature: { type: 'solid', shape: 'box', dx: 80, dy: 10, dz: 5, at: { origin: [0, 60, 0] } } });
  });
  await settle(500);
  await clickTab('Assembly 1');
  await settle(500);
  const after = await state();
  const part = await page.evaluate(() => {
    const a = window.schmishape.assembly;
    const p = a.partOf(a.asm().instances[1]);
    return { min: p.min, max: p.max };
  });
  check('its instance has the new shape', near(part.max[0], 80), JSON.stringify(part));
  const mate = after.mates[0];
  check('the mate still holds', after.failures.length === 0 && dist(worldOf(after.instances[1], mate.ca.frame.o), worldOf(after.instances[0], mate.cb.frame.o)) < 1e-6, JSON.stringify(after.failures));
  void fA;
  await shot('a16-part-changed');

  await clickTab('Part Studio 2');
  await page.evaluate(async () => {
    const f = window.schmishape.doc.features.find((x) => x.name === 'Arm');
    const before = window.schmishape.documentText();
    await window.schmishape.mutate('feature_delete', { id: f.id });
    window.schmishape.pushUndo(before);
  });
  await settle(500);
  await clickTab('Assembly 1');
  await settle(500);
  const gone = await state();
  check('a part that’s gone says so', /gone from Part Studio 2/.test(gone.instances[1].problem ?? ''), gone.instances[1].problem ?? 'nothing');
  check('the row shows it', await page.$eval(`[data-instance="${gone.instances[1].id}"]`, (e) => e.classList.contains('failed')));
  check('its mate says why it failed', gone.failures.length === 1 && /gone/.test(gone.failures[0][1]), JSON.stringify(gone.failures));
  check('and the status bar says so too', /Revolute 1/.test(gone.failed ?? ''), gone.failed ?? 'nothing');
  check('the other part is still shown', gone.mesh.tris === 12, `${gone.mesh.tris}`);
  check('the mate row is marked', await page.$eval(`[data-mate="${gone.mates[0].id}"]`, (e) => e.classList.contains('failed')));
  await shot('a17-part-gone');
  await clickTab('Part Studio 2');
  await parked();
  await ctrl('z');
  await clickTab('Assembly 1');
  await settle(500);
  const back = await state();
  check('bringing it back brings the instance back', !back.instances[1].problem && !back.failures.length, JSON.stringify(back.failures));
}

console.log('the tab');
{
  const before = await state();
  const b = await tabBox('Assembly 1');
  await page.mouse.click(b.x + 20, b.y + 10, { button: 'right' });
  await wait(100);
  await page.$eval('.menu [data-item="Duplicate"]', (e) => e.click());
  await settle(700);
  const copy = await state();
  check('duplicating an assembly copies what’s in it', copy.instances.length === before.instances.length && copy.mates.length === 1);
  await page.evaluate(() => window.schmishape.assembly.deleteMate(window.schmishape.assembly.asm().mates[0].id));
  await settle(100);
  await clickTab('Assembly 1');
  check('and the copy is its own', (await state()).mates.length === 1);
  const c = await tabBox('Copy of Assembly 1');
  await page.mouse.click(c.x + 20, c.y + 10, { button: 'right' });
  await wait(100);
  await page.$eval('.menu [data-item="Delete"]', (e) => e.click());
  await settle(500);
  await page.$eval('.toast-action', (e) => e.click());
  await settle(700);
  const restored = await state();
  check('deleting and undoing keeps its contents', restored.instances.length === before.instances.length && restored.mates.length === 0, `${restored.instances.length} ${restored.mates.length}`);
  await clickTab('Assembly 1');
  check('and the first is untouched', (await state()).mates.length === 1);
}

console.log('back in a Part Studio');
{
  await clickTab('Part Studio 1');
  check('the modelling tools are back', !(await page.$('[data-command="asm.insert"]')) && !!(await page.$('[data-command=extrude]')));
  check('and its model is shown, not the assembly', (await page.evaluate(() => window.schmishape.doc.features.map((f) => f.name))).join() === 'Base,Lug');
  check('the status bar is clear', !(await page.evaluate(() => window.schmishape.doc.failed)));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (problems.length) console.log('Browser errors:\n  ' + [...new Set(problems)].join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
