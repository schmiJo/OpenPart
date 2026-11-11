// The document's tabs along the bottom: Part Studios, Assemblies and folders, driven with the mouse in the real app.
// Usage: node scripts/smoke-tabs.mjs <url> <screenshot folder>
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
const out = process.argv[3] ?? '/tmp/schmishape-tabs';
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

const bar = () => page.$$eval('.tabbar .tab', (t) => t.map((x) => x.querySelector('.tab-name')?.textContent ?? ''));
const active = () => page.$$eval('.tabbar .tab.on .tab-name', (t) => t[0]?.textContent ?? null);
const tabBox = async (name) => {
  const handle = await page.evaluateHandle((n) => [...document.querySelectorAll('.tabbar .tab')].find((t) => t.querySelector('.tab-name')?.textContent === n), name);
  const b = await handle.asElement()?.boundingBox();
  if (!b) throw new Error(`no tab named ${name}`);
  return b;
};
const clickTab = async (name) => { const b = await tabBox(name); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await settle(350); };
const tabMenu = async (name, item) => {
  const b = await tabBox(name);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await wait(100);
  await page.$eval(`.menu [data-item="${item}"]`, (e) => e.click());
  await settle(350);
};
const insert = async (command) => {
  await page.$eval('[data-testid=tab-insert]', (e) => e.click());
  await wait(80);
  await page.$eval(`.menu [data-command="${command}"]`, (e) => e.click());
  await settle(350);
};
const drag = async (from, to) => {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await wait(40);
  await page.mouse.up();
  await settle(200);
};
const middle = (b) => [b.x + b.width / 2, b.y + b.height / 2];
const features = () => page.evaluate(() => window.schmishape.doc.features.map((f) => f.name));
const volume = () => page.evaluate(() => window.schmishape.doc.solid?.volume ?? 0);
const addBox = (dx, name) => page.evaluate(async (dx, name) => {
  const before = window.schmishape.documentText();
  await window.schmishape.mutate('feature_add', { name, feature: { type: 'solid', shape: 'box', dx, dy: 10, dz: 10 } });
  window.schmishape.pushUndo(before);
}, dx, name);
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('schmishape.tabs')));
const ctrl = async (key) => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await settle(350); };

await page.goto(url, { waitUntil: 'load' });

console.log('a document from before tabs');
await page.waitForFunction(() => window.schmishape?.doc && window.schmishape.documentText(), { timeout: 20000 });
await page.evaluate(async () => {
  await window.schmishape.mutate('feature_add', { name: 'Old box', feature: { type: 'solid', shape: 'box', dx: 7, dy: 7, dz: 7 } });
  const text = window.schmishape.documentText();
  localStorage.clear();
  localStorage.setItem('schmishape.document', text);
  localStorage.setItem('schmishape.dimension-places', '{"1":{"2":[3,4]}}');
  window.addEventListener('pagehide', () => { localStorage.removeItem('schmishape.tabs'); localStorage.removeItem('schmishape.document.t1'); localStorage.setItem('schmishape.document', text); });
});
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=tabbar] .tab', { timeout: 20000 });
await settle(600);
const firstLook = await features();
check('it comes back as the first Part Studio', firstLook.join() === 'Old box', JSON.stringify(firstLook));
check('and its old key has moved', await page.evaluate(() => localStorage.getItem('schmishape.document') === null && !!localStorage.getItem('schmishape.document.t1')));
check('its dimension labels moved with it', await page.evaluate(() => localStorage.getItem('schmishape.dimension-places') === null && localStorage.getItem('schmishape.dimension-places.t1') === '{"1":{"2":[3,4]}}'));

console.log('a new document');
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=empty]', { timeout: 20000 });
await settle(400);
check('it has a Part Studio and an Assembly, as in Onshape', (await bar()).join() === 'Part Studio 1,Assembly 1', (await bar()).join());
check('the Part Studio is open', (await active()) === 'Part Studio 1');
await shot('t01-new-document');

console.log('each Part Studio is its own document');
await addBox(10, 'Box A');
await settle();
await page.$eval('[data-testid=tab-insert]', (e) => e.click());
await wait(100);
await shot('t02-insert-menu');
await page.$eval('.menu [data-command="tab.part-studio"]', (e) => e.click());
await settle(400);
check('a new tab goes right of the active one', (await bar()).join() === 'Part Studio 1,Part Studio 2,Assembly 1', (await bar()).join());
check('and becomes active', (await active()) === 'Part Studio 2');
check('and it starts empty', (await features()).length === 0 && !!(await page.$('[data-testid=empty]')));
await addBox(20, 'Box B');
await settle();
await addBox(30, 'Box C');
await settle();
check('it models on its own', (await features()).join() === 'Box B,Box C', (await features()).join());
await clickTab('Part Studio 1');
check('the first is still there', (await features()).join() === 'Box A' && near(await volume(), 1000), `${await features()} ${await volume()}`);
await shot('t03-back-on-the-first');
await clickTab('Part Studio 2');
check('and so is the second', (await features()).join() === 'Box B,Box C', (await features()).join());

console.log('undo stays with its tab');
await page.mouse.move(700, 20);
await ctrl('z');
check('undo takes back this tab’s last step', (await features()).join() === 'Box B', (await features()).join());
await clickTab('Part Studio 1');
await page.mouse.move(700, 20);
await ctrl('z');
check('and that tab has its own', (await features()).length === 0, (await features()).join());
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await settle(350);
check('redo too', (await features()).join() === 'Box A');
await clickTab('Part Studio 2');
await page.mouse.move(700, 20);
await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
await settle(350);
check('and the other tab’s redo is still waiting', (await features()).join() === 'Box B,Box C', (await features()).join());

console.log('the view stays with its tab');
const camera = () => page.evaluate(() => { const c = window.schmishape.view.renderer.camera; return { halfH: c.halfH, back: c.back() }; });
await page.keyboard.press('1');
await wait(500);
const secondView = await camera();
await clickTab('Part Studio 1');
await page.keyboard.press('2');
await wait(500);
await clickTab('Part Studio 2');
const backAgain = await camera();
check('coming back restores how it was looked at', near(backAgain.back[2], secondView.back[2], 1e-2) && near(backAgain.halfH, secondView.halfH, 1e-2), JSON.stringify(backAgain));

console.log('an Assembly');
await clickTab('Assembly 1');
check('it opens', (await active()) === 'Assembly 1');
check('it says it’s empty and what isn’t built', !!(await page.$('[data-testid=assembly-empty]')));
const heads = await page.$$eval('.sidebar h2', (h) => h.map((x) => x.textContent));
check('its panel lists instances and mates', heads.join() === 'Instances (0),Mates (0)', heads.join());
check('the modelling tools give way to its own', !(await page.$('[data-command=sketch]')) && !!(await page.$('[data-command="asm.insert"]')));
check('the planes are gone', (await page.evaluate(() => window.schmishape.view.renderer.planes.length)) === 0);
await page.keyboard.press('Shift');
await page.keyboard.press('s');
await wait(100);
check('and so is the key for a sketch', await page.evaluate(() => !window.schmishape.session()));
await shot('t04-assembly');
await clickTab('Part Studio 1');
check('the planes come back', (await page.evaluate(() => window.schmishape.view.renderer.planes.length)) === 3);

console.log('folders');
await insert('tab.folder');
check('a new folder asks for its name', !!(await page.$('.tab-rename')));
await page.keyboard.type('Brackets');
await page.keyboard.press('Enter');
await settle(150);
check('it takes the name', (await bar()).includes('Brackets'), (await bar()).join());
check('it doesn’t open by itself', (await active()) === 'Part Studio 1');
await drag(middle(await tabBox('Part Studio 2')), middle(await tabBox('Brackets')));
check('dragging a tab onto it moves it in', !(await bar()).includes('Part Studio 2'), (await bar()).join());
await shot('t05-moved-into-folder');
await clickTab('Brackets');
check('opening it shows only what’s in it', (await bar()).join() === 'Part Studio 2', (await bar()).join());
check('the active tab hasn’t changed', (await features()).join() === 'Box A');
check('there’s a way back', !!(await page.$('[data-testid=all-tabs]')));
await shot('t06-inside-folder');
await insert('tab.part-studio');
check('creating here puts it in the folder', (await bar()).join() === 'Part Studio 2,Part Studio 3' || (await bar()).join() === 'Part Studio 3,Part Studio 2', (await bar()).join());
check('and opens it', (await active()) === 'Part Studio 3');
await clickTab('Part Studio 2');
check('a tab in a folder opens its own document', (await features()).join() === 'Box B,Box C', (await features()).join());
await page.$eval('[data-testid=all-tabs]', (e) => e.click());
await settle(150);
check('All tabs goes back to the top', (await bar()).includes('Brackets') && (await bar()).includes('Part Studio 1'), (await bar()).join());
check('the folder shows it holds the active tab', await page.$eval('.tab[data-kind=folder]', (e) => e.classList.contains('holds')));
await insert('tab.folder');
await page.keyboard.type('Inner');
await page.keyboard.press('Enter');
await settle(150);
await drag(middle(await tabBox('Inner')), middle(await tabBox('Brackets')));
check('a folder can go in a folder', !(await bar()).includes('Inner'), (await bar()).join());
await clickTab('Brackets');
await clickTab('Inner');
const crumbs = await page.$$eval('.tab-crumb .tab-name', (c) => c.map((x) => x.textContent));
check('the bar shows the way down', crumbs.join() === 'Brackets,Inner', crumbs.join());
check('an empty folder says so', /empty/.test(await page.$eval('.tabs-empty', (e) => e.textContent)));
await shot('t07-nested');
await page.$eval('[data-testid=all-tabs]', (e) => e.click());
await settle(150);
await clickTab('Brackets');
const outer = await tabBox('Inner');
await tabMenu('Inner', 'Move to parent folder');
check('a folder moves up from its menu', !(await bar()).includes('Inner'), (await bar()).join());
await page.$eval('[data-testid=all-tabs]', (e) => e.click());
await settle(150);
check('and is at the top now', (await bar()).includes('Inner'), (await bar()).join());
void outer;

console.log('reordering');
const before = await bar();
const a = await tabBox('Assembly 1'), p = await tabBox('Part Studio 1');
await drag(middle(a), [p.x + 6, p.y + p.height / 2]);
const after = await bar();
check('dragging a tab reorders it', after.indexOf('Assembly 1') < after.indexOf('Part Studio 1'), `${before.join()} -> ${after.join()}`);
check('a click after a drag opens nothing', (await active()) !== 'Assembly 1');

console.log('rename, duplicate, delete');
await tabMenu('Assembly 1', 'Rename');
await page.keyboard.type('Gearbox');
await page.keyboard.press('Enter');
await settle(150);
check('rename', (await bar()).includes('Gearbox'), (await bar()).join());
await clickTab('Part Studio 1');
await addBox(50, 'Box D');
await settle();
await tabMenu('Part Studio 1', 'Duplicate');
check('duplicate opens a copy beside it', (await active()) === 'Copy of Part Studio 1', `${await active()}`);
check('with the same features', (await features()).join() === 'Box A,Box D', (await features()).join());
await addBox(60, 'Box E');
await settle();
await clickTab('Part Studio 1');
check('and changing the copy leaves the first alone', (await features()).join() === 'Box A,Box D', (await features()).join());
await tabMenu('Copy of Part Studio 1', 'Delete');
check('delete removes it', !(await bar()).includes('Copy of Part Studio 1'), (await bar()).join());
const toastText = await page.$eval('.toast', (e) => e.textContent);
check('and offers to undo', /Deleted Copy of Part Studio 1.*Undo/.test(toastText), toastText);
await shot('t08-delete-undo');
await page.$eval('.toast-action', (e) => e.click());
await settle(400);
check('undo brings it back, open', (await active()) === 'Copy of Part Studio 1');
check('with its work', (await features()).join() === 'Box A,Box D,Box E', (await features()).join());
await tabMenu('Copy of Part Studio 1', 'Delete');
check('deleting the open tab opens another', (await active()) !== null && (await features()).length > 0, `${await active()}`);

console.log('tab manager');
await page.$eval('[data-testid=tab-manager-toggle]', (e) => e.click());
await settle(150);
check('it opens', !!(await page.$('[data-testid=tab-manager]')));
const rows = await page.$$eval('.tab-row', (r) => r.map((x) => [x.querySelector('.tab-name')?.textContent, parseInt(x.style.paddingLeft, 10)]));
check('it shows the folder tree', rows.some(([n, d]) => n === 'Part Studio 2' && d > 6) && rows.some(([n, d]) => n === 'Brackets' && d === 6), JSON.stringify(rows));
await shot('t09-tab-manager');
const row = async (name) => {
  const h = await page.evaluateHandle((n) => [...document.querySelectorAll('.tab-row')].find((t) => t.querySelector('.tab-name')?.textContent === n), name);
  return h.asElement().boundingBox();
};
const r2 = await row('Part Studio 2');
await page.mouse.click(...middle(r2));
await settle(400);
check('clicking a row opens that tab', (await features()).join() === 'Box B,Box C' && (await active()) === 'Part Studio 2', `${await features()}`);
check('and the bar follows it into its folder', (await bar()).includes('Part Studio 2') && !(await bar()).includes('Gearbox'), (await bar()).join());
const fb = await row('Brackets');
await page.mouse.click(...middle(fb));
await settle(100);
check('a folder’s row folds it', !(await page.$$eval('.tab-row .tab-name', (n) => n.map((x) => x.textContent))).includes('Part Studio 2'));
await page.mouse.click(...middle(fb));
await settle(100);
await page.$eval('.tab-manager .filter input', (e) => e.focus());
await page.keyboard.type('gear');
await settle(100);
check('search finds a tab by name', (await page.$$eval('.tab-row .tab-name', (n) => n.map((x) => x.textContent))).join() === 'Gearbox');
await page.keyboard.press('Escape');
await settle(100);
const rp2 = await row('Part Studio 2'), rg = await row('Gearbox');
await drag(middle(rp2), [rg.x + rg.width / 2, rg.y + 3]);
const parentOf = async (name) => (await stored()).tabs.find((t) => t.name === name)?.parent;
check('dragging a row out of a folder works too', (await parentOf('Part Studio 2')) === null, `${await parentOf('Part Studio 2')}`);
await page.$eval('[data-testid=tab-manager-toggle]', (e) => e.click());
await settle(150);
check('it closes', !(await page.$('[data-testid=tab-manager]')));

console.log('leaving with something open');
await page.$eval('[data-testid=all-tabs]', (e) => e.click()).catch(() => {});
await settle(150);
await clickTab('Part Studio 2');
await page.$eval('[data-command=extrude]', (e) => e.disabled);
await page.evaluate(() => window.schmishape.startFeature('fillet'));
await settle(400);
check('a dialog is open', !!(await page.$('[data-testid=dialog]')));
await clickTab('Part Studio 1');
check('switching cancels it', !(await page.$('[data-testid=dialog]')));
await page.$eval('[data-testid=tab-insert]', (e) => e.click());
await wait(80);
await page.keyboard.press('Escape');
await page.keyboard.press('0');
await wait(500);
await page.$eval('[data-command=sketch]', (e) => e.click());
await wait(80);
await page.$eval('[data-plane="1"]', (e) => e.click());
await wait(300);
const box = await page.$eval('[data-testid=viewport]', (e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
await page.keyboard.press('c');
const clickSlowly = async (x, y) => { await page.mouse.move(x, y); await wait(30); await page.mouse.down(); await page.mouse.up(); await wait(150); };
await clickSlowly(box.x, box.y);
await clickSlowly(box.x + 60, box.y);
await wait(300);
check('with a circle in it', (await page.evaluate(() => window.schmishape.session().data.entities.length)) === 1);
check('a sketch is open', await page.evaluate(() => !!window.schmishape.session()));
const fBefore = (await features()).length;
await clickTab('Part Studio 2');
check('switching keeps it, as Esc does', await page.evaluate(() => !window.schmishape.session()));
await clickTab('Part Studio 1');
check('and it’s in its own tab’s history', (await features()).length === fBefore + 1, (await features()).join());

console.log('files open as Part Studios of their own');
const fileText = await page.evaluate(() => window.schmishape.documentText());
await page.evaluate((t) => window.schmishape.tabs.openInTab(t, 'From a file'), fileText);
await settle(400);
check('a file gets a tab named after it', (await active()) === 'From a file', `${await active()}`);
check('holding its features', (await features()).length === fBefore + 1, (await features()).join());
const openedBad = await page.evaluate(async () => {
  const count = window.schmishape.tabs.tabs().length;
  let threw = false;
  try { await window.schmishape.tabs.openInTab('{not a document', 'Broken'); } catch { threw = true; }
  return { threw, same: window.schmishape.tabs.tabs().length === count, active: window.schmishape.tabs.activeTab().name };
});
await settle(400);
check('a broken file makes no tab and says so', openedBad.threw && openedBad.same && openedBad.active === 'From a file', JSON.stringify(openedBad));
check('and what was open is untouched', (await features()).length === fBefore + 1, (await features()).join());
await tabMenu('From a file', 'Delete');

console.log('unpack, and the last tab');
await page.evaluate(() => window.schmishape.tabs.setOpenFolder(null));
await settle(100);
await tabMenu('Inner', 'Unpack folder');
check('unpacking an empty folder removes it', !(await bar()).includes('Inner'), (await bar()).join());
await tabMenu('Brackets', 'Unpack folder');
const flat = await bar();
check('unpacking puts its tabs where it was', flat.includes('Part Studio 3') && !flat.includes('Brackets'), flat.join());

console.log('reload');
await clickTab('Part Studio 2');
await page.evaluate(() => window.schmishape.tabs.setOpenFolder(null));
await insert('tab.folder');
await page.keyboard.type('Kept');
await page.keyboard.press('Enter');
await settle(150);
await drag(middle(await tabBox('Part Studio 3')), middle(await tabBox('Kept')));
const names = await bar();
await wait(600);
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-testid=tabbar] .tab', { timeout: 20000 });
await settle(600);
check('the tabs and their order come back', (await bar()).join() === names.join(), `${(await bar()).join()} vs ${names.join()}`);
check('so does which one was open', (await active()) === 'Part Studio 2', `${await active()}`);
check('with its document', (await features()).join() === 'Box B,Box C', (await features()).join());
await clickTab('Part Studio 1');
check('and the others’ documents', (await features()).includes('Box A'), (await features()).join());
await clickTab('Kept');
check('and the folders', (await bar()).join() === 'Part Studio 3', (await bar()).join());
await page.$eval('[data-testid=all-tabs]', (e) => e.click());
await settle(150);

console.log('the last tab can’t go');
await page.evaluate(() => {
  const t = window.schmishape.tabs;
  return (async () => {
    for (const x of t.tabs().filter((x) => x.kind !== 'folder').slice(1)) await t.deleteTab(x.id);
  })();
});
await settle(400);
const leftOver = await page.evaluate(() => window.schmishape.tabs.tabs().filter((x) => x.kind !== 'folder').map((x) => x.name));
check('one tab is left', leftOver.length === 1, leftOver.join());
await page.evaluate(() => window.schmishape.tabs.deleteTab(window.schmishape.tabs.tabs().find((x) => x.kind !== 'folder').id));
await settle(300);
check('and it stays', (await page.evaluate(() => window.schmishape.tabs.tabs().filter((x) => x.kind !== 'folder').length)) === 1);
await shot('t10-one-left');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (problems.length) console.log('Browser errors:\n  ' + [...new Set(problems)].join('\n  '));
await browser.close();
process.exit(failures.length ? 1 : 0);
