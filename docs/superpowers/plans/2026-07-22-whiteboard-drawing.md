# Whiteboard Drawing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Whiteboard node an actual drawing surface — drag to create shapes, draw freehand, move and resize elements, and type text in place.

**Architecture:** All coordinate maths lives in a pure `drawing/geometry.ts` so it unit-tests without a DOM. A `useWhiteboardDrawing` hook owns the pointer state machine and keeps in-progress gestures in local React state, committing to the graph exactly once on pointer-up. `WhiteboardCanvas` renders committed elements plus the live draft through a single shared `WhiteboardShape` renderer, so preview and SVG export can never drift.

**Tech Stack:** React 19, TypeScript (strict), Vitest + @testing-library/react, jsdom. No new dependencies.

Spec: `docs/superpowers/specs/2026-07-22-whiteboard-drawing-design.md`

## Global Constraints

- **No new dependencies.** The whiteboard stays Artemis-owned inert SVG.
- **Structure gate** (`scripts/structure/check.mjs`): max 12 hand-written files per directory, max 2,000 lines per file. `content/whiteboard/` ends at 7 files, `content/whiteboard/drawing/` at 11.
- **Run `check:structure` from the checkout being verified.** The gate supports both primary checkouts and worktrees.
- **Zero-warning lint:** `corepack pnpm lint` runs with `--max-warnings=0`. No unused exports, no dead code.
- **Viewbox is fixed at 960 × 640.** Declared once as `VIEW_BOX_WIDTH` / `VIEW_BOX_HEIGHT` in `model.ts`; `svg.ts`'s local `WIDTH`/`HEIGHT` constants are replaced by imports of these.
- **Bounds, copied verbatim from the existing model:** coordinates clamp to ±4,000; width/height clamp to 1..4,000; `strokeWidth` 1..8; `opacity` 0..100; `fontSize` 8..96; text 20,000 chars; `MAX_ELEMENTS = 2_000`. New: `MAX_POINTS_PER_STROKE = 512`, `MIN_ELEMENT_SIZE = 4`.
- **Test command:** `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit <path>`
- **Typecheck:** `corepack pnpm --dir apps/desktop typecheck`. The harness LSP cannot resolve this worktree's cloned `node_modules` — trust `tsc`, ignore LSP module-not-found diagnostics.

## File Structure

`apps/desktop/src/renderer/src/components/workspace/content/whiteboard/` (6 files today → 7):

| File                          | Responsibility                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `model.ts`                    | **Modify.** Element types, parsing, bounds, factories, and the pure element→path helpers shared by renderer and exporter. |
| `model.test.ts`               | **Create.** Parsing bounds and factory behaviour.                                                                         |
| `svg.ts`                      | **Modify.** Export-string builder; gains `freedraw`, switches arrows to points.                                           |
| `svg.test.ts`                 | **Create.** Export output + allowlist regression.                                                                         |
| `WhiteboardNodeFace.tsx`      | **Modify.** Composition only — strip, canvas, popover, text editor.                                                       |
| `WhiteboardNodeFace.test.tsx` | **Modify.** Face-level behaviour.                                                                                         |
| `whiteboard.css`              | **Modify.** Tool strip + canvas styles.                                                                                   |
| `WhiteboardPreview.tsx`       | **Delete.** Superseded by `WhiteboardCanvas`; no other consumer since the inspector was removed in `694b0c3`.             |

`…/content/whiteboard/drawing/` (new, 11 files):

| File                           | Responsibility                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `geometry.ts`                  | Pure interaction maths: pointer→viewBox, drag normalisation, hit-test, resize, stroke sampling. |
| `geometry.test.ts`             | Unit tests for the above.                                                                       |
| `useWhiteboardDrawing.ts`      | Pointer state machine; local draft state, single commit per gesture.                            |
| `useWhiteboardDrawing.test.ts` | `renderHook` tests for the state machine.                                                       |
| `WhiteboardShape.tsx`          | The single element→SVG renderer.                                                                |
| `WhiteboardCanvas.tsx`         | Interactive `<svg>`: elements, draft, selection outline, resize handles.                        |
| `WhiteboardCanvas.test.tsx`    | Pointer-driven creation/move/resize tests.                                                      |
| `WhiteboardToolStrip.tsx`      | Header tool selector.                                                                           |
| `WhiteboardToolStrip.test.tsx` | Tool selection + read-only tests.                                                               |
| `WhiteboardTextEditor.tsx`     | Inline text input overlay.                                                                      |
| `drawing.css`                  | Canvas, handle, strip, and text-editor styles.                                                  |

Unchanged but touched: `apps/desktop/src/main/workflow/context/whiteboard-source.ts` (+ its existing test).

## Amendment to the spec: arrow direction

The spec did not cover this, and drag-to-draw forces it. Today an arrow renders from `(x, y)` to `(x + width, y + height)`, and `width`/`height` clamp to a minimum of 1 — so **an arrow can only ever point down-right**. Dragging up-left would silently produce a down-right arrow.

Fix: arrows render from their `points` array (`points[0]` → `points[1]`, relative to `x, y`) instead of from the bounding box corners. `x, y, width, height` become the normalised bounding box. Old documents are unaffected: an arrow persisted with `points: [[0,0],[w,h]]` renders exactly as before, and `parseElement` falls back to `[[0,0],[width,height]]` when stored points are missing or malformed.

---

### Task 1: Freedraw and directional arrows in the data model

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/workspace/content/whiteboard/model.ts`
- Test: `apps/desktop/src/renderer/src/components/workspace/content/whiteboard/model.test.ts` (create)

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces:

  ```ts
  export const VIEW_BOX_WIDTH = 960;
  export const VIEW_BOX_HEIGHT = 640;
  export const MIN_ELEMENT_SIZE = 4;
  export const MAX_POINTS_PER_STROKE = 512;

  export type WhiteboardElementType =
    | 'rectangle'
    | 'ellipse'
    | 'diamond'
    | 'arrow'
    | 'text'
    | 'freedraw';
  export type WhiteboardPoint = readonly [number, number];
  export interface WhiteboardBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  // WhiteboardElement.points widens to `readonly WhiteboardPoint[] | undefined`.

  export function boundsOfPoints(points: readonly WhiteboardPoint[]): WhiteboardBounds;
  export function createWhiteboardElement(
    type: 'rectangle' | 'ellipse' | 'diamond' | 'text',
    bounds: WhiteboardBounds,
    text?: string,
  ): WhiteboardElement;
  export function createArrowElement(
    start: WhiteboardPoint,
    end: WhiteboardPoint,
  ): WhiteboardElement;
  export function createFreedrawElement(
    points: readonly WhiteboardPoint[],
  ): WhiteboardElement | null;
  export function arrowEndpoints(element: WhiteboardElement): {
    readonly start: WhiteboardPoint;
    readonly end: WhiteboardPoint;
  };
  export function strokePath(element: WhiteboardElement): string;
  // updateWhiteboardElement keeps its signature; it now scales `points` proportionally.
  ```

- [ ] **Step 1: Write the failing tests**

Create `model.test.ts` covering:

```ts
import { describe, expect, it } from 'vitest';
import {
  arrowEndpoints,
  boundsOfPoints,
  createArrowElement,
  createFreedrawElement,
  createWhiteboardElement,
  parseWhiteboardDocument,
  strokePath,
  updateWhiteboardElement,
  MAX_POINTS_PER_STROKE,
  type WhiteboardPoint,
} from './model.js';

function documentWith(element: unknown) {
  return parseWhiteboardDocument({ elements: [element] });
}

describe('boundsOfPoints', () => {
  it('spans the extremes and enforces the minimum size', () => {
    expect(
      boundsOfPoints([
        [10, 20],
        [40, 20],
      ]),
    ).toEqual({ x: 10, y: 20, width: 30, height: 4 });
  });
});

describe('createArrowElement', () => {
  it('points up-left when dragged up-left', () => {
    const arrow = createArrowElement([100, 100], [50, 50]);
    expect(arrow).toMatchObject({ x: 50, y: 50, width: 50, height: 50 });
    expect(arrowEndpoints(arrow)).toEqual({ start: [100, 100], end: [50, 50] });
  });
});

describe('createFreedrawElement', () => {
  it('stores points relative to the bounding box origin', () => {
    const stroke = createFreedrawElement([
      [100, 100],
      [140, 180],
    ]);
    expect(stroke).toMatchObject({ type: 'freedraw', x: 100, y: 100, width: 40, height: 80 });
    expect(stroke?.points).toEqual([
      [0, 0],
      [40, 80],
    ]);
  });

  it('rejects a stroke with fewer than two points', () => {
    expect(createFreedrawElement([[10, 10]])).toBeNull();
  });
});

describe('strokePath', () => {
  it('emits absolute move/line commands', () => {
    const stroke = createFreedrawElement([
      [10, 10],
      [20, 30],
    ]);
    expect(strokePath(stroke!)).toBe('M10 10 L20 30');
  });
});

describe('parseWhiteboardDocument freedraw', () => {
  it('drops non-finite points and caps the count', () => {
    const points: unknown[] = [
      [0, 0],
      [1, Number.NaN],
      ['x', 2],
    ];
    for (let index = 0; index < 600; index += 1) points.push([index, index]);
    const parsed = documentWith({ id: 'f1', type: 'freedraw', points });
    expect(parsed.elements[0]?.points?.length).toBe(MAX_POINTS_PER_STROKE);
    expect(
      parsed.elements[0]?.points?.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    ).toBe(true);
  });

  it('rejects a freedraw element left with fewer than two valid points', () => {
    expect(
      documentWith({
        id: 'f2',
        type: 'freedraw',
        points: [
          [0, 0],
          [1, Number.NaN],
        ],
      }).elements,
    ).toEqual([]);
  });

  it('keeps a legacy arrow rendering identically when it has no stored points', () => {
    const parsed = documentWith({ id: 'a1', type: 'arrow', x: 5, y: 5, width: 100, height: 50 });
    expect(arrowEndpoints(parsed.elements[0]!)).toEqual({ start: [5, 5], end: [105, 55] });
  });
});

describe('updateWhiteboardElement', () => {
  it('scales stroke points with the box', () => {
    const stroke = createFreedrawElement([
      [0, 0],
      [50, 50],
    ])!;
    const next = updateWhiteboardElement(
      { ...parseWhiteboardDocument({}), elements: [stroke] },
      stroke.id,
      { width: 100, height: 25 },
    );
    expect(next.elements[0]?.points).toEqual([
      [0, 0],
      [100, 25],
    ]);
  });
});

describe('createWhiteboardElement', () => {
  it('creates a shape at the supplied bounds', () => {
    expect(
      createWhiteboardElement('rectangle', { x: 12, y: 34, width: 56, height: 78 }),
    ).toMatchObject({ type: 'rectangle', x: 12, y: 34, width: 56, height: 78 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace/content/whiteboard/model.test.ts`
Expected: FAIL — `boundsOfPoints is not a function` and the other new exports missing.

- [ ] **Step 3: Implement the model changes**

In `model.ts`:

1. Export `VIEW_BOX_WIDTH = 960`, `VIEW_BOX_HEIGHT = 640`, `MIN_ELEMENT_SIZE = 4`, `MAX_POINTS_PER_STROKE = 512`.
2. Add `'freedraw'` to `WhiteboardElementType` and to the array inside `isElementType`.
3. Add `WhiteboardPoint` and `WhiteboardBounds`; widen `WhiteboardElement.points` to `readonly WhiteboardPoint[]`.
4. Extract the shared base-element builder used by all three factories (it is the existing `base` object literal, parameterised by `type` and `bounds` instead of `index`). `backgroundColor` is `DEFAULT_FILL` for rectangle/ellipse/diamond and `'transparent'` for arrow/text/freedraw.
5. Replace the index/staircase `createWhiteboardElement` with the bounds-taking signature above; add `createArrowElement` and `createFreedrawElement` as specified in **Interfaces**.
6. Add `boundsOfPoints`, `arrowEndpoints`, and `strokePath`. `strokePath` formats each coordinate through the existing 2-decimal rounding.
7. Add a `parsePoints(value: unknown): WhiteboardPoint[]` helper: non-arrays → `[]`; slice to `MAX_POINTS_PER_STROKE`; drop entries that are not 2-element arrays of finite numbers; clamp each coordinate to ±4,000.
8. In `parseElement`, add a `freedraw` branch that returns `null` when `parsePoints` yields fewer than 2 points, and change the `arrow` branch to use stored points when at least 2 survive, falling back to `[[0, 0], [width, height]]`.
9. In `updateWhiteboardElement`, replace the arrow-only points reset with proportional scaling applied to both `arrow` and `freedraw`: multiply each stored point by `width / element.width` and `height / element.height`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command as Step 2.
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/model.ts \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/model.test.ts
git commit -m "feat(whiteboard): freedraw element type and directional arrows in the model"
```

---

### Task 2: Pure interaction geometry

**Files:**

- Create: `…/content/whiteboard/drawing/geometry.ts`
- Test: `…/content/whiteboard/drawing/geometry.test.ts`

**Interfaces:**

- Consumes: `WhiteboardPoint`, `WhiteboardBounds`, `WhiteboardElement`, `MIN_ELEMENT_SIZE`, `MAX_POINTS_PER_STROKE`, `VIEW_BOX_WIDTH`, `VIEW_BOX_HEIGHT` from `../model.js`.
- Produces:

  ```ts
  export type WhiteboardHandle = 'nw' | 'ne' | 'sw' | 'se';
  export interface WhiteboardRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  }
  export function viewBoxPoint(
    rect: WhiteboardRect,
    clientX: number,
    clientY: number,
  ): WhiteboardPoint;
  export function dragBounds(start: WhiteboardPoint, current: WhiteboardPoint): WhiteboardBounds;
  export function hitTest(
    elements: readonly WhiteboardElement[],
    point: WhiteboardPoint,
  ): string | null;
  export function resizeBounds(
    element: WhiteboardElement,
    handle: WhiteboardHandle,
    point: WhiteboardPoint,
  ): WhiteboardBounds;
  export function appendStrokePoint(
    points: readonly WhiteboardPoint[],
    point: WhiteboardPoint,
  ): readonly WhiteboardPoint[];
  export function handlePosition(
    bounds: WhiteboardBounds,
    handle: WhiteboardHandle,
  ): WhiteboardPoint;
  ```

- [ ] **Step 1: Write the failing tests**

Create `geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createWhiteboardElement } from '../model.js';
import { appendStrokePoint, dragBounds, hitTest, resizeBounds, viewBoxPoint } from './geometry.js';

// 960x640 viewBox rendered into a 480x320 box: uniform scale 0.5, no letterboxing.
const EXACT = { left: 0, top: 0, width: 480, height: 320 };
// A 480x480 box letterboxes vertically: scale 0.5, 80px bars top and bottom.
const TALL = { left: 0, top: 0, width: 480, height: 480 };

describe('viewBoxPoint', () => {
  it('maps a pointer position through a uniform scale', () => {
    expect(viewBoxPoint(EXACT, 240, 160)).toEqual([480, 320]);
  });

  it('subtracts the letterbox offset', () => {
    expect(viewBoxPoint(TALL, 240, 240)).toEqual([480, 320]);
  });

  it('clamps a pointer inside the letterbox bar to the drawable area', () => {
    expect(viewBoxPoint(TALL, 240, 10)).toEqual([480, 0]);
  });

  it('accounts for the element offset', () => {
    expect(viewBoxPoint({ ...EXACT, left: 100, top: 50 }, 340, 210)).toEqual([480, 320]);
  });
});

describe('dragBounds', () => {
  it('normalises a drag up and to the left', () => {
    expect(dragBounds([100, 100], [40, 60])).toEqual({ x: 40, y: 60, width: 60, height: 40 });
  });

  it('enforces the minimum size on a click without movement', () => {
    expect(dragBounds([10, 10], [10, 10])).toEqual({ x: 10, y: 10, width: 4, height: 4 });
  });
});

describe('hitTest', () => {
  const lower = createWhiteboardElement('rectangle', { x: 0, y: 0, width: 100, height: 100 });
  const upper = createWhiteboardElement('rectangle', { x: 50, y: 50, width: 100, height: 100 });

  it('returns the topmost element under the point', () => {
    expect(hitTest([lower, upper], [60, 60])).toBe(upper.id);
  });

  it('returns null when nothing is under the point', () => {
    expect(hitTest([lower, upper], [400, 400])).toBeNull();
  });

  it('ignores deleted elements', () => {
    expect(hitTest([{ ...lower, isDeleted: true }], [10, 10])).toBeNull();
  });
});

describe('resizeBounds', () => {
  const element = createWhiteboardElement('rectangle', { x: 100, y: 100, width: 100, height: 100 });

  it('anchors the opposite corner when dragging the north-west handle', () => {
    expect(resizeBounds(element, 'nw', [150, 150])).toEqual({
      x: 150,
      y: 150,
      width: 50,
      height: 50,
    });
  });

  it('anchors the top-left when dragging the south-east handle', () => {
    expect(resizeBounds(element, 'se', [400, 300])).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 200,
    });
  });
});

describe('appendStrokePoint', () => {
  it('skips a point within the sampling distance of the previous one', () => {
    expect(appendStrokePoint([[0, 0]], [1, 0])).toEqual([[0, 0]]);
  });

  it('appends a point beyond the sampling distance', () => {
    expect(appendStrokePoint([[0, 0]], [10, 0])).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('stops appending at the cap', () => {
    const full = Array.from({ length: 512 }, (_, index) => [index * 10, 0] as const);
    expect(appendStrokePoint(full, [99_999, 0])).toHaveLength(512);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/geometry.test.ts`
Expected: FAIL — cannot resolve `./geometry.js`.

- [ ] **Step 3: Implement `geometry.ts`**

```ts
import {
  MAX_POINTS_PER_STROKE,
  MIN_ELEMENT_SIZE,
  VIEW_BOX_HEIGHT,
  VIEW_BOX_WIDTH,
  type WhiteboardBounds,
  type WhiteboardElement,
  type WhiteboardPoint,
} from '../model.js';

export type WhiteboardHandle = 'nw' | 'ne' | 'sw' | 'se';
export interface WhiteboardRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const SAMPLE_DISTANCE = 2;
const HIT_TOLERANCE = 4;

export function viewBoxPoint(
  rect: WhiteboardRect,
  clientX: number,
  clientY: number,
): WhiteboardPoint {
  const scale = Math.min(rect.width / VIEW_BOX_WIDTH, rect.height / VIEW_BOX_HEIGHT);
  if (!Number.isFinite(scale) || scale <= 0) return [0, 0];
  const offsetX = (rect.width - VIEW_BOX_WIDTH * scale) / 2;
  const offsetY = (rect.height - VIEW_BOX_HEIGHT * scale) / 2;
  return [
    clamp((clientX - rect.left - offsetX) / scale, 0, VIEW_BOX_WIDTH),
    clamp((clientY - rect.top - offsetY) / scale, 0, VIEW_BOX_HEIGHT),
  ];
}
```

`dragBounds` takes the min corner and `Math.max(MIN_ELEMENT_SIZE, Math.abs(delta))` for each side. `resizeBounds` picks the anchor corner opposite the dragged handle and delegates to `dragBounds`. `handlePosition` returns the viewBox coordinate of a given handle on a bounds. `hitTest` walks the array backwards, skips `isDeleted`, and returns the first element whose bounding box — expanded by `HIT_TOLERANCE` on each side — contains the point. `appendStrokePoint` returns `points` unchanged at the cap or within `SAMPLE_DISTANCE` (via `Math.hypot`) of the last point, otherwise appends.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/geometry.ts \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/geometry.test.ts
git commit -m "feat(whiteboard): pure interaction geometry for the drawing surface"
```

---

### Task 3: Shared shape renderer and SVG export

**Files:**

- Create: `…/content/whiteboard/drawing/WhiteboardShape.tsx`
- Modify: `…/content/whiteboard/svg.ts`
- Test: `…/content/whiteboard/svg.test.ts` (create)

**Interfaces:**

- Consumes: `arrowEndpoints`, `strokePath`, `VIEW_BOX_WIDTH`, `VIEW_BOX_HEIGHT` from `../model.js` / `./model.js`.
- Produces:

  ```ts
  export function WhiteboardShape(props: {
    readonly element: WhiteboardElement;
    readonly selected: boolean;
    readonly onSelect?: (() => void) | undefined;
  }): JSX.Element;
  ```

  `whiteboardSvg` keeps its existing signature.

- [ ] **Step 1: Write the failing test**

Create `svg.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertSafeDiagramSvg } from '../../../../../../main/diagram/svg-policy.js';
import { createArrowElement, createFreedrawElement, parseWhiteboardDocument } from './model.js';
import { whiteboardSvg } from './svg.js';

function documentOf(...elements: unknown[]) {
  return parseWhiteboardDocument({ elements });
}

describe('whiteboardSvg', () => {
  it('emits a path for a freehand stroke', () => {
    const svg = whiteboardSvg(
      documentOf(
        createFreedrawElement([
          [10, 10],
          [40, 50],
        ]),
      ),
    );
    expect(svg).toContain('<path d="M10 10 L40 50"');
    expect(svg).toContain('fill="none"');
  });

  it('emits an arrow along its stored points, not the box diagonal', () => {
    const svg = whiteboardSvg(documentOf(createArrowElement([100, 100], [50, 50])));
    expect(svg).toContain('x1="100" y1="100" x2="50" y2="50"');
  });

  it('produces export-policy-safe SVG for a freehand stroke', () => {
    const svg = whiteboardSvg(
      documentOf(
        createFreedrawElement([
          [10, 10],
          [40, 50],
        ]),
      ),
    );
    expect(() => assertSafeDiagramSvg(svg)).not.toThrow();
  });

  it('escapes text content', () => {
    const svg = whiteboardSvg(documentOf({ id: 't1', type: 'text', text: '<script>&' }));
    expect(svg).toContain('&lt;script&gt;&amp;');
  });
});
```

Verify the relative import depth for `svg-policy.js` before running — from `…/renderer/src/components/workspace/content/whiteboard/` the main process is at `…/apps/desktop/src/main/`. Adjust the `../` count if `tsc` disagrees.

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace/content/whiteboard/svg.test.ts`
Expected: FAIL — no `<path>` in the output; the freedraw element falls through to the text branch.

- [ ] **Step 3: Implement**

In `svg.ts`: replace the local `WIDTH`/`HEIGHT` with imports of `VIEW_BOX_WIDTH`/`VIEW_BOX_HEIGHT`; add a `freedraw` branch emitting
`<path d="${strokePath(element)}" fill="none" stroke="…" stroke-width="…" stroke-linecap="round" stroke-linejoin="round" opacity="…"/>`;
change the `arrow` branch to derive `x1,y1,x2,y2` and the arrowhead angle from `arrowEndpoints(element)` rather than the box corners.

Create `WhiteboardShape.tsx` by moving `PreviewElement`, `ArrowElement`, and `diamondPoints` out of `WhiteboardPreview.tsx`, renaming the exported component to `WhiteboardShape`, making `onSelect` optional, adding a `freedraw` branch that renders `<path d={strokePath(element)} fill="none" strokeLinecap="round" strokeLinejoin="round" …/>`, and switching the arrow branch to `arrowEndpoints`.

- [ ] **Step 4: Run the test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/svg.ts \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/svg.test.ts \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/WhiteboardShape.tsx
git commit -m "feat(whiteboard): render and export freehand strokes and directional arrows"
```

---

### Task 4: Freehand in the agent-context snapshot

**Files:**

- Modify: `apps/desktop/src/main/workflow/context/whiteboard-source.ts`
- Test: the existing test file for that module (find it with `ls apps/desktop/src/main/workflow/context/`)

**Interfaces:**

- Consumes: nothing from earlier tasks — this module deliberately re-implements its own bounded parsing.
- Produces: `SafeWhiteboardElement.points` widens to `[number, number][]`; `SafeWhiteboardDocument` gains `truncatedPointCount: number`.

- [ ] **Step 1: Write the failing tests**

Add to the existing test file:

```ts
it('normalizes a freehand stroke', () => {
  const safe = safeWhiteboardDocument({
    elements: [
      {
        id: 'f1',
        type: 'freedraw',
        x: 0,
        y: 0,
        width: 40,
        height: 50,
        points: [
          [0, 0],
          [40, 50],
        ],
      },
    ],
  });
  expect(safe.elements[0]).toMatchObject({
    type: 'freedraw',
    points: [
      [0, 0],
      [40, 50],
    ],
  });
});

it('truncates an oversized stroke and reports the count', () => {
  const points = Array.from({ length: 600 }, (_, index) => [index, index]);
  const safe = safeWhiteboardDocument({ elements: [{ id: 'f2', type: 'freedraw', points }] });
  expect(safe.elements[0]?.points).toHaveLength(512);
  expect(safe.truncatedPointCount).toBe(88);
});

it('drops a freehand stroke left with fewer than two valid points', () => {
  const safe = safeWhiteboardDocument({
    elements: [{ id: 'f3', type: 'freedraw', points: [[0, 0]] }],
  });
  expect(safe.elements).toEqual([]);
  expect(safe.discardedElementCount).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run vitest against that test file. Expected: FAIL — `freedraw` is not in `ELEMENT_TYPES`, so the element is discarded and `truncatedPointCount` is undefined.

- [ ] **Step 3: Implement**

Add `'freedraw'` to `ELEMENT_TYPES`. Add `MAX_POINTS = 512`. Widen `SafeWhiteboardElement.points` to `[number, number][]`. Add a module-level-free counting approach: have `safeElement` return the element plus the number of points it dropped, and accumulate that into a new `truncatedPointCount` field on `SafeWhiteboardDocument`. Parse `freedraw` points with the same finite/clamp rules as the other numbers, return `null` when fewer than 2 survive, and keep arrays exactly as `[[x, y], …]`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS, including the file's pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/workflow/context/whiteboard-source.ts \
        apps/desktop/src/main/workflow/context/<the-test-file>
git commit -m "feat(whiteboard): include bounded freehand strokes in agent context"
```

---

### Task 5: Gesture state machine

**Files:**

- Create: `…/content/whiteboard/drawing/useWhiteboardDrawing.ts`
- Test: `…/content/whiteboard/drawing/useWhiteboardDrawing.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1 and 2.
- Produces:

  ```ts
  export type WhiteboardTool =
    | 'select'
    | 'rectangle'
    | 'ellipse'
    | 'diamond'
    | 'arrow'
    | 'text'
    | 'freedraw';

  export type WhiteboardDraft =
    | {
        readonly kind: 'shape';
        readonly tool: 'rectangle' | 'ellipse' | 'diamond';
        readonly start: WhiteboardPoint;
        readonly current: WhiteboardPoint;
      }
    | { readonly kind: 'arrow'; readonly start: WhiteboardPoint; readonly current: WhiteboardPoint }
    | { readonly kind: 'stroke'; readonly points: readonly WhiteboardPoint[] }
    | {
        readonly kind: 'move';
        readonly id: string;
        readonly start: WhiteboardPoint;
        readonly current: WhiteboardPoint;
      }
    | {
        readonly kind: 'resize';
        readonly id: string;
        readonly handle: WhiteboardHandle;
        readonly current: WhiteboardPoint;
      };

  export interface WhiteboardTextDraft {
    readonly id: string | null; // null = creating, non-null = editing an existing element
    readonly point: WhiteboardPoint; // top-left anchor in viewBox coords
    readonly value: string;
  }

  export interface WhiteboardDrawing {
    readonly tool: WhiteboardTool;
    readonly selectedId: string | null;
    readonly draft: WhiteboardDraft | null;
    readonly textDraft: WhiteboardTextDraft | null;
    readonly setTool: (tool: WhiteboardTool) => void;
    readonly select: (id: string | null) => void;
    readonly beginGesture: (point: WhiteboardPoint, handle?: WhiteboardHandle) => void;
    readonly extendGesture: (point: WhiteboardPoint) => void;
    readonly endGesture: () => void;
    readonly cancelGesture: () => void;
    readonly editText: (id: string) => void;
    readonly changeText: (value: string) => void;
    readonly commitText: () => void;
    readonly cancelText: () => void;
    readonly deleteSelected: () => void;
  }

  export function useWhiteboardDrawing(options: {
    readonly document: WhiteboardDocument;
    readonly annotationIds: readonly string[];
    readonly readOnly: boolean;
    readonly onRecordHistory: () => void;
    readonly onPersist: (
      document: WhiteboardDocument,
      annotationIds: readonly string[] | undefined,
    ) => void;
  }): WhiteboardDrawing;
  ```

**Behaviour contract:**

- `beginGesture` with `handle` present and a selection → `resize` draft. With the `select` tool and a hit → `move` draft; with the `select` tool and no hit → clears the selection, no draft. With a shape tool → `shape`/`arrow` draft. With `freedraw` → `stroke` draft seeded with the point. With `text` → opens a `textDraft` (no pointer draft).
- Every branch that will mutate calls `onRecordHistory()` exactly once, at `beginGesture`.
- `extendGesture` only updates local state.
- `endGesture` calls `onPersist` exactly once and clears the draft. A `stroke` that yields fewer than 2 sampled points, or a `move`/`resize` that produced no change, persists nothing.
- `cancelGesture` clears the draft without persisting.
- `readOnly` makes `beginGesture`, `deleteSelected`, and `commitText` no-ops.
- `commitText` on a null-id draft appends a text element and appends its id to `annotationIds`; on a non-null id it patches `text`/`originalText` and passes `undefined` for `annotationIds`. An empty/whitespace value persists nothing.

- [ ] **Step 1: Write the failing tests**

Create `useWhiteboardDrawing.test.ts` using `renderHook` and `act` from `@testing-library/react` (see `…/workspace/useProjectChecks.test.tsx` for the established pattern). Cover, one `it` each:

1. `beginGesture` + `extendGesture` + `endGesture` with the `rectangle` tool persists one rectangle at the dragged bounds, and calls `onRecordHistory` once and `onPersist` once.
2. The `arrow` tool dragged up-left persists an arrow whose `arrowEndpoints` match the drag direction.
3. The `freedraw` tool persists one `freedraw` element whose point count matches the sampled points.
4. A `freedraw` gesture with a single point persists nothing.
5. `select` tool: `beginGesture` on an existing element then a drag moves it by the delta.
6. `beginGesture` with handle `'se'` resizes the selected element.
7. `cancelGesture` mid-drag leaves `onPersist` uncalled and `draft` null.
8. `readOnly: true` makes a full gesture persist nothing.
9. `commitText` with a value appends a text element and appends its id to the passed `annotationIds`.
10. `commitText` with `'   '` persists nothing.
11. `editText` on an existing text element then `commitText` patches it and passes `undefined` for `annotationIds`.
12. `deleteSelected` marks the element `isDeleted` and removes its id from `annotationIds`.

- [ ] **Step 2: Run the tests to verify they fail**

Run vitest against the new file. Expected: FAIL — cannot resolve `./useWhiteboardDrawing.js`.

- [ ] **Step 3: Implement the hook**

Implement to the contract above using `useState` for `tool`, `selectedId`, `draft`, `textDraft`, and `useCallback` for each action. Commit helpers build the next `WhiteboardDocument` with the Task 1 factories and `updateWhiteboardElement`, then call `onPersist` once. Keep the file focused — no rendering concerns.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/useWhiteboardDrawing.ts \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/useWhiteboardDrawing.test.ts
git commit -m "feat(whiteboard): pointer gesture state machine with single-commit drags"
```

---

### Task 6: Interactive canvas

**Files:**

- Create: `…/content/whiteboard/drawing/WhiteboardCanvas.tsx`, `…/drawing/drawing.css`
- Test: `…/content/whiteboard/drawing/WhiteboardCanvas.test.tsx`

**Interfaces:**

- Consumes: `WhiteboardDrawing` (Task 5), `WhiteboardShape` (Task 3), `viewBoxPoint`/`handlePosition` (Task 2).
- Produces:
  ```ts
  export function WhiteboardCanvas(props: {
    readonly document: WhiteboardDocument;
    readonly drawing: WhiteboardDrawing;
    readonly readOnly: boolean;
    readonly className?: string | undefined;
  }): JSX.Element;
  ```

**Behaviour contract:**

- Renders `<svg viewBox="0 0 960 640" aria-label="Whiteboard canvas" role="application">` with the background as an in-viewBox `<rect>`, **not** a CSS background, so the white area equals the drawable area.
- `onPointerDown` calls `setPointerCapture`, maps the event through `viewBoxPoint(target.getBoundingClientRect(), …)`, and calls `drawing.beginGesture`. `onPointerMove` → `extendGesture` (only while a draft exists). `onPointerUp` → `endGesture`. `onPointerCancel` / `onLostPointerCapture` → `cancelGesture`.
- Renders the live draft as an extra `WhiteboardShape` above the committed ones.
- When an element is selected and not read-only, renders a dashed outline plus four `<rect>` handles with `data-handle="nw|ne|sw|se"` and `aria-hidden="true"`; pointer-down on a handle passes that handle to `beginGesture`.
- Read-only renders no handles and attaches no pointer handlers.
- Double-click calls `drawing.editText(id)` when the hit element is text.
- `jsdom` note: `getBoundingClientRect()` returns all zeros by default, which makes `viewBoxPoint` return `[0, 0]`. Tests must stub it — see Step 1.

- [ ] **Step 1: Write the failing tests**

Create `WhiteboardCanvas.test.tsx`. Stub the rect so coordinate maths is exercised:

```ts
function stubRect(element: Element): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 960,
    height: 640,
    right: 960,
    bottom: 640,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}
```

jsdom does not implement `setPointerCapture`/`releasePointerCapture`; assign no-op stubs onto the SVG element before dispatching. Use `fireEvent.pointerDown/pointerMove/pointerUp` with explicit `clientX`/`clientY`.

Cover: a rectangle-tool drag from (100,100) to (300,250) persists a rectangle at those bounds; a pointer-move without a prior pointer-down persists nothing; read-only renders no `[data-handle]` elements; a selected element renders four handles; the background is a `<rect>` inside the SVG rather than a CSS `background` style.

- [ ] **Step 2: Run the tests to verify they fail**

Run vitest against the new file. Expected: FAIL — cannot resolve `./WhiteboardCanvas.js`.

- [ ] **Step 3: Implement the canvas and its CSS**

Implement to the contract above. `drawing.css` styles `.whiteboard-canvas` (`flex: 1; min-height: 0; width: 100%; touch-action: none;`), `.whiteboard-canvas-handle`, the selection outline, the tool strip, and the inline text input.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/WhiteboardCanvas.tsx \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/WhiteboardCanvas.test.tsx \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/drawing.css
git commit -m "feat(whiteboard): interactive drawing canvas with selection handles"
```

---

### Task 7: Tool strip

**Files:**

- Create: `…/content/whiteboard/drawing/WhiteboardToolStrip.tsx`
- Test: `…/content/whiteboard/drawing/WhiteboardToolStrip.test.tsx`

**Interfaces:**

- Consumes: `WhiteboardTool` (Task 5).
- Produces:
  ```ts
  export function WhiteboardToolStrip(props: {
    readonly tool: WhiteboardTool;
    readonly readOnly: boolean;
    readonly onSelectTool: (tool: WhiteboardTool) => void;
  }): JSX.Element;
  ```

**Behaviour contract:** one `<button>` per tool with `aria-label` `Select`, `Draw rectangle`, `Draw ellipse`, `Draw diamond`, `Draw arrow`, `Add text`, `Draw freehand`; `aria-pressed` true only on the active tool; every button `disabled` when `readOnly`. Icons: `MousePointer2`, `Square`, `Circle`, `Diamond`, `ArrowRight`, `Type`, `Pencil` from `lucide-react`, all `size={13} aria-hidden="true"`.

- [ ] **Step 1: Write the failing tests**

Cover: renders seven buttons; `aria-pressed` is true only for the active tool; clicking a button calls `onSelectTool` with that tool; all buttons are disabled when `readOnly`.

- [ ] **Step 2: Run the tests to verify they fail**

Expected: FAIL — cannot resolve `./WhiteboardToolStrip.js`.

- [ ] **Step 3: Implement**

Implement to the contract, driven by a module-level array of `{ tool, label, icon }` so the markup stays a single `map`.

- [ ] **Step 4: Run the tests to verify they pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/WhiteboardToolStrip.tsx \
        apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/WhiteboardToolStrip.test.tsx
git commit -m "feat(whiteboard): persistent tool strip in the node header"
```

---

### Task 8: Inline text editor

**Files:**

- Create: `…/content/whiteboard/drawing/WhiteboardTextEditor.tsx`

**Interfaces:**

- Consumes: `WhiteboardTextDraft` (Task 5), `VIEW_BOX_WIDTH`/`VIEW_BOX_HEIGHT` (Task 1).
- Produces:
  ```ts
  export function WhiteboardTextEditor(props: {
    readonly draft: WhiteboardTextDraft;
    readonly onChange: (value: string) => void;
    readonly onCommit: () => void;
    readonly onCancel: () => void;
  }): JSX.Element;
  ```

**Behaviour contract:** an `<input aria-label="Whiteboard text">` absolutely positioned over the canvas, with `left`/`top` expressed as percentages of the viewBox (`draft.point[0] / VIEW_BOX_WIDTH * 100`), `maxLength={20_000}`, autofocused on mount. Enter or blur → `onCommit`; Escape → `onCancel`. Escape must also `stopPropagation` so it does not bubble to the canvas gesture handler.

This component has no test file of its own — it is covered by the face-level tests in Task 9, which exercise it through a real text-tool click. That keeps `drawing/` at 11 files.

- [ ] **Step 1: Implement**

Implement to the contract above.

- [ ] **Step 2: Verify it compiles**

Run: `corepack pnpm --dir apps/desktop typecheck`
Expected: no errors (the component is not yet imported; that is fine).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/drawing/WhiteboardTextEditor.tsx
git commit -m "feat(whiteboard): inline text editor overlay"
```

---

### Task 9: Wire the face together

**Files:**

- Modify: `…/content/whiteboard/WhiteboardNodeFace.tsx`, `…/content/whiteboard/WhiteboardNodeFace.test.tsx`, `…/content/whiteboard/whiteboard.css`
- Delete: `…/content/whiteboard/WhiteboardPreview.tsx`

**Interfaces:**

- Consumes: everything from Tasks 1–8.
- Produces: no new exports.

**Behaviour contract:**

- The header strip renders the element count, then `WhiteboardToolStrip`, then the existing Tools button.
- The body renders `WhiteboardCanvas`, the `WhiteboardTextEditor` when `drawing.textDraft` is non-null, and the existing Tools popover.
- The Tools popover **keeps** the per-element numeric editor, the stroke/fill colour pickers, the delete button, the agent-context picker, and SVG export. It **loses** the four create-shape buttons and the annotation text field.
- `persist` and `readOnly` keep their current semantics and are passed into `useWhiteboardDrawing` as `onPersist` / `readOnly`, with `session.recordHistory` as `onRecordHistory`.

- [ ] **Step 1: Update the face tests**

Rewrite `WhiteboardNodeFace.test.tsx`. The existing "adds shapes from the toolbar popover" and "adds annotations" cases no longer describe the UI — replace them. Keep the read-only case. Add:

1. Selecting the rectangle tool then dragging on the canvas persists a rectangle at the dragged bounds.
2. Selecting the text tool, clicking the canvas, typing, and pressing Enter persists a text element and appends its id to `annotationIds`.
3. Pressing Escape instead of Enter persists nothing.
4. A locked node disables every tool-strip button.
5. The Tools popover still exposes the numeric `x` field for a selected element.

Reuse the `stubRect` and pointer-capture stubs from Task 6.

- [ ] **Step 2: Run the tests to verify they fail**

Run vitest against `WhiteboardNodeFace.test.tsx`. Expected: FAIL — no tool-strip buttons exist yet.

- [ ] **Step 3: Rewrite the face and delete the dead preview**

Compose the pieces per the contract. Then `git rm` `WhiteboardPreview.tsx` and confirm nothing imports it:

```bash
grep -rn "WhiteboardPreview" apps/desktop/src || echo "no references"
```

- [ ] **Step 4: Run the whiteboard tests**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace/content/whiteboard`
Expected: PASS across every whiteboard test file.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/
git commit -m "feat(whiteboard): drag to draw, freehand pen, move, resize, and inline text"
```

---

### Task 10: Full verification

- [ ] **Step 1: Full unit suite**

Run: `corepack pnpm test:unit`
Expected: 0 failures. Baseline before this work was 2895 passing; the count should rise by roughly the number of tests added and nothing should newly fail.

- [ ] **Step 2: Typecheck and lint**

```bash
corepack pnpm --dir apps/desktop typecheck
corepack pnpm lint
corepack pnpm format:check
```

Expected: all clean, zero warnings.

- [ ] **Step 3: Structure gate**

```bash
corepack pnpm check:structure
```

Expected: clean. If it reports `content/whiteboard/drawing` over 12 files, fold a test file into a sibling rather than adding a directory.

- [ ] **Step 4: Update the implementation checklist**

Append a dated entry to `IMPLEMENTATION_CHECKLIST.md` in the style of the existing 2026-07-18 whiteboard entries, recording what shipped and the test counts.

- [ ] **Step 5: Commit and open the PR**

```bash
git add IMPLEMENTATION_CHECKLIST.md
git commit -m "docs: record whiteboard drawing in the implementation checklist"
git push -u origin feature/whiteboard-drawing
gh pr create --base main --title "feat(whiteboard): make the whiteboard actually drawable" --body "…"
```

## Self-Review

**Spec coverage:** model changes → Task 1; geometry → Task 2; shape renderer + export → Task 3; agent context → Task 4; gesture machine → Task 5; canvas + drawable-area fix → Task 6; tool strip → Task 7; inline text → Task 8; composition + popover trim → Task 9; verification → Task 10. The arrow-direction issue the spec missed is called out as an explicit amendment above and implemented in Tasks 1 and 3.

**Type consistency:** `WhiteboardPoint`, `WhiteboardBounds`, `WhiteboardHandle`, `WhiteboardTool`, `WhiteboardDraft`, `WhiteboardTextDraft`, and `WhiteboardDrawing` are each declared once, in the task that owns them, and referenced by that exact name everywhere else. `strokePath`, `arrowEndpoints`, and `boundsOfPoints` live in `model.ts` so both `svg.ts` and `drawing/` import them without a circular dependency.

**Known risk:** `WhiteboardCanvas` depends on `getBoundingClientRect`, which jsdom stubs to zeros. Task 6 Step 1 addresses this explicitly; if a later test mysteriously produces `[0, 0]` coordinates, a missing rect stub is the cause.
