import { createSignal, For, Show } from 'solid-js';
import { closeOnEscape, ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { DialogFrame } from '../ui/DialogFrame';
import { Icon } from '../ui/icons';
import './assembly.css';
import { MATE_TYPES, type MateData } from './model';
import {
  acceptMate, asm, asmFreedom, cancelMate, deleteInstances, deleteMate, editMate, insertOpen, insertParts, insertRows, instanceById, instanceName, instanceProblem, mateDraft, mateFailures,
  openInsert, renameInstance, renameMate, renamingInstance, renamingMate, selectedInstances, selectedMate, selectInstances, setFixed, setHidden, setInsertOpen, setMateSuppressed, setRenamingInstance,
  setRenamingMate, setSelectedMate, updateDraft,
} from './store';
import { MATE_DOF, mateTypeName, type MateType } from './solver';

type Menu = { x: number; y: number; items: (MenuItem | null)[] };

const WHAT_MOVES: Record<MateType, string> = {
  fastened: 'No movement between them',
  revolute: 'Turns about Z',
  slider: 'Slides along Z',
  planar: 'Slides in X and Y, turns about Z',
  cylindrical: 'Slides along Z and turns about Z',
  'pin-slot': 'Turns about Z and slides along X',
  ball: 'Turns any way about a point',
  parallel: 'Moves anywhere and turns about Z',
};

export const mateIcon = (t: MateType) => `mate-${t}`;

function RenameInput(props: { value: string; label: string; commit: (name: string) => void; done: () => void }) {
  return (
    <input
      class="feature-rename"
      value={props.value}
      aria-label={props.label}
      spellcheck={false}
      ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        const name = e.currentTarget.value.trim();
        props.done();
        if (name && name !== props.value) props.commit(name);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { e.currentTarget.value = props.value; e.currentTarget.blur(); }
      }}
    />
  );
}

function InstanceRow(props: { id: string; openMenu: (m: Menu) => void }) {
  const inst = () => instanceById(props.id);
  const problem = () => { const i = inst(); return i ? instanceProblem(i) : null; };
  const menu = (x: number, y: number) => {
    const i = inst();
    if (!i) return;
    if (!selectedInstances().includes(i.id)) selectInstances([i.id]);
    props.openMenu({
      x,
      y,
      items: [
        { label: i.hidden ? 'Show' : 'Hide', run: () => setHidden(i.id, !i.hidden) },
        { label: i.fixed ? 'Unfix' : 'Fix', run: () => setFixed(i.id, !i.fixed) },
        { label: 'Rename', run: () => setRenamingInstance(i.id) },
        null,
        { label: 'Delete', keys: 'Delete', danger: true, run: () => deleteInstances([i.id]) },
      ],
    });
  };
  return (
    <Show when={inst()}>
      {(i) => (
        <div
          class="asm-row"
          classList={{ selected: selectedInstances().includes(i().id), off: i().hidden, failed: !!problem() }}
          data-instance={i().id}
          tabIndex={0}
          data-tip={problem() ?? undefined}
          onClick={(e) => {
            const cur = selectedInstances();
            selectInstances(e.shiftKey ? (cur.includes(i().id) ? cur.filter((x) => x !== i().id) : [...cur, i().id]) : [i().id]);
          }}
          onContextMenu={(e) => { e.preventDefault(); menu(e.clientX, e.clientY); }}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
              e.preventDefault();
              const b = e.currentTarget.getBoundingClientRect();
              menu(b.left + 24, b.bottom);
            }
          }}
        >
          <Icon name="part" />
          <Show
            when={renamingInstance() === i().id}
            fallback={
              <>
                <span class="feature-name" data-tip={instanceName(i())}>{/^(.*) <\d+>$/.exec(instanceName(i()))?.[1] ?? instanceName(i())}</span>
                <Show when={/<\d+>$/.exec(instanceName(i()))}>{(n) => <span class="asm-number">{n()[0]}</span>}</Show>
              </>
            }
          >
            <RenameInput value={instanceName(i())} label="Instance name" commit={(name) => renameInstance(i().id, name)} done={() => setRenamingInstance(null)} />
          </Show>
          <Show when={i().fixed}><span class="asm-fixed" aria-label="Fixed" data-tip="Fixed in place"><Icon name="fix" /></span></Show>
          <Show when={problem()}><span class="feature-warn" aria-label="Failed"><Icon name="warn" size={14} /></span></Show>
          <button
            class="row-eye"
            classList={{ off: i().hidden }}
            aria-label={`${i().hidden ? 'Show' : 'Hide'} ${instanceName(i())}`}
            aria-pressed={i().hidden}
            data-tip={i().hidden ? 'Show' : 'Hide'}
            onClick={(e) => { e.stopPropagation(); setHidden(i().id, !i().hidden); }}
          >
            <Icon name={i().hidden ? 'eye-off' : 'eye'} />
          </button>
        </div>
      )}
    </Show>
  );
}

function MateRow(props: { mate: MateData; openMenu: (m: Menu) => void }) {
  const failure = () => mateFailures().get(props.mate.id);
  const who = () => {
    const a = instanceById(props.mate.a), b = instanceById(props.mate.b);
    return a && b ? `${instanceName(a)} and ${instanceName(b)}` : undefined;
  };
  const menu = (x: number, y: number) => {
    setSelectedMate(props.mate.id);
    props.openMenu({
      x,
      y,
      items: [
        { label: 'Edit', keys: 'Enter', run: () => editMate(props.mate.id) },
        { label: 'Rename', run: () => setRenamingMate(props.mate.id) },
        { label: props.mate.suppressed ? 'Unsuppress' : 'Suppress', run: () => setMateSuppressed(props.mate.id, !props.mate.suppressed) },
        null,
        { label: 'Delete', keys: 'Delete', danger: true, run: () => deleteMate(props.mate.id) },
      ],
    });
  };
  return (
    <div
      class="asm-row"
      classList={{ selected: selectedMate() === props.mate.id, off: props.mate.suppressed, failed: !!failure() }}
      data-mate={props.mate.id}
      tabIndex={0}
      data-tip={failure() ?? who()}
      onClick={() => { selectInstances([]); setSelectedMate(props.mate.id); }}
      onDblClick={() => editMate(props.mate.id)}
      onContextMenu={(e) => { e.preventDefault(); menu(e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.stopPropagation(); editMate(props.mate.id); }
        if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault();
          const b = e.currentTarget.getBoundingClientRect();
          menu(b.left + 24, b.bottom);
        }
      }}
    >
      <Icon name={mateIcon(props.mate.type)} />
      <Show when={renamingMate() === props.mate.id} fallback={<span class="feature-name">{props.mate.name}</span>}>
        <RenameInput value={props.mate.name} label="Mate name" commit={(name) => renameMate(props.mate.id, name)} done={() => setRenamingMate(null)} />
      </Show>
      <Show when={failure()}><span class="feature-warn" aria-label="Failed"><Icon name="warn" size={14} /></span></Show>
    </div>
  );
}

/** An assembly's side of the window: its instances, and the mates between them. */
export function AssemblyPanels() {
  const [menu, setMenu] = createSignal<Menu | null>(null);
  return (
    <>
      <section class="panel features" aria-label="Instances">
        <h2>Instances ({asm().instances.length})</h2>
        <div class="asm-list" data-testid="instances">
          <For each={asm().instances}>{(i) => <InstanceRow id={i.id} openMenu={setMenu} />}</For>
        </div>
      </section>
      <section class="panel parts" aria-label="Mates">
        <h2>Mates ({asm().mates.length})</h2>
        <div class="asm-mates" data-testid="mates">
          <For each={asm().mates}>{(m) => <MateRow mate={m} openMenu={setMenu} />}</For>
        </div>
      </section>
      <Show when={menu()}>{(m) => <ContextMenu {...m()} close={() => setMenu(null)} />}</Show>
    </>
  );
}

export function AssemblyStatus() {
  const text = () => (asmFreedom() === 0 ? 'Fully defined' : `${asmFreedom()} ${asmFreedom() === 1 ? 'freedom' : 'freedoms'} left`);
  return <Show when={asm().instances.length > 0}><div class="sketch-status" classList={{ done: asmFreedom() === 0 }} data-testid="assembly-status">{text()}</div></Show>;
}

function InsertDialog() {
  closeOnEscape(() => insertOpen(), () => setInsertOpen(false));
  return (
    <DialogFrame
      label="Insert parts"
      testid="insert-dialog"
      icon="insert"
      title="Insert parts"
      actions={<button class="dialog-action" aria-label="Close" data-tip="Close" data-keys="Esc" onClick={() => setInsertOpen(false)}><Icon name="close" /></button>}
    >
        <Show when={insertRows()} fallback={<p class="field-hint">Reading the Part Studios…</p>}>
          {(rows) => (
            <>
              <For each={rows()}>
                {(row) => (
                  <div class="insert-group" data-studio={row.tab}>
                    <button class="insert-row studio" disabled={!row.parts.length} data-tip={row.parts.length ? 'Insert all of its parts' : undefined} onClick={() => void insertParts(row.tab, null)}>
                      <Icon name="part-studio" />
                      <span class="feature-name">{row.name}</span>
                    </button>
                    <For each={row.parts}>
                      {(p) => (
                        <button class="insert-row part" data-part-body={p.body} onClick={() => void insertParts(row.tab, p.body)}>
                          <Icon name="part" />
                          <span class="feature-name">{p.label}</span>
                        </button>
                      )}
                    </For>
                    <Show when={row.error}><p class="dialog-error" role="alert">{row.error}</p></Show>
                    <Show when={!row.parts.length && !row.error}><p class="field-hint">No parts yet</p></Show>
                  </div>
                )}
              </For>
              <Show when={!rows().length}><p class="field-hint">This document has no Part Studios.</p></Show>
            </>
          )}
        </Show>
    </DialogFrame>
  );
}

function ConnectorWell(props: { label: string; which: 'first' | 'second' }) {
  const picked = () => mateDraft()?.[props.which] ?? null;
  const name = () => {
    const p = picked();
    const i = p && instanceById(p.instance);
    return i ? instanceName(i) : '';
  };
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <div class="pick-well" classList={{ waiting: !picked() }} data-testid={`mate-${props.which}`}>
        <Show when={picked()} fallback={<>Click a connector</>}>
          <span class="pick-text" data-tip={name()}>{name()}</span>
          <button class="link" onClick={() => updateDraft({ [props.which]: null })}>Clear</button>
        </Show>
      </div>
    </div>
  );
}

function MateDialog() {
  const d = () => mateDraft()!;
  const ready = () => !!d().first && !!d().second;
  return (
    <DialogFrame
      label="Mate"
      testid="mate-dialog"
      title={d().editing ? d().name : `${mateTypeName(d().type)} mate`}
      actions={
        <>
          <button class="dialog-action ok" disabled={!ready() || !!d().error} aria-label="Add mate" data-tip={d().editing ? 'Save' : 'Add mate'} data-keys="Enter" data-testid="mate-ok" onClick={acceptMate}><Icon name="check" /></button>
          <button class="dialog-action" aria-label="Cancel" data-tip="Cancel" data-keys="Esc" onClick={cancelMate}><Icon name="close" /></button>
        </>
      }
    >
        <div class="mate-types" role="radiogroup" aria-label="Mate type">
          <For each={MATE_TYPES}>
            {(t) => (
              <button class="mate-type" classList={{ on: d().type === t }} role="radio" aria-checked={d().type === t} aria-label={mateTypeName(t)} data-tip={mateTypeName(t)} data-mate-type={t} onClick={() => updateDraft({ type: t })}>
                <Icon name={mateIcon(t)} />
              </button>
            )}
          </For>
        </div>
        <p class="mate-dof">{WHAT_MOVES[d().type]}. {MATE_DOF[d().type]} {MATE_DOF[d().type] === 1 ? 'freedom' : 'freedoms'}.</p>
        <ConnectorWell label="First" which="first" />
        <ConnectorWell label="Second" which="second" />
        <div class="field">
          <span class="field-label">Align</span>
          <div class="mate-actions">
            <button class="mate-action" classList={{ on: d().flip }} disabled={!ready()} aria-label="Flip primary axis" aria-pressed={d().flip} data-tip="Flip primary axis" data-testid="mate-flip" onClick={() => updateDraft({ flip: !d().flip })}><Icon name="mate-flip" /></button>
            <button class="mate-action" disabled={!ready()} aria-label="Reorient secondary axis" data-tip="Reorient secondary axis" data-testid="mate-turn" onClick={() => updateDraft({ quarter: (d().quarter + 1) % 4 })}><Icon name="mate-turn" /></button>
          </div>
        </div>
        <Show when={d().error}><p class="dialog-error" role="alert" data-testid="mate-error">{d().error}</p></Show>
    </DialogFrame>
  );
}

/** What floats over an assembly's view. */
export function AssemblyDialogs() {
  return (
    <>
      <Show when={mateDraft()}><MateDialog /></Show>
      <Show when={insertOpen() && !mateDraft()}><InsertDialog /></Show>
    </>
  );
}

export function AssemblyEmpty() {
  return (
    <Show when={!asm().instances.length && !insertOpen()}>
      <div class="empty" data-testid="assembly-empty">
        <p>This assembly is empty.</p>
        <button class="link asm-empty-link" onClick={() => void openInsert()}>Insert a part from a Part Studio</button>
      </div>
    </Show>
  );
}

