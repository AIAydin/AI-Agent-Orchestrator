# Terminal, File & Diff Node Faces (sub-plan 2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three heavier node kinds — `terminal`, `file`, `diff` — render their real content on the node face (replacing the generic title/description `.node-body`), following the shipped `AgentSessionNode`/`PreviewNodeFace`/registry pattern established by sub-plans 2a + 2b. `terminal` embeds the live xterm session (mirror of the shipped agent-session terminal embed) plus a compact config strip and an in-node launch-review overlay. `file` mounts the Monaco `FileEditorWorkspace` on the face, lazily (only while expanded and above a measured minimum size, unmounting on collapse), with file assignment via a `ProjectFileBrowser` popover. `diff` renders `GitDiffViewer` inline read-only with a compact file list, keeping the full `GitReviewDialog` reachable as a "maximize" affordance. Inspector panels stay mounted and fully functional (sidebar retirement is sub-plan 2d); faces coexist with panels.

**Architecture:** Each face registers its kind into the existing `canvas/faces/node-face-registry.tsx` `FACES` map. Faces read services from `AgentSessionContext` (extended with one navigation callback, `openDiffReview`, for the maximize affordance) and call preload APIs directly the same way the shipped inspectors do (`window.forgeboard.terminal` via `terminalOperationsFromWindow()`, `window.forgeboard.files`, `window.forgeboard.git.review`). The terminal face reuses `useTerminalNodeController` unchanged and embeds `TerminalSurface` + `TerminalLaunchReviewDialog`, exactly like `AgentSessionNode` and `TerminalNodePanel`; small pure helpers (`terminalNodeConfiguration`/`terminalCommandConfiguration`/`terminalSessionNodeStatus`) move out of `WorkspaceInspector.tsx` into a shared `terminal/node-configuration.ts` so panel and face build config identically. The file face composes the shipped `FileEditorWorkspace` + `ProjectFileBrowser`. The diff face loads the full review with the shipped `useGitReview` hook, derives a compact file list via `git-review-model`, and renders the shipped `GitDiffViewer` read-only. Monaco and the review payload are gated behind a new `lib/use-above-min-size.ts` ResizeObserver hook (the same `typeof ResizeObserver === 'undefined'` pattern `PreviewNodeFace` uses). Per-kind dimensions extend the 2a/2b lookup in `shared/canvas/node-dimensions.ts`; per-kind CSS hangs off the existing `data-node-kind` attribute.

**Tech Stack:** React 19 + @xyflow/react v12 (vitest jsdom + testing-library), zod contracts (unchanged), plain CSS with design tokens, Monaco (dynamically imported by `FileEditorPanel` already). Renderer-only — no main-process or preload changes.

**Spec:** `docs/superpowers/specs/2026-07-20-content-on-node-design.md` §2c.

## Plan-time findings

- **Registry + chrome are already generic (2a/2b).** `CanvasNode.tsx:194` computes `const Face = data.collapsed ? null : nodeFaceForKind(data.kind);` and `:297-298` renders `{Face !== null && <Face id={id} data={data} />}` with the generic `.node-body` only when `Face === null`. So collapse unmounts the face for free (the primary lazy-mount lever), and the header (collapse pill, lock, status dot) + `NodeResizer` stay outside the face by construction. `terminal`/`file`/`diff` are all `builtin(...)` in `node-registry/registry.ts:100-102` with `resizable: true, collapsible: true`. Registering the three kinds needs only new entries in `node-face-registry.tsx`'s `FACES` and moving them out of the registry test's null-case.
- **Dimensions must be added — they currently fall through to the 320×180/210×92 default.** `node-dimensions.ts` special-cases `agent`/`web-preview`/`mobile-preview`, then a `DOCUMENT_NODE_DIMENSIONS` map (2b: eight kinds), then the default. `terminal`/`file`/`diff` are in none of these. This plan adds a parallel `CONTENT_NODE_DIMENSIONS` map consulted by both `defaultNodeDimensionsForKind` and `minimumNodeDimensionsForKind`, plus matching `:has(...)` min-size rules in `canvas.css`. Chosen values: **terminal 560×480 / min 400×320** (a CLI window, identical to `AGENT_NODE_*`), **file 640×520 / min 420×360** (Monaco needs room), **diff 640×560 / min 440×360** (sidebar list + hunks).
- **Terminal face — services audit.** `AgentSessionNode` already embeds `TerminalSurface` + `useTerminalNodeController` with `operations: terminalOperationsFromWindow()` (i.e. `window.forgeboard.terminal`) and feeds it `launch?.configuration` (a `TerminalNodeConfiguration`). The terminal NODE face is the same shape but with the terminal's OWN config instead of an agent launch: `terminalNodeConfiguration(node, settings)` (`WorkspaceInspector.tsx:469-480`) maps `data.command` + `settings.terminalShell`/`settings.envAllowlist` → `TerminalNodeConfiguration`; writes go back through `terminalCommandConfiguration(...)` → `updateNodeData(id, { command })` (`:482-491`); status mirrors via `terminalSessionNodeStatus(...)` (`:493-503`). **The face needs NO services beyond `AgentSessionContext`** (`project`, `settings`, `graphReadOnly`, `updateNodeData`, `recordHistory`, `reportError`) — it drives the controller directly. The launch review is `TerminalLaunchReviewDialog` (already rendered by the panel at `controller.pendingPlan !== null`); the face renders it as an in-node `.node-face-overlay`. **Config editing lives in a `.node-face-popover`** (the 2b popover pattern) reusing `EnvironmentAllowlistEditor compact`; the strip shows the resolved program name + Start/Interrupt/Terminate. The three helpers move to `terminal/node-configuration.ts` (`terminalNodeConfiguration` re-typed to take `data` instead of the whole node) so panel and face share them.
- **File face — lazy-mount strategy (RESOLVED).** The dominant lazy behavior is already free: `CanvasNode` renders no face while collapsed, so mounting `FileEditorWorkspace` inside the face means Monaco mounts on expand and disposes on collapse. On top of that, `FileEditorWorkspace` mounts **only when a real file is assigned** (`data.file` present, `!missing`, `kind === 'file'`); with no assignment the face shows the `ProjectFileBrowser` popover and mounts NO editor. The literal "above min size" guard is implemented with a new `lib/use-above-min-size.ts` (ResizeObserver, `typeof ResizeObserver === 'undefined' → true` fallback exactly like `PreviewNodeFace.tsx:56`): below the file min the face shows a lightweight "Expand to edit this file" placeholder and mounts no Monaco. `FileEditorWorkspace` gets `operations={window.forgeboard.files}` directly (its `FileEditorOperations` seam == `window.forgeboard.files`; no context/IPC needed), `readOnly = graphReadOnly || data.locked || reference.missing || reference.kind !== 'file'`, and assignment persists `{ file: { projectId, relativePath, kind:'file', missing:false, lastKnownHash? } }` mirroring `WorkspaceInspector.tsx:540-561`.
- **Diff face — feasibility (RESOLVED: inline read-only viewer IS feasible).** `GitDiffViewer` (`git-review/diff/GitDiffViewer.tsx`) is a self-contained presentational component: given one `GitDiffDisplayFile` + stage/unstage/discard handlers it renders the hunks; `readOnly` hides the mutation buttons. Its data is a `GitReviewView` from a single IPC (`window.forgeboard.git.review(target)`) — exactly what the shipped `useGitReview(target)` hook loads, and what `DiffReviewNodeInspector`'s summary already fetches. `git-review-model.ts` derives everything else purely: `buildReviewGroups(review)`, `allReviewFiles`, `findReviewFile`, `firstReviewSelection`, `fileDiffStats`, `workingTreeDiffStats`, `statusLabel`, `GitDiffDisplayFile`. **Decision:** the face renders a compact custom file list (from `allReviewFiles`) + `GitDiffViewer` in **read-only** mode (no staging/discard on the face), lazily (mount the review-loading inner component only when expanded && above min && a `GitTargetInput` resolves && `project.health.isGitRepository`); ALL mutating flows (stage/unstage/discard/commit/ship) stay in the existing `GitReviewDialog`, reachable via a "maximize" button that calls a new `openDiffReview(nodeId, request)` context method wrapping `gitReview.openNodeReview` (mirroring `Workspace.tsx:1961-1964`). The face does not need `useDiffReviewNodeController` at all — branch/ahead/behind come from the loaded `review`, and file stats from `workingTreeDiffStats(review)` — so it stays per-node without the selected-node-scoped controller. A tiny new hook is unnecessary: `useGitReview` is already the right lightweight loader; it is called inside a child component that only mounts when the gate is open (hooks stay unconditional).
- **Context churn.** The only new `AgentSessionContext` member is `openDiffReview(nodeId, request)`, a stable `useCallback` — added to the memo + deps like 2b's `openGitPrReadiness`. No new rosters or volatile state; the diff/file/terminal faces read no workflow-runtime state, so `WorkflowRuntimeContext` is untouched. Existing tests that build an `AgentSessionContextValue` literal without casts must add `openDiffReview: vi.fn()` (wrapper-only).
- **Panels stay functional.** `WorkspaceInspector.tsx` keeps `DiffReviewNodeInspector`, `TerminalNodePanel`, and `FileNodeEditor`. The only inspector edits are the three-helper move (import from `terminal/node-configuration.js` instead of local functions) and the one call-site retype `terminalNodeConfiguration(selectedNode.data, props.settings)`. `DiffReviewNodeInspector` and the file editor sections are not touched.
- **No `WorkshopNodeData` schema changes.** Every face renders existing persisted fields (`data.command`, `data.file`, `data.reviewTarget`, `data.viewMode`, `data.showWhitespace`); `CanvasDocument` node `data` is `z.record(z.unknown())`. No preload, no main-process, no IPC additions.

## Global Constraints

- **Execute in the sub-plan 2c worktree:** use the checkout for branch `feature/content-faces-2cd` (based on `main` tip `c7cce93`, which already has 2a + 2b merged). Do not touch another session's checkout. Stage only the files each task names; never `git add -A`.
- **Renderer-only, no new IPC:** this sub-plan adds no IPC channels, no preload surface, and no main-process code. Faces may call only preload APIs the inspectors already call (`terminal.*` via `terminalOperationsFromWindow()`, `files.*`, `git.review`). Any deviation requires explicit justification in the commit message.
- **Panels stay functional:** do not delete or degrade any inspector panel; sidebar removal is sub-plan 2d. Update panel code only for the extractions named in Files lists. Never weaken an existing test assertion — add provider wrappers when a test newly needs context, nothing else.
- **Faces must keep node chrome intact:** collapse (35px pill), lock, group membership, and resize continue to work for all three kinds; every face root is `.node-face` inside the existing `<article class="canvas-node">`, and scroll/drag isolation uses `nowheel nodrag` exactly like `PreviewNodeFace`.
- Run scoped tests from the worktree root: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit <path>`. Typecheck: `corepack pnpm --dir apps/desktop typecheck` (from the worktree root). Lint (verification task): `corepack pnpm lint`. Full unit suite: `corepack pnpm test:unit`.
- The app must build, typecheck, and pass tests after every task. Tasks 1-2 are ordered prerequisites (dimensions → context); Tasks 3-5 (terminal, file, diff) are independent of each other and each registers its own face. Task 6 verifies.
- Commit message suffix (every commit): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All paths below are relative to `apps/desktop/` unless they start with `docs/`.

---

### Task 1: Per-kind dimensions for terminal, file, and diff

**Files:**

- Modify: `src/shared/canvas/node-dimensions.ts` (add `CONTENT_NODE_DIMENSIONS`; consult it in both lookups)
- Modify: `src/renderer/src/styles/workspace/canvas.css` (append `:has(...)` min-size rules after the 2b `test` rule)
- Test: `src/renderer/src/components/workspace/model/node-persistence.test.ts` (append)

**Interfaces (exact values; CSS and later face tests depend on them):**

| kind       | default | minimum |
| ---------- | ------- | ------- |
| `terminal` | 560×480 | 400×320 |
| `file`     | 640×520 | 420×360 |
| `diff`     | 640×560 | 440×360 |

- [ ] **Step 1: Write the failing tests** — append to `node-persistence.test.ts` (same style as the 2a/2b cases):

```ts
it('gives terminal, file, and diff nodes face dimensions', () => {
  expect(initialWorkshopNodeDimensions('terminal')).toEqual({ width: 560, height: 480 });
  expect(initialWorkshopNodeDimensions('file')).toEqual({ width: 640, height: 520 });
  expect(initialWorkshopNodeDimensions('diff')).toEqual({ width: 640, height: 560 });
});

it('floors persisted terminal, file, and diff nodes at their per-kind minimums', () => {
  const floored = (kind: WorkshopNode['data']['kind']) =>
    persistedWorkshopNodeDimensions({
      data: { kind } as WorkshopNode['data'],
      width: 10,
      height: 10,
    });
  expect(floored('terminal')).toEqual({ width: 400, height: 320 });
  expect(floored('file')).toEqual({ width: 420, height: 360 });
  expect(floored('diff')).toEqual({ width: 440, height: 360 });
});
```

- [ ] **Step 2: Run to verify failure** — `.../model/node-persistence.test.ts` → FAIL (all three fall back to 320×180 / 210×92).

- [ ] **Step 3: Implement.**

`src/shared/canvas/node-dimensions.ts` — add after `DOCUMENT_NODE_DIMENSIONS`:

```ts
/** Face dimensions for the heavier content node kinds (sub-plan 2c). */
export const CONTENT_NODE_DIMENSIONS: Readonly<
  Record<string, { readonly default: NodeDimensions; readonly minimum: NodeDimensions }>
> = {
  terminal: { default: { width: 560, height: 480 }, minimum: { width: 400, height: 320 } },
  file: { default: { width: 640, height: 520 }, minimum: { width: 420, height: 360 } },
  diff: { default: { width: 640, height: 560 }, minimum: { width: 440, height: 360 } },
};
```

In `defaultNodeDimensionsForKind`, before the `DOCUMENT_NODE_DIMENSIONS` lookup:

```ts
const contentDimensions = CONTENT_NODE_DIMENSIONS[kind];
if (contentDimensions !== undefined) return contentDimensions.default;
```

In `minimumNodeDimensionsForKind`, before the `DOCUMENT_NODE_DIMENSIONS` lookup:

```ts
const contentDimensions = CONTENT_NODE_DIMENSIONS[kind];
if (contentDimensions !== undefined) return contentDimensions.minimum;
```

`canvas.css` — append after the 2b `test` rule:

```css
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='terminal']:not(.collapsed)) {
  min-width: 400px;
  min-height: 320px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='file']:not(.collapsed)) {
  min-width: 420px;
  min-height: 360px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='diff']:not(.collapsed)) {
  min-width: 440px;
  min-height: 360px;
}
```

- [ ] **Step 4: Run tests + typecheck** — node-persistence test → PASS; `CanvasNode.test.tsx` → PASS (agent/preview/document minimums unchanged); typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/shared/canvas/node-dimensions.ts apps/desktop/src/renderer/src/styles/workspace/canvas.css apps/desktop/src/renderer/src/components/workspace/model/node-persistence.test.ts
git commit -m "feat: per-kind canvas dimensions for terminal, file, and diff node faces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Scaffolding — openDiffReview context callback + size-gate hook + shared face CSS

**Files:**

- Create: `src/renderer/src/lib/use-above-min-size.ts`
- Create: `src/renderer/src/lib/use-above-min-size.test.tsx`
- Modify: `src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx` (add `openDiffReview`)
- Modify: `src/renderer/src/components/workspace/shell/Workspace.tsx` (wire `openDiffReview` into `agentSessionValue` memo + deps)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (add the three kinds to the flex-column face scaffold; add `.node-face-overlay`)

**Interfaces (produced; Tasks 3-5 consume — names must match exactly):**

```ts
// AgentSessionContext.tsx addition to AgentSessionContextValue:
//   openDiffReview(nodeId: string, request: DiffReviewOpenRequest): void;

// lib/use-above-min-size.ts
export function useAboveMinSize(
  ref: RefObject<HTMLElement | null>,
  min: { readonly width: number; readonly height: number },
): boolean;
```

- [ ] **Step 1: Write the failing test** (`use-above-min-size.test.tsx`):

```tsx
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useRef, type JSX } from 'react';

import { useAboveMinSize } from './use-above-min-size.js';

afterEach(cleanup);

function Probe({ width, height }: { width: number; height: number }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const above = useAboveMinSize(ref, { width: 100, height: 100 });
  return (
    <div ref={ref} data-testid="probe">
      {above ? 'above' : 'below'}
    </div>
  );
}

function installResizeObserver(width: number, height: number): void {
  class MockResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        width,
        height,
      } as DOMRect);
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
}

describe('useAboveMinSize', () => {
  it('reports true once the observed box meets both minimums', () => {
    installResizeObserver(200, 200);
    render(<Probe width={200} height={200} />);
    expect(screen.getByTestId('probe').textContent).toBe('above');
    vi.unstubAllGlobals();
  });

  it('reports false when either dimension is under the minimum', () => {
    installResizeObserver(80, 200);
    render(<Probe width={80} height={200} />);
    expect(screen.getByTestId('probe').textContent).toBe('below');
    vi.unstubAllGlobals();
  });

  it('defaults to true when ResizeObserver is unavailable', () => {
    const original = globalThis.ResizeObserver;
    // @ts-expect-error deliberately removing the global for the fallback path
    delete globalThis.ResizeObserver;
    render(<Probe width={10} height={10} />);
    expect(screen.getByTestId('probe').textContent).toBe('above');
    globalThis.ResizeObserver = original;
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.**

`src/renderer/src/lib/use-above-min-size.ts`:

```ts
import { useEffect, useState, type RefObject } from 'react';

/**
 * Reports whether `ref`'s content box is at least `min` wide and tall, tracking
 * live resizes. Faces use it to defer mounting heavy children (Monaco, a Git
 * review payload) until the node is genuinely usable. When ResizeObserver is
 * unavailable (jsdom without a mock) it defaults to true, so eager mounting is
 * the safe fallback.
 */
export function useAboveMinSize(
  ref: RefObject<HTMLElement | null>,
  min: { readonly width: number; readonly height: number },
): boolean {
  const [above, setAbove] = useState(typeof ResizeObserver === 'undefined');

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (typeof ResizeObserver === 'undefined') {
      setAbove(true);
      return;
    }
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setAbove(rect.width >= min.width && rect.height >= min.height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [min.height, min.width, ref]);

  return above;
}
```

`AgentSessionContext.tsx` — add the type import and the interface member:

```ts
import type { DiffReviewOpenRequest } from '../../diff-review/DiffReviewNodeInspector.js';
```

and inside `AgentSessionContextValue`, after `openGitPrReadiness`:

```ts
  openDiffReview(nodeId: string, request: DiffReviewOpenRequest): void;
```

`Workspace.tsx` — add `openDiffReview` to the `agentSessionValue` memo body (next to `openGitPrReadiness`), reading the node from the existing `nodesRef.current`:

```ts
      openDiffReview: (nodeId: string, request: DiffReviewOpenRequest) => {
        const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
        if (node?.data.kind !== 'diff') return;
        gitReview.openNodeReview(nodeId, node.data.reviewTarget, request);
      },
```

Add `DiffReviewOpenRequest` to the existing `diff-review` type import in `Workspace.tsx`, and add `gitReview` to the `agentSessionValue` dependency array (leave the rest untouched).

`node-face.css` — add the three kinds to the shared flex-column scaffold and add the overlay:

```css
.canvas-node[data-node-kind='terminal']:not(.collapsed),
.canvas-node[data-node-kind='file']:not(.collapsed),
.canvas-node[data-node-kind='diff']:not(.collapsed) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.canvas-node[data-node-kind='terminal']:not(.collapsed) > header,
.canvas-node[data-node-kind='file']:not(.collapsed) > header,
.canvas-node[data-node-kind='diff']:not(.collapsed) > header {
  flex: 0 0 auto;
}
.node-face-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: rgb(0 0 0 / 0.45);
}
```

- [ ] **Step 4: Run tests + typecheck.** New hook test → PASS. Run `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.test.tsx` and the shell slice — any test constructing an `AgentSessionContextValue` literal without casts must add `openDiffReview: vi.fn()`; wrapper-only updates. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/lib/use-above-min-size.ts apps/desktop/src/renderer/src/lib/use-above-min-size.test.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: openDiffReview context callback and node-face size-gate scaffolding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Stage any context-literal test files updated in Step 4 as well.)

---

### Task 3: Terminal face (embedded xterm + compact config strip + in-node launch review)

**Files:**

- Create: `src/renderer/src/components/workspace/terminal/node-configuration.ts`
- Create: `src/renderer/src/components/workspace/terminal/TerminalNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/terminal/TerminalNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/shell/WorkspaceInspector.tsx` (delete the three moved helpers; import from `node-configuration.js`; retype the call site)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `terminal`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx` (move `terminal` to the function case)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append terminal rules)

**Extraction (moves, behavior-preserving):** move `terminalNodeConfiguration`, `terminalCommandConfiguration`, and `terminalSessionNodeStatus` out of `WorkspaceInspector.tsx:469-503` into `node-configuration.ts`. `terminalNodeConfiguration` is re-typed to take `data: WorkshopNodeData` (not the whole `WorkshopNode`) and `settings: AppSettings`. `WorkspaceInspector.tsx` imports the three from `../terminal/node-configuration.js` and updates its call site to `terminalNodeConfiguration(selectedNode.data, props.settings)`.

**Interfaces:**

```ts
// node-configuration.ts
export function terminalNodeConfiguration(
  data: WorkshopNodeData,
  settings: AppSettings,
): TerminalNodeConfiguration;
export function terminalCommandConfiguration(
  configuration: TerminalNodeConfiguration,
): NonNullable<WorkshopNodeData['command']>;
export function terminalSessionNodeStatus(
  status: TerminalSessionStatus | undefined,
  exitCode: number | null | undefined,
): WorkshopNodeData['status'];
```

- [ ] **Step 1: Write the failing test** (`TerminalNodeFace.test.tsx`). The terminal operations are stubbed via a mocked `terminalOperationsFromWindow`, and `TerminalSurface` is mocked to a marker so the test asserts wiring, not xterm:

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const listSessions = vi.hoisted(() => vi.fn());
const onEvent = vi.hoisted(() => vi.fn(() => () => undefined));
vi.mock('./types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types.js')>();
  return {
    ...actual,
    terminalOperationsFromWindow: () => ({
      listSessions,
      onEvent,
      replay: vi.fn(),
      getSession: vi.fn(),
      chooseExecutable: vi.fn(),
      prepareLaunch: vi.fn(),
      confirmLaunch: vi.fn(),
      cancelLaunch: vi.fn(),
      sendInput: vi.fn(),
      resize: vi.fn(),
      interrupt: vi.fn(),
      terminate: vi.fn(),
    }),
  };
});
vi.mock('./TerminalSurface.js', () => ({
  TerminalSurface: () => <div data-testid="terminal-surface" />,
}));

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { TerminalNodeFace } from './TerminalNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  listSessions.mockResolvedValue({ ok: true, value: [] });
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    settings: { terminalShell: '/bin/zsh', envAllowlist: ['PATH'] } as AppSettings,
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    reportError: vi.fn(),
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'terminal',
    title: 'Build',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8dbd6f',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <TerminalNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TerminalNodeFace', () => {
  it('shows the resolved program on the strip and mounts the terminal surface', async () => {
    renderFace();
    expect(await screen.findByTestId('terminal-surface')).toBeTruthy();
    expect(screen.getByLabelText('Terminal').textContent).toContain('zsh');
  });

  it('edits configuration in the popover and persists it as command', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Configure terminal' }));
    const program = screen.getByLabelText('Program');
    fireEvent.focus(program);
    fireEvent.change(program, { target: { value: '/usr/bin/make' } });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        command: expect.objectContaining({ executable: '/usr/bin/make' }),
      }),
    );
  });

  it('disables Start and the config popover for locked nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Review and start' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Configure terminal' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.**

`node-configuration.ts` (verbatim moves of `WorkspaceInspector.tsx:469-503`, `terminalNodeConfiguration` re-typed to `data`):

```ts
import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { TerminalSessionStatus } from '../../../../../shared/terminal/index.js';
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import type { TerminalNodeConfiguration } from './types.js';

export function terminalNodeConfiguration(
  data: WorkshopNodeData,
  settings: AppSettings,
): TerminalNodeConfiguration {
  const command = data.command;
  return {
    executable: command?.executable ?? settings.terminalShell,
    arguments: command?.arguments ?? [],
    cwdRelative: command?.cwdRelative ?? '.',
    environmentVariableNames: command?.environmentNames ?? settings.envAllowlist,
  };
}

export function terminalCommandConfiguration(
  configuration: TerminalNodeConfiguration,
): NonNullable<WorkshopNodeData['command']> {
  return {
    executable: configuration.executable,
    arguments: [...configuration.arguments],
    cwdRelative: configuration.cwdRelative,
    environmentNames: [...configuration.environmentVariableNames],
  };
}

export function terminalSessionNodeStatus(
  status: TerminalSessionStatus | undefined,
  exitCode: number | null | undefined,
): WorkshopNodeData['status'] {
  if (status === undefined) return 'idle';
  if (status === 'starting') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'interrupted' || status === 'terminated') return 'cancelled';
  if (status === 'exited') return exitCode === 0 ? 'succeeded' : 'failed';
  return 'failed';
}
```

`WorkspaceInspector.tsx` edits: delete the three local functions (`:469-503`); add `import { terminalCommandConfiguration, terminalNodeConfiguration, terminalSessionNodeStatus } from '../terminal/node-configuration.js';`; change the `configuration={terminalNodeConfiguration(selectedNode, props.settings)}` call at `:357` to `configuration={terminalNodeConfiguration(selectedNode.data, props.settings)}`. (The `terminalCommandConfiguration`/`terminalSessionNodeStatus` call sites at `:361`/`:367` are unchanged.)

`TerminalNodeFace.tsx`:

```tsx
import { CircleStop, Keyboard, Play, RotateCcw, Settings2, TerminalSquare } from 'lucide-react';
import { useRef, useState, type JSX } from 'react';

import { EnvironmentAllowlistEditor } from '../../configuration/EnvironmentAllowlistEditor.js';
import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';
import { TerminalLaunchReviewDialog } from './TerminalLaunchReviewDialog.js';
import { TerminalSurface, type TerminalSurfaceHandle } from './TerminalSurface.js';
import { terminalCommandConfiguration, terminalNodeConfiguration } from './node-configuration.js';
import { terminalOperationsFromWindow, type TerminalNodeConfiguration } from './types.js';
import { useTerminalNodeController } from './useTerminalNodeController.js';
import './terminal-node.css';

/**
 * Terminal face: the live xterm session fills the node body (mirroring the
 * agent-session embed), a compact strip shows the resolved program plus
 * Start/Interrupt/Terminate, and the executable/arguments/cwd/env are edited in
 * a node-anchored popover. The launch review renders as an in-node overlay.
 */
export function TerminalNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const configuration = terminalNodeConfiguration(data, session.settings);
  const surfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  const [configuring, setConfiguring] = useState(false);

  const controller = useTerminalNodeController({
    projectId: session.project.id,
    nodeId: id,
    configuration,
    onError: session.reportError,
    operations: terminalOperationsFromWindow(),
  });

  const program = configuration.executable.split(/[\\/]/u).at(-1) ?? configuration.executable;
  const mutationBusy = controller.busy !== null || controller.pendingPlan !== null;
  const canStart = !readOnly && !controller.active && !mutationBusy;

  const updateConfiguration = (patch: Partial<TerminalNodeConfiguration>): void => {
    session.recordHistory();
    session.updateNodeData(id, {
      command: terminalCommandConfiguration({ ...configuration, ...patch }),
    });
  };

  return (
    <section className="node-face terminal-node-face" aria-label="Terminal">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <TerminalSquare size={12} aria-hidden="true" /> {program === '' ? 'No program' : program}
        </span>
        {controller.active ? (
          <>
            <button
              type="button"
              aria-label="Interrupt"
              disabled={controller.busy !== null}
              onClick={() => void controller.interrupt()}
            >
              <Keyboard size={12} aria-hidden="true" /> Interrupt
            </button>
            <button
              type="button"
              className="danger-text"
              aria-label="Terminate"
              disabled={controller.busy !== null && controller.busy !== 'interrupting'}
              onClick={() => void controller.terminate()}
            >
              <CircleStop size={12} aria-hidden="true" /> Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label={controller.session === null ? 'Review and start' : 'Review and restart'}
            disabled={!canStart}
            onClick={() => void controller.prepareLaunch()}
          >
            {controller.session === null ? (
              <Play size={12} aria-hidden="true" />
            ) : (
              <RotateCcw size={12} aria-hidden="true" />
            )}
            {controller.session === null ? 'Start' : 'Restart'}
          </button>
        )}
        <button
          type="button"
          aria-label="Configure terminal"
          aria-pressed={configuring}
          disabled={readOnly || controller.active}
          onClick={() => setConfiguring((open) => !open)}
        >
          <Settings2 size={12} aria-hidden="true" /> Configure
        </button>
      </div>

      <div className="node-face-body nowheel nodrag">
        <div className="terminal-face-surface">
          <TerminalSurface
            ref={surfaceRef}
            sessionId={controller.session?.id ?? null}
            output={controller.output}
            inputEnabled={controller.active && !readOnly && controller.busy === null}
            onInput={(chunk) => controller.sendInput(chunk)}
            onResize={(columns, rows) => controller.resize(columns, rows)}
          />
          {controller.session === null ? (
            <p className="node-face-hint">Choose a program, then Start to run it here.</p>
          ) : null}
        </div>
        {controller.error !== null ? (
          <p className="terminal-face-error" role="alert">
            {controller.error}
          </p>
        ) : null}

        {configuring ? (
          <div className="node-face-popover" aria-label="Terminal configuration">
            <label className="node-face-row">
              Program
              <input
                type="text"
                aria-label="Program"
                name={`node-${id}-terminal-face-executable`}
                value={configuration.executable}
                readOnly={readOnly}
                onFocus={session.recordHistory}
                onChange={
                  readOnly
                    ? undefined
                    : (event) => updateConfiguration({ executable: event.target.value })
                }
              />
            </label>
            <label className="node-face-row">
              Folder
              <input
                type="text"
                aria-label="Folder to run in"
                name={`node-${id}-terminal-face-cwd`}
                value={configuration.cwdRelative}
                placeholder="."
                readOnly={readOnly}
                onFocus={session.recordHistory}
                onChange={
                  readOnly
                    ? undefined
                    : (event) => updateConfiguration({ cwdRelative: event.target.value })
                }
              />
            </label>
            <EnvironmentAllowlistEditor
              name={`node-${id}-terminal-face-environment`}
              value={configuration.environmentVariableNames}
              compact
              onChange={
                readOnly
                  ? () => undefined
                  : (environmentVariableNames) => updateConfiguration({ environmentVariableNames })
              }
            />
          </div>
        ) : null}
      </div>

      {controller.pendingPlan !== null ? (
        <div className="node-face-overlay nodrag" role="dialog" aria-label="Review terminal launch">
          <TerminalLaunchReviewDialog
            plan={controller.pendingPlan}
            busy={controller.busy === 'confirming' || controller.busy === 'cancelling-plan'}
            onCancel={() => void controller.cancelLaunch()}
            onContinue={() => void controller.confirmLaunch()}
          />
        </div>
      ) : null}
    </section>
  );
}
```

`node-face-registry.tsx` — add import and entry:

```tsx
import { TerminalNodeFace } from '../../terminal/TerminalNodeFace.js';
// in FACES:
  terminal: TerminalNodeFace,
```

`node-face-registry.test.tsx` — move `terminal` from the null-case to the function-case:

```tsx
expect(nodeFaceForKind('terminal')).toBeTypeOf('function');
```

and delete the `expect(nodeFaceForKind('file')).toBeNull();` line's `terminal` sibling if present (only `terminal` moves in this task; `file`/`diff` move in Tasks 4/5).

`node-face.css` — append:

```css
.terminal-face-surface {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.terminal-face-surface > .node-face-hint {
  position: absolute;
  inset: 0;
  margin: auto;
}
.terminal-face-error {
  margin: 0;
  color: #d06870;
}
```

- [ ] **Step 4: Run tests + typecheck.** `TerminalNodeFace.test.tsx` → PASS; `terminal/TerminalNodePanel.test.tsx` → PASS unchanged (helpers now imported from `node-configuration.js`); `WorkspaceInspector.test.tsx` → PASS unchanged; registry test → PASS. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/terminal/node-configuration.ts apps/desktop/src/renderer/src/components/workspace/terminal/TerminalNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/terminal/TerminalNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/shell/WorkspaceInspector.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: terminal session and config render on the node face

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: File face (lazy Monaco editor + ProjectFileBrowser assignment popover)

**Files:**

- Create: `src/renderer/src/components/workspace/content/file/FileNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/content/file/FileNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `file`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx` (move `file` to the function case)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append file rules)

**Interfaces:** consumes `FileEditorWorkspace` (`components/file-editor/tabs/FileEditorWorkspace.js`), `ProjectFileBrowser` + `ProjectFileSelection` (`components/file-editor/browser/ProjectFileBrowser.js`), `useAboveMinSize`, `NodeFaceProps`. Data model: `data.file` = `{ projectId; relativePath; kind: 'file'|'directory'|'image'|'artifact'; missing: boolean; lastKnownHash? }` (persisted, `CanvasNode.tsx:71-77`).

- [ ] **Step 1: Write the failing test** (`FileNodeFace.test.tsx`). `FileEditorWorkspace` and `ProjectFileBrowser` are mocked to markers (avoids Monaco + file IPC); the assignment path is asserted through the mock's `onSelect`:

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../../file-editor/tabs/FileEditorWorkspace.js', () => ({
  FileEditorWorkspace: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="file-editor" data-readonly={String(readOnly)} />
  ),
}));
vi.mock('../../../../file-editor/browser/ProjectFileBrowser.js', () => ({
  ProjectFileBrowser: ({
    onSelect,
  }: {
    onSelect: (selection: {
      projectId: string;
      relativePath: string;
      document: { sha256: string | null };
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="file-browser"
      onClick={() =>
        onSelect({ projectId: 'p1', relativePath: 'src/app.ts', document: { sha256: 'abc' } })
      }
    >
      pick
    </button>
  ),
}));

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { FileNodeFace } from './FileNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'file',
    title: 'File',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#6d9ed0',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <FileNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

const fileReference = {
  projectId: 'p1',
  relativePath: 'src/app.ts',
  kind: 'file' as const,
  missing: false,
};

describe('FileNodeFace', () => {
  it('shows the file browser and mounts no editor without an assignment', () => {
    renderFace();
    expect(screen.getByTestId('file-browser')).toBeTruthy();
    expect(screen.queryByTestId('file-editor')).toBeNull();
  });

  it('persists the chosen file assignment', () => {
    renderFace();
    fireEvent.click(screen.getByTestId('file-browser'));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      file: {
        projectId: 'p1',
        relativePath: 'src/app.ts',
        kind: 'file',
        missing: false,
        lastKnownHash: 'abc',
      },
    });
  });

  it('mounts the editor when a file is assigned (ResizeObserver absent → eager)', () => {
    renderFace({ file: fileReference });
    expect(screen.getByTestId('file-editor')).toBeTruthy();
    expect(screen.getByTestId('file-editor').getAttribute('data-readonly')).toBe('false');
  });

  it('opens read-only for locked nodes', () => {
    renderFace({ file: fileReference, locked: true });
    expect(screen.getByTestId('file-editor').getAttribute('data-readonly')).toBe('true');
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.** `FileNodeFace.tsx`:

```tsx
import { FolderSearch, Replace, type LucideProps } from 'lucide-react';
import { useEffect, useRef, useState, type JSX } from 'react';

import {
  ProjectFileBrowser,
  type ProjectFileSelection,
} from '../../../../file-editor/browser/ProjectFileBrowser.js';
import { FileEditorWorkspace } from '../../../../file-editor/tabs/FileEditorWorkspace.js';
import { minimumNodeDimensionsForKind } from '../../../../../../shared/canvas/node-dimensions.js';
import { useAboveMinSize } from '../../../../../lib/use-above-min-size.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

const FILE_FACE_MINIMUM = minimumNodeDimensionsForKind('file');

/**
 * File face: the Monaco-backed FileEditorWorkspace fills the node body, but only
 * mounts while the node is expanded, has a usable file assignment, and is above
 * the file kind's minimum size — one Monaco instance per visible expanded file
 * node is the perf concern this guards. File assignment uses a ProjectFileBrowser
 * popover. Alt-text/relink and agent-context sharing stay in the panel until 2d.
 */
export function FileNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const reference = data.file;
  const graphReadOnly = session.graphReadOnly || interactions.readOnly;
  const [browsing, setBrowsing] = useState(reference === undefined || reference.missing);
  const large = useAboveMinSize(bodyRef, FILE_FACE_MINIMUM);

  useEffect(() => {
    if (reference === undefined || reference.missing) setBrowsing(true);
  }, [reference?.missing, reference?.projectId, reference?.relativePath]);

  const editable = reference !== undefined && !reference.missing && reference.kind === 'file';
  const editorReadOnly = graphReadOnly || data.locked || !editable;

  const selectFile = (selection: ProjectFileSelection): void => {
    session.recordHistory();
    session.updateNodeData(id, {
      file: {
        projectId: selection.projectId,
        relativePath: selection.relativePath,
        kind: 'file',
        missing: false,
        ...(selection.document.sha256 === null ? {} : { lastKnownHash: selection.document.sha256 }),
      },
    });
    setBrowsing(false);
  };

  return (
    <section className="node-face file-node-face" aria-label="File editor">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {reference === undefined ? 'No file assigned' : reference.relativePath}
        </span>
        <button
          type="button"
          aria-label={reference === undefined ? 'Choose file' : 'Change file'}
          aria-pressed={browsing}
          disabled={data.locked || graphReadOnly}
          onClick={() => setBrowsing((open) => !open)}
        >
          {reference === undefined ? <FolderSearch {...ICON} /> : <Replace {...ICON} />}
          {reference === undefined ? 'Choose' : 'Change'}
        </button>
      </div>

      <div className="node-face-body nowheel nodrag" ref={bodyRef}>
        {reference !== undefined && reference.kind !== 'file' ? (
          <p className="node-face-hint" role="status">
            This node points to a {reference.kind}. Choose a file to edit it here.
          </p>
        ) : !editable ? (
          <p className="node-face-hint">Choose a file from this project to edit it on the node.</p>
        ) : !large ? (
          <p className="node-face-hint">Make this node larger to edit the file.</p>
        ) : (
          <FileEditorWorkspace
            primary={{ projectId: reference.projectId, relativePath: reference.relativePath }}
            operations={window.forgeboard.files}
            readOnly={editorReadOnly}
            onBrowseFiles={() => setBrowsing(true)}
            onRevealInTree={() => setBrowsing(true)}
          />
        )}

        {browsing ? (
          <div className="node-face-popover" aria-label="Choose a project file">
            <ProjectFileBrowser
              projectId={session.project.id}
              operations={window.forgeboard.files}
              {...(reference === undefined ? {} : { selectedRelativePath: reference.relativePath })}
              assignmentDisabled={data.locked}
              onSelect={selectFile}
              {...(reference === undefined ? {} : { onCancel: () => setBrowsing(false) })}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

const ICON: LucideProps = { size: 12, 'aria-hidden': true };
```

`node-face-registry.tsx` — add import and entry:

```tsx
import { FileNodeFace } from '../../content/file/FileNodeFace.js';
// in FACES:
  file: FileNodeFace,
```

`node-face-registry.test.tsx` — remove `expect(nodeFaceForKind('file')).toBeNull();` and add to the function case:

```tsx
expect(nodeFaceForKind('file')).toBeTypeOf('function');
```

`node-face.css` — append:

```css
.file-node-face .node-face-body {
  padding: 0;
}
.file-node-face .file-editor-workspace {
  flex: 1;
  min-height: 0;
}
```

- [ ] **Step 4: Run tests + typecheck.** `FileNodeFace.test.tsx` → PASS; `file-editor/tabs/FileEditorWorkspace.test.tsx` and `FileEditorPanel.test.tsx` → PASS unchanged; `WorkspaceInspector.test.tsx` → PASS (FileNodeEditor untouched); registry test → PASS. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/file/FileNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/content/file/FileNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: lazy Monaco file editor on the node face with browser assignment

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Diff face (inline read-only GitDiffViewer + compact file list + maximize)

**Files:**

- Create: `src/renderer/src/components/workspace/content/diff/DiffNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/content/diff/DiffNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `diff`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx` (move `diff` to the function case)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append diff rules)

**Interfaces:** consumes `useGitReview` (`components/git-review/useGitReview.js`), `GitDiffViewer` (`components/git-review/diff/GitDiffViewer.js`), `git-review-model` (`buildReviewGroups`, `allReviewFiles`, `findReviewFile`, `firstReviewSelection`, `fileDiffStats`, `statusLabel`, `workingTreeDiffStats`, `GitFileSelection`), `GitTargetInputSchema` + `GitTargetInput` (`shared/git/contracts.js`), `openDiffReview` from context, `useAboveMinSize`, `NodeFaceProps`. The heavy child (which calls `useGitReview`) is an inner component mounted only when the gate is open, so the hook stays unconditional.

- [ ] **Step 1: Write the failing test** (`DiffNodeFace.test.tsx`). `useGitReview` and `GitDiffViewer` are mocked so the test asserts wiring (target build, file list, maximize) without real Git IPC:

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const useGitReview = vi.hoisted(() => vi.fn());
vi.mock('../../../../git-review/useGitReview.js', () => ({ useGitReview }));
vi.mock('../../../../git-review/diff/GitDiffViewer.js', () => ({
  GitDiffViewer: ({ file }: { file: { path: string } | null }) => (
    <div data-testid="diff-viewer">{file?.path ?? 'none'}</div>
  ),
}));

import type { GitReviewView } from '../../../../../../shared/git/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { DiffNodeFace } from './DiffNodeFace.js';

const openDiffReview = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  openDiffReview.mockClear();
  useGitReview.mockReturnValue({
    review: reviewWithFile('src/app.ts'),
    loading: false,
    busyLabel: null,
    error: null,
  });
});

function reviewWithFile(path: string): GitReviewView {
  return {
    target: { kind: 'primary', projectId: 'p1' },
    branch: 'main',
    dirty: true,
    conflicted: false,
    ahead: 1,
    behind: 0,
    refreshedAt: new Date().toISOString(),
    entries: [{ path, index: 'M', worktree: '.', kind: 'modified', originalPath: null }],
    staged: {
      additions: 3,
      deletions: 1,
      files: [{ newPath: path, oldPath: path, status: 'modified', binary: false, hunks: [] }],
    },
    unstaged: { additions: 0, deletions: 0, files: [] },
  } as unknown as GitReviewView;
}

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1', name: 'Demo', health: { isGitRepository: true } },
    graphReadOnly: false,
    openDiffReview,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'diff',
    title: 'Review',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#e27b68',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <DiffNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('DiffNodeFace', () => {
  it('renders the compact file list and the selected file in the viewer', () => {
    renderFace();
    expect(screen.getByRole('button', { name: /src\/app\.ts/ })).toBeTruthy();
    expect(screen.getByTestId('diff-viewer').textContent).toBe('src/app.ts');
  });

  it('maximizes into the full review dialog with the persisted preferences', () => {
    renderFace({ viewMode: 'split', showWhitespace: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
    expect(openDiffReview).toHaveBeenCalledWith('n1', {
      target: { kind: 'primary', projectId: 'p1' },
      preferences: { viewMode: 'split', showWhitespace: true },
      purpose: 'review',
    });
  });

  it('shows a hint instead of the viewer when the project is not a Git repo', () => {
    const value = sessionValue();
    (value.project.health as { isGitRepository: boolean }).isGitRepository = false;
    render(
      <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
        <AgentSessionProvider value={value}>
          <DiffNodeFace id="n1" data={nodeData()} />
        </AgentSessionProvider>
      </CanvasNodeInteractionProvider>,
    );
    expect(screen.queryByTestId('diff-viewer')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('not tracked by Git');
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.** `DiffNodeFace.tsx`:

```tsx
import { FileCode2, Maximize2 } from 'lucide-react';
import { useMemo, useRef, useState, type JSX } from 'react';

import {
  GitTargetInputSchema,
  type GitTargetInput,
} from '../../../../../../shared/git/contracts.js';
import { minimumNodeDimensionsForKind } from '../../../../../../shared/canvas/node-dimensions.js';
import { useAboveMinSize } from '../../../../../lib/use-above-min-size.js';
import {
  allReviewFiles,
  buildReviewGroups,
  fileDiffStats,
  findReviewFile,
  firstReviewSelection,
  statusLabel,
  workingTreeDiffStats,
  type GitFileSelection,
} from '../../../../git-review/git-review-model.js';
import { GitDiffViewer } from '../../../../git-review/diff/GitDiffViewer.js';
import { useGitReview } from '../../../../git-review/useGitReview.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

const DIFF_FACE_MINIMUM = minimumNodeDimensionsForKind('diff');
const noop = (): void => undefined;

/**
 * Diff face: a compact changed-file list plus an inline, read-only GitDiffViewer.
 * All staging/discard/commit/delivery stays in the full GitReviewDialog, reached
 * via the "Open review" maximize button (openDiffReview). The review payload is
 * loaded only while the node is expanded, above the diff kind's minimum size, the
 * target resolves, and the project is a Git repo.
 */
export function DiffNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const large = useAboveMinSize(bodyRef, DIFF_FACE_MINIMUM);
  const preferences = {
    viewMode: data.viewMode ?? 'split',
    showWhitespace: data.showWhitespace ?? false,
  };

  const target = useMemo<GitTargetInput | null>(() => {
    const candidate =
      data.reviewTarget?.kind === 'agent-run'
        ? { kind: 'agent-worktree', projectId: session.project.id, runId: data.reviewTarget.runId }
        : { kind: 'primary', projectId: session.project.id };
    const parsed = GitTargetInputSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [data.reviewTarget, session.project.id]);

  const isGitRepo = session.project.health.isGitRepository;

  return (
    <section className="node-face diff-node-face" aria-label="Review changes">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <FileCode2 size={12} aria-hidden="true" />
          {data.reviewTarget?.kind === 'agent-run' ? 'Agent run' : session.project.name}
        </span>
        <button
          type="button"
          aria-label="Open review"
          disabled={target === null || !isGitRepo}
          onClick={() => {
            if (target === null) return;
            session.openDiffReview(id, { target, preferences, purpose: 'review' });
          }}
        >
          <Maximize2 size={12} aria-hidden="true" /> Open review
        </button>
      </div>

      <div className="node-face-body nowheel nodrag" ref={bodyRef}>
        {!isGitRepo ? (
          <p className="node-face-hint" role="status">
            This project folder is not tracked by Git, so there is nothing to review.
          </p>
        ) : target === null ? (
          <p className="node-face-hint" role="status">
            The saved review target is not valid. Open the review to pick another.
          </p>
        ) : !large ? (
          <p className="node-face-hint">Make this node larger to see the changes.</p>
        ) : (
          <DiffFaceViewer target={target} preferences={preferences} />
        )}
      </div>
    </section>
  );
}

function DiffFaceViewer({
  target,
  preferences,
}: {
  readonly target: GitTargetInput;
  readonly preferences: { viewMode: 'split' | 'unified'; showWhitespace: boolean };
}): JSX.Element {
  const { review, loading, error } = useGitReview(target);
  const [selection, setSelection] = useState<GitFileSelection | null>(null);

  const groups = useMemo(() => (review === null ? null : buildReviewGroups(review)), [review]);
  const files = groups === null ? [] : allReviewFiles(groups);
  const effectiveSelection = selection ?? (groups === null ? null : firstReviewSelection(groups));
  const file = groups === null ? null : findReviewFile(groups, effectiveSelection);
  const totals = review === null ? null : workingTreeDiffStats(review);

  if (error !== null) {
    return (
      <p className="node-face-hint" role="alert">
        {error}
      </p>
    );
  }
  if (loading || review === null) {
    return (
      <p className="node-face-hint" role="status" aria-busy={true}>
        Loading the current Git changes…
      </p>
    );
  }
  if (files.length === 0) {
    return <p className="node-face-hint">No changes to review right now.</p>;
  }

  return (
    <div className="diff-face-split">
      <nav className="diff-face-files" aria-label="Changed files">
        {totals !== null ? (
          <p className="diff-face-totals">
            {totals.files} {totals.files === 1 ? 'file' : 'files'} · +{totals.additions} −
            {totals.deletions}
          </p>
        ) : null}
        <ul>
          {files.map((entry) => {
            const active =
              effectiveSelection !== null &&
              effectiveSelection.area === entry.area &&
              effectiveSelection.path === entry.path;
            const stats = fileDiffStats(entry);
            return (
              <li key={`${entry.area}:${entry.path}`}>
                <button
                  type="button"
                  className={active ? 'active' : ''}
                  aria-pressed={active}
                  aria-label={`${entry.path} (${statusLabel(entry)})`}
                  onClick={() => setSelection({ area: entry.area, path: entry.path })}
                >
                  <strong title={entry.path}>{entry.path}</strong>
                  <small>
                    {statusLabel(entry)}
                    {entry.diff ? ` · +${stats.additions} −${stats.deletions}` : ''}
                  </small>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="diff-face-viewer">
        <GitDiffViewer
          file={file}
          busy={false}
          readOnly={true}
          displayPreferences={preferences}
          onStageHunk={noop}
          onUnstageHunk={noop}
          onPrepareDiscard={noop}
        />
      </div>
    </div>
  );
}
```

`node-face-registry.tsx` — add import and entry:

```tsx
import { DiffNodeFace } from '../../content/diff/DiffNodeFace.js';
// in FACES:
  diff: DiffNodeFace,
```

`node-face-registry.test.tsx` — remove `expect(nodeFaceForKind('diff')).toBeNull();` and add:

```tsx
expect(nodeFaceForKind('diff')).toBeTypeOf('function');
```

(the registry test's null-case should now only assert kinds that remain generic, e.g. `group-frame`, `extension`, `unknown-kind`.)

`node-face.css` — append:

```css
.diff-face-split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(120px, 34%) 1fr;
  gap: 8px;
}
.diff-face-files {
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--line);
}
.diff-face-totals {
  margin: 0 0 4px;
  color: var(--text-soft);
}
.diff-face-files ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.diff-face-files button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text-soft);
  text-align: left;
  cursor: pointer;
}
.diff-face-files button.active {
  border-color: var(--line-strong);
  background: var(--surface-raised);
}
.diff-face-files strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.diff-face-viewer {
  min-height: 0;
  overflow: auto;
}
```

- [ ] **Step 4: Run tests + typecheck.** `DiffNodeFace.test.tsx` → PASS; `git-review/diff/GitDiffViewer.test.tsx` and `diff-review/DiffReviewNodeInspector.test.tsx` → PASS unchanged (neither touched); registry test → PASS. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/diff/DiffNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/content/diff/DiffNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: inline read-only diff review on the node face with maximize to dialog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `corepack pnpm --dir apps/desktop typecheck` → clean.
- [ ] **Step 2:** From the worktree root: `corepack pnpm lint` → clean; `corepack pnpm test:unit` → green (record any pre-existing failures and confirm they fail identically on the pre-task baseline commit `c7cce93` before ignoring).
- [ ] **Step 3:** Focused slice (must pass): `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace apps/desktop/src/renderer/src/lib apps/desktop/src/renderer/src/components/file-editor apps/desktop/src/renderer/src/components/git-review`.
- [ ] **Step 4:** Manual smoke via `corepack pnpm --dir apps/desktop dev` — NOTE: launching Electron from this worktree requires the electron-dist clone fix (copy `dist/` + `path.txt` from the main checkout's electron package into this worktree's; see the project memory "Worktree Electron fix"):
  - All three kinds: add the node → face renders at its stated default size (terminal 560×480, file 640×520, diff 640×560); resize respects the stated minimum; collapse → 35px pill and back; lock disables face editing; the inspector panel for the same node still works alongside the face.
  - `terminal`: Configure popover edits program/folder/env and persists to `data.command`; Start runs the in-node launch review overlay, then the live session fills the body; Interrupt/Stop appear while active; typing works; a config change while running is reflected on the next restart; the sidebar `TerminalNodePanel` still starts/stops the same node.
  - `file`: with no assignment the browser popover shows and NO Monaco mounts; choose a file → Monaco loads; shrink below min → editor unmounts and the "make larger" hint shows, grow back → it remounts; collapse → Monaco disposes; a directory/missing reference shows the guidance hint; the sidebar file editor still edits the same file.
  - `diff`: compact file list + inline read-only GitDiffViewer render for the resolved target; selecting a file swaps the hunks; "Open review" opens the full `GitReviewDialog` with the node's saved layout/whitespace preferences and staging/commit works there; a non-Git project shows the "not tracked by Git" hint; the sidebar `DiffReviewNodeInspector` still configures the target.
  - Scroll inside every face body scrolls content (nowheel), dragging by the node header still moves the node, and canvas zoom is unaffected.
- [ ] **Step 5:** Check off this plan's boxes and commit the plan file: `git add docs/superpowers/plans/2026-07-21-terminal-file-diff-faces.md && git commit -m "docs: terminal, file, and diff faces plan executed"` (with the co-author trailer).
