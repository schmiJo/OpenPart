import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { removeFace, removeSection, regionsTakeFaces, setValueAt, acceptDialog, activatePick, activeDef, activePick, canonical, cancelDialog, clearRegions, dialogBusy, dialogError, dialogMissing, dialogName, editingId, hasLaterFeatures, nothingPicked, pickBase, removeRegions, setValue, showingFinal, toggleFinal, values, takesRegions } from '../features/dialog';
import { AXIS_CHOICES, newStep, type FieldDef, type PathStep, type Section } from '../features/defs';
import { edgeWord, faceWord, fmtNum, partLabel } from '../features/words';
import { sameRegions, sketchLines, wholeSketch, type RegionPick } from '../sketch/regions';
import { doc, isHidden, isSketchFeature, numberOr, partLooks, sketchRegions } from '../store/doc';
import { view } from '../viewport/instance';
import { DialogFrame } from './DialogFrame';
import { Icon } from './icons';

function ExprField(props: { field: FieldDef; off?: boolean }) {
  const key = props.field.key;
  const scrub = (e: PointerEvent) => {
    const start = Number(values[key]);
    if (props.off || !Number.isFinite(start)) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const step = props.field.scrub ?? 1;
    const move = (ev: PointerEvent) => {
      const v = start + Math.round((ev.clientX - x0) / 3) * step * (ev.shiftKey ? 0.1 : 1);
      setValue(key, String(Number(v.toFixed(3))));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div class="field" classList={{ off: props.off }}>
      <span class="field-label scrub" onPointerDown={scrub} data-tip={props.off ? undefined : 'Drag to change. Hold Shift for finer steps.'}>{props.field.label}</span>
      <div class="field-control">
        <label class="field-input">
          <input
            data-field={key}
            aria-label={props.field.label}
            value={String(values[key] ?? '')}
            disabled={props.off}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => {
              const text = e.currentTarget.value;
              if (numberOr(text) !== '') setValue(key, text);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') void acceptDialog();
              if (e.key === 'Escape') void cancelDialog();
            }}
          />
          <Show when={props.field.unit}><span class="unit">{props.field.unit}</span></Show>
        </label>
        <FlipButton field={props.field} off={props.off} />
      </div>
      <Show when={props.field.hint}><p class="field-hint wide">{props.field.hint}</p></Show>
    </div>
  );
}

/** The arrow beside a field that turns its direction round. */
function FlipButton(props: { field: FieldDef; off?: boolean }) {
  return (
    <Show when={props.field.flip}>
      {(f) => (
        <button
          class="field-flip"
          classList={{ on: !!values[f().key] }}
          disabled={props.off || f().disabled?.(values)}
          aria-label={f().label}
          aria-pressed={!!values[f().key]}
          data-tip={f().label}
          data-testid="flip-direction"
          onClick={() => setValue(f().key, !values[f().key])}
        >
          <Icon name="flip" />
        </button>
      )}
    </Show>
  );
}

function SelectField(props: { field: FieldDef; off?: boolean }) {
  return (
    <div class="field" classList={{ off: props.off }}>
      <span class="field-label">{props.field.label}</span>
      <div class="field-control">
        <select class="select" data-field={props.field.key} aria-label={props.field.label} disabled={props.off} value={String(values[props.field.key] ?? '')} onChange={(e) => setValue(props.field.key, e.currentTarget.value)}>
          <For each={props.field.options}>{(o) => <option value={o.value} disabled={o.disabled?.(values)} selected={values[props.field.key] === o.value}>{o.label}</option>}</For>
        </select>
        <FlipButton field={props.field} off={props.off} />
      </div>
    </div>
  );
}

function Segment(props: { field: FieldDef }) {
  return (
    <div class="field" classList={{ bare: props.field.bare }}>
      <Show when={!props.field.bare}><span class="field-label">{props.field.label}</span></Show>
      <div class="segment" role="radiogroup" aria-label={props.field.label}>
        <For each={props.field.options}>
          {(o) => (
            <button role="radio" aria-checked={values[props.field.key] === o.value} classList={{ on: values[props.field.key] === o.value }} disabled={o.disabled?.(values)} onClick={() => setValue(props.field.key, o.value)}>{o.label}</button>
          )}
        </For>
      </div>
    </div>
  );
}

function Tabs(props: { field: FieldDef }) {
  return (
    <div class="dialog-tabs" role="radiogroup" aria-label={props.field.label}>
      <For each={props.field.options}>
        {(o) => (
          <button role="radio" aria-checked={values[props.field.key] === o.value} classList={{ on: values[props.field.key] === o.value }} disabled={o.disabled?.(values)} onClick={() => setValue(props.field.key, o.value)}>{o.label}</button>
        )}
      </For>
    </div>
  );
}

function CheckField(props: { field: FieldDef; off?: boolean; changed?: (on: boolean) => void }) {
  const off = () => props.off || props.field.disabled?.(values);
  return (
    <label class="check" classList={{ off: off() }}>
      <input
        type="checkbox"
        data-field={props.field.key}
        checked={!!values[props.field.key]}
        disabled={off()}
        onChange={(e) => {
          setValue(props.field.key, e.currentTarget.checked);
          props.changed?.(e.currentTarget.checked);
        }}
      />
      <span>{props.field.label}</span>
    </label>
  );
}

/** A row that opens to more fields, as Onshape's have, and can have a checkbox that turns them on. */
function GroupField(props: { field: FieldDef; off?: boolean }) {
  const turnedOn = () => !props.field.checkable || (!!values[props.field.key] && !props.field.disabled?.(values));
  const [open, setOpen] = createSignal(!!props.field.checkable && !!values[props.field.key]);
  const shown = () => open() && !props.field.disabled?.(values);
  return (
    <div class="field-group" data-group={props.field.key}>
      <div class="group-head">
        <button class="dialog-caret" classList={{ closed: !shown() }} disabled={!!props.field.disabled?.(values)} aria-expanded={shown()} aria-label={`${shown() ? 'Hide' : 'Show'} ${props.field.label}`} onClick={() => setOpen(!open())}>
          <Icon name="caret" size={13} />
        </button>
        <Show when={props.field.checkable} fallback={<button class="group-title" onClick={() => setOpen(!open())}>{props.field.label}</button>}>
          <CheckField field={props.field} off={props.off} changed={setOpen} />
        </Show>
      </div>
      <Show when={shown()}>
        <div class="group-body"><FieldList fields={props.field.fields ?? []} off={props.off || !turnedOn()} /></div>
      </Show>
    </div>
  );
}

function SketchField(props: { field: FieldDef }) {
  const sketches = () => doc.features.filter((f) => isSketchFeature(f) && !isHidden(f));
  return (
    <>
      <label class="field">
        <span class="field-label">{props.field.label}</span>
        <select class="select" value={String(values[props.field.key] ?? '')} onChange={(e) => setValue(props.field.key, Number(e.currentTarget.value))}>
          <For each={sketches()}>{(s) => <option value={String(s.id)} selected={values[props.field.key] === s.id}>{s.name}</option>}</For>
        </select>
      </label>
      <Show when={props.field.hint}><p class="field-hint">{props.field.hint}</p></Show>
    </>
  );
}

interface PickRow { name: string; size: string; remove: () => void }

/** The tinted box from Onshape: what the field is for, then one row per thing picked, each with a way to drop it. */
function PickBox(props: { field: FieldDef; prompt: string; rows: PickRow[]; waiting: boolean; clear: () => void }) {
  const active = () => activePick() === props.field.key;
  return (
    <>
      <div
        class="pick-box"
        classList={{ waiting: props.waiting, idle: !active() }}
        data-testid="pick-well"
        data-pick={props.field.key}
        aria-current={active() ? 'true' : undefined}
        onPointerDown={() => { if (!active()) activatePick(props.field.key); }}
      >
        <div class="pick-head">
          <span class="pick-label">{props.field.label}</span>
          <Show when={props.rows.length > 0}><button class="link" onClick={() => props.clear()}>Clear</button></Show>
        </div>
        <Show when={props.rows.length > 0} fallback={<div class="pick-prompt">{props.prompt}</div>}>
          <div class="pick-rows">
            <For each={props.rows}>
              {(r) => (
                <div class="pick-row">
                  <span class="pick-name">{r.name}</span>
                  <Show when={r.size}><span class="pick-size">{r.size}</span></Show>
                  <button class="pick-remove" aria-label={`Remove ${r.name}`} data-tip="Remove" onClick={() => r.remove()}><Icon name="close" /></button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={props.field.hint}><p class="field-hint">{props.field.hint}</p></Show>
    </>
  );
}

const fmtPoint = (p?: number[]) => (p ? `(${p.map((c) => fmtNum(c)).join(', ')})` : '');

/** Edges, faces, a face, a part or parts, or a corner, picked from the model as it was before this feature. */
function PickField(props: { field: FieldDef }) {
  const key = props.field.key;
  const kind = props.field.kind;
  const raw = () => JSON.parse(JSON.stringify(values[key] ?? null));
  const list = (): any[] => (Array.isArray(raw()) ? raw() : raw() === null ? [] : [raw()]);
  const single = kind === 'face' || kind === 'part' || kind === 'vertex';
  const without = (i: number) => setValue(key, single ? null : list().filter((_, at) => at !== i));
  const rows = createMemo<PickRow[]>(() => {
    const base = pickBase();
    return list().map((item, i) => {
      const remove = () => without(i);
      if (kind === 'edges') {
        const e = base?.edges.find((x) => canonical(x.select) === canonical(item));
        return { name: edgeWord(e?.curve), size: e ? `${fmtNum(e.length)} mm` : '', remove };
      }
      if (kind === 'part' || kind === 'parts') return { name: base ? partLabel(base.mesh.parts, item, partLooks()) : item, size: '', remove };
      if (kind === 'vertex') return { name: 'Vertex', size: fmtPoint(item.near ?? item.point), remove };
      // One name can cover several faces, such as a pattern's copies.
      const faces = base?.faces.filter((x) => x.name === item || x.key === item) ?? [];
      return { name: faceWord(faces[0]?.surface), size: faces.length ? `${fmtNum(faces.reduce((t, f) => t + f.area, 0))} mm²` : '', remove };
    });
  });
  const prompt = { edges: 'Click edges in the view', faces: 'Click faces in the view', face: 'Click a face in the view', part: 'Click a part in the view', parts: 'Click parts in the view', vertex: 'Click an edge near its end' }[kind as string] ?? '';
  return <PickBox field={props.field} prompt={prompt} rows={rows()} waiting={rows().length === 0} clear={() => setValue(key, single ? null : [])} />;
}

function RegionField(props: { field: FieldDef }) {
  const rows = createMemo<PickRow[]>(() => {
    if (nothingPicked()) return [];
    const base = pickBase();
    const faceRows = ((values.faces ?? []) as string[]).map((ref) => {
      const faces = base?.faces.filter((x) => x.name === ref || x.key === ref) ?? [];
      return { name: faceWord(faces[0]?.surface), size: faces.length ? `${fmtNum(faces.reduce((t, f) => t + f.area, 0))} mm²` : '', remove: () => removeFace(ref) };
    });
    const picks = (values.regions ?? []) as RegionPick[];
    const sketches = [...new Set(picks.map((p) => p.sketch))];
    if (!sketches.length && !faceRows.length && values.sketch !== null && values.sketch !== undefined) sketches.push(values.sketch);
    const regionRows = sketches.flatMap((sketch) => {
      const name = doc.features.find((f) => f.id === sketch)?.name ?? '';
      const there = sketchRegions().get(sketch) ?? [];
      const ids = picks.filter((p) => p.sketch === sketch).map((p) => p.id);
      if (!ids.length || sameRegions(ids, wholeSketch(there))) {
        const area = there.filter((r) => ids.includes(r.id)).reduce((t, r) => t + r.area, 0);
        return [{ name: `All of ${name}`, size: area ? `${fmtNum(area)} mm²` : '', remove: () => (sketches.length > 1 || faceRows.length ? removeRegions(sketch) : clearRegions()) }];
      }
      return ids.map((id) => {
        const r = there.find((x) => x.id === id);
        return { name: `Region of ${name}`, size: r ? `${fmtNum(r.area)} mm²` : '', remove: () => removeRegions(sketch, [id]) };
      });
    });
    return [...faceRows, ...regionRows];
  });
  return <PickBox field={props.field} prompt={regionsTakeFaces() ? 'Click flat faces or regions in the view' : 'Click regions in the view'} rows={rows()} waiting={nothingPicked()} clear={clearRegions} />;
}

/** A loft's profiles, numbered in the order it passes through them. */
function SectionsField(props: { field: FieldDef }) {
  const rows = createMemo<PickRow[]>(() =>
    ((values.sections ?? []) as Section[]).map((x, i) => {
      const name = doc.features.find((f) => f.id === x.sketch)?.name ?? '';
      const there = sketchRegions().get(x.sketch) ?? [];
      const area = x.id ? there.find((r) => r.id === x.id)?.area ?? 0 : there.filter((r) => wholeSketch(there).includes(r.id)).reduce((t, r) => t + r.area, 0);
      return { name: `${i + 1}. ${x.id ? `Region of ${name}` : name}`, size: area ? `${fmtNum(area)} mm²` : '', remove: () => removeSection(i) };
    }),
  );
  return <PickBox field={props.field} prompt="Click profiles in order, in the view or the list" rows={rows()} waiting={rows().length === 0} clear={() => setValue(props.field.key, [])} />;
}

/** A revolve's axis: a line of its sketch, clicked in the view or chosen here, or one of the sketch's own axes. */
function AxisField(props: { field: FieldDef }) {
  const key = props.field.key;
  const active = () => activePick() === key;
  const lines = createMemo(() => {
    sketchRegions();
    return values.sketch === null || values.sketch === undefined ? [] : sketchLines(Number(values.sketch));
  });
  return (
    <>
      <div class="pick-box axis-box" classList={{ idle: !active() }} data-pick={key} data-testid="axis-well" aria-current={active() ? 'true' : undefined} onPointerDown={() => { if (!active()) activatePick(key); }}>
        <div class="pick-head"><span class="pick-label">{props.field.label}</span></div>
        <select class="select" data-field={key} aria-label={props.field.label} value={String(values[key] ?? '')} onChange={(e) => setValue(key, e.currentTarget.value)}>
          <option value={AXIS_CHOICES.y} selected={values[key] === AXIS_CHOICES.y}>Sketch’s vertical axis</option>
          <option value={AXIS_CHOICES.x} selected={values[key] === AXIS_CHOICES.x}>Sketch’s horizontal axis</option>
          <For each={lines()}>{(l, i) => <option value={`line:${l.id}`} selected={values[key] === `line:${l.id}`}>{`${l.construction ? 'Construction line' : 'Line'} ${i() + 1}, ${fmtNum(Math.hypot(l.end[0] - l.start[0], l.end[1] - l.start[1]))} mm`}</option>}</For>
          <Show when={values[key] === AXIS_CHOICES.normal}><option value={AXIS_CHOICES.normal} selected>Straight out of the sketch</option></Show>
          <Show when={values[key] === 'custom'}><option value="custom" selected>As the file has it</option></Show>
        </select>
      </div>
      <Show when={props.field.hint}><p class="field-hint">{props.field.hint}</p></Show>
    </>
  );
}

/** A sweep's path: straight runs and bends, each carrying on from where the last one ends. */
function StepsField(props: { field: FieldDef }) {
  const key = props.field.key;
  const steps = () => (values[key] ?? []) as PathStep[];
  const change = (i: number, k: keyof PathStep, v: string) => setValueAt(key, i, k, v);
  const input = (i: number, k: keyof PathStep, label: string, unit: string) => (
    <label class="step-input">
      <span>{label}</span>
      <input
        aria-label={`${label}, step ${i + 1}`}
        data-step={`${i}.${k}`}
        value={String(steps()[i]?.[k] ?? '')}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => { if (numberOr(e.currentTarget.value) !== '') change(i, k, e.currentTarget.value); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') void acceptDialog();
          if (e.key === 'Escape') void cancelDialog();
        }}
      />
      <span class="unit">{unit}</span>
    </label>
  );
  return (
    <div class="steps" data-testid="path-steps">
      <span class="field-label">{props.field.label}</span>
      <For each={steps()}>
        {(s, i) => (
          <div class="step-row">
            <span class="step-kind">{s.kind === 'line' ? 'Straight' : 'Bend'}</span>
            <Show when={s.kind === 'line'} fallback={<>{input(i(), 'radius', 'Radius', 'mm')}{input(i(), 'degrees', 'Angle', '°')}{input(i(), 'toward', 'Toward', '°')}</>}>
              {input(i(), 'length', 'Length', 'mm')}
            </Show>
            <button class="pick-remove" aria-label={`Remove step ${i() + 1}`} data-tip="Remove" onClick={() => setValue(key, steps().filter((_, at) => at !== i()).map((x) => ({ ...x })))}><Icon name="close" /></button>
          </div>
        )}
      </For>
      <div class="step-add">
        <button class="dialog-final" onClick={() => setValue(key, [...steps().map((x) => ({ ...x })), newStep('line')])}>Add straight</button>
        <button class="dialog-final" onClick={() => setValue(key, [...steps().map((x) => ({ ...x })), newStep('bend')])}>Add bend</button>
      </div>
      <Show when={props.field.hint}><p class="field-hint">{props.field.hint}</p></Show>
    </div>
  );
}

function FieldList(props: { fields: FieldDef[]; off?: boolean }) {
  return (
    <For each={props.fields}>
      {(f) => (
        <Show when={!f.when || f.when(values)}>
          <Switch>
            <Match when={f.kind === 'expr'}><ExprField field={f} off={props.off} /></Match>
            <Match when={f.kind === 'segment'}><Segment field={f} /></Match>
            <Match when={f.kind === 'select'}><SelectField field={f} off={props.off} /></Match>
            <Match when={f.kind === 'tabs'}><Tabs field={f} /></Match>
            <Match when={f.kind === 'check'}><CheckField field={f} off={props.off} /></Match>
            <Match when={f.kind === 'group'}><GroupField field={f} off={props.off} /></Match>
            <Match when={f.kind === 'sketch'}><SketchField field={f} /></Match>
            <Match when={['edges', 'faces', 'face', 'part', 'parts', 'vertex'].includes(f.kind)}><PickField field={f} /></Match>
            <Match when={f.kind === 'regions'}><RegionField field={f} /></Match>
            <Match when={f.kind === 'sections'}><SectionsField field={f} /></Match>
            <Match when={f.kind === 'axis'}><AxisField field={f} /></Match>
            <Match when={f.kind === 'steps'}><StepsField field={f} /></Match>
          </Switch>
        </Show>
      )}
    </For>
  );
}

const OPACITY_KEY = 'schmishape.preview-opacity';
function loadOpacity() {
  try {
    const v = Number(localStorage.getItem(OPACITY_KEY) ?? '');
    return localStorage.getItem(OPACITY_KEY) !== null && v >= 0 && v <= 1 ? v : 0.35;
  } catch {
    return 0.35;
  }
}
/** How solid an extrude's see-through preview is, from the model before it (0) to the model after it (1), as in Onshape. */
const [previewOpacity, setPreviewOpacity] = createSignal(loadOpacity());

function PreviewSlider() {
  return (
    <input
      class="preview-slider"
      type="range"
      min="0"
      max="1"
      step="0.05"
      value={previewOpacity()}
      aria-label="Preview opacity"
      data-tip="Preview: from before this feature to after it"
      data-testid="preview-slider"
      onInput={(e) => {
        const v = Number(e.currentTarget.value);
        setPreviewOpacity(v);
        try { localStorage.setItem(OPACITY_KEY, String(v)); } catch { /* It only costs remembering this for next time. */ }
      }}
    />
  );
}

export function FeatureDialog() {
  const accepts = () => (editingId() !== null ? 'Save' : `Add ${activeDef()?.title.toLowerCase()}`);
  // Added material is what's see-through. A cut stays solid, and Final shows the finished model.
  const seeThrough = () => takesRegions() && !showingFinal() && values.body !== 'surface' && (values.mode === 'add' || values.mode === 'new_body');
  createEffect(() => {
    activeDef();
    const r = view.renderer;
    if (!r) return;
    r.previewOpacity = previewOpacity();
    r.invalidate();
  });
  return (
    <Show when={activeDef()}>
      {(d) => (
        <DialogFrame
          label={d().title}
          testid="dialog"
          title={dialogName()}
          actions={
            <>
              <Show when={dialogBusy()}><span class="spinner" aria-label="Rebuilding" /></Show>
              <button class="dialog-action ok" disabled={!!dialogError() || !!dialogMissing()} aria-label={accepts()} data-tip={dialogMissing() ?? accepts()} data-keys="Enter" onClick={() => void acceptDialog()} data-testid="dialog-ok"><Icon name="check" /></button>
              <button class="dialog-action" aria-label="Cancel" data-tip="Cancel" data-keys="Esc" onClick={() => void cancelDialog()}><Icon name="close" /></button>
            </>
          }
          below={<Show when={dialogError()}><p class="dialog-error" role="alert" data-testid="dialog-error">{dialogError()}</p></Show>}
          footer={
            seeThrough() || hasLaterFeatures() ? (
              <>
                <Show when={seeThrough()}><PreviewSlider /></Show>
                <Show when={hasLaterFeatures()}><button class="dialog-final" classList={{ on: showingFinal() }} aria-pressed={showingFinal()} data-tip="Show the finished model while editing" onClick={() => void toggleFinal()} data-testid="dialog-final">Final</button></Show>
              </>
            ) : undefined
          }
        >
          <FieldList fields={d().fields} />
        </DialogFrame>
      )}
    </Show>
  );
}
