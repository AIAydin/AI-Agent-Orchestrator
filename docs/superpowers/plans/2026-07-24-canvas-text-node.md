# Canvas Text Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A frameless, Canva-style `text` canvas node: created from the palette or by double-clicking empty canvas, edited inline, movable, width-resizable, rotatable, with S/M/L font presets — annotation only, no connection edges.

**Architecture:** New built-in node kind `text` flowing through the existing registry → shell (`CanvasNode`) → face pattern. The shell gets an opt-in frameless variant (CSS keyed on `data-node-kind='text'` plus small JSX branches, mirroring the existing `group-frame` special-casing). Rotation is a data field rendered as a CSS transform on the node article. Persistence, undo, autosave, snapshots, and export need no structural changes (kind/data pass through verbatim); the collaboration metadata contract gets the new node type registered.

**Tech Stack:** TypeScript strict, React 19, @xyflow/react 12, zod, vitest + @testing-library/react (jsdom), Playwright e2e, plain global CSS.

**Spec:** `docs/superpowers/specs/2026-07-24-canvas-text-node-design.md`

## Global Constraints

- Run every command from the worktree root (the repo checkout containing this file).
- Hand-written files must stay under 2,000 lines; maintained folders under 12 direct files (`node scripts/structure/check.mjs` verifies). All new renderer files go in `apps/desktop/src/renderer/src/components/workspace/content/text/`.
- Prettier: 100-column printWidth, single quotes, trailing commas (`config/tooling/prettier.config.mjs`).
- No new dependencies.
- Data field names used everywhere: `text` (string, ≤10,000 chars), `fontSize` (`'s' | 'm' | 'l'`, default `'m'`), `rotationDeg` (number, −180..180, default 0).
- Renderer test command shape: `corepack pnpm -C apps/desktop exec vitest run <path relative to apps/desktop>`. Core: `corepack pnpm -C packages/core exec vitest run src/model/domain.test.ts`.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Core domain schema

**Files:**
- Modify: `packages/core/src/model/domain.ts` (add `TextNodeSchema` next to `NoteImageNodeSchema` ~line 618; add to `CanvasNodeSchema` union ~line 660)
- Test: `packages/core/src/model/domain.test.ts`

**Interfaces:**
- Produces: `TextNodeSchema` export; `'text'` becomes a valid `CanvasNodeType`. Data shape `{ text: string; fontSize: 's'|'m'|'l'; rotationDeg: number }`.

- [ ] **Step 1: Write the failing test** — append to `packages/core/src/model/domain.test.ts` (follow the file's existing describe/it style and imports; `CanvasNodeSchema` is already imported there):

```ts
describe('text node schema', () => {
  const baseText = {
    id: '018f6ff0-0000-7000-8000-000000000001',
    type: 'text',
    title: 'Text',
    color: '#8f9bb3',
    icon: 'type',
    position: { x: 10, y: 20 },
    size: { width: 260, height: 64 },
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    data: {},
  };

  it('applies defaults for an empty data object', () => {
    const parsed = CanvasNodeSchema.parse(baseText);
    if (parsed.type !== 'text') throw new Error('expected text node');
    expect(parsed.data.text).toBe('');
    expect(parsed.data.fontSize).toBe('m');
    expect(parsed.data.rotationDeg).toBe(0);
  });

  it('accepts explicit fields and round-trips them', () => {
    const parsed = CanvasNodeSchema.parse({
      ...baseText,
      data: { text: 'Ship it', fontSize: 'l', rotationDeg: -45 },
    });
    if (parsed.type !== 'text') throw new Error('expected text node');
    expect(parsed.data).toEqual({ text: 'Ship it', fontSize: 'l', rotationDeg: -45 });
  });

  it('rejects out-of-range rotation and oversized text', () => {
    expect(() =>
      CanvasNodeSchema.parse({ ...baseText, data: { rotationDeg: 200 } }),
    ).toThrow();
    expect(() =>
      CanvasNodeSchema.parse({ ...baseText, data: { text: 'x'.repeat(10_001) } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `corepack pnpm -C packages/core exec vitest run src/model/domain.test.ts` — expect the three new tests to FAIL (invalid discriminator `text`).

- [ ] **Step 3: Implement** — in `packages/core/src/model/domain.ts`, directly after `NoteImageNodeSchema`:

```ts
export const TextNodeSchema = createNodeSchema(
  'text',
  z
    .object({
      text: z.string().max(10_000).default(''),
      fontSize: z.enum(['s', 'm', 'l']).default('m'),
      rotationDeg: z.number().min(-180).max(180).default(0),
    })
    .strict(),
);
```

Add `TextNodeSchema,` to the `CanvasNodeSchema` discriminated union array (after `NoteImageNodeSchema,`).

- [ ] **Step 4: Run test to verify it passes** — same command. Expect PASS (whole file green).

- [ ] **Step 5: Commit** — `git add packages/core/src/model/domain.ts packages/core/src/model/domain.test.ts && git commit -m "feat(core): add text canvas node schema"` (with trailer).

---

### Task 2: Collaboration contract registration

**Files:**
- Modify: `apps/desktop/src/shared/collaboration/metadata-contracts.ts` (`CollaborationNodeTypeSchema` enum, lines 32-49)
- Modify: `apps/desktop/src/shared/collaboration/canvas-metadata.ts` (`collaborationNodeType` switch, lines 285-310)

**Interfaces:**
- Produces: `'text'` is an accepted collaboration node type; text nodes project base metadata (title/position/size/color/lock/group) into room snapshots instead of being dropped. Content fields (`text`, `fontSize`, `rotationDeg`) intentionally do NOT sync (same as note-image markdown).

- [ ] **Step 1: Add `'text'`** to the `z.enum([...])` in `CollaborationNodeTypeSchema` (alphabetical position beside the other kinds).
- [ ] **Step 2: Add the switch case** in `collaborationNodeType`: alongside the existing simple cases add `case 'text':` returning `'text'` (match the file's existing pattern for e.g. `'note-image'`).
- [ ] **Step 3: Typecheck the desktop app** — `corepack pnpm -C apps/desktop exec tsc --noEmit -p tsconfig.json`. Expected: PASS (or the same pre-existing state as before the change — run once before editing to baseline).
- [ ] **Step 4: Commit** — `git add apps/desktop/src/shared/collaboration && git commit -m "feat(collab): register text node type in metadata contract"` (with trailer).

---

### Task 3: Registry kind, dimensions, and node data fields

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/node-registry/registry.ts` (`NODE_KINDS` line 28; `BUILT_INS` line 98; lucide import line 1-24)
- Modify: `apps/desktop/src/shared/canvas/node-dimensions.ts` (`DOCUMENT_NODE_DIMENSIONS`, lines 67-102)
- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx` (`WorkshopNodeData` interface)
- Test: `apps/desktop/src/renderer/src/components/workspace/node-registry/registry.test.ts`
- Test: `apps/desktop/src/renderer/src/components/workspace/model/node-persistence.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: renderer kind `'text'` (in `NODE_KINDS`, palette appears automatically via `filteredTemplates`); registry definition `label: 'Text'`, `description: 'A floating text label'`, `color: '#8f9bb3'`, icon `Type` (lucide); dimensions default `{ width: 260, height: 64 }`, minimum `{ width: 120, height: 40 }`; `WorkshopNodeData` gains `text?: string; fontSize?: 's' | 'm' | 'l'; rotationDeg?: number;`.

- [ ] **Step 1: Write failing tests.** In `registry.test.ts`, following the file's existing assertions style, add:

```ts
it('registers the text node kind', () => {
  expect(NODE_KINDS).toContain('text');
  const definition = NODE_DEFINITIONS.text;
  expect(definition.label).toBe('Text');
  expect(definition.color).toBe('#8f9bb3');
});
```

In `node-persistence.test.ts`, mirror the per-kind dimension expectations (lines 79-123 pattern):

```ts
it('uses text label dimensions', () => {
  expect(initialWorkshopNodeDimensions('text')).toEqual({ width: 260, height: 64 });
  expect(
    persistedWorkshopNodeDimensions(node('text', { width: 10, height: 10 })),
  ).toEqual({ width: 120, height: 40 });
});
```

(Adjust the `node(...)` factory call to the file's actual helper signature at lines 126-146.)

- [ ] **Step 2: Run to verify failure** — `corepack pnpm -C apps/desktop exec vitest run src/renderer/src/components/workspace/node-registry/registry.test.ts src/renderer/src/components/workspace/model/node-persistence.test.ts` — new tests FAIL.

- [ ] **Step 3: Implement.**
  - `registry.ts`: add `'text',` to `NODE_KINDS` (before `'group-frame'`); add `Type` to the lucide-react import; add to `BUILT_INS`: `builtin('text', 'Text', 'A floating text label', '#8f9bb3', Type),` (before the `group-frame` entry).
  - `node-dimensions.ts`: add to `DOCUMENT_NODE_DIMENSIONS`:

```ts
  text: {
    default: { width: 260, height: 64 },
    minimum: { width: 120, height: 40 },
  },
```

  - `CanvasNode.tsx` `WorkshopNodeData`: add after `markdown?: string;`:

```ts
  text?: string;
  fontSize?: 's' | 'm' | 'l';
  rotationDeg?: number;
```

- [ ] **Step 4: Run to verify pass** — same command; both files green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(canvas): register text node kind, dimensions, data fields"` (with trailer).

---

### Task 4: Text face, edit bus, and face styles

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/text-edit-bus.ts`
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/text-edit-bus.test.ts`
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/TextNodeFace.tsx`
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/TextNodeFace.test.tsx`
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/text-node-face.css`
- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (FACES map + import)
- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css` (add `'text'` to a flex-column kind group)

**Interfaces:**
- Consumes: `useAgentSession()` (`updateNodeData(id, partial)`, `recordHistory()`, `graphReadOnly`), `useCanvasNodeInteractions()` (`readOnly`), `NodeFaceProps { id, data }`.
- Produces: `TextNodeFace` (registered as `text` face); edit bus API `requestTextEdit(nodeId: string): void` and `onTextEditRequest(listener: (nodeId: string) => void): () => void`; face root `<section className="node-face text-node-face" data-text-size={data.fontSize ?? 'm'}>`; textarea has `aria-label="Text content"`; display div class `text-face-display`, placeholder class `text-face-placeholder` with copy `Type…`.

- [ ] **Step 1: Edit bus (test first).** `text-edit-bus.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { onTextEditRequest, requestTextEdit } from './text-edit-bus.js';

describe('text edit bus', () => {
  it('notifies subscribers and stops after unsubscribe', () => {
    const seen = vi.fn();
    const unsubscribe = onTextEditRequest(seen);
    requestTextEdit('node-1');
    expect(seen).toHaveBeenCalledWith('node-1');
    unsubscribe();
    requestTextEdit('node-2');
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
```

Run `corepack pnpm -C apps/desktop exec vitest run src/renderer/src/components/workspace/content/text/text-edit-bus.test.ts` → FAIL (module missing). Implement `text-edit-bus.ts`:

```ts
/** In-memory request channel: the canvas asks a mounted text face to enter edit mode. */
const listeners = new Set<(nodeId: string) => void>();

export function requestTextEdit(nodeId: string): void {
  for (const listener of listeners) listener(nodeId);
}

export function onTextEditRequest(listener: (nodeId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
```

Re-run → PASS.

- [ ] **Step 2: Face tests (failing).** `TextNodeFace.test.tsx`, mirroring the harness in `NoteImageNodeFace.test.tsx` (jsdom pragma, provider stack, `sessionValue`, `nodeData` helpers — copy that file's setup shape, dropping the image/file mocks):

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AgentSessionProvider } from '../../runs/agent-session/AgentSessionContext.js';
import type { AgentSessionContextValue } from '../../runs/agent-session/AgentSessionContext.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { TextNodeFace } from './TextNodeFace.js';
import { requestTextEdit } from './text-edit-bus.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

function sessionValue(): AgentSessionContextValue {
  return {
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'text',
    title: 'Text',
    description: 'A floating text label',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8f9bb3',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <TextNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TextNodeFace', () => {
  it('starts editing when mounted empty and writes text changes', () => {
    renderFace();
    const editor = screen.getByLabelText('Text content');
    expect(recordHistory).toHaveBeenCalledTimes(1);
    fireEvent.change(editor, { target: { value: 'Move fast' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { text: 'Move fast' });
  });

  it('shows committed text and re-enters editing on double click', () => {
    renderFace({ text: 'Hello' });
    const display = screen.getByText('Hello');
    fireEvent.doubleClick(display);
    expect(screen.getByLabelText('Text content')).toBeTruthy();
  });

  it('shows a placeholder for committed empty text and none while locked', () => {
    renderFace({ text: '' });
    // committed empty (not auto-editing) is covered via locked which disables auto-edit
    cleanup();
    renderFace({ text: '', locked: true });
    expect(screen.getByText('Type…')).toBeTruthy();
    expect(screen.queryByLabelText('Text content')).toBeNull();
  });

  it('enters editing when the edit bus targets this node', () => {
    renderFace({ text: 'Hi' });
    requestTextEdit('n1');
    expect(screen.getByLabelText('Text content')).toBeTruthy();
  });

  it('caps text at 10k characters', () => {
    renderFace();
    const editor = screen.getByLabelText('Text content');
    fireEvent.change(editor, { target: { value: 'x'.repeat(10_050) } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { text: 'x'.repeat(10_000) });
  });
});
```

Run → FAIL (module missing).

- [ ] **Step 3: Implement `TextNodeFace.tsx`:**

```tsx
import { useEffect, useRef, useState } from 'react';

import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { onTextEditRequest } from './text-edit-bus.js';
import './text-node-face.css';

const TEXT_LIMIT = 10_000;

export function TextNodeFace({ id, data }: NodeFaceProps) {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const text = data.text ?? '';
  const [editing, setEditing] = useState(() => !readOnly && text === '');
  const startedRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => onTextEditRequest((nodeId) => {
    if (nodeId === id && !readOnly) setEditing(true);
  }), [id, readOnly]);

  useEffect(() => {
    if (!editing) {
      startedRef.current = false;
      return;
    }
    if (!startedRef.current) {
      startedRef.current = true;
      session.recordHistory();
    }
    const editor = editorRef.current;
    if (editor !== null) {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.style.height = 'auto';
      editor.style.height = `${editor.scrollHeight}px`;
    }
  }, [editing, session]);

  if (readOnly && editing) setEditing(false);

  if (editing && !readOnly) {
    return (
      <section className="node-face text-node-face" data-text-size={data.fontSize ?? 'm'}>
        <textarea
          ref={editorRef}
          className="text-face-editor nodrag nowheel"
          aria-label="Text content"
          value={text}
          rows={1}
          onChange={(event) => {
            session.updateNodeData(id, { text: event.target.value.slice(0, TEXT_LIMIT) });
            event.target.style.height = 'auto';
            event.target.style.height = `${event.target.scrollHeight}px`;
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setEditing(false);
            }
          }}
        />
      </section>
    );
  }

  return (
    <section className="node-face text-node-face" data-text-size={data.fontSize ?? 'm'}>
      <div
        className={text === '' ? 'text-face-display text-face-placeholder' : 'text-face-display'}
        {...(readOnly ? {} : { onDoubleClick: () => setEditing(true) })}
      >
        {text === '' ? 'Type…' : text}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Styles.** `text-node-face.css`:

```css
.text-node-face {
  --text-face-size: 24px;
  display: flex;
  flex: 1 1 auto;
  padding: 4px 6px;
}

.text-node-face[data-text-size='s'] {
  --text-face-size: 16px;
}

.text-node-face[data-text-size='l'] {
  --text-face-size: 40px;
}

.text-face-display,
.text-face-editor {
  width: 100%;
  font-size: var(--text-face-size);
  font-weight: 550;
  line-height: 1.25;
  color: var(--text-strong, inherit);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.text-face-editor {
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  overflow: hidden;
}

.text-face-placeholder {
  opacity: 0.45;
}
```

In `node-face.css`, add `'text'` to the kind group that applies `display: flex; flex-direction: column;` to `.canvas-node[data-node-kind='…']:not(.collapsed)` (the document/status group at lines 3-24).

- [ ] **Step 5: Register the face.** In `node-face-registry.tsx`: `import { TextNodeFace } from '../../content/text/TextNodeFace.js';` and add `text: TextNodeFace,` to `FACES`.

- [ ] **Step 6: Run tests** — `corepack pnpm -C apps/desktop exec vitest run src/renderer/src/components/workspace/content/text/` → all PASS.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(canvas): text node face with inline editing"` (with trailer).

---

### Task 5: Frameless shell variant, rotation handle, and size controls

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/TextRotateHandle.tsx`
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/TextSizeControls.tsx`
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/text-rotation.ts`
- Create: `apps/desktop/src/renderer/src/components/workspace/content/text/text-rotation.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx`
- Modify: `apps/desktop/src/renderer/src/styles/workspace/canvas.css`
- Test: `apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.test.tsx` (extend, following its existing mock setup for `@xyflow/react` and the face registry)

**Interfaces:**
- Consumes: `useAgentSession()` for writes; `data.rotationDeg` / `data.fontSize` from Task 3.
- Produces: pure helpers in `text-rotation.ts`: `normalizeRotation(value: number): number` (wraps into −180..180) and `snappedRotation(raw: number, shiftKey: boolean): number` (Shift → 15° steps; within 3° of a cardinal −180/−90/0/90/180 → snap); `TextRotateHandle({ id })` renders `button.text-rotate-handle` with `aria-label="Rotate text"`; `TextSizeControls({ id, fontSize })` renders three buttons labelled `S`, `M`, `L` (aria-labels `Small text`, `Medium text`, `Large text`).

- [ ] **Step 1: Rotation math tests (failing).** `text-rotation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { normalizeRotation, snappedRotation } from './text-rotation.js';

describe('text rotation helpers', () => {
  it('normalizes angles into [-180, 180]', () => {
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-190)).toBe(170);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(45)).toBe(45);
  });

  it('snaps to 15 degree steps while shift is held', () => {
    expect(snappedRotation(22, true)).toBe(15);
    expect(snappedRotation(23, true)).toBe(30);
  });

  it('snaps near cardinal angles without shift', () => {
    expect(snappedRotation(2, false)).toBe(0);
    expect(snappedRotation(88, false)).toBe(90);
    expect(snappedRotation(-178.5, false)).toBe(-180);
    expect(snappedRotation(40, false)).toBe(40);
  });
});
```

Run → FAIL. Implement `text-rotation.ts`:

```ts
const CARDINALS = [-180, -90, 0, 90, 180] as const;
const CARDINAL_SNAP_DEGREES = 3;

export function normalizeRotation(value: number): number {
  const wrapped = ((value % 360) + 540) % 360 - 180;
  return wrapped === -180 && value > 0 ? 180 : wrapped;
}

export function snappedRotation(raw: number, shiftKey: boolean): number {
  const normalized = normalizeRotation(raw);
  if (shiftKey) return normalizeRotation(Math.round(normalized / 15) * 15);
  for (const cardinal of CARDINALS) {
    if (Math.abs(normalized - cardinal) <= CARDINAL_SNAP_DEGREES) return normalizeRotation(cardinal);
  }
  return Math.round(normalized * 10) / 10;
}
```

Re-run → PASS. Note: `normalizeRotation(360)` must be `0` and `normalizeRotation(190)` must be `-170`; adjust only if a test disagrees with the arithmetic, never the tests.

- [ ] **Step 2: Rotate handle component.** `TextRotateHandle.tsx`:

```tsx
import { useRef } from 'react';
import { RotateCw } from 'lucide-react';

import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { snappedRotation } from './text-rotation.js';

export function TextRotateHandle({ id }: { readonly id: string }) {
  const session = useAgentSession();
  const recorded = useRef(false);

  return (
    <button
      type="button"
      className="text-rotate-handle nodrag"
      aria-label="Rotate text"
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        recorded.current = false;
        const article = event.currentTarget.closest('.canvas-node');
        if (article === null) return;
        const bounds = article.getBoundingClientRect();
        const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        const move = (pointer: PointerEvent) => {
          if (!recorded.current) {
            recorded.current = true;
            session.recordHistory();
          }
          const raw =
            (Math.atan2(pointer.clientY - center.y, pointer.clientX - center.x) * 180) / Math.PI +
            90;
          session.updateNodeData(id, { rotationDeg: snappedRotation(raw, pointer.shiftKey) });
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      }}
    >
      <RotateCw size={12} aria-hidden="true" />
    </button>
  );
}
```

- [ ] **Step 3: Size controls.** `TextSizeControls.tsx`:

```tsx
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

const SIZES = [
  { value: 's', label: 'S', description: 'Small text' },
  { value: 'm', label: 'M', description: 'Medium text' },
  { value: 'l', label: 'L', description: 'Large text' },
] as const;

export function TextSizeControls({
  id,
  fontSize,
}: {
  readonly id: string;
  readonly fontSize: 's' | 'm' | 'l';
}) {
  const session = useAgentSession();
  return (
    <span className="text-size-controls" role="group" aria-label="Text size">
      {SIZES.map((size) => (
        <button
          key={size.value}
          type="button"
          className={fontSize === size.value ? 'text-size-button active' : 'text-size-button'}
          aria-label={size.description}
          aria-pressed={fontSize === size.value}
          onClick={(event) => {
            event.stopPropagation();
            session.recordHistory();
            session.updateNodeData(id, { fontSize: size.value });
          }}
        >
          {size.label}
        </button>
      ))}
    </span>
  );
}
```

- [ ] **Step 4: Shell branches in `CanvasNode.tsx`.** Add imports for `TextRotateHandle` and `TextSizeControls`. Alongside `const groupFrame = ...` add `const isText = data.kind === 'text';`. Then:
  - Article `className` list: add `isText ? 'text-node' : ''`.
  - Article `style`: add `...(isText ? { ['--text-rotation' as string]: `${data.rotationDeg ?? 0}deg` } : {})`.
  - Skip connection handles: wrap both `targetHandles.map(...)` and `sourceHandles.map(...)` blocks with `{!isText && (...)}`.
  - Header for text nodes: replace the header contents with a pill variant when `isText`:

```tsx
{isText ? (
  <>
    <TextSizeControls id={id} fontSize={data.fontSize ?? 'm'} />
    {data.locked && <Lock size={12} aria-label="Locked" />}
    <CanvasNodeDetailsPopover id={id} data={data} readOnly={!canChangePresentation} />
  </>
) : (
  /* existing header children unchanged */
)}
```

  (Keep the existing header for all other kinds byte-identical; the collapse button and status dot are simply not rendered in the text branch.)
  - After the face render, add: `{isText && selected && canChangePresentation && <TextRotateHandle id={id} />}`.

- [ ] **Step 5: Shell CSS in `styles/workspace/canvas.css`** (append a text-node section):

```css
/* Frameless text node */
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='text']:not(.collapsed)) {
  min-width: 120px;
  min-height: 40px;
  height: auto !important;
}

.canvas-node.text-node {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  transform: rotate(var(--text-rotation, 0deg));
}

.canvas-node.text-node::before {
  display: none;
}

.canvas-node.text-node.selected {
  border-color: var(--node-accent);
}

.canvas-node.text-node > header {
  position: absolute;
  top: -38px;
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-raised);
  box-shadow: 0 4px 14px rgb(0 0 0 / 12%);
  opacity: 0;
  pointer-events: none;
}

.canvas-node.text-node.selected > header {
  opacity: 1;
  pointer-events: auto;
}

.text-size-controls {
  display: inline-flex;
  gap: 2px;
}

.text-size-button {
  min-width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.text-size-button.active {
  background: color-mix(in srgb, var(--node-accent) 18%, transparent);
}

.text-rotate-handle {
  position: absolute;
  top: -64px;
  left: 50%;
  transform: translateX(-50%);
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--surface-raised);
  cursor: grab;
}

.react-flow__node:has(.canvas-node[data-node-kind='text'])
  .react-flow__resize-control:is(.top, .bottom, .top-left, .top-right, .bottom-left, .bottom-right) {
  display: none;
}
```

- [ ] **Step 6: Shell tests.** Extend `CanvasNode.test.tsx` (reuse its existing render harness and mocks) with:

```tsx
it('renders the text kind frameless: no handles, no collapse, rotation transform', () => {
  renderCanvasNode({ kind: 'text', rotationDeg: 30, text: 'Hi' });
  expect(screen.queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();
  const article = screen.getByRole('article');
  expect(article.className).toContain('text-node');
  expect(article.getAttribute('style')).toContain('--text-rotation: 30deg');
  expect(document.querySelectorAll('.node-handle')).toHaveLength(0);
});
```

(Adapt the helper name to that file's actual render helper; assertions are the contract.) Run `corepack pnpm -C apps/desktop exec vitest run src/renderer/src/components/workspace/canvas/CanvasNode.test.tsx src/renderer/src/components/workspace/content/text/` → PASS, plus the whole pre-existing file stays green.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(canvas): frameless text node shell with rotation and size controls"` (with trailer).

---

### Task 6: Rotation field in the details popover

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/node-details/CanvasNodeDetailsPopover.tsx` (`SettingsSection`, lines 143-177)
- Test: `apps/desktop/src/renderer/src/components/workspace/canvas/node-details/CanvasNodeDetails.test.tsx`

**Interfaces:**
- Consumes: `normalizeRotation` from `content/text/text-rotation.js` (Task 5); `useAgentSession()`.
- Produces: for `data.kind === 'text'` only, a labelled number input `Rotation (degrees)` writing `rotationDeg`.

- [ ] **Step 1: Failing test** (in `CanvasNodeDetails.test.tsx`, using its provider stack):

```tsx
it('edits rotation for text nodes from the settings tab', async () => {
  renderDetails({ kind: 'text', rotationDeg: 10 });
  await openSettingsTab();
  const rotation = screen.getByLabelText('Rotation (degrees)');
  fireEvent.change(rotation, { target: { value: '200' } });
  expect(updateNodeData).toHaveBeenCalledWith('n1', { rotationDeg: -160 });
});
```

(Adapt helper names to the file's existing harness.) Run → FAIL.

- [ ] **Step 2: Implement** — inside `SettingsSection`'s fieldset, after the Accent colour label:

```tsx
{data.kind === 'text' && (
  <label>
    Rotation (degrees)
    <input
      type="number"
      name={`node-${id}-details-rotation`}
      min={-180}
      max={180}
      step={1}
      value={Math.round(data.rotationDeg ?? 0)}
      onFocus={recordHistory}
      onChange={(event) =>
        updateNodeData(id, { rotationDeg: normalizeRotation(Number(event.target.value) || 0) })
      }
    />
  </label>
)}
```

- [ ] **Step 3: Run** the details test file → PASS (whole file green).
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(canvas): rotation field for text nodes in details settings"` (with trailer).

---

### Task 7: Double-click creation, Enter-to-edit, and connection guard

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/WorkspaceCanvas.tsx`
- Modify: `apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx` (`onConnect`, lines 1514-1545)
- Test: `apps/desktop/src/renderer/src/components/workspace/canvas/WorkspaceCanvas.test.tsx`

**Interfaces:**
- Consumes: `onAddNode(kind, position?)` prop (already exists, line 110); `requestTextEdit` from the bus; `instance.screenToFlowPosition`; text default dimensions `{ 260, 64 }` (Task 3).
- Produces: `zoomOnDoubleClick={false}`; double-click on `.react-flow__pane` creates a centered text node; Enter on a focused text node opens its editor; `onConnect` refuses edges touching a text node.

- [ ] **Step 1: Failing tests** in `WorkspaceCanvas.test.tsx` (reuse its render harness and ReactFlow mocks):

```tsx
it('creates a text node when the pane is double-clicked', () => {
  const onAddNode = vi.fn();
  const { container } = renderWorkspaceCanvas({ onAddNode });
  const pane = container.querySelector('.react-flow__pane');
  expect(pane).not.toBeNull();
  fireEvent.doubleClick(pane as Element, { clientX: 400, clientY: 300 });
  expect(onAddNode).toHaveBeenCalledWith('text', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
});
```

(If the existing harness mocks `ReactFlow` such that no `.react-flow__pane` exists, render the mock with a pane-classed div — follow the file's established mock shape.) Run → FAIL.

- [ ] **Step 2: Implement in `WorkspaceCanvas.tsx`.**
  - Add to the `<ReactFlow>` props: `zoomOnDoubleClick={false}`.
  - On the wrapping `<section className="canvas-region">`, add:

```tsx
onDoubleClick={(event) => {
  if (collaborationGraphReadOnly) return;
  const target = event.target as HTMLElement;
  if (!target.classList.contains('react-flow__pane')) return;
  const position = instance?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
  if (position === undefined) return;
  onAddNode('text', { x: position.x - 130, y: position.y - 32 });
}}
```

  - In the existing `onKeyDownCapture` handler, after the editable-element guard (line ~382), add:

```tsx
if (event.key === 'Enter') {
  const nodeElement = (event.target as HTMLElement).closest<HTMLElement>(
    '.react-flow__node[data-id]',
  );
  const nodeId = nodeElement?.dataset['id'];
  const node = nodeId === undefined ? undefined : nodes.find((item) => item.id === nodeId);
  if (node !== undefined && node.data.kind === 'text' && !collaborationGraphReadOnly && !node.data.locked) {
    event.preventDefault();
    event.stopPropagation();
    requestTextEdit(node.id);
    return;
  }
}
```

  (Import `requestTextEdit` from `../content/text/text-edit-bus.js`; `nodes` is already a prop.)

- [ ] **Step 3: Connection guard in `Workspace.tsx` `onConnect`** — after the `canConnectUnlocked` check:

```tsx
const endpoints = [connection.source, connection.target];
if (nodes.some((node) => endpoints.includes(node.id) && node.data.kind === 'text')) {
  setEvents((items) => ['Text nodes are annotations and cannot be connected.', ...items].slice(0, 30));
  return;
}
```

- [ ] **Step 4: Run** — `corepack pnpm -C apps/desktop exec vitest run src/renderer/src/components/workspace/canvas/WorkspaceCanvas.test.tsx` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(canvas): double-click text creation, enter-to-edit, edge guard"` (with trailer).

---

### Task 8: End-to-end test, spec deviations, full verification

**Files:**
- Create: `apps/desktop/e2e/canvas/interactions/text-node.spec.ts`
- Modify: `docs/superpowers/specs/2026-07-24-canvas-text-node-design.md` (append a `## Deviations` section only if implementation diverged)

**Interfaces:**
- Consumes: e2e harness (`createCanvasUserData`, `openSafeDemo`, `reopenRecentProject`, `closeCanvasHarness` from `./harness.js`), selectors per `canvas-actions.ts` conventions, plus the face classes from Task 4.

- [ ] **Step 1: Write the e2e spec:**

```ts
import { expect, test, type ElectronApplication } from '@playwright/test';

import { closeCanvasHarness, createCanvasUserData, openSafeDemo, reopenRecentProject } from './harness.js';

test('text node: create from palette, type, rotate, persist across relaunch', async () => {
  const userDataDirectory = await createCanvasUserData();
  const externalRequests: string[] = [];
  let electronApp: ElectronApplication | null = null;
  try {
    const firstSession = await openSafeDemo(userDataDirectory, externalRequests);
    electronApp = firstSession.app;
    const { page } = firstSession;

    await test.step('create a text node from the palette and type into it', async () => {
      await page.locator('.template-section').getByRole('button', { name: /^Text/ }).click();
      const editor = page.getByLabel('Text content');
      await expect(editor).toBeVisible();
      await editor.fill('Ship it Friday');
      await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
      await expect(page.locator('.text-face-display')).toHaveText('Ship it Friday');
    });

    await test.step('rotate via the details settings field', async () => {
      const node = page.getByRole('article', { name: /^Text: / });
      await node.click();
      await node.locator('.node-details-button').click();
      const rotation = page.getByLabel('Rotation (degrees)');
      await rotation.fill('45');
      await page.keyboard.press('Escape');
      await expect(node).toHaveCSS('transform', /matrix/);
    });

    await test.step('persists across relaunch', async () => {
      const secondSession = await reopenRecentProject(electronApp, userDataDirectory, externalRequests);
      electronApp = secondSession.app;
      const reopenedPage = secondSession.page;
      await expect(reopenedPage.locator('.text-face-display')).toHaveText('Ship it Friday');
    });
  } finally {
    await closeCanvasHarness(electronApp, userDataDirectory);
  }
});
```

(Match `reopenRecentProject`'s real signature from `harness.ts` before running; adjust the call shape only, not the assertions.)

- [ ] **Step 2: Run the spec** — `corepack pnpm -C apps/desktop exec playwright test e2e/canvas/interactions/text-node.spec.ts`. Precondition: `node_modules/electron/dist` must exist in this worktree (electron postinstall). If missing, run `node node_modules/electron/install.js` from the worktree root first. Expected: PASS.
- [ ] **Step 3: Full gates from the worktree root** — `node scripts/structure/check.mjs` then `corepack pnpm verify`. Expected: structure PASS; verify matches the baseline state of `main` (pre-existing format/structure failures on main, if any, must not grow — compare against a baseline `corepack pnpm verify` run on the untouched merge-base if verify is red).
- [ ] **Step 4: Spec deviations** — if any behavior shipped differently from the spec, append a dated `## Deviations` section describing exactly what and why; commit.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "test(e2e): text node create, rotate, persist"` (with trailer).
