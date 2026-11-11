# schmishape

A parametric CAD app that runs in the browser, built on the [CoreShape](../core_shape) kernel. The
kernel runs locally as WebAssembly, so modelling needs no server and works offline.

```sh
pnpm install
pnpm dev          # builds the engine, then serves http://localhost:5183
pnpm build        # type-checks and builds a static site into dist/
pnpm smoke <url> <folder>   # drives the app in headless Chrome, saving screenshots to the folder
pnpm smoke:regions <url> <folder>   # the same, for extruding a sketch's regions
pnpm smoke:tabs <url> <folder>      # the same, for tabs and folders
node scripts/smoke-dialog.mjs <url> <folder>     # the same, for the feature dialogs
node scripts/smoke-rollback.mjs <url> <folder>   # the same, for going back to an earlier feature
node scripts/smoke-assembly.mjs <url> <folder>   # the same, for assemblies and mates
node scripts/test-assembly-solver.mjs            # the mate solver alone, with exact answers
```

It needs Rust with the `wasm32-unknown-unknown` target, Node and pnpm, and `core_shape` next to this folder.

Open it in a real browser. An editor's built-in preview may have no WebGL: VS Code's does not on a snap install with NVIDIA, which reports `webgl: disabled_off` under `code --status`. The app says so in the viewport.

## What it does

- **Sketches:** lines, rectangles, circles, arcs and points on a plane or a flat face. Snapping infers
  constraints as you draw. Dragging, dimensions and every constraint go through the kernel's solver, and
  the toolbar shows how much freedom is left.
- **Sketch tools:** line, corner and center rectangle, center and 3-point circle, 3-point, center and tangent arc, spline, point, trim, corner rounding, and dotted construction lines (Q). Lines snap to right angles, tangents, midpoints and alignments, with a small icon for each. M or the magnet turns that off, and holding Shift ignores it for a moment.
- **Sketch regions, as in Onshape:** every closed area a sketch's curves make is shaded and can be extruded by itself, including the pieces where shapes cross, and a circle inside a rectangle gives you the ring and the disc separately. Click regions in the view, or a sketch in the list for all of it. All of a sketch keeps a loop in a loop as a hole, unlike Onshape, which fills it unless you drop the inner region. A sketch stays on show until every region has been used, so one sketch can make several extrudes at different lengths. While you pick regions, an added extrude's preview is see-through over the model before it, as in Onshape, so every shape stays in sight and can be clicked from any angle. A cut stays solid, because the hole is what you need to see, and Final shows the finished model.
- **Features:** extrude, revolve, sweep, loft, helix, fillet (with a variable radius), chamfer, shell, draft, offset, thicken, delete face, copy faces, mirror, linear and circular patterns, transform (move or copy parts), boolean, and delete part, each with a live preview. Refusals appear in the
  dialog with the kernel's reason. A file or an AI can still add box, cylinder, cone, sphere and torus features,
  and they can be edited, but there are no tools for them.
- **Extrude, as in Onshape:** it takes a part's flat faces as well as sketch regions, in the same box: click the top of a block to build up from it, or flip it with Remove to cut down into it. Selecting a flat face first, or right-clicking one, starts an extrude of it. Ends are Blind, Up to next, Up to face, Up to part, Up to vertex and Through all, with the flip beside them. One extrude can take regions from several sketches. Choosing an end that needs a pick hands the clicks to its box, and clicking any box takes them back: only the box with the lit edge takes clicks, as in Onshape.
- **Revolve, as in Onshape:** it takes sketch regions, from one sketch or several in the same plane, and turns them about any line of the sketch, construction or not, or the sketch's own axes. With its regions already picked, the axis box takes the clicks next. The revolve follows that line when the sketch changes.
- **Loft profiles, as in Onshape:** click regions in the view, or sketches in the list, in the order the loft passes through them. One region of a sketch with several outlines can be a profile.
- **Surfaces:** Solid or Surface on extrude, revolve, sweep, loft and helix, and Fill (a flat surface in each closed area of a sketch), Copy faces, Sew (closed up, surfaces become a solid) and Trim surface (by a part, a plane or a sketch). The Parts list shows surfaces under their own heading.
- **Sidebar, as in Onshape:** Default geometry (origin and planes, each with a show or hide eye), Features with a filter, and Parts and Surfaces, one row per body as the kernel counts them. Right-click a part to rename it (or double-click it), edit its appearance, hide it or delete it. Names and colors are kept in the document's `app` data, by the kernel's name for the part, so they save with the file and an AI can read them. Right-click a feature to edit, rename, turn off, delete or roll to it. New features go in at the rollback bar.
- **Going back, as in Onshape:** double-click a feature or a sketch to edit it, and the model shows how it stood at that step, with everything after it gone and the camera left alone. A single click only selects. Finishing or cancelling puts the rollback bar back where it was. Final, in the dialog, shows the finished model while you edit. Right-click a row for Roll to here, or the bar for Roll to end. Drag the bar, or click it and use ↑ and ↓ to step through.
- **Assemblies:** insert parts from any Part Studio (`I`), then drag them or use the triad. Click a part for the triad, and drag a part to move it freely. Mates (`M`, or the toolbar) offer connectors on hover, as in Onshape: flat faces at the centroid, vertices, edge midpoints and arc centers; round faces along the axis; edges at their middle and ends. Hold Shift to stay on a face or edge. The first part picked moves to the second. Fastened, Revolute, Slider, Planar, Cylindrical, Pin slot, Ball and Parallel are in, with flip and reorient, and the toolbar shows the freedoms left. A mate that can't hold says which one it conflicts with. Assemblies autosave with their tab and have their own undo, and instances follow their Part Studio when you come back.
- **Feature dialogs, as in Onshape:** drag the header to move one and its edges to resize it, and it stays where you put it. Double-click the header to put it back. Solid and Surface are the tabs along the top, New, Add, Remove and Intersect sit under them, and what you've picked is listed in a tinted box with a × on each row. Extrude has End type with a flip button, Depth, Symmetric, Starting offset and Second end position, all taking expressions. The slider by Final sets how solid its preview is, from the model before it to the model after it.
- **Variables:** any dimension takes an expression, like `width / 2`.
- **Tabs, as in Onshape:** Part Studios, Assemblies and folders along the bottom, with + to create them. A new document starts with one Part Studio and one Assembly. Each Part Studio is its own model, with its own undo, view and autosave. Drag a tab to reorder it, or onto a folder to move it in. Clicking a folder shows just its tabs. Right-click for rename, duplicate, delete, moving and unpacking. The icon beside + opens the tab manager, a searchable tree of everything.
- **Files:** autosave, `.coreshape` open and save, STEP import and export, STL export. A file holds one Part Studio and opens as a tab of its own. The tab structure lives in the browser, and there's no file for a whole document yet.
- **Keys:** `?` lists them all and `Ctrl K` searches every command. Right-click any plane or surface for New sketch. On a curved surface the sketch goes on the plane touching it under the cursor.
- **Mouse, as in Onshape:** right drag rotates, freely, around the point on the model under the cursor, or the model's center from empty space. Alt with right drag keeps Z upright. Middle drag or Ctrl with right drag pans, and scroll zooms. The left button selects: click, Shift to add, or drag a box.
- **Links to parts while sketching, as in Onshape:** with the select tool, a part's corners and edges can be hovered and selected where they can be seen. Coincident (or any constraint) between a sketch point and a part's corner or edge brings that corner or edge into the sketch as linked geometry, drawn in violet, and the point follows it when the part changes. Drawing onto a part's corner snaps to it and ties there too. Use (U) brings selected edges in as curves of the sketch, still following the part, as Onshape's Use does. Linked geometry is fixed: it can't be dragged.
- **Constraint tools, as in Onshape:** every constraint button can always be clicked. With what it needs already selected, it's added at once. Otherwise the button stays pressed and takes clicks, adding the constraint as soon as the picks fit and staying on for the next pair, until Esc or another tool. The status bar says what each one takes, and picks that can't fit say why.
- **Sketch mode** only changes the toolbar. The camera and planes stay as they were, and opening an existing sketch rolls the model back to that step. The left button draws, and right-click has Normal to sketch plane. Esc steps back through the drawing, the tool and the selection, then keeps the sketch and leaves.
- **Dimensions:** click something and the dimension appears with its current value, following the cursor. Where you pull it decides horizontal, vertical or aligned, and a second click on something measures between the two. Press, pull and release works too. Drag a placed dimension to move it, and double-click it to change it. Only sizes count: 90 on something at -90 keeps it where it is. Where labels sit is kept in the browser, not in the `.coreshape` file, whose reader refuses fields it doesn't know. The view cube's faces, edges and corners are all clickable, its arrows turn the view 15° or 90° with Shift, and dragging it rotates.

## How it fits together

```
Sidebar, sketcher, viewport ─┐
(next) built-in AI panel    ─┼─► CoreShape's MCP tool layer ─► kernel
(next) Claude Code bridge   ─┘   compiled to WebAssembly, in a Web Worker
```

The UI models only through the same tools an AI uses, so anything you can do, an AI can do too, and its
work lands in the same history. `window.schmishape.engine.call(tool, args)` is that API, from the console.

| Path | Contents |
|---|---|
| `engine/` | The Rust glue: the tool layer, plus what a screen needs and a tool shouldn't return as JSON, which is display meshes, with each body's faces and edges, STL bytes and parameter values. It meshes the kernel's own rebuild, so nothing is built twice |
| `src/engine/` | The worker and its client. Restores the document if the kernel crashes or is stopped |
| `src/store/doc.ts` | The document as the UI sees it: every change, undo, rollback and autosave |
| `src/assembly/` | The mate solver (`solver.ts`, plain math, tested alone by `scripts/test-assembly-solver.mjs`), connectors, and a store. A second kernel worker reads each Part Studio's parts, so the main document isn't disturbed, and instances are baked into one mesh. This all lives in the app and isn't reachable through the tool layer yet. The kernel gained its own `coreshape-assembly` crate and tools while this was being built, and this doesn't use them |
| `src/store/tabs.ts` | The tabs and folders. The kernel holds one document at a time, so switching tabs puts one away and opens the other |
| `src/features/` | Each feature's fields and JSON, and the dialog with its live preview |
| `src/sketch/` | The sketch session, its tools and snapping, the overlay that draws it, and each sketch's regions |
| `src/viewport/` | Camera and the hand-written WebGL2 renderer, with GPU picking |
| `src/ui/DialogFrame.tsx` | The movable, resizable window around every dialog |
| `src/ui/` | The interface. `src/commands.ts` is the list behind the toolbar, palette and shortcuts |

## Design

A dense, serious tool: icon-only toolbars with fast tooltips, a text menu bar, and Inter at 12px. Icons are drawn
like technical drawings, with one-pixel lines and what the tool acts on in amber. Light grey chrome around a
near-white viewport, with faint planes and a clear part view as in Onshape. Amber is the one highlight colour.

## Workarounds to remove

These exist so that `core_shape` stays untouched. Each one wants a small change there.

- **A revolve's axis is kept as numbers.** The kernel takes an axis as a point and a direction, so a revolve about a sketch line remembers which line in its `app` data, and the app rewrites the axis whenever that line moves. An axis that names the line would follow it by itself, for an AI too.

Older documents made hidden copies of sketches, named `~axis:<id>` for a revolve and `~regions:<id> <n>` for an extrude of some regions, from before the kernel's revolve took an axis and its extrude took regions. Opening one turns them into plain features, with the same shape and face names.

## Known gaps

- **Sketches on a face don't follow it.** The plane is copied when the sketch starts, so moving that face later doesn't move the sketch.
- **No AI panel yet,** and no bridge for Claude Code, though the tool API it would use is in place.
- **Not built yet in assemblies:** placing by clicking in the view, subassemblies, groups, Tangent and Width mates, offsets, limits, relations, explicit mate connectors, Snap mode, and exporting or saving an assembly to a file.
- **Not built yet:** Thin, on extrude. A sweep's path is a list of straight runs and bends, which is what the kernel takes, rather than edges picked in the view. Transform between two places (`frames`) and fillets with several sets of radii have no dialog.
- **Part colors and names are for Part Studios.** Assemblies still show every part in grey, under its default name.
- **Plain `sketch` features,** which only an AI or a file can make, show in the history but can't be edited or drawn in the view.
- **Checked in Chrome only,** with software rendering and on an NVIDIA RTX 3060. It hasn't run in Firefox or Safari, or been installed as an app.
