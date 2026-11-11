import { createSignal } from 'solid-js';
import { cancelDialog } from '../features/dialog';
import { finishSketch, session } from '../sketch/controller';
import { copyPlaces, dropPlaces, keepPlacesOf, readPlaces, restorePlaces, setPlacesScope } from '../sketch/dimension';
import { view } from '../viewport/instance';
import type { Quat, V3 } from '../viewport/math';
import { boot, doc, documentText, flushAutosave, mesh, rememberDoc, serial, setAutosaveKey, showDoc, storage, type DocMemory } from './doc';
import { clearSelection, mode, setHiddenParts, setMode, toast } from './ui';

/**
 * A document's tabs, as in Onshape. The kernel holds one document at a time, so each Part Studio is its own kernel
 * document, and switching tabs puts the one you left away and opens the other.
 */
export type TabKind = 'part-studio' | 'assembly' | 'folder';
export interface Tab { id: string; kind: TabKind; name: string; parent: string | null }

const TABS_KEY = 'schmishape.tabs';
const LEGACY_DOC_KEY = 'schmishape.document';
const MANAGER_KEY = 'schmishape.tab-manager';
const docKey = (id: string) => `schmishape.document.${id}`;
const BASE_NAME: Record<TabKind, string> = { 'part-studio': 'Part Studio', assembly: 'Assembly', folder: 'Folder' };

export const [tabs, setTabs] = createSignal<Tab[]>([]);
export const [activeTabId, setActiveTabId] = createSignal('');
/** The folder the tab bar is showing, or null for the top level. */
export const [openFolder, setOpenFolder] = createSignal<string | null>(null);
export const [renamingTab, setRenamingTab] = createSignal<string | null>(null);
export const [tabManagerOpen, setTabManagerShown] = createSignal(storage.get(MANAGER_KEY) === 'open');

export const tabById = (id: string | null) => tabs().find((t) => t.id === id);
export const activeTab = () => tabById(activeTabId());
export const inAssembly = () => activeTab()?.kind === 'assembly';
export const childrenOf = (parent: string | null) => tabs().filter((t) => t.parent === parent);
export const iconForTab = (t: Tab) => t.kind;

/** A folder's chain of parents, starting from the top level and ending with it. */
export function folderPath(id: string | null) {
  const out: Tab[] = [];
  for (let t = tabById(id); t; t = tabById(t.parent)) out.unshift(t);
  return out;
}

/** Whether a tab is in a folder, however deep. */
export function isInside(id: string, folder: string) {
  for (let t = tabById(id); t; t = tabById(t.parent)) if (t.parent === folder) return true;
  return false;
}

let nextId = 1;
const save = () => storage.set(TABS_KEY, JSON.stringify({ tabs: tabs(), active: activeTabId(), next: nextId }));

export function toggleTabManager() {
  const next = !tabManagerOpen();
  setTabManagerShown(next);
  storage.set(MANAGER_KEY, next ? 'open' : 'closed');
}

/** What an Assembly tab does as it opens and closes. The assembly code fills these in, so this file doesn't depend on it. */
export const assemblyHooks = {
  enter: async (_tab: string) => {},
  leave: () => {},
  copy: (_from: string, _to: string) => {},
  take: (_tab: string): string | null => null,
  put: (_tab: string, _text: string | null) => {},
};

interface Camera { target: V3; rot: Quat; halfH: number }
/** What a tab was doing when you left it. Undo and the view last until the page closes, the document for good. */
const memory = new Map<string, { doc: DocMemory; camera?: Camera }>();
const docOf = (id: string): DocMemory => memory.get(id)?.doc ?? { text: tabById(id)?.kind === 'part-studio' ? storage.get(docKey(id)) : null, rollback: null, undo: [], redo: [] };

/** A Part Studio's document, wherever it is just now, for an assembly to read its parts from. */
export const tabDocumentText = (id: string) => (id === activeTabId() ? documentText() : docOf(id).text);

function firstFreeName(kind: TabKind) {
  const names = new Set(tabs().map((t) => t.name));
  let n = 1;
  while (names.has(`${BASE_NAME[kind]} ${n}`)) n++;
  return `${BASE_NAME[kind]} ${n}`;
}

/** Goes right of `beside`, as a new tab goes right of the active one, or at the end of the folder on show. */
function addTab(kind: TabKind, name?: string, beside: Tab | undefined = activeTab()): Tab {
  const parent = beside && beside !== activeTab() ? beside.parent : openFolder();
  const t: Tab = { id: `t${nextId++}`, kind, name: name ?? firstFreeName(kind), parent };
  const list = tabs().slice();
  const at = beside && beside.parent === parent ? list.indexOf(beside) + 1 : list.length;
  list.splice(at, 0, t);
  setTabs(list);
  save();
  return t;
}

async function switchTo(id: string, opened?: string) {
  const t = tabById(id);
  if (!t || t.kind === 'folder') return false;
  if (id === activeTabId() && opened === undefined) {
    setOpenFolder(t.parent);
    return true;
  }
  // Leaving keeps a sketch and cancels a dialog, the same as Esc does.
  if (session()) {
    await finishSketch();
    if (session()) return false;
  }
  await cancelDialog();
  if (mode() === 'pick-plane') setMode('part');
  await serial(async () => {});
  if (inAssembly()) assemblyHooks.leave();
  flushAutosave();
  const left = activeTabId();
  const cam = view.renderer?.camera;
  if (tabById(left)) memory.set(left, { doc: rememberDoc(), camera: cam && { target: [...cam.target], rot: [...cam.rot] as Quat, halfH: cam.halfH } });
  setActiveTabId(id);
  setOpenFolder(t.parent);
  setAutosaveKey(t.kind === 'part-studio' ? docKey(id) : null);
  setPlacesScope(id);
  save();
  clearSelection();
  setHiddenParts(new Set<number>());
  if (opened !== undefined) await showDoc({ text: opened, rollback: null, undo: [], redo: [] });
  else {
    const mem = docOf(id);
    try {
      await showDoc(mem);
    } catch (e) {
      // Keep what was stored: a new document's autosave would otherwise overwrite it.
      if (mem.text) storage.set(`${docKey(id)}.unopened`, mem.text);
      toast(`${t.name} couldn't be opened, so it's empty for now. ${(e as Error).message}`, 'error');
      await showDoc({ text: null, rollback: null, undo: [], redo: [] });
    }
  }
  if (t.kind === 'assembly') await assemblyHooks.enter(id);
  if (cam) {
    const saved = memory.get(id)?.camera;
    const m = mesh();
    if (saved && opened === undefined) cam.animateTo(saved, 0);
    else if (m && m.indices.length) cam.fitBox(m.min, m.max, 0);
    else cam.animateTo({ target: [0, 0, 0], rot: cam.viewRot('iso'), halfH: 70 }, 0);
    view.renderer?.invalidate();
  }
  return true;
}

let queue: Promise<unknown> = Promise.resolve();
/** Tab changes happen one at a time, however fast the clicks come. */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export const activateTab = (id: string) => inTurn(() => switchTo(id));

/** Makes a tab, in the folder on show. A folder waits for its name, and anything else opens. */
export function createTab(kind: TabKind) {
  return inTurn(async () => {
    const t = addTab(kind);
    if (kind === 'folder') setRenamingTab(t.id);
    else await switchTo(t.id);
  });
}

const activeIsEmpty = () => activeTab()?.kind === 'part-studio' && doc.features.length === 0;

/** Somewhere to build something new: this Part Studio if it's still empty, or a new one. */
export function openBlankStudio(name: string) {
  return inTurn(async () => {
    if (activeIsEmpty()) renameTab(activeTabId(), name);
    else await switchTo(addTab('part-studio', name).id);
  });
}

/** Opens a saved document as a Part Studio of its own. If it can't be read, nothing changes and the reason is thrown. */
export function openInTab(text: string, name: string) {
  return inTurn(async () => {
    if (activeIsEmpty()) {
      await showDoc({ text, rollback: null, undo: [], redo: [] });
      renameTab(activeTabId(), name);
      return;
    }
    const from = activeTabId();
    const t = addTab('part-studio', name);
    try {
      await switchTo(t.id, text);
    } catch (e) {
      setTabs(tabs().filter((x) => x.id !== t.id));
      memory.delete(t.id);
      await switchTo(from);
      throw e;
    }
  });
}

export function renameTab(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  setTabs(tabs().map((t) => (t.id === id ? { ...t, name: trimmed } : t)));
  save();
}

export function duplicateTab(id: string) {
  return inTurn(async () => {
    const t = tabById(id);
    if (!t || t.kind === 'folder') return;
    const text = id === activeTabId() ? documentText() : docOf(id).text;
    const copy = addTab(t.kind, `Copy of ${t.name}`, t);
    copyPlaces(id, copy.id);
    if (t.kind === 'assembly') assemblyHooks.copy(id, copy.id);
    await switchTo(copy.id, t.kind === 'part-studio' && text ? text : undefined);
  });
}

/** Deletes a tab, with a moment to change your mind. A document always keeps at least one. */
export function deleteTab(id: string) {
  return inTurn(async () => {
    const t = tabById(id);
    if (!t || t.kind === 'folder') return;
    const others = tabs().filter((x) => x.kind !== 'folder' && x.id !== id);
    if (!others.length) return toast('A document needs at least one tab.');
    if (id === activeTabId()) {
      const sameFolder = childrenOf(t.parent).filter((x) => x.kind !== 'folder');
      const next = sameFolder[sameFolder.indexOf(t) + 1] ?? sameFolder[sameFolder.indexOf(t) - 1] ?? others[0];
      if (!(await switchTo(next.id))) return;
    }
    const at = tabs().indexOf(t);
    const kept = memory.get(id) ?? { doc: docOf(id) };
    const places = readPlaces(id);
    const assembly = t.kind === 'assembly' ? assemblyHooks.take(id) : null;
    memory.delete(id);
    storage.remove(docKey(id));
    dropPlaces(id);
    setTabs(tabs().filter((x) => x.id !== id));
    save();
    toast(`Deleted ${t.name}.`, 'info', {
      label: 'Undo',
      run: () => inTurn(async () => {
        const list = tabs().slice();
        list.splice(Math.min(at, list.length), 0, { ...t, parent: tabById(t.parent) ? t.parent : null });
        setTabs(list);
        memory.set(id, kept);
        if (t.kind === 'part-studio' && kept.doc.text) storage.set(docKey(id), kept.doc.text);
        restorePlaces(id, places);
        assemblyHooks.put(id, assembly);
        await switchTo(id);
      }),
    });
  });
}

/** Moves a tab beside another, or into a folder. A folder can't go inside itself. */
export function moveTab(id: string, targetId: string, where: 'before' | 'after' | 'into') {
  const moving = tabById(id), target = tabById(targetId);
  if (!moving || !target || id === targetId) return;
  if (where === 'into' && target.kind !== 'folder') return;
  if (moving.kind === 'folder' && (targetId === id || isInside(targetId, id))) return;
  const list = tabs().filter((t) => t.id !== id);
  const moved = { ...moving, parent: where === 'into' ? targetId : target.parent };
  list.splice(where === 'into' ? list.length : list.indexOf(target) + (where === 'after' ? 1 : 0), 0, moved);
  setTabs(list);
  save();
}

/** Moves a tab to a level of the folder tree: into a folder, or to the top with null. */
export function moveToFolder(id: string, folder: string | null) {
  const moving = tabById(id);
  if (!moving || moving.parent === folder || id === folder) return;
  if (moving.kind === 'folder' && folder && isInside(folder, id)) return;
  setTabs([...tabs().filter((t) => t.id !== id), { ...moving, parent: folder }]);
  save();
}

/** Puts a folder's contents where the folder was, and removes the folder. */
export function unpackFolder(id: string) {
  const folder = tabById(id);
  if (!folder || folder.kind !== 'folder') return;
  const list: Tab[] = [];
  const contents = tabs().filter((t) => t.parent === id).map((t) => ({ ...t, parent: folder.parent }));
  for (const t of tabs()) {
    if (t.id === id) list.push(...contents);
    else if (t.parent !== id) list.push(t);
  }
  setTabs(list);
  if (openFolder() === id) setOpenFolder(folder.parent);
  save();
}

/** A new document has a Part Studio and an Assembly, as in Onshape. Anything autosaved before tabs existed is the first. */
function restoreTabs() {
  try {
    const saved = JSON.parse(storage.get(TABS_KEY) ?? 'null');
    if (Array.isArray(saved?.tabs) && saved.tabs.some((t: Tab) => t.kind !== 'folder')) {
      nextId = saved.next ?? saved.tabs.length + 1;
      setTabs(saved.tabs);
      const active = saved.tabs.find((t: Tab) => t.id === saved.active && t.kind !== 'folder') ?? saved.tabs.find((t: Tab) => t.kind !== 'folder');
      setActiveTabId(active.id);
      setOpenFolder(active.parent);
      return;
    }
  } catch {
    /* It can't be read, so it's as if there were none. */
  }
  const studio: Tab = { id: 't1', kind: 'part-studio', name: 'Part Studio 1', parent: null };
  nextId = 3;
  setTabs([studio, { id: 't2', kind: 'assembly', name: 'Assembly 1', parent: null }]);
  setActiveTabId(studio.id);
  const old = storage.get(LEGACY_DOC_KEY);
  if (old) {
    storage.set(docKey(studio.id), old);
    storage.remove(LEGACY_DOC_KEY);
  }
  keepPlacesOf(studio.id);
  save();
}

export async function bootTabs() {
  restoreTabs();
  const t = activeTab()!;
  setAutosaveKey(t.kind === 'part-studio' ? docKey(t.id) : null);
  setPlacesScope(t.id);
  await boot();
  if (t.kind === 'assembly') await assemblyHooks.enter(t.id);
}
