import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { activateTab, activeTabId, childrenOf, createTab, deleteTab, duplicateTab, folderPath, iconForTab, isInside, moveTab, moveToFolder, openFolder, renameTab, renamingTab, setOpenFolder, setRenamingTab, tabById, tabManagerOpen, tabs, toggleTabManager, unpackFolder, type Tab } from '../store/tabs';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './icons';

type Menu = { x: number; y: number; items: (MenuItem | null)[] };
const [menu, setMenu] = createSignal<Menu | null>(null);

function tabMenu(t: Tab, x: number, y: number) {
  const rename = { label: 'Rename', run: () => setRenamingTab(t.id) };
  const folders = tabs().filter((f) => f.kind === 'folder' && f.id !== t.parent && f.id !== t.id && !(t.kind === 'folder' && isInside(f.id, t.id)));
  const moves: MenuItem[] = folders.map((f) => ({ label: `Move to ${f.name}`, run: () => moveToFolder(t.id, f.id) }));
  if (t.parent) moves.push({ label: 'Move to parent folder', run: () => moveToFolder(t.id, tabById(t.parent)?.parent ?? null) });
  const items: (MenuItem | null)[] = t.kind === 'folder'
    ? [rename, ...moves, null, { label: 'Unpack folder', run: () => unpackFolder(t.id) }]
    : [rename, { label: 'Duplicate', run: () => duplicateTab(t.id) }, ...moves, null, { label: 'Delete', danger: true, run: () => deleteTab(t.id) }];
  setMenu({ x, y, items });
}

const openTab = (t: Tab) => (t.kind === 'folder' ? setOpenFolder(t.id) : void activateTab(t.id));

function TabName(props: { tab: Tab }) {
  return (
    <Show when={renamingTab() === props.tab.id} fallback={<span class="tab-name">{props.tab.name}</span>}>
      <input
        class="tab-rename"
        value={props.tab.name}
        aria-label="Tab name"
        spellcheck={false}
        ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          renameTab(props.tab.id, e.currentTarget.value);
          setRenamingTab(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { e.currentTarget.value = props.tab.name; e.currentTarget.blur(); }
        }}
      />
    </Show>
  );
}

/** Where a dragged tab would land: beside a tab, into a folder, or at a level of the folder path. */
type Drop = { on: string; where: 'before' | 'after' | 'into' } | { level: string | null };
const [drop, setDrop] = createSignal<Drop | null>(null);
const dropClass = (id: string) => {
  const d = drop();
  return d && 'on' in d && d.on === id ? `drop-${d.where}` : '';
};
/** A drag ends in a click on whatever it started on, which shouldn't open anything. */
let justDragged = false;

function startDrag(e: PointerEvent, t: Tab, axis: 'x' | 'y') {
  if (e.button !== 0 || renamingTab() === t.id) return;
  const x0 = e.clientX, y0 = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    dragging = true;
    const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-tab],[data-tab-level]');
    if (under?.dataset.tabLevel !== undefined) return setDrop({ level: under.dataset.tabLevel || null });
    const target = under ? tabById(under.dataset.tab!) : undefined;
    if (!target || target.id === t.id) return setDrop(null);
    const b = under!.getBoundingClientRect();
    const at = axis === 'x' ? (ev.clientX - b.left) / b.width : (ev.clientY - b.top) / b.height;
    if (target.kind === 'folder' && at > 0.25 && at < 0.75 && !(t.kind === 'folder' && isInside(target.id, t.id))) setDrop({ on: target.id, where: 'into' });
    else setDrop({ on: target.id, where: at < 0.5 ? 'before' : 'after' });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const d = drop();
    setDrop(null);
    if (!dragging) return;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    if (!d) return;
    if ('level' in d) moveToFolder(t.id, d.level);
    else moveTab(t.id, d.on, d.where);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

const keyMenu = (e: KeyboardEvent, t: Tab) => {
  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    tabMenu(t, b.left + 12, b.top);
  }
};

/** Holds the active tab, somewhere inside it. */
const holdsActive = (t: Tab) => t.kind === 'folder' && isInside(activeTabId(), t.id);

function BarTab(props: { tab: Tab }) {
  let el!: HTMLDivElement;
  createEffect(() => {
    if (activeTabId() === props.tab.id) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  return (
    <div
      ref={el}
      class={`tab ${dropClass(props.tab.id)}`}
      classList={{ on: activeTabId() === props.tab.id, holds: holdsActive(props.tab) }}
      role="tab"
      tabIndex={0}
      aria-selected={activeTabId() === props.tab.id}
      data-tab={props.tab.id}
      data-kind={props.tab.kind}
      onPointerDown={(e) => startDrag(e, props.tab, 'x')}
      onClick={(e) => {
        // Keys are for the app after a click, so the tab shouldn't keep a focus ring.
        e.currentTarget.blur();
        if (!justDragged) openTab(props.tab);
      }}
      onDblClick={() => { if (props.tab.kind !== 'folder') setRenamingTab(props.tab.id); }}
      onContextMenu={(e) => { e.preventDefault(); tabMenu(props.tab, e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (renamingTab() === props.tab.id) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openTab(props.tab); }
        keyMenu(e, props.tab);
      }}
    >
      <Icon name={iconForTab(props.tab)} />
      <TabName tab={props.tab} />
    </div>
  );
}

/** The bottom of the window: a document's Part Studios, Assemblies and folders, as in Onshape. */
export function TabBar() {
  const shown = createMemo(() => childrenOf(openFolder()));
  const levelClass = (level: string | null) => {
    const d = drop();
    return d && 'level' in d && d.level === level ? 'drop-into' : '';
  };
  return (
    <nav class="tabbar" aria-label="Document tabs" data-testid="tabbar">
      <button class="tab-tool" classList={{ held: tabManagerOpen() }} aria-label="Tab manager" aria-pressed={tabManagerOpen()} data-tip="Tab manager" onClick={toggleTabManager} data-testid="tab-manager-toggle"><Icon name="tab-manager" /></button>
      <button
        class="tab-tool"
        aria-label="Insert new tab"
        aria-haspopup="menu"
        data-tip="Insert new tab"
        data-testid="tab-insert"
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: b.left,
            y: b.top,
            items: [
              { label: 'Create Part Studio', command: 'tab.part-studio', run: () => createTab('part-studio') },
              { label: 'Create Assembly', command: 'tab.assembly', run: () => createTab('assembly') },
              { label: 'Create folder', command: 'tab.folder', run: () => createTab('folder') },
            ],
          });
        }}
      ><Icon name="plus" /></button>
      <Show when={openFolder()}>
        <button class={`tab-tool ${levelClass(null)}`} aria-label="All tabs" data-tip="All tabs" data-tab-level="" onClick={() => setOpenFolder(null)} data-testid="all-tabs"><Icon name="all-tabs" /></button>
        <For each={folderPath(openFolder())}>
          {(f) => (
            <button class={`tab-crumb ${levelClass(f.id)}`} classList={{ here: f.id === openFolder() }} data-tab-level={f.id} onClick={() => setOpenFolder(f.id)} onContextMenu={(e) => { e.preventDefault(); tabMenu(f, e.clientX, e.clientY); }}>
              <Icon name="folder" />
              <span class="tab-name">{f.name}</span>
            </button>
          )}
        </For>
      </Show>
      <div class="tabs" role="tablist">
        <For each={shown()}>{(t) => <BarTab tab={t} />}</For>
        <Show when={openFolder() && !shown().length}><span class="tabs-empty">This folder is empty. Drag tabs onto it, or create one here with +.</span></Show>
      </div>
      <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
    </nav>
  );
}

function TreeRows(props: { parent: string | null; depth: number; closed: () => Set<string>; toggle: (id: string) => void }) {
  return (
    <For each={childrenOf(props.parent)}>
      {(t) => (
        <>
          <ManagerRow tab={t} depth={props.depth} closed={props.closed} toggle={props.toggle} />
          <Show when={t.kind === 'folder' && !props.closed().has(t.id)}>
            <TreeRows parent={t.id} depth={props.depth + 1} closed={props.closed} toggle={props.toggle} />
          </Show>
        </>
      )}
    </For>
  );
}

function ManagerRow(props: { tab: Tab; depth: number; closed: () => Set<string>; toggle: (id: string) => void }) {
  const t = () => props.tab;
  const isFolder = () => t().kind === 'folder';
  return (
    <div
      class={`tab-row ${dropClass(t().id)}`}
      classList={{ on: activeTabId() === t().id }}
      style={{ 'padding-left': `${6 + props.depth * 14}px` }}
      tabIndex={0}
      data-tab={t().id}
      data-kind={t().kind}
      onPointerDown={(e) => startDrag(e, t(), 'y')}
      onClick={(e) => {
        e.currentTarget.blur();
        if (justDragged) return;
        if (isFolder()) props.toggle(t().id);
        else void activateTab(t().id);
      }}
      onDblClick={() => { if (isFolder()) setOpenFolder(t().id); }}
      onContextMenu={(e) => { e.preventDefault(); tabMenu(t(), e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (renamingTab() === t().id) return;
        if (e.key === 'Enter') { e.stopPropagation(); if (isFolder()) props.toggle(t().id); else void activateTab(t().id); }
        keyMenu(e, t());
      }}
    >
      <span class="tab-caret" classList={{ closed: props.closed().has(t().id) }}>
        <Show when={isFolder()}><Icon name="caret" size={13} /></Show>
      </span>
      <Icon name={iconForTab(t())} />
      <TabName tab={t()} />
    </div>
  );
}

/** Every tab in one tree, opened from the corner of the tab bar. */
export function TabManager() {
  const [query, setQuery] = createSignal('');
  const [closed, setClosed] = createSignal(new Set<string>());
  const toggle = (id: string) => {
    const next = new Set(closed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setClosed(next);
  };
  const found = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? tabs().filter((t) => t.name.toLowerCase().includes(q)) : null;
  });
  const count = () => tabs().filter((t) => t.kind !== 'folder').length;
  return (
    <aside class="tab-manager" aria-label="Tab manager" data-testid="tab-manager">
      <h2>Tabs ({count()})</h2>
      <div class="filter">
        <input value={query()} placeholder="Search tabs" aria-label="Search tabs" spellcheck={false} onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }} />
      </div>
      <div class="tab-tree">
        <Show when={found()} fallback={<TreeRows parent={null} depth={0} closed={closed} toggle={toggle} />}>
          {(list) => (
            <>
              <For each={list()}>{(t) => <ManagerRow tab={t} depth={0} closed={() => new Set()} toggle={() => setOpenFolder(t.id)} />}</For>
              <Show when={!list().length}><p class="panel-empty">No tab has that name.</p></Show>
            </>
          )}
        </Show>
      </div>
    </aside>
  );
}
