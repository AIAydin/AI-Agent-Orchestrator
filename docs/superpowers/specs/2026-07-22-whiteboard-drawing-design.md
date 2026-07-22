# Whiteboard drawing — design

Date: 2026-07-22
Status: Approved (brainstorm), pending implementation plan

## Goal

The Whiteboard node becomes an actual drawing surface: pick a tool, drag on the canvas to create a shape sized and positioned where you dragged, draw freehand with a pen, and move or resize what is already there. Text is typed directly on the canvas where you click it.

## Problem today

The whiteboard face renders an **inert** SVG with no pointer handling at all:

- `WhiteboardPreview.tsx` puts no handler on the `<svg>` itself. The only interaction is `onClick` on an _already existing_ element, to select it. Clicking or dragging empty canvas is a no-op by construction.
- `grep -rn "onPointer|onMouseDown|onDrag|draggable"` across the whiteboard directory returns **zero matches**.
- Shapes can only be created from the "Tools" popover, and land at a fixed staircase position — `x = 24 + (index % 8) * 22`, `y = 24 + (index % 6) * 22` (`model.ts:88`).
- They are then repositioned and resized by _typing numbers_ into x/y/width/height fields in the face's Tools popover (`WhiteboardNodeFace.tsx`, the `whiteboard-face-number-grid` block).

This matches the original intent — `IMPLEMENTATION_CHECKLIST.md:1489` describes "UI-only rectangle, ellipse, diamond, arrow, and text-annotation editing… rendered solely with Forgeboard-owned inert React SVG primitives" — so this is an unimplemented capability, not a regression.

## Decisions made during brainstorming

- **Scope:** drag-to-create shapes, move, corner-handle resize, **and** a freehand pen (a new `freedraw` element type).
- **Tool selector:** a persistent tool strip in the existing header row, replacing the "Tools" popover. A popover cannot host modal tools — it would have to be reopened for every stroke.
- **Text:** click empty canvas with the text tool to drop a caret and type in place; double-click an existing text to re-edit it. New text elements still register in `annotationIds`, so agent context is unchanged.
- **Stay Forgeboard-owned:** no third-party drawing library. The document stays bounded, sanitized, Excalidraw-compatible JSON rendered by our own SVG primitives.
- **No pan/zoom inside the node.** The viewBox stays a fixed 960×640 scaled to fit.

## Constraint: structure gate

`scripts/structure/check.mjs` enforces `MAX_FILES_PER_DIRECTORY = 12` (counting every hand-written file, not just code) and `MAX_LINES = 2_000`. The whiteboard directory holds 6 files today and gains 2 test files, so the new interactive layer goes in a `whiteboard/drawing/` subdirectory (11 files) rather than alongside the existing modules.

## Baseline: what `main` actually has

The right sidebar was deleted on `main` in `694b0c3`, taking `WhiteboardMockupInspector.tsx` with it. Everything it owned now lives in the face's Tools popover: the shape buttons, the annotation field, the per-element numeric editor, stroke/fill colours, the agent-context picker, and SVG export. The face reads `session.nodeRoster` and calls `session.attachWhiteboardContext`.

The popover therefore **survives as the properties-and-actions popover**. It loses only the two things the new interaction model replaces: the four create-shape buttons (the header tool strip creates now) and the annotation text field (inline text creates now). The numeric editor, colours, agent context, and export stay exactly as they are — they remain the precise way to nudge an element.

## Architecture

### 1. Data model (`model.ts`, extended in place)

- `WhiteboardElementType` gains `'freedraw'`.
- `points` widens from the fixed 2-tuple `readonly [[number, number], [number, number]]` to `readonly (readonly [number, number])[]`. Arrow keeps exactly two points (`[0,0]` and `[width, height]`), so its semantics do not change.
- A `freedraw` element stores `x,y` = stroke bounding-box origin, `width,height` = bounding-box size, `points` = coordinates **relative to that origin**, `backgroundColor: 'transparent'`.
- Bounds: `MAX_POINTS_PER_STROKE = 512`; non-finite coordinates are dropped; each coordinate clamps to the existing ±4,000 range; a `freedraw` with fewer than 2 valid points is rejected by `parseElement`.
- `updateWhiteboardElement` gains proportional point scaling, so resizing a stroke scales its path with the box.

### 2. Pure geometry (`drawing/geometry.ts`)

Every coordinate concern lives here as pure functions so it unit-tests without a DOM:

```ts
// Pointer position -> viewBox coordinates. Accounts for the default
// preserveAspectRatio="xMidYMid meet" letterboxing; clamps into 0..960 / 0..640.
export function viewBoxPoint(rect: Rect, clientX: number, clientY: number): Point;

// Normalized box, so dragging up/left works. Minimum size 4.
export function dragBounds(start: Point, current: Point): Bounds;

// Topmost hit — reverse iteration, so the last drawn element wins.
export function hitTest(elements: readonly WhiteboardElement[], point: Point): string | null;

export function resizeBounds(element: WhiteboardElement, handle: Handle, point: Point): Bounds;

// Distance-thresholded sampling (skip within ~2 units of the previous point),
// hard-capped at MAX_POINTS_PER_STROKE.
export function appendStrokePoint(points: readonly Point[], point: Point): readonly Point[];

// The "M x y L …" path data, shared by the React renderer and the export string
// builder so preview and export cannot drift.
export function strokePath(element: WhiteboardElement): string;
```

`viewBoxPoint` deliberately does **not** use `getScreenCTM()`: jsdom does not implement it, and `getBoundingClientRect()` is already scaled by the React Flow zoom transform, so zoom cancels out on its own.

### 3. Gesture state machine (`drawing/useWhiteboardDrawing.ts`)

Holds `tool` (`'select' | 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text' | 'freedraw'`), `selectedId`, `draft` (the in-progress create/move/resize), and `editingTextId`.

- **pointerdown** — capture the pointer, call `session.recordHistory()` exactly once.
- **pointermove** — update **local draft state only**.
- **pointerup** — commit with a single `session.updateNodeData` call.

Keeping the graph untouched mid-drag is what prevents a 500-point stroke from triggering 500 whole-graph re-renders and 500 undo entries.

`readOnly` (`session.graphReadOnly || data.locked || interactions.readOnly`) short-circuits every mutating branch. Escape cancels an in-flight gesture; Delete/Backspace removes the selection while the surface has focus.

### 4. Surfaces (`drawing/`)

- **`WhiteboardShape.tsx`** — the single element→SVG renderer, gaining a `freedraw` branch. One renderer, so nothing can drift.
- **`WhiteboardCanvas.tsx`** — the interactive `<svg>`: committed elements, the live draft, the selection outline, and four corner handles. Keeps the existing `nodrag`/`nowheel` classes and adds `touch-action: none`, so React Flow cannot pan, zoom, or drag the node out from under a stroke. Read-only nodes render through the same component with interaction disabled.
- **`WhiteboardToolStrip.tsx`** — added to the header row: element count, then select / rectangle / ellipse / diamond / arrow / text / pen, with `aria-pressed` marking the active tool and every control disabled when read-only. The existing Tools button stays beside it, now opening the properties-and-actions popover.
- **`WhiteboardTextEditor.tsx`** — inline text as an HTML `<input>` absolutely positioned over the SVG, placed by inverting `viewBoxPoint`. Not `<foreignObject>`, which is absent from the export allowlist. Enter or blur commits and registers the id in `annotationIds`; Escape or an empty value discards without creating an element. Double-clicking an existing text re-opens it for editing and does not re-register its id.

`WhiteboardPreview.tsx` is **deleted** — `WhiteboardCanvas` supersedes it and it has no other consumer now that the inspector is gone.

### 5. Drawable-area fix

Today the white area is a CSS `background` on the `<svg>` element, so it also paints the letterbox margins — the white region is _larger_ than the drawable 3:2 region, which would make edge clicks feel dead once clicks matter. The background becomes a `<rect>` inside the viewBox, so the white area is exactly the drawable area. This matches what `svg.ts` already emits for export.

### 6. Export and agent context

- `svg.ts` gains a `freedraw` branch emitting `<path d="…" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`. `path`, `d`, `stroke-linecap`, and `stroke-linejoin` are **already** allowlisted in `main/diagram/svg-policy.ts`, so main-process revalidation passes without policy changes.
- `main/workflow/context/whiteboard-source.ts` adds `'freedraw'` to `ELEMENT_TYPES`, widens `points` on `SafeWhiteboardElement`, caps points per stroke, and counts dropped points so the disclosed snapshot stays honest about what was truncated.

## Data flow

Pointer event → `viewBoxPoint` → gesture hook draft (local state, no graph write) → pointerup → `createWhiteboardElement` / `updateWhiteboardElement` → `session.updateNodeData({ excalidraw, annotationIds })` → persisted node data → `parseWhiteboardDocument` on read → `WhiteboardCanvas` renders, `whiteboardSvg` exports, `safeWhiteboardDocument` normalizes for agent context.

## Error handling

- Pointer coordinates outside the drawable region clamp into the viewBox rather than creating off-canvas elements.
- A degenerate gesture (drag under the 4-unit minimum, stroke under 2 points) commits nothing and leaves no history entry beyond the one already recorded.
- A pointer lost mid-gesture (`pointercancel`, capture loss) discards the draft.
- The new per-stroke point cap is enforced on write (during sampling) _and_ re-enforced on parse, so hand-edited or corrupt persisted JSON cannot exceed it. The existing `MAX_ELEMENTS = 2_000` document cap keeps being enforced on parse.
- Read-only nodes accept selection but reject every mutation.

## Testing

- **Geometry unit:** pointer mapping under letterboxing and under zoom; drag normalization for all four directions; minimum size; hit-test topmost-wins; resize from each corner; sampling distance threshold and hard cap; `strokePath` output.
- **Model:** `freedraw` parse bounds — point cap, non-finite points dropped, under-2-point strokes rejected, coordinate clamping; arrow still parses to exactly two points; proportional point scaling on resize.
- **Export:** `svg.ts` emits the expected path and escapes attributes; a regression test asserts a document containing a freehand stroke passes `assertSafeDiagramSvg`.
- **Agent context:** `safeWhiteboardDocument` normalizes `freedraw`, truncates points, and reports the counts.
- **Face:** drag creates a shape at the drag bounds; the pen creates a `freedraw`; select-and-drag moves; a corner handle resizes; inline text commits on Enter and discards on Escape; double-click re-edits; every gesture is inert when read-only; `recordHistory` fires once per gesture and `updateNodeData` once per commit.

## Out of scope

- Pan and zoom inside the node.
- Rotation, multi-select, grouping, z-order controls.
- Images or embedded files on the whiteboard.
- Changes to the popover's numeric x/y/width/height editor, colour pickers, agent-context picker, or SVG export — they stay as they are.
