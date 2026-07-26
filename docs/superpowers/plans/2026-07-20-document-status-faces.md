# Document & Status Node Faces (sub-plan 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eight node kinds — `diagram`, `whiteboard`, `brief`, `note-image`, `task`, `review-gate`, `git-pr`, `test` — render their actual content on the node face (replacing the generic title/description `.node-body`), all pure DOM/SVG, following the shipped `AgentSessionNode`/`PreviewNodeFace` pattern. Inspector panels remain mounted and fully functional (sidebar retirement is sub-plan 2d); faces coexist with panels.

**Architecture:** `CanvasNode` stops special-casing kinds and consults a static face registry (`canvas/faces/node-face-registry.tsx`, kind → component). Faces read services from `AgentSessionContext` (extended with two low-churn rosters and one navigation callback, kept referentially stable via a new `useKeyedStable` helper) and, for the two workflow-driven faces, from a new `WorkflowRuntimeContext` that carries the volatile `useWorkflowRuns` state so workflow output events re-render only the faces that consume them. Reusable pieces are extracted from the existing inspectors (`useMermaidDiagram`, `WhiteboardPreview`, `useNoteImagePreviews`, `gitPrConfiguration`/`gitPrNodeDataPatch`, `updatedCriteria`/`gateLabel`/`gateLabelFromView`); compact row editors are lightly duplicated where the inspector layout is sidebar-shaped. Per-kind dimensions extend the 2a lookup in `shared/canvas/node-dimensions.ts`; per-kind CSS hangs off the existing `data-node-kind` attribute.

**Tech Stack:** React 19 + @xyflow/react v12 (vitest jsdom + testing-library), zod contracts (unchanged), plain CSS with design tokens. Renderer-only — no main-process or preload changes.

**Spec:** `docs/superpowers/specs/2026-07-20-content-on-node-design.md` §2b.

## Plan-time findings

- `CanvasNode.tsx:194-197` and `:293-297` branch on ad-hoc `agentWindow`/`previewFace` booleans; with eight more kinds this becomes a registry. All eight target kinds are `builtin(...)` in `node-registry/registry.ts` with `resizable: true, collapsible: true`, and the generic header (collapse pill, lock glyph, status dot) plus `NodeResizer` are outside the face branch — collapse (35px pill via `canvas.css:157-160`), lock, group, and resize behaviors are untouched by construction.
- 2a already generalized sizing: `node-persistence.ts` and `CanvasNode.tsx:191` route through `defaultNodeDimensionsForKind`/`minimumNodeDimensionsForKind`. The 2b dimensions batch therefore touches only `shared/canvas/node-dimensions.ts`, `styles/workspace/canvas.css`, and tests — no persistence changes.
- Services audit (the "what do faces need beyond AgentSessionContext" question):
  - diagram / brief / note-image / whiteboard faces need only the existing context (`project`, `graphReadOnly`, `updateNodeData`, `recordHistory`, `reportError`) plus direct `window.forgeboard.files.chooseImage`/`loadImage` calls exactly as `NoteImageInspector` makes today. **No new IPC.**
  - task face needs the agent-node list; review-gate needs the test-node list with `checkProducerId`; git-pr's `useGitPrNodeController` needs `{id, data:{title}}` node labels and `{id, label}` agent labels (`useGitPrNodeController.ts:759` uses only `.label`; `AgentSessionContextValue.runnableAgents` already is `(AgentDetection & {id})[]` with `label`). → `AgentSessionContextValue` gains `nodeRoster`, `checkProducers`, and `openGitPrReadiness(runId)` (wrapping `gitReview.openTarget`, mirroring `Workspace.tsx:1826-1832`).
  - test and review-gate faces need `useWorkflowRuns` state (`executions`, `interactionEvents`, `busyAction`, `mutationsAuthorized`, start/cancel, artifact reveal/open — today threaded through `WorkspaceInspector` props at `Workspace.tsx:1802-1820`) plus the review-gate view map (`Workspace.tsx:1092`) and the pending-decision list (`Workspace.tsx:1210-1213`, dialog state at `:222`). This state churns on every workflow output event, so it goes in a **separate** `WorkflowRuntimeContext` — putting it on `AgentSessionContext` would re-render every agent terminal and preview webview face per event.
  - Rosters churn with every `nodes` array identity change (each drag frame). A `useKeyedStable` helper keeps the roster reference stable unless its content key changes, so `agentSessionValue` does not churn during drags.
- Clean extractions (moves): the debounced render effect `MermaidDiagramInspector.tsx:28-62` → `useMermaidDiagram`; `WhiteboardPreview`/`PreviewElement`/`ArrowElement`/`diamondPoints` (`WhiteboardMockupInspector.tsx:237-360`, `:473-477`) → `WhiteboardPreview.tsx`; the preview-loader effect `NoteImageInspector.tsx:38-113` → `useNoteImagePreviews`; `gitPrConfiguration`/`gitPrNodeDataPatch` (`WorkspaceInspector.tsx:504-533`) → `git-pr/configuration.ts` (signature takes `data` instead of `node`); `updatedCriteria`/`gateLabel`/`gateLabelFromView` (`WorkflowNodeInspector.tsx:465-492`) → `workflow-node-config.ts`. `testNodeAttempts`/`testStatusLabel` (`test-node/view-model.ts`) are already exported. Compact checklist/criteria rows and the whiteboard `addElement` closure are lightly duplicated on faces — the inspector versions are sidebar-width layouts and sharing them would force a config-prop-heavy component.
- The review-gate "approval action" reuses the existing decision dialog: a pure `workflowPendingDecision(execution, nodeId)` selector over `humanDecisions`/`revisionEscapes`/`approvals` (all carry `nodeId`; `shared/workflow/contracts.ts:233-243`, `:144-186`) yields a `WorkflowDecisionTarget` (`workflows/workflow-ui-types.ts:7-10`) handed to `setWorkflowDecision`.
- Heavyweight flows intentionally stay panel-side in 2b (rehomed in 2d): git-pr push/PR plan dialogs (`PlanDialog` is a focus-trapped modal), SVG exports, brief attachments/variables, note-image alt-text/relink, whiteboard element editor + agent-context sharing, test-node command configuration. Every one of those remains reachable because `WorkspaceInspector` is untouched except for the two helper moves.
- No shared popover primitive exists (only `WorkspaceTooltip`); faces use a local absolutely-positioned `.node-face-popover` panel inside the node body (`nodrag nowheel`), toggled from the face strip.
- `WorkshopNodeData` needs **zero** new fields; every face renders existing persisted data (`CanvasDocument` node `data` is `z.record(z.unknown())`, nothing schema-visible changes).

## Global Constraints

- **Execute in the Phase 2 worktree:** use the checkout for branch `feature/content-on-node`. Do not touch another session's checkout. The worktree's tree is clean — plain `git add <exact paths>` is fine, but still stage only the files each task names; never `git add -A`.
- **Renderer-only, no new IPC:** this sub-plan adds no IPC channels, no preload surface, and no main-process code. Faces may call only preload APIs the inspectors already call (`files.chooseImage`/`loadImage`, `git.remote.*` + `runs.list` via `useGitPrNodeController`, `workflows.revealArtifact`/`openArtifact`). Any deviation requires explicit justification in the commit message.
- **Panels stay functional:** do not delete or degrade any inspector panel; sidebar removal is sub-plan 2d. Update panel code only for the extractions named in Files lists. Never weaken an existing test assertion — add provider wrappers when a test newly needs context, nothing else.
- **Faces must keep node chrome intact:** collapse (35px pill), lock, group membership, and resize continue to work for all eight kinds; every face root is `.node-face` inside the existing `<article class="canvas-node">`, and scroll/drag isolation uses `nowheel nodrag` exactly like `PreviewNodeFace`.
- Run scoped tests from the worktree root: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit <path>`. Typecheck: `corepack pnpm --dir apps/desktop typecheck` (from the worktree root). Lint (verification task): `corepack pnpm lint`. Full unit suite: `corepack pnpm test:unit`.
- The app must build, typecheck, and pass tests after every task. Tasks 1-3 are ordered prerequisites (registry → dimensions → contexts); Tasks 4-9 are independent of each other and each registers its own face(s).
- Commit message suffix (every commit): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All paths below are relative to `apps/desktop/` unless they start with `docs/`.

---

### Task 1: Node face registry in CanvasNode

**Files:**

- Create: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx`
- Create: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx`
- Create: `src/renderer/src/components/workspace/canvas/faces/node-face.css`
- Modify: `src/renderer/src/components/workspace/canvas/CanvasNode.tsx` (`:17-18` imports, `:194-197` booleans, `:293-297` render branch)

**Interfaces (produced; Tasks 4-9 register into `FACES` and import `NodeFaceProps`):**

```ts
// node-face-registry.tsx
export interface NodeFaceProps {
  readonly id: string;
  readonly data: WorkshopNodeData;
}
export type NodeFaceComponent = (props: NodeFaceProps) => JSX.Element;
export function nodeFaceForKind(kind: string): NodeFaceComponent | null;
```

- [ ] **Step 1: Write the failing test** (`node-face-registry.test.tsx`):

```tsx
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { nodeFaceForKind } from './node-face-registry.js';

describe('nodeFaceForKind', () => {
  it('returns face components for kinds that render content on the node', () => {
    expect(nodeFaceForKind('agent')).toBeTypeOf('function');
    expect(nodeFaceForKind('web-preview')).toBeTypeOf('function');
    expect(nodeFaceForKind('mobile-preview')).toBeTypeOf('function');
  });

  it('returns null for kinds that keep the generic node body', () => {
    expect(nodeFaceForKind('group-frame')).toBeNull();
    expect(nodeFaceForKind('file')).toBeNull();
    expect(nodeFaceForKind('extension')).toBeNull();
    expect(nodeFaceForKind('unknown-kind')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement.**

`src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx`:

```tsx
import type { JSX } from 'react';

import { PreviewNodeFace } from '../../previews/PreviewNodeFace.js';
import { AgentSessionNode } from '../../runs/agent-session/AgentSessionNode.js';
import type { WorkshopNodeData } from '../CanvasNode.js';
import './node-face.css';

/** Props every node face receives from CanvasNode. */
export interface NodeFaceProps {
  readonly id: string;
  readonly data: WorkshopNodeData;
}

export type NodeFaceComponent = (props: NodeFaceProps) => JSX.Element;

/**
 * Kind → face component. A registered kind renders its content on the node
 * face instead of the generic title/description body. Faces mount only while
 * the node is expanded; CanvasNode's header (collapse, lock, status) and
 * resizer stay outside the face.
 */
const FACES: Readonly<Partial<Record<string, NodeFaceComponent>>> = {
  agent: function AgentFace({ id, data }: NodeFaceProps) {
    return <AgentSessionNode id={id} data={data} />;
  },
  'web-preview': function WebPreviewFace({ id, data }: NodeFaceProps) {
    return <PreviewNodeFace id={id} kind="web-preview" data={data} />;
  },
  'mobile-preview': function MobilePreviewFace({ id, data }: NodeFaceProps) {
    return <PreviewNodeFace id={id} kind="mobile-preview" data={data} />;
  },
};

export function nodeFaceForKind(kind: string): NodeFaceComponent | null {
  return FACES[kind] ?? null;
}
```

`src/renderer/src/components/workspace/canvas/faces/node-face.css` (shared face scaffold; per-kind rules appended by later tasks):

```css
/* Document & status faces: the node becomes a flex column so the face body
   fills the space under the shared header. */
.canvas-node[data-node-kind='diagram']:not(.collapsed),
.canvas-node[data-node-kind='whiteboard']:not(.collapsed),
.canvas-node[data-node-kind='brief']:not(.collapsed),
.canvas-node[data-node-kind='note-image']:not(.collapsed),
.canvas-node[data-node-kind='task']:not(.collapsed),
.canvas-node[data-node-kind='review-gate']:not(.collapsed),
.canvas-node[data-node-kind='git-pr']:not(.collapsed),
.canvas-node[data-node-kind='test']:not(.collapsed) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.canvas-node[data-node-kind='diagram']:not(.collapsed) > header,
.canvas-node[data-node-kind='whiteboard']:not(.collapsed) > header,
.canvas-node[data-node-kind='brief']:not(.collapsed) > header,
.canvas-node[data-node-kind='note-image']:not(.collapsed) > header,
.canvas-node[data-node-kind='task']:not(.collapsed) > header,
.canvas-node[data-node-kind='review-gate']:not(.collapsed) > header,
.canvas-node[data-node-kind='git-pr']:not(.collapsed) > header,
.canvas-node[data-node-kind='test']:not(.collapsed) > header {
  flex: 0 0 auto;
}
.node-face {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.node-face-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-raised);
  font-size: var(--text-xs);
}
.node-face-strip-label {
  color: var(--text-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.node-face-status {
  margin-left: auto;
  color: var(--text-faint);
  white-space: nowrap;
}
.node-face-status.failed {
  color: #d06870;
}
.node-face-strip button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: transparent;
  color: var(--text-soft);
  font-size: var(--text-xs);
  cursor: pointer;
}
.node-face-strip button:disabled {
  opacity: 0.5;
  cursor: default;
}
.node-face-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--text-xs);
}
.node-face-body label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--text-soft);
}
.node-face-hint {
  margin: auto;
  max-width: 30ch;
  text-align: center;
  color: var(--text-faint);
}
.node-face-popover {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 5;
  width: min(260px, calc(100% - 12px));
  max-height: calc(100% - 12px);
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-raised);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
}
.node-face-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.node-face-row input[type='text'],
.node-face-row input:not([type]),
.node-face-body textarea,
.node-face-body select {
  font-size: var(--text-xs);
  min-width: 0;
  flex: 1;
}
.node-face-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.node-face-chips span {
  padding: 1px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-soft);
  white-space: nowrap;
}
```

`CanvasNode.tsx` edits:

- Replace the imports at `:17-18` (`AgentSessionNode`, `PreviewNodeFace`) with:

```ts
import { nodeFaceForKind } from './faces/node-face-registry.js';
```

- Replace lines 194-197:

```ts
const isAgent = data.kind === 'agent';
const Face = data.collapsed ? null : nodeFaceForKind(data.kind);
```

- Replace the render block at `:293-297`:

```tsx
      {Face !== null && <Face id={id} data={data} />}
      {Face === null && definition.behaviors.collapsible && !data.collapsed && (
```

(The `agent-drag-handle`/`agent-window` class logic and everything else stays.)

- [ ] **Step 4: Run tests + typecheck.** New registry test → PASS. Run `apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.test.tsx`, `apps/desktop/src/renderer/src/components/workspace/canvas/WorkspaceCanvas.test.tsx`, and `apps/desktop/src/renderer/src/components/workspace/previews/PreviewNodeFace.test.tsx` → PASS unchanged (pure refactor). Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx
git commit -m "refactor: kind-to-face registry replaces per-kind branches in CanvasNode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Per-kind dimensions for the eight document & status kinds

**Files:**

- Modify: `src/shared/canvas/node-dimensions.ts` (append table; extend both lookup functions)
- Modify: `src/renderer/src/styles/workspace/canvas.css` (after the mobile-preview rule at `:153-156`)
- Test: `src/renderer/src/components/workspace/model/node-persistence.test.ts` (append)

**Interfaces (exact values; CSS and later face tests depend on them):**

| kind          | default | minimum |
| ------------- | ------- | ------- |
| `diagram`     | 480×360 | 320×240 |
| `whiteboard`  | 560×420 | 360×280 |
| `brief`       | 440×440 | 320×280 |
| `note-image`  | 400×360 | 300×240 |
| `task`        | 340×280 | 260×200 |
| `review-gate` | 360×300 | 280×220 |
| `git-pr`      | 420×380 | 320×260 |
| `test`        | 400×340 | 300×240 |

- [ ] **Step 1: Write the failing tests** — append to `node-persistence.test.ts` (same style as the 2a preview cases):

```ts
it('gives document and status nodes face dimensions', () => {
  expect(initialWorkshopNodeDimensions('diagram')).toEqual({ width: 480, height: 360 });
  expect(initialWorkshopNodeDimensions('whiteboard')).toEqual({ width: 560, height: 420 });
  expect(initialWorkshopNodeDimensions('brief')).toEqual({ width: 440, height: 440 });
  expect(initialWorkshopNodeDimensions('note-image')).toEqual({ width: 400, height: 360 });
  expect(initialWorkshopNodeDimensions('task')).toEqual({ width: 340, height: 280 });
  expect(initialWorkshopNodeDimensions('review-gate')).toEqual({ width: 360, height: 300 });
  expect(initialWorkshopNodeDimensions('git-pr')).toEqual({ width: 420, height: 380 });
  expect(initialWorkshopNodeDimensions('test')).toEqual({ width: 400, height: 340 });
});

it('floors persisted document and status nodes at their per-kind minimums', () => {
  const floored = (kind: WorkshopNode['data']['kind']) =>
    persistedWorkshopNodeDimensions({
      data: { kind } as WorkshopNode['data'],
      width: 10,
      height: 10,
    });
  expect(floored('diagram')).toEqual({ width: 320, height: 240 });
  expect(floored('whiteboard')).toEqual({ width: 360, height: 280 });
  expect(floored('brief')).toEqual({ width: 320, height: 280 });
  expect(floored('note-image')).toEqual({ width: 300, height: 240 });
  expect(floored('task')).toEqual({ width: 260, height: 200 });
  expect(floored('review-gate')).toEqual({ width: 280, height: 220 });
  expect(floored('git-pr')).toEqual({ width: 320, height: 260 });
  expect(floored('test')).toEqual({ width: 300, height: 240 });
});
```

- [ ] **Step 2: Run to verify failure** — `.../model/node-persistence.test.ts` → FAIL (all kinds fall back to 320×180 / 210×92).

- [ ] **Step 3: Implement.**

`src/shared/canvas/node-dimensions.ts` — append before the two functions, then extend both:

```ts
interface NodeDimensions {
  readonly width: number;
  readonly height: number;
}

/** Face dimensions for the document & status node kinds (sub-plan 2b). */
export const DOCUMENT_NODE_DIMENSIONS: Readonly<
  Record<string, { readonly default: NodeDimensions; readonly minimum: NodeDimensions }>
> = {
  diagram: { default: { width: 480, height: 360 }, minimum: { width: 320, height: 240 } },
  whiteboard: { default: { width: 560, height: 420 }, minimum: { width: 360, height: 280 } },
  brief: { default: { width: 440, height: 440 }, minimum: { width: 320, height: 280 } },
  'note-image': { default: { width: 400, height: 360 }, minimum: { width: 300, height: 240 } },
  task: { default: { width: 340, height: 280 }, minimum: { width: 260, height: 200 } },
  'review-gate': { default: { width: 360, height: 300 }, minimum: { width: 280, height: 220 } },
  'git-pr': { default: { width: 420, height: 380 }, minimum: { width: 320, height: 260 } },
  test: { default: { width: 400, height: 340 }, minimum: { width: 300, height: 240 } },
};
```

In `defaultNodeDimensionsForKind`, insert before the final `return DEFAULT_CANVAS_NODE_DIMENSIONS;`:

```ts
const documentDimensions = DOCUMENT_NODE_DIMENSIONS[kind];
if (documentDimensions !== undefined) return documentDimensions.default;
```

In `minimumNodeDimensionsForKind`, insert before the final `return CANVAS_NODE_MINIMUM_DIMENSIONS;`:

```ts
const documentDimensions = DOCUMENT_NODE_DIMENSIONS[kind];
if (documentDimensions !== undefined) return documentDimensions.minimum;
```

`canvas.css` — append after the `mobile-preview` rule at `:153-156`:

```css
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='diagram']:not(.collapsed)) {
  min-width: 320px;
  min-height: 240px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='whiteboard']:not(.collapsed)) {
  min-width: 360px;
  min-height: 280px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='brief']:not(.collapsed)) {
  min-width: 320px;
  min-height: 280px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='note-image']:not(.collapsed)) {
  min-width: 300px;
  min-height: 240px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='task']:not(.collapsed)) {
  min-width: 260px;
  min-height: 200px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='review-gate']:not(.collapsed)) {
  min-width: 280px;
  min-height: 220px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='git-pr']:not(.collapsed)) {
  min-width: 320px;
  min-height: 260px;
}
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='test']:not(.collapsed)) {
  min-width: 300px;
  min-height: 240px;
}
```

- [ ] **Step 4: Run tests + typecheck** — node-persistence test → PASS; `CanvasNode.test.tsx` → PASS (agent/preview minimums unchanged); typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/shared/canvas/node-dimensions.ts apps/desktop/src/renderer/src/styles/workspace/canvas.css apps/desktop/src/renderer/src/components/workspace/model/node-persistence.test.ts
git commit -m "feat: per-kind canvas dimensions for document and status node faces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Context extensions — rosters on AgentSessionContext, new WorkflowRuntimeContext

**Files:**

- Create: `src/renderer/src/lib/use-keyed-stable.ts`
- Create: `src/renderer/src/lib/use-keyed-stable.test.tsx`
- Create: `src/renderer/src/components/workspace/workflows/WorkflowRuntimeContext.tsx`
- Create: `src/renderer/src/components/workspace/workflows/WorkflowRuntimeContext.test.tsx`
- Modify: `src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx`
- Modify: `src/renderer/src/components/workspace/shell/Workspace.tsx` (`:1519-1553` context memo; `:1643`/`:1760` provider nesting; new memos/callbacks before the memo)

**Interfaces (produced; Tasks 6-9 consume — names must match exactly):**

```ts
// AgentSessionContext.tsx additions
export interface CanvasNodeRosterEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly locked: boolean;
}
export interface CheckProducerEntry {
  readonly nodeId: string;
  readonly producerId: string;
  readonly title: string;
  readonly checkKind: 'lint' | 'typecheck' | 'test' | 'build' | 'custom';
}
// added to AgentSessionContextValue:
//   readonly nodeRoster: readonly CanvasNodeRosterEntry[];
//   readonly checkProducers: readonly CheckProducerEntry[];
//   openGitPrReadiness(runId: string): void;

// WorkflowRuntimeContext.tsx
export interface WorkflowRuntimeContextValue {
  readonly executions: readonly WorkflowExecutionView[];
  readonly interactionEvents: readonly WorkflowInteractionEventEnvelope[];
  readonly busyAction: string | null;
  readonly mutationsAuthorized: boolean;
  reviewGateFor(nodeId: string): WorkflowReviewGateView | null;
  pendingDecisionFor(nodeId: string): WorkflowDecisionTarget | null;
  requestDecision(target: WorkflowDecisionTarget): void;
  startNode(nodeId: string): void;
  cancelNode(input: { executionId: string; nodeId: string; attempt: number }): void;
  revealArtifact(input: WorkflowArtifactActionInput): Promise<void>;
  openArtifact(input: WorkflowArtifactActionInput): Promise<void>;
}
export function workflowPendingDecision(
  execution: WorkflowExecutionView | null,
  nodeId: string,
): WorkflowDecisionTarget | null;
export const WorkflowRuntimeProvider: React.FC<{ value; children }>;
export function useWorkflowRuntime(): WorkflowRuntimeContextValue;

// lib/use-keyed-stable.ts
export function useKeyedStable<T>(value: T, key: string): T;
```

- [ ] **Step 1: Write the failing tests.**

`src/renderer/src/lib/use-keyed-stable.test.tsx`:

```tsx
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useKeyedStable } from './use-keyed-stable.js';

describe('useKeyedStable', () => {
  it('keeps the previous reference while the key is unchanged', () => {
    const first = [{ id: 'a' }];
    const { result, rerender } = renderHook(
      ({ value, key }: { value: readonly { id: string }[]; key: string }) =>
        useKeyedStable(value, key),
      { initialProps: { value: first, key: 'a' } },
    );
    expect(result.current).toBe(first);
    rerender({ value: [{ id: 'a' }], key: 'a' });
    expect(result.current).toBe(first);
  });

  it('adopts the new value when the key changes', () => {
    const first = [{ id: 'a' }];
    const second = [{ id: 'b' }];
    const { result, rerender } = renderHook(
      ({ value, key }: { value: readonly { id: string }[]; key: string }) =>
        useKeyedStable(value, key),
      { initialProps: { value: first, key: 'a' } },
    );
    rerender({ value: second, key: 'b' });
    expect(result.current).toBe(second);
  });
});
```

`src/renderer/src/components/workspace/workflows/WorkflowRuntimeContext.test.tsx`:

```tsx
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { WorkflowExecutionView } from '../../../../../shared/workflow/contracts.js';
import {
  useWorkflowRuntime,
  workflowPendingDecision,
  WorkflowRuntimeProvider,
  type WorkflowRuntimeContextValue,
} from './WorkflowRuntimeContext.js';

function execution(overrides: Partial<WorkflowExecutionView> = {}): WorkflowExecutionView {
  return {
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    ...overrides,
  } as unknown as WorkflowExecutionView;
}

describe('workflowPendingDecision', () => {
  it('returns null without an execution or matching request', () => {
    expect(workflowPendingDecision(null, 'n1')).toBeNull();
    expect(workflowPendingDecision(execution(), 'n1')).toBeNull();
  });

  it('prefers human decisions, then revision escapes, then launch approvals', () => {
    const human = { nodeId: 'n1' };
    const revision = { nodeId: 'n1' };
    const launch = { nodeId: 'n1' };
    expect(
      workflowPendingDecision(
        execution({
          humanDecisions: [human],
          revisionEscapes: [revision],
          approvals: [launch],
        } as unknown as Partial<WorkflowExecutionView>),
        'n1',
      ),
    ).toEqual({ kind: 'human', request: human });
    expect(
      workflowPendingDecision(
        execution({
          revisionEscapes: [revision],
          approvals: [launch],
        } as unknown as Partial<WorkflowExecutionView>),
        'n1',
      ),
    ).toEqual({ kind: 'revision', request: revision });
    expect(
      workflowPendingDecision(
        execution({ approvals: [launch] } as unknown as Partial<WorkflowExecutionView>),
        'n1',
      ),
    ).toEqual({ kind: 'launch', request: launch });
  });
});

describe('useWorkflowRuntime', () => {
  it('throws without a provider and returns the provided value with one', () => {
    expect(() => renderHook(() => useWorkflowRuntime())).toThrow(
      'useWorkflowRuntime requires a WorkflowRuntimeProvider.',
    );
    const value = {
      busyAction: null,
      startNode: vi.fn(),
    } as unknown as WorkflowRuntimeContextValue;
    const { result } = renderHook(() => useWorkflowRuntime(), {
      wrapper: ({ children }) => (
        <WorkflowRuntimeProvider value={value}>{children}</WorkflowRuntimeProvider>
      ),
    });
    expect(result.current).toBe(value);
  });
});
```

- [ ] **Step 2: Run to verify failure** — both modules not found.

- [ ] **Step 3: Implement.**

`src/renderer/src/lib/use-keyed-stable.ts`:

```ts
import { useRef } from 'react';

/**
 * Returns the same reference across renders until `key` changes. Used to keep
 * derived rosters referentially stable while the canvas nodes array identity
 * churns (drags, selection), so context values do not re-create per frame.
 */
export function useKeyedStable<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; value: T }>({ key, value });
  if (ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}
```

`src/renderer/src/components/workspace/workflows/WorkflowRuntimeContext.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';

import type {
  WorkflowArtifactActionInput,
  WorkflowExecutionView,
  WorkflowInteractionEventEnvelope,
  WorkflowReviewGateView,
} from '../../../../../shared/workflow/contracts.js';
import type { WorkflowDecisionTarget } from './workflow-ui-types.js';

/**
 * Volatile workflow-run state for components rendered inside canvas nodes
 * (test and review-gate faces). Kept separate from AgentSessionContext so
 * workflow output events re-render only the faces that consume them.
 */
export interface WorkflowRuntimeContextValue {
  readonly executions: readonly WorkflowExecutionView[];
  readonly interactionEvents: readonly WorkflowInteractionEventEnvelope[];
  readonly busyAction: string | null;
  readonly mutationsAuthorized: boolean;
  reviewGateFor(nodeId: string): WorkflowReviewGateView | null;
  pendingDecisionFor(nodeId: string): WorkflowDecisionTarget | null;
  requestDecision(target: WorkflowDecisionTarget): void;
  startNode(nodeId: string): void;
  cancelNode(input: { executionId: string; nodeId: string; attempt: number }): void;
  revealArtifact(input: WorkflowArtifactActionInput): Promise<void>;
  openArtifact(input: WorkflowArtifactActionInput): Promise<void>;
}

/** Pure selector: the decision the user can currently make for a node, if any. */
export function workflowPendingDecision(
  execution: WorkflowExecutionView | null,
  nodeId: string,
): WorkflowDecisionTarget | null {
  if (execution === null) return null;
  const human = execution.humanDecisions.find((request) => request.nodeId === nodeId);
  if (human !== undefined) return { kind: 'human', request: human };
  const revision = execution.revisionEscapes.find((request) => request.nodeId === nodeId);
  if (revision !== undefined) return { kind: 'revision', request: revision };
  const launch = execution.approvals.find((request) => request.nodeId === nodeId);
  if (launch !== undefined) return { kind: 'launch', request: launch };
  return null;
}

const WorkflowRuntimeContext = createContext<WorkflowRuntimeContextValue | null>(null);

export const WorkflowRuntimeProvider: React.FC<{
  value: WorkflowRuntimeContextValue;
  children: ReactNode;
}> = ({ value, children }) => (
  <WorkflowRuntimeContext.Provider value={value}>{children}</WorkflowRuntimeContext.Provider>
);

export function useWorkflowRuntime(): WorkflowRuntimeContextValue {
  const value = useContext(WorkflowRuntimeContext);
  if (value === null) {
    throw new Error('useWorkflowRuntime requires a WorkflowRuntimeProvider.');
  }
  return value;
}
```

`AgentSessionContext.tsx` — add above `AgentSessionContextValue` and extend the interface:

```ts
/** Low-churn snapshot of canvas nodes for faces that need cross-node options. */
export interface CanvasNodeRosterEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly locked: boolean;
}

/** Test nodes that can satisfy a review gate's required checks. */
export interface CheckProducerEntry {
  readonly nodeId: string;
  readonly producerId: string;
  readonly title: string;
  readonly checkKind: 'lint' | 'typecheck' | 'test' | 'build' | 'custom';
}
```

and inside `AgentSessionContextValue` (after `requestDeleteNode`):

```ts
  readonly nodeRoster: readonly CanvasNodeRosterEntry[];
  readonly checkProducers: readonly CheckProducerEntry[];
  openGitPrReadiness(runId: string): void;
```

`Workspace.tsx` wiring:

- Imports to add: `useKeyedStable` from `'../../../lib/use-keyed-stable.js'`; `checkProducerId` from `'../workflows/workflow-node-config.js'` (if not already imported); `WorkflowRuntimeProvider, workflowPendingDecision, type WorkflowRuntimeContextValue` from `'../workflows/WorkflowRuntimeContext.js'`; `type CanvasNodeRosterEntry, type CheckProducerEntry` from the agent-session context module.
- Insert immediately before the `agentSessionValue` memo (`:1519`):

```ts
const nodeRosterSource = useMemo<readonly CanvasNodeRosterEntry[]>(
  () =>
    nodes.map((node) => ({
      id: node.id,
      title: node.data.title,
      kind: node.data.kind,
      locked: node.data.locked,
    })),
  [nodes],
);
const nodeRoster = useKeyedStable(
  nodeRosterSource,
  nodeRosterSource
    .map(
      (entry) => `${entry.id}\u0000${entry.title}\u0000${entry.kind}\u0000${String(entry.locked)}`,
    )
    .join('\n'),
);
const checkProducersSource = useMemo<readonly CheckProducerEntry[]>(
  () =>
    nodes
      .filter((node) => node.data.kind === 'test')
      .map((node) => ({
        nodeId: node.id,
        producerId: checkProducerId(node),
        title: node.data.title,
        checkKind: node.data.checkKind ?? 'test',
      })),
  [nodes],
);
const checkProducers = useKeyedStable(
  checkProducersSource,
  checkProducersSource
    .map(
      (entry) =>
        `${entry.nodeId}\u0000${entry.producerId}\u0000${entry.title}\u0000${entry.checkKind}`,
    )
    .join('\n'),
);
const openGitPrReadiness = useCallback(
  (runId: string) => {
    gitReview.openTarget({ kind: 'agent-worktree', projectId: project.id, runId });
  },
  [gitReview, project.id],
);
```

- Add `nodeRoster,`, `checkProducers,`, `openGitPrReadiness,` to the `agentSessionValue` object and its dependency array.
- Insert after `agentSessionValue`:

```ts
const workflowRuntimeValue = useMemo<WorkflowRuntimeContextValue>(
  () => ({
    executions: workflows.executions,
    interactionEvents: workflows.interactionEvents,
    busyAction: workflows.busyAction,
    mutationsAuthorized: workflows.mutationsAuthorized,
    reviewGateFor: (nodeId: string) => workflowReviewGates.get(nodeId) ?? null,
    pendingDecisionFor: (nodeId: string) =>
      workflowPendingDecision(workflows.currentExecution, nodeId),
    requestDecision: setWorkflowDecision,
    startNode: (nodeId: string) =>
      void workflows.start({ kind: 'node', nodeId, includeUpstream: false }),
    cancelNode: (input) => void workflows.cancelNode(input),
    revealArtifact: async (input) => {
      unwrap(await window.forgeboard.workflows.revealArtifact(input));
    },
    openArtifact: async (input) => {
      unwrap(await window.forgeboard.workflows.openArtifact(input));
    },
  }),
  [workflowReviewGates, workflows],
);
```

(If `workflows` — the `useWorkflowRuns` return — is not referentially stable per render, narrow the deps to `[workflowReviewGates, workflows.executions, workflows.interactionEvents, workflows.busyAction, workflows.mutationsAuthorized, workflows.currentExecution, workflows.start, workflows.cancelNode]` and reference those fields via locals; do not silence the exhaustive-deps rule.)

- Nest the provider inside the existing `AgentSessionProvider` (`:1643`/`:1760`):

```tsx
        <AgentSessionProvider value={agentSessionValue}>
        <WorkflowRuntimeProvider value={workflowRuntimeValue}>
        <WorkspaceCanvas
          ...
        />
        </WorkflowRuntimeProvider>
        </AgentSessionProvider>
```

- [ ] **Step 4: Run tests + typecheck.** New tests → PASS. Run `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.test.tsx` and the workspace shell slice (`.../components/workspace/shell`) — any test constructing an `AgentSessionContextValue` literal without casts must gain the three new members (`nodeRoster: []`, `checkProducers: []`, `openGitPrReadiness: vi.fn()`); wrapper-only updates. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/lib/use-keyed-stable.ts apps/desktop/src/renderer/src/lib/use-keyed-stable.test.tsx apps/desktop/src/renderer/src/components/workspace/workflows/WorkflowRuntimeContext.tsx apps/desktop/src/renderer/src/components/workspace/workflows/WorkflowRuntimeContext.test.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx
git commit -m "feat: node-face service contexts - rosters, git-pr readiness, workflow runtime

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Stage any test files updated in Step 4 as well.)

---

### Task 4: Diagram face (mermaid render extracted into a shared hook)

**Files:**

- Create: `src/renderer/src/components/workspace/content/diagram/use-mermaid-diagram.ts`
- Create: `src/renderer/src/components/workspace/content/diagram/DiagramNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/content/diagram/DiagramNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/content/diagram/MermaidDiagramInspector.tsx` (delete the moved state/effect, consume the hook)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `diagram`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append)

**Interfaces:**

```ts
// use-mermaid-diagram.ts
export interface MermaidDiagramState {
  readonly svg: string | null; // latest successful render (kept while re-rendering)
  readonly error: string | null; // error for the *current* source only
  readonly rendering: boolean;
}
export function useMermaidDiagram(source: string): MermaidDiagramState;
```

- [ ] **Step 1: Write the failing test** (`DiagramNodeFace.test.tsx`):

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const renderDiagram = vi.hoisted(() => vi.fn());
vi.mock('./mermaid-renderer.js', () => ({
  renderMermaidDiagram: renderDiagram,
}));

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { DiagramNodeFace } from './DiagramNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  renderDiagram.mockReset();
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
    kind: 'diagram',
    title: 'System map',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#7888d8',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <DiagramNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('DiagramNodeFace', () => {
  it('opens in the editor when there is no source and persists edits', () => {
    renderFace();
    const editor = screen.getByRole('textbox', { name: 'Mermaid source' });
    fireEvent.focus(editor);
    fireEvent.change(editor, { target: { value: 'flowchart LR\nA-->B' } });
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', { mermaidSource: 'flowchart LR\nA-->B' });
  });

  it('renders the sanitized diagram on the face when source exists', async () => {
    renderDiagram.mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered</text></svg>',
    );
    renderFace({ mermaidSource: 'flowchart LR\nA-->B' });
    expect(screen.queryByRole('textbox', { name: 'Mermaid source' })).toBeNull();
    expect(await screen.findByRole('img', { name: 'System map diagram' })).toBeTruthy();
  });

  it('reports render failures on the face', async () => {
    renderDiagram.mockRejectedValue(new Error('Parse error on line 2'));
    renderFace({ mermaidSource: 'not mermaid' });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Parse error on line 2');
  });

  it('locks the editor for read-only nodes but keeps the source viewable', () => {
    renderFace({ mermaidSource: 'flowchart LR\nA-->B', locked: true });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mermaid source' }));
    const editor = screen.getByRole('textbox', { name: 'Mermaid source' });
    expect(editor).toHaveProperty('readOnly', true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.**

`src/renderer/src/components/workspace/content/diagram/use-mermaid-diagram.ts` (the state machine is a move of `MermaidDiagramInspector.tsx:28-62` — symbols `DiagramRenderState`, `renderState`, `renderSequence`, the 180 ms debounce effect — with one deliberate change: the last successful SVG is kept visible while a newer source renders, per the spec's "cached, debounced"):

```ts
import { useEffect, useRef, useState } from 'react';

import { renderMermaidDiagram } from './mermaid-renderer.js';

type DiagramRenderState =
  | { readonly source: string; readonly status: 'rendered'; readonly svg: string }
  | { readonly source: string; readonly status: 'error'; readonly message: string };

export interface MermaidDiagramState {
  readonly svg: string | null;
  readonly error: string | null;
  readonly rendering: boolean;
}

/**
 * Debounced (180 ms) Mermaid render shared by the diagram node face and the
 * inspector. The previous successful SVG stays available while a newer source
 * renders, so the face never flashes empty during typing.
 */
export function useMermaidDiagram(source: string): MermaidDiagramState {
  const [renderState, setRenderState] = useState<DiagramRenderState | null>(null);
  const renderSequence = useRef(0);

  useEffect(() => {
    const sequence = ++renderSequence.current;
    if (source.trim() === '') {
      setRenderState(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      void renderMermaidDiagram(source)
        .then((svg) => {
          if (sequence !== renderSequence.current) return;
          setRenderState({ source, status: 'rendered', svg });
        })
        .catch((error: unknown) => {
          if (sequence !== renderSequence.current) return;
          setRenderState({
            source,
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'This Mermaid diagram could not be rendered.',
          });
        });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [source]);

  const current = renderState?.source === source ? renderState : null;
  return {
    svg:
      current?.status === 'rendered'
        ? current.svg
        : renderState?.status === 'rendered'
          ? renderState.svg
          : null,
    error: current?.status === 'error' ? current.message : null,
    rendering: source.trim() !== '' && current === null,
  };
}
```

`src/renderer/src/components/workspace/content/diagram/DiagramNodeFace.tsx`:

```tsx
import { useState, type JSX } from 'react';
import { Eye, FilePenLine } from 'lucide-react';

import { SafeSvgImage } from '../../../content/svg/SafeSvgImage.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { useMermaidDiagram } from './use-mermaid-diagram.js';

/** Diagram face: rendered Mermaid SVG with a source editor that toggles in place. */
export function DiagramNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const source = data.mermaidSource ?? '';
  const diagram = useMermaidDiagram(source);
  const [editing, setEditing] = useState(source.trim() === '');

  return (
    <section className="node-face diagram-node-face" aria-label="Mermaid diagram">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">Mermaid</span>
        <button
          type="button"
          aria-label="Edit Mermaid source"
          aria-pressed={editing}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? (
            <Eye size={12} aria-hidden="true" />
          ) : (
            <FilePenLine size={12} aria-hidden="true" />
          )}
          {editing ? 'Preview' : 'Edit'}
        </button>
        <span
          className={`node-face-status ${diagram.error === null ? '' : 'failed'}`}
          role="status"
        >
          {source.trim() === ''
            ? 'empty'
            : diagram.error !== null
              ? 'invalid'
              : diagram.rendering
                ? 'rendering'
                : 'rendered'}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        {editing ? (
          <textarea
            className="diagram-face-editor"
            aria-label="Mermaid source"
            name={`node-${id}-mermaid-face-source`}
            value={source}
            readOnly={readOnly}
            placeholder={'flowchart LR\n  Brief --> Agent\n  Agent --> Review'}
            onFocus={session.recordHistory}
            onChange={
              readOnly
                ? undefined
                : (event) => session.updateNodeData(id, { mermaidSource: event.target.value })
            }
          />
        ) : (
          <div
            className="diagram-face-preview"
            role="region"
            aria-label="Mermaid preview"
            aria-busy={diagram.rendering}
          >
            {source.trim() === '' ? (
              <p className="node-face-hint">Add Mermaid source to see a diagram.</p>
            ) : null}
            {diagram.error !== null ? <p role="alert">{diagram.error}</p> : null}
            {diagram.svg !== null ? (
              <SafeSvgImage source={diagram.svg} alt={`${data.title} diagram`} />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
```

`MermaidDiagramInspector.tsx` refactor (behavior-preserving):

- Delete the local `DiagramRenderState` type (`:10-12`), the `renderState`/`renderSequence` state (`:29`, `:32`), the derived `currentRender`/`renderedSvg`/`renderError` (`:33-35`), and the effect (`:37-62`).
- Add `import { useMermaidDiagram } from './use-mermaid-diagram.js';` and, in the component body:

```ts
const { svg: renderedSvg, error: renderError, rendering } = useMermaidDiagram(source);
```

- Replace the `aria-busy` expression (`:132`) with `aria-busy={rendering}`.

`node-face-registry.tsx` — add import and entry:

```tsx
import { DiagramNodeFace } from '../../content/diagram/DiagramNodeFace.js';
// in FACES:
  diagram: DiagramNodeFace,
```

`node-face.css` — append:

```css
.diagram-face-editor {
  flex: 1;
  min-height: 0;
  resize: none;
  font-family: ui-monospace, monospace;
}
.diagram-face-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
}
.diagram-face-preview img,
.diagram-face-preview svg {
  max-width: 100%;
  max-height: 100%;
}
```

- [ ] **Step 4: Run tests + typecheck.** `DiagramNodeFace.test.tsx` → PASS; `MermaidDiagramInspector.test.tsx` → PASS unchanged; registry test (append `expect(nodeFaceForKind('diagram')).toBeTypeOf('function');` to the first case). Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/diagram/use-mermaid-diagram.ts apps/desktop/src/renderer/src/components/workspace/content/diagram/DiagramNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/content/diagram/DiagramNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/content/diagram/MermaidDiagramInspector.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: mermaid diagrams render on the node face with in-place source editing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Whiteboard face (interactive SVG preview extracted, toolbar popover)

**Files:**

- Create: `src/renderer/src/components/workspace/content/whiteboard/WhiteboardPreview.tsx`
- Create: `src/renderer/src/components/workspace/content/whiteboard/WhiteboardNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/content/whiteboard/WhiteboardNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/content/whiteboard/WhiteboardMockupInspector.tsx` (delete moved symbols, import the extracted preview)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `whiteboard`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append)

**Extraction (a move, byte-identical bodies):** move `WhiteboardPreview` (`WhiteboardMockupInspector.tsx:237-266`), `PreviewElement` (`:268-329`), `ArrowElement` (`:331-360`), and `diamondPoints` (`:473-477`) into `WhiteboardPreview.tsx`. Only `WhiteboardPreview` is exported; it gains one optional prop `className?: string | undefined` applied as ``className={`whiteboard-preview${className === undefined ? '' : ` ${className}`}`}``. Target module header:

```tsx
import type { WhiteboardDocument, WhiteboardElement } from './model.js';

export function WhiteboardPreview({
  document,
  selectedId,
  onSelect,
  className,
}: {
  readonly document: WhiteboardDocument;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly className?: string | undefined;
}) {
  /* moved body, className applied as above */
}
```

The inspector adds `import { WhiteboardPreview } from './WhiteboardPreview.js';` and drops the moved symbols plus their now-unused imports.

- [ ] **Step 1: Write the failing test** (`WhiteboardNodeFace.test.tsx`):

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { WhiteboardNodeFace } from './WhiteboardNodeFace.js';

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
    kind: 'whiteboard',
    title: 'Mockup',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#c482aa',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <WhiteboardNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('WhiteboardNodeFace', () => {
  it('renders the inert SVG preview as the face body', () => {
    renderFace();
    expect(screen.getByRole('img', { name: 'Inert whiteboard preview' })).toBeTruthy();
  });

  it('adds shapes from the toolbar popover and records history', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rectangle' }));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        excalidraw: expect.objectContaining({
          elements: [expect.objectContaining({ type: 'rectangle' })],
        }),
      }),
    );
  });

  it('adds annotations and tracks their ids', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Whiteboard tools' }));
    fireEvent.change(screen.getByLabelText('Annotation'), { target: { value: 'Header here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
    const patch = updateNodeData.mock.calls.at(-1)?.[1] as {
      excalidraw: { elements: Array<{ id: string; type: string }> };
      annotationIds: string[];
    };
    expect(patch.excalidraw.elements[0]?.type).toBe('text');
    expect(patch.annotationIds).toEqual([patch.excalidraw.elements[0]?.id]);
  });

  it('keeps the toolbar closed for locked nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Whiteboard tools' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.**

Perform the extraction described above, then create `WhiteboardNodeFace.tsx`:

```tsx
import { useMemo, useState, type JSX } from 'react';
import { ArrowRight, Circle, Diamond, Shapes, Square, Trash2, Type } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import {
  createWhiteboardElement,
  parseWhiteboardDocument,
  type WhiteboardDocument,
  type WhiteboardElementType,
} from './model.js';
import { WhiteboardPreview } from './WhiteboardPreview.js';

/**
 * Whiteboard face: the interactive inert-SVG preview fills the node body; the
 * shape toolbar lives in a small node-anchored popover. Element editing,
 * export, and agent-context sharing stay in the inspector panel until 2d.
 */
export function WhiteboardNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const document = useMemo(() => parseWhiteboardDocument(data.excalidraw), [data.excalidraw]);
  const activeElements = document.elements.filter((element) => !element.isDeleted);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [annotation, setAnnotation] = useState('');
  const selected = activeElements.find((element) => element.id === selectedId) ?? null;

  const persist = (
    next: WhiteboardDocument,
    annotationIds: readonly string[] | undefined,
  ): void => {
    session.updateNodeData(id, {
      excalidraw: next,
      annotationIds: annotationIds === undefined ? (data.annotationIds ?? []) : [...annotationIds],
    });
  };

  const addElement = (type: WhiteboardElementType, text = ''): void => {
    if (readOnly) return;
    session.recordHistory();
    const element = createWhiteboardElement(type, activeElements.length, text);
    persist(
      { ...document, elements: [...document.elements, element] },
      type === 'text' ? [...(data.annotationIds ?? []), element.id] : undefined,
    );
    setSelectedId(element.id);
    setAnnotation('');
  };

  const deleteSelected = (): void => {
    if (readOnly || selected === null) return;
    session.recordHistory();
    persist(
      {
        ...document,
        elements: document.elements.map((element) =>
          element.id === selected.id
            ? { ...element, isDeleted: true, version: element.version + 1, updated: Date.now() }
            : element,
        ),
      },
      (data.annotationIds ?? []).filter((annotationId) => annotationId !== selected.id),
    );
    setSelectedId(null);
  };

  return (
    <section className="node-face whiteboard-node-face" aria-label="Whiteboard">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {activeElements.length} element{activeElements.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          aria-label="Whiteboard tools"
          aria-expanded={toolsOpen}
          disabled={readOnly}
          onClick={() => setToolsOpen((open) => !open)}
        >
          <Shapes size={12} aria-hidden="true" /> Tools
        </button>
      </div>
      <div className="node-face-body nowheel nodrag">
        <WhiteboardPreview
          document={document}
          selectedId={selectedId}
          onSelect={setSelectedId}
          className="whiteboard-face-preview"
        />
        {toolsOpen && !readOnly ? (
          <div className="node-face-popover" role="dialog" aria-label="Whiteboard tools">
            <div className="whiteboard-face-tools">
              <button
                type="button"
                aria-label="Add rectangle"
                onClick={() => addElement('rectangle')}
              >
                <Square size={13} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Add ellipse" onClick={() => addElement('ellipse')}>
                <Circle size={13} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Add diamond" onClick={() => addElement('diamond')}>
                <Diamond size={13} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Add arrow" onClick={() => addElement('arrow')}>
                <ArrowRight size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Delete selected element"
                disabled={selected === null}
                onClick={deleteSelected}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
            <label>
              Annotation
              <input
                name={`node-${id}-whiteboard-face-annotation`}
                value={annotation}
                maxLength={20_000}
                placeholder="Describe a screen or interaction"
                onChange={(event) => setAnnotation(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={annotation.trim() === ''}
              onClick={() => addElement('text', annotation.trim())}
            >
              <Type size={13} aria-hidden="true" /> Add annotation
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
```

`node-face-registry.tsx` — `import { WhiteboardNodeFace } from '../../content/whiteboard/WhiteboardNodeFace.js';`, entry `whiteboard: WhiteboardNodeFace,`.

`node-face.css` — append:

```css
.whiteboard-node-face .node-face-body {
  padding: 0;
}
svg.whiteboard-face-preview {
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
}
.whiteboard-face-tools {
  display: flex;
  gap: 4px;
}
.whiteboard-face-tools button {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
}
.whiteboard-face-tools button:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 4: Run tests + typecheck.** New face test → PASS; `WhiteboardMockupInspector.test.tsx` → PASS unchanged (extraction is behavior-preserving); registry test extended with `whiteboard`. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/whiteboard/WhiteboardPreview.tsx apps/desktop/src/renderer/src/components/workspace/content/whiteboard/WhiteboardNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/content/whiteboard/WhiteboardNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/content/whiteboard/WhiteboardMockupInspector.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: whiteboard preview becomes the node face with a toolbar popover

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Brief and note-image faces

**Files:**

- Create: `src/renderer/src/components/workspace/content/BriefNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/content/BriefNodeFace.test.tsx`
- Create: `src/renderer/src/components/workspace/content/note-image/use-note-image-previews.ts`
- Create: `src/renderer/src/components/workspace/content/note-image/NoteImageNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/content/note-image/NoteImageNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/content/note-image/NoteImageInspector.tsx` (consume the extracted hook)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `brief`, `note-image`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append)

**Extraction (`use-note-image-previews.ts`):** move the preview-loading effect from `NoteImageInspector.tsx:38-113` (state `previews`, memo `signature`, the whole `useEffect`) into:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectImageLoadResult } from '../../../../../../shared/files/images/contracts.js';
import type { NoteImageReference } from './reference-updates.js';

export type NoteImagePreviewState = ProjectImageLoadResult | { readonly status: 'loading' };

/**
 * Loads inert previews for note-image references. When `onReconcile` is given
 * (the editable inspector), `missing` flags are reconciled against load
 * results; faces pass nothing and stay read-only observers.
 */
export function useNoteImagePreviews(
  projectId: string,
  images: readonly NoteImageReference[],
  onReconcile?: (images: NoteImageReference[]) => void,
): Readonly<Record<string, NoteImagePreviewState>> {
  const [previews, setPreviews] = useState<Readonly<Record<string, NoteImagePreviewState>>>({});
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const reconcileRef = useRef(onReconcile);
  reconcileRef.current = onReconcile;
  const signature = useMemo(
    () => images.map((image) => `${image.projectId}:${image.relativePath}`).join('\n'),
    [images],
  );

  useEffect(() => {
    let active = true;
    const current = imagesRef.current;
    if (current.length === 0) {
      setPreviews({});
      return () => {
        active = false;
      };
    }
    setPreviews(
      Object.fromEntries(current.map((image) => [image.relativePath, { status: 'loading' }])),
    );
    void Promise.all(
      current.map(async (image): Promise<[string, ProjectImageLoadResult]> => {
        if (image.projectId !== projectId) {
          return [
            image.relativePath,
            {
              status: 'unavailable',
              projectId: image.projectId,
              relativePath: image.relativePath,
              message: 'This image belongs to a different project and was not loaded.',
            },
          ];
        }
        try {
          return [
            image.relativePath,
            await window.forgeboard.files.loadImage({
              projectId,
              relativePath: image.relativePath,
            }),
          ];
        } catch (cause) {
          return [
            image.relativePath,
            {
              status: 'unavailable',
              projectId,
              relativePath: image.relativePath,
              message:
                cause instanceof Error ? cause.message : 'Forgeboard could not load this image.',
            },
          ];
        }
      }),
    ).then((loaded) => {
      if (!active) return;
      setPreviews(Object.fromEntries(loaded));
      const reconcile = reconcileRef.current;
      if (reconcile === undefined) return;
      const byPath = new Map(loaded);
      let changed = false;
      const reconciled = current.map((image) => {
        const preview = byPath.get(image.relativePath);
        if (preview?.status === 'missing' && !image.missing) {
          changed = true;
          return { ...image, missing: true };
        }
        if (preview?.status === 'available' && image.missing) {
          changed = true;
          return { ...image, missing: false };
        }
        return image;
      });
      if (changed) reconcile(reconciled);
    });
    return () => {
      active = false;
    };
  }, [projectId, signature]);

  return previews;
}
```

`NoteImageInspector.tsx` then deletes its `previews` state, `signature` memo, `PreviewState` type, and the effect, replacing them with:

```ts
const previews = useNoteImagePreviews(
  projectId,
  images,
  readOnly ? undefined : (reconciled) => onUpdate({ images: reconciled }),
);
```

- [ ] **Step 1: Write the failing tests.**

`BriefNodeFace.test.tsx`:

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { BriefNodeFace } from './BriefNodeFace.js';

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
    kind: 'brief',
    title: 'Login brief',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#8d7de8',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <BriefNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('BriefNodeFace', () => {
  it('adds checklist items in place', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Add checklist item' }));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      checklist: [expect.objectContaining({ label: 'New requirement', checked: false })],
    });
  });

  it('toggles checklist completion in place', () => {
    renderFace({ checklist: [{ id: 'c1', label: 'Design ready', checked: false }] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Design ready' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      checklist: [{ id: 'c1', label: 'Design ready', checked: true }],
    });
  });

  it('edits done conditions in place', () => {
    renderFace({
      acceptanceCriteria: [{ id: 'a1', description: 'Works end to end', satisfied: false }],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Works end to end as done' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      acceptanceCriteria: [{ id: 'a1', description: 'Works end to end', satisfied: true }],
    });
  });

  it('saves and restores versions from the history popover', () => {
    renderFace({
      markdown: '# v2',
      versions: [
        {
          id: 'v1',
          createdAt: '2026-07-19T10:00:00.000Z',
          markdown: '# v1',
          authorId: 'local-user',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Version history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save brief version' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      versions: [
        expect.objectContaining({ markdown: '# v1' }),
        expect.objectContaining({ markdown: '# v2' }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Restore brief version/ }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', { markdown: '# v1' });
  });
});
```

`NoteImageNodeFace.test.tsx`:

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { NoteImageNodeFace } from './NoteImageNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const reportError = vi.fn();
const loadImage = vi.fn();
const chooseImage = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  reportError.mockClear();
  loadImage.mockReset();
  chooseImage.mockReset();
  Object.defineProperty(window, 'forgeboard', {
    configurable: true,
    value: { files: { loadImage, chooseImage } },
  });
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    reportError,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'note-image',
    title: 'Moodboard',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#c5a75f',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <NoteImageNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('NoteImageNodeFace', () => {
  it('renders loaded project images in the grid', async () => {
    loadImage.mockResolvedValue({
      status: 'available',
      projectId: 'p1',
      relativePath: 'docs/hero.png',
      dataUrl: 'data:image/png;base64,AAAA',
    });
    renderFace({
      images: [{ projectId: 'p1', relativePath: 'docs/hero.png', kind: 'image', missing: false }],
      altText: { 'docs/hero.png': 'Hero shot' },
    });
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Hero shot' }).getAttribute('src')).toBe(
        'data:image/png;base64,AAAA',
      ),
    );
  });

  it('adds an image through the existing chooser', async () => {
    chooseImage.mockResolvedValue({
      projectId: 'p1',
      relativePath: 'docs/new.png',
      missing: false,
    });
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Choose image' }));
    await waitFor(() => expect(recordHistory).toHaveBeenCalled());
    expect(updateNodeData).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        images: [expect.objectContaining({ relativePath: 'docs/new.png', kind: 'image' })],
      }),
    );
  });

  it('surfaces chooser failures through the session error channel', async () => {
    chooseImage.mockRejectedValue(new Error('dialog failed'));
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Choose image' }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith('dialog failed'));
  });

  it('disables editing for read-only nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Choose image' })).toHaveProperty('disabled', true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — modules not found.

- [ ] **Step 3: Implement.**

`src/renderer/src/components/workspace/content/BriefNodeFace.tsx`:

```tsx
import { useState, type JSX } from 'react';
import { History, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';

import { MarkdownComposer } from '../../content/markdown/MarkdownComposer.js';
import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';

/**
 * Product-brief face: markdown, checklist, and done conditions edit in place;
 * version history lives in a popover. Attachments and prompt variables stay in
 * the inspector panel until 2d.
 */
export function BriefNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const markdown = data.markdown ?? '';
  const checklist = data.checklist ?? [];
  const criteria = data.acceptanceCriteria ?? [];
  const versions = data.versions ?? [];
  const latestVersion = versions.at(-1);
  const [historyOpen, setHistoryOpen] = useState(false);

  const update = (patch: Parameters<typeof session.updateNodeData>[1]): void => {
    session.updateNodeData(id, patch);
  };

  return (
    <section className="node-face brief-node-face" aria-label="Product brief">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">Product brief</span>
        <button
          type="button"
          aria-label="Version history"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <History size={12} aria-hidden="true" /> {versions.length}
        </button>
      </div>
      <div className="node-face-body nowheel nodrag">
        <MarkdownComposer
          label="Requirements"
          value={markdown}
          readOnly={readOnly}
          emptyLabel="Write the product requirements, constraints, and how you'll know it's done."
          onBeginEdit={session.recordHistory}
          onChange={(value) => update({ markdown: value })}
        />

        <div className="node-face-list-header">
          <strong>
            Checklist <span>{checklist.length}</span>
          </strong>
          <button
            type="button"
            aria-label="Add checklist item"
            disabled={readOnly}
            onClick={() => {
              session.recordHistory();
              update({
                checklist: [
                  ...checklist,
                  { id: crypto.randomUUID(), label: 'New requirement', checked: false },
                ],
              });
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add
          </button>
        </div>
        {checklist.map((item, index) => (
          <div className="node-face-row" key={item.id}>
            <input
              type="checkbox"
              name={`brief-face-checklist-complete-${item.id}`}
              checked={item.checked}
              disabled={readOnly}
              aria-label={`Complete ${item.label}`}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({
                  checklist: checklist.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, checked: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <input
              name={`brief-face-checklist-label-${item.id}`}
              value={item.label}
              readOnly={readOnly}
              aria-label={`Checklist item ${index + 1}`}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({
                  checklist: checklist.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, label: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <button
              type="button"
              className="icon-button danger-text"
              aria-label={`Remove ${item.label}`}
              disabled={readOnly}
              onClick={() => {
                session.recordHistory();
                update({ checklist: checklist.filter((candidate) => candidate.id !== item.id) });
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}

        <div className="node-face-list-header">
          <strong>
            Done when <span>{criteria.length}</span>
          </strong>
          <button
            type="button"
            aria-label="Add a done condition"
            disabled={readOnly}
            onClick={() => {
              session.recordHistory();
              update({
                acceptanceCriteria: [
                  ...criteria,
                  { id: crypto.randomUUID(), description: 'New done condition', satisfied: false },
                ],
              });
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add
          </button>
        </div>
        {criteria.map((criterion, index) => (
          <div className="node-face-row" key={criterion.id}>
            <input
              type="checkbox"
              name={`brief-face-criterion-satisfied-${criterion.id}`}
              checked={criterion.satisfied}
              disabled={readOnly}
              aria-label={`Mark ${criterion.description} as done`}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, satisfied: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <input
              name={`brief-face-criterion-description-${criterion.id}`}
              value={criterion.description}
              readOnly={readOnly}
              aria-label={`Done condition ${index + 1}`}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, description: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <button
              type="button"
              className="icon-button danger-text"
              aria-label={`Remove ${criterion.description}`}
              disabled={readOnly}
              onClick={() => {
                session.recordHistory();
                update({
                  acceptanceCriteria: criteria.filter((candidate) => candidate.id !== criterion.id),
                });
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}

        {historyOpen ? (
          <div className="node-face-popover" role="dialog" aria-label="Brief version history">
            <button
              type="button"
              aria-label="Save brief version"
              disabled={readOnly || markdown.trim() === '' || latestVersion?.markdown === markdown}
              onClick={() => {
                session.recordHistory();
                update({
                  versions: [
                    ...versions,
                    {
                      id: crypto.randomUUID(),
                      createdAt: new Date().toISOString(),
                      markdown,
                      authorId: 'local-user',
                    },
                  ],
                });
              }}
            >
              <Save size={12} aria-hidden="true" /> Save brief version
            </button>
            {versions.length === 0 ? (
              <p>No saved versions yet. Edits still save automatically with the canvas.</p>
            ) : (
              <ol className="brief-face-versions">
                {versions
                  .slice()
                  .reverse()
                  .map((version) => (
                    <li key={version.id}>
                      <span>{new Date(version.createdAt).toLocaleString()}</span>
                      <button
                        type="button"
                        disabled={readOnly || version.markdown === markdown}
                        aria-label={`Restore brief version from ${new Date(version.createdAt).toLocaleString()}`}
                        onClick={() => {
                          session.recordHistory();
                          update({ markdown: version.markdown });
                        }}
                      >
                        <RotateCcw size={11} aria-hidden="true" /> Restore
                      </button>
                    </li>
                  ))}
              </ol>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
```

`src/renderer/src/components/workspace/content/note-image/NoteImageNodeFace.tsx`:

```tsx
import { useState, type JSX } from 'react';
import { ImagePlus } from 'lucide-react';

import { MarkdownComposer } from '../../../content/markdown/MarkdownComposer.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { addOrReplaceImageReference, type NoteImageReference } from './reference-updates.js';
import { useNoteImagePreviews } from './use-note-image-previews.js';

/**
 * Note & image face: markdown plus an image grid; images are added through the
 * existing project chooser. Alt text, relinking, and canvas-image reuse stay
 * in the inspector panel until 2d.
 */
export function NoteImageNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const images = data.images ?? [];
  const altText = data.altText ?? {};
  const previews = useNoteImagePreviews(session.project.id, images);
  const [choosing, setChoosing] = useState(false);

  const choose = async (): Promise<void> => {
    if (readOnly || choosing) return;
    setChoosing(true);
    try {
      const reference = await window.forgeboard.files.chooseImage({
        projectId: session.project.id,
      });
      if (reference === null) return;
      const normalized: NoteImageReference = {
        projectId: reference.projectId,
        relativePath: reference.relativePath,
        kind: 'image',
        missing: reference.missing,
        ...(reference.lastKnownHash === undefined
          ? {}
          : { lastKnownHash: reference.lastKnownHash }),
      };
      session.recordHistory();
      session.updateNodeData(id, { images: addOrReplaceImageReference(images, normalized) });
    } catch (cause) {
      session.reportError(
        cause instanceof Error ? cause.message : 'Could not choose this project image.',
      );
    } finally {
      setChoosing(false);
    }
  };

  return (
    <section className="node-face note-image-node-face" aria-label="Note and images">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          {images.length} image{images.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          aria-label="Choose image"
          disabled={readOnly || choosing}
          onClick={() => void choose()}
        >
          <ImagePlus size={12} aria-hidden="true" /> {choosing ? 'Choosing…' : 'Choose image'}
        </button>
      </div>
      <div className="node-face-body nowheel nodrag">
        <MarkdownComposer
          label="Note"
          value={data.markdown ?? ''}
          readOnly={readOnly}
          emptyLabel="Write a note that stays on this device."
          onBeginEdit={session.recordHistory}
          onChange={(markdown) => session.updateNodeData(id, { markdown })}
        />
        {images.length > 0 ? (
          <ul className="note-image-face-grid" aria-label="Linked images">
            {images.map((image) => {
              const preview = previews[image.relativePath];
              return (
                <li key={`${image.projectId}:${image.relativePath}`}>
                  {preview?.status === 'available' ? (
                    <img
                      src={preview.dataUrl}
                      alt={altText[image.relativePath] ?? image.relativePath}
                      draggable={false}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span role="status">
                      {preview?.status === 'loading' || preview === undefined
                        ? 'Loading…'
                        : preview.status === 'missing' || image.missing
                          ? 'Missing'
                          : 'No preview'}
                    </span>
                  )}
                  <code>{image.relativePath}</code>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
```

`node-face-registry.tsx` — imports + entries `brief: BriefNodeFace,` and `'note-image': NoteImageNodeFace,`.

`node-face.css` — append:

```css
.node-face-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.node-face-list-header strong span {
  color: var(--text-faint);
  font-weight: 400;
}
.node-face-list-header button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
}
.brief-face-versions {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.brief-face-versions li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.note-image-face-grid {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 8px;
}
.note-image-face-grid li {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.note-image-face-grid img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.note-image-face-grid code {
  font-size: var(--text-2xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 4: Run tests + typecheck.** Both face tests → PASS; `NoteImageInspector.test.tsx` and `BuiltInContentInspector.test.tsx` → PASS unchanged; registry test extended with `brief`/`note-image`. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/content/BriefNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/content/BriefNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/content/note-image/use-note-image-previews.ts apps/desktop/src/renderer/src/components/workspace/content/note-image/NoteImageNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/content/note-image/NoteImageNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/content/note-image/NoteImageInspector.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: brief and note-image content edits in place on the node face

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Task and review-gate faces

**Files:**

- Modify: `src/renderer/src/components/workspace/workflows/workflow-node-config.ts` (receive moved helpers)
- Modify: `src/renderer/src/components/workspace/workflows/WorkflowNodeInspector.tsx` (delete moved helpers, import them)
- Create: `src/renderer/src/components/workspace/workflows/faces/TaskNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/workflows/faces/TaskNodeFace.test.tsx`
- Create: `src/renderer/src/components/workspace/workflows/faces/ReviewGateNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/workflows/faces/ReviewGateNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `task`, `review-gate`)

**Helper move (bodies byte-identical, now exported):** move `updatedCriteria` (`WorkflowNodeInspector.tsx:465-479`), `gateLabel` (`:481-488`), and `gateLabelFromView` (`:490-492`) to the bottom of `workflow-node-config.ts` with `export` added (`gateLabelFromView` needs `import type { WorkflowReviewGateView } from '../../../../../shared/workflow/contracts.js';` there). `WorkflowNodeInspector.tsx` imports all three from `'./workflow-node-config.js'`.

- [ ] **Step 1: Write the failing tests.**

`TaskNodeFace.test.tsx`:

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import { TaskNodeFace } from './TaskNodeFace.js';

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
    nodeRoster: [
      { id: 'agent-1', title: 'Builder', kind: 'agent', locked: false },
      { id: 'file-1', title: 'Spec', kind: 'file', locked: false },
    ],
    checkProducers: [],
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'task',
    title: 'Build login',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#58a6a6',
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <TaskNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TaskNodeFace', () => {
  it('edits status, assignee, and priority as compact rows', () => {
    renderFace();
    fireEvent.change(screen.getByLabelText('Task status'), { target: { value: 'in-progress' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { taskStatus: 'in-progress' });
    fireEvent.change(screen.getByLabelText('Assigned agent'), { target: { value: 'agent-1' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { assigneeId: 'agent-1' });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'urgent' } });
    expect(updateNodeData).toHaveBeenCalledWith('n1', { priority: 'urgent' });
  });

  it('offers only agent nodes as assignees', () => {
    renderFace();
    const options = [...screen.getByLabelText('Assigned agent').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toEqual(['', 'agent-1']);
  });

  it('edits done conditions in place', () => {
    renderFace({
      acceptanceCriteria: [{ id: 'a1', description: 'Tests pass', satisfied: false }],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Tests pass as done' }));
    expect(updateNodeData).toHaveBeenCalledWith('n1', {
      acceptanceCriteria: [{ id: 'a1', description: 'Tests pass', satisfied: true }],
    });
  });

  it('disables every control for read-only nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByLabelText('Task status')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Assigned agent')).toHaveProperty('disabled', true);
  });
});
```

`ReviewGateNodeFace.test.tsx`:

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkflowReviewGateView } from '../../../../../../shared/workflow/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import {
  WorkflowRuntimeProvider,
  type WorkflowRuntimeContextValue,
} from '../WorkflowRuntimeContext.js';
import { ReviewGateNodeFace } from './ReviewGateNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const requestDecision = vi.fn();

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  requestDecision.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    nodeRoster: [],
    checkProducers: [
      { nodeId: 't1', producerId: 'test', title: 'Unit tests', checkKind: 'test' },
      { nodeId: 't2', producerId: 'lint', title: 'Lint', checkKind: 'lint' },
    ],
  } as unknown as AgentSessionContextValue;
}

function runtimeValue(
  overrides: Partial<WorkflowRuntimeContextValue> = {},
): WorkflowRuntimeContextValue {
  return {
    executions: [],
    interactionEvents: [],
    busyAction: null,
    mutationsAuthorized: true,
    reviewGateFor: () => null,
    pendingDecisionFor: () => null,
    requestDecision,
    startNode: vi.fn(),
    cancelNode: vi.fn(),
    revealArtifact: vi.fn(),
    openArtifact: vi.fn(),
    ...overrides,
  } as WorkflowRuntimeContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'review-gate',
    title: 'Quality gate',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#64a774',
    humanApprovalRequired: true,
    requiredCheckIds: [],
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(
  overrides: Partial<WorkshopNodeData> = {},
  runtime: Partial<WorkflowRuntimeContextValue> = {},
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <WorkflowRuntimeProvider value={runtimeValue(runtime)}>
          <ReviewGateNodeFace id="g1" data={nodeData(overrides)} />
        </WorkflowRuntimeProvider>
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('ReviewGateNodeFace', () => {
  it('shows the authoritative gate state when the workflow has evaluated it', () => {
    renderFace(
      {},
      {
        reviewGateFor: () =>
          ({
            nodeId: 'g1',
            status: 'waiting-human',
            reasons: ['Waiting for your approval.'],
          }) as unknown as WorkflowReviewGateView,
      },
    );
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Waiting for you');
    expect(screen.getByText('Waiting for your approval.')).toBeTruthy();
  });

  it('falls back to the saved gate state without an evaluation', () => {
    renderFace({ gateState: 'passed' });
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Passed');
  });

  it('toggles required checks in place', () => {
    renderFace();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Require Unit tests' }));
    expect(recordHistory).toHaveBeenCalled();
    expect(updateNodeData).toHaveBeenCalledWith('g1', { requiredCheckIds: ['test'] });
  });

  it('surfaces the pending decision as an approval action', () => {
    const target = { kind: 'human' as const, request: { nodeId: 'g1' } };
    renderFace({}, { pendingDecisionFor: () => target as never });
    fireEvent.click(screen.getByRole('button', { name: 'Review and decide' }));
    expect(requestDecision).toHaveBeenCalledWith(target);
  });
});
```

- [ ] **Step 2: Run to verify failure** — modules not found.

- [ ] **Step 3: Implement.**

Perform the helper move, then create `faces/TaskNodeFace.tsx`:

```tsx
import type { JSX } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

/** Task face: status, assignee, priority, and done conditions as compact rows. */
export function TaskNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const agents = session.nodeRoster.filter((entry) => entry.kind === 'agent');
  const criteria = data.acceptanceCriteria ?? [];

  const update = (patch: Parameters<typeof session.updateNodeData>[1]): void => {
    session.updateNodeData(id, patch);
  };

  return (
    <section className="node-face task-node-face" aria-label="Task">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">Task</span>
        <span className="node-face-status" role="status">
          {data.taskStatus ?? 'backlog'}
        </span>
      </div>
      <fieldset className="node-face-body nowheel nodrag" disabled={readOnly}>
        <div className="task-face-grid">
          <label>
            Status
            <select
              name={`node-${id}-task-face-status`}
              aria-label="Task status"
              value={data.taskStatus ?? 'backlog'}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({ taskStatus: event.target.value as NonNullable<typeof data.taskStatus> })
              }
            >
              <option value="backlog">Backlog</option>
              <option value="ready">Ready</option>
              <option value="in-progress">In progress</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label>
            Priority
            <select
              name={`node-${id}-task-face-priority`}
              aria-label="Priority"
              value={data.priority ?? 'normal'}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({ priority: event.target.value as NonNullable<typeof data.priority> })
              }
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
        </div>
        <label>
          Assigned agent
          <select
            name={`node-${id}-task-face-assignee`}
            aria-label="Assigned agent"
            value={data.assigneeId ?? ''}
            onFocus={session.recordHistory}
            onChange={(event) => update({ assigneeId: event.target.value })}
          >
            <option value="">Choose an agent…</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
        </label>

        <div className="node-face-list-header">
          <strong>
            Done when <span>{criteria.length}</span>
          </strong>
          <button
            type="button"
            aria-label="Add a done condition"
            onClick={() => {
              session.recordHistory();
              update({
                acceptanceCriteria: [
                  ...criteria,
                  { id: crypto.randomUUID(), description: 'New done condition', satisfied: false },
                ],
              });
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add
          </button>
        </div>
        {criteria.map((criterion, index) => (
          <div className="node-face-row" key={criterion.id}>
            <input
              type="checkbox"
              name={`task-face-criterion-satisfied-${criterion.id}`}
              checked={criterion.satisfied}
              aria-label={`Mark ${criterion.description} as done`}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, satisfied: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <input
              name={`task-face-criterion-description-${criterion.id}`}
              value={criterion.description}
              aria-label={`Done condition ${index + 1}`}
              onFocus={session.recordHistory}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, description: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <button
              type="button"
              className="icon-button danger-text"
              aria-label={`Remove ${criterion.description}`}
              onClick={() => {
                session.recordHistory();
                update({
                  acceptanceCriteria: criteria.filter((candidate) => candidate.id !== criterion.id),
                });
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
      </fieldset>
    </section>
  );
}
```

`faces/ReviewGateNodeFace.tsx`:

```tsx
import type { JSX } from 'react';
import { ShieldCheck } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { gateLabel, gateLabelFromView } from '../workflow-node-config.js';
import { useWorkflowRuntime } from '../WorkflowRuntimeContext.js';

/**
 * Review-gate face: authoritative gate state, required checks, and the pending
 * approval action (opens the existing decision dialog). Reviewer/retry policy
 * configuration stays in the inspector panel until 2d.
 */
export function ReviewGateNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const runtime = useWorkflowRuntime();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const gate = runtime.reviewGateFor(id);
  const decision = runtime.pendingDecisionFor(id);
  const required = new Set(data.requiredCheckIds ?? []);

  const update = (patch: Parameters<typeof session.updateNodeData>[1]): void => {
    session.recordHistory();
    session.updateNodeData(id, patch);
  };

  return (
    <section className="node-face review-gate-node-face" aria-label="Quality gate">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <ShieldCheck size={12} aria-hidden="true" /> Quality gate
        </span>
        <span className="node-face-status" role="status">
          {gate === null ? gateLabel(data.gateState) : gateLabelFromView(gate.status)}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        <label className="node-face-row review-gate-face-toggle">
          <input
            type="checkbox"
            name={`node-${id}-face-human-approval`}
            checked={data.humanApprovalRequired ?? true}
            disabled={readOnly}
            aria-label="Require human approval"
            onChange={(event) => update({ humanApprovalRequired: event.target.checked })}
          />
          <span>Require human approval</span>
        </label>

        <div className="node-face-list-header">
          <strong>
            Required checks <span>{required.size}</span>
          </strong>
        </div>
        {session.checkProducers.length === 0 ? (
          <p className="node-face-hint">Add a test node to the canvas, then select it here.</p>
        ) : (
          session.checkProducers.map((producer) => (
            <label className="node-face-row" key={producer.nodeId}>
              <input
                type="checkbox"
                name={`node-${id}-face-producer-${producer.nodeId}`}
                checked={required.has(producer.producerId)}
                disabled={readOnly}
                aria-label={`Require ${producer.title}`}
                onChange={(event) => {
                  const next = new Set(required);
                  if (event.target.checked) next.add(producer.producerId);
                  else next.delete(producer.producerId);
                  update({ requiredCheckIds: [...next].sort() });
                }}
              />
              <span className="review-gate-face-producer">
                {producer.title} <small>{producer.checkKind}</small>
              </span>
            </label>
          ))
        )}

        {gate !== null && gate.reasons.length > 0 ? (
          <ul className="review-gate-face-reasons" aria-label="Review gate reasons">
            {gate.reasons.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}

        {decision !== null && runtime.mutationsAuthorized ? (
          <button
            type="button"
            className="review-gate-face-decide"
            onClick={() => runtime.requestDecision(decision)}
          >
            Review and decide
          </button>
        ) : null}
      </div>
    </section>
  );
}
```

`node-face-registry.tsx` — imports + entries `task: TaskNodeFace,` and `'review-gate': ReviewGateNodeFace,`. `node-face.css` — append:

```css
.task-face-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.review-gate-face-producer small {
  color: var(--text-faint);
  margin-left: 4px;
}
.review-gate-face-reasons {
  margin: 0;
  padding-left: 16px;
  color: var(--text-soft);
}
.review-gate-face-decide {
  align-self: flex-start;
  padding: 4px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
}
```

- [ ] **Step 4: Run tests + typecheck.** Both face tests → PASS; `workflows/tests/WorkflowNodeInspector.test.tsx` → PASS unchanged (helper move is behavior-preserving); registry test extended. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/workflows/workflow-node-config.ts apps/desktop/src/renderer/src/components/workspace/workflows/WorkflowNodeInspector.tsx apps/desktop/src/renderer/src/components/workspace/workflows/faces/TaskNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/workflows/faces/TaskNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/workflows/faces/ReviewGateNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/workflows/faces/ReviewGateNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: task and review-gate status edit and approve on the node face

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Git-pr operational strip face

**Files:**

- Create: `src/renderer/src/components/workspace/git-pr/configuration.ts` (receives moved helpers)
- Modify: `src/renderer/src/components/workspace/shell/WorkspaceInspector.tsx` (delete `gitPrConfiguration`/`gitPrNodeDataPatch` at `:504-533`, import from the new module, call with `selectedNode.data`)
- Create: `src/renderer/src/components/workspace/git-pr/GitPrNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/git-pr/GitPrNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/git-pr/index.ts` (re-export the moved helpers if the barrel exports configuration types)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `git-pr`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append)

**Helper move:** `git-pr/configuration.ts` gets the two functions from `WorkspaceInspector.tsx:504-533`, with `gitPrConfiguration`'s signature changed from `(node: WorkshopNode, defaultRemote: string)` to `(data: WorkshopNodeData, defaultRemote: string)` (every `node.data.` becomes `data.`; the title fallback becomes `data.title`). `WorkspaceInspector.tsx:341` becomes `configuration={gitPrConfiguration(selectedNode.data, props.settings.gitRemote)}`.

```ts
// git-pr/configuration.ts
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import type { GitPrNodeConfiguration } from './types.js';

export function gitPrConfiguration(
  data: WorkshopNodeData,
  defaultRemote: string,
): GitPrNodeConfiguration {
  /* moved body */
}

export function gitPrNodeDataPatch(
  patch: Partial<GitPrNodeConfiguration>,
): Partial<WorkshopNodeData> {
  /* moved body */
}
```

- [ ] **Step 1: Write the failing test** (`GitPrNodeFace.test.tsx`):

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { GitPrNodeController } from './types.js';

const controller = vi.hoisted(() => ({ current: null as unknown as GitPrNodeController }));
const useGitPrNodeController = vi.hoisted(() => vi.fn(() => controller.current));
vi.mock('./useGitPrNodeController.js', () => ({ useGitPrNodeController }));

import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../runs/agent-session/AgentSessionContext.js';
import { GitPrNodeFace } from './GitPrNodeFace.js';

const updateNodeData = vi.fn();
const recordHistory = vi.fn();
const openGitPrReadiness = vi.fn();

function baseController(overrides: Partial<GitPrNodeController> = {}): GitPrNodeController {
  return {
    agentRuns: [],
    agentRunsLoaded: true,
    agentRunsError: null,
    availableRemotes: null,
    inspection: null,
    inspectionError: null,
    githubStatus: null,
    githubError: null,
    ciStatus: null,
    ciError: null,
    actionError: null,
    pendingPlan: null,
    busy: null,
    notice: null,
    refreshAgentRuns: vi.fn(),
    inspect: vi.fn(),
    preparePush: vi.fn(),
    checkGitHub: vi.fn(),
    preparePullRequest: vi.fn(),
    checkCi: vi.fn(),
    cancelPlan: vi.fn(),
    confirmPlan: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);
beforeEach(() => {
  updateNodeData.mockClear();
  recordHistory.mockClear();
  openGitPrReadiness.mockClear();
  useGitPrNodeController.mockClear();
  controller.current = baseController();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    settings: { gitRemote: 'origin' },
    graphReadOnly: false,
    updateNodeData,
    recordHistory,
    reportError: vi.fn(),
    runnableAgents: [{ id: 'claude', label: 'Claude Code' }],
    nodeRoster: [{ id: 'a1', title: 'Builder', kind: 'agent', locked: false }],
    checkProducers: [],
    openGitPrReadiness,
  } as unknown as AgentSessionContextValue;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'git-pr',
    title: 'Publish login',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#7888d8',
    deliveryTarget: { kind: 'agent-run', runId: 'run-1' },
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(overrides: Partial<WorkshopNodeData> = {}) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <GitPrNodeFace id="n1" data={nodeData(overrides)} />
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('GitPrNodeFace', () => {
  it('drives the existing controller with roster-derived labels', () => {
    renderFace();
    expect(useGitPrNodeController).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        nodes: [{ id: 'a1', data: { title: 'Builder' } }],
        agents: [{ id: 'claude', label: 'Claude Code' }],
      }),
    );
  });

  it('shows the operational strip once an inspection exists', () => {
    controller.current = baseController({
      inspection: {
        targetRunId: 'run-1',
        sourceBranch: 'feature/login',
        remote: 'origin',
        destinationBranch: 'feature/login',
        requestedBaseBranch: 'main',
        commitCount: 3,
        fileCount: 5,
        additions: 120,
        deletions: 8,
        ahead: 3,
        behind: 1,
        ready: true,
        readiness: [],
        commits: [],
        files: [],
      } as unknown as NonNullable<GitPrNodeController['inspection']>,
    });
    renderFace({ remote: 'origin', destinationBranch: 'feature/login', baseBranch: 'main' });
    expect(screen.getByText('feature/login → origin/main')).toBeTruthy();
    expect(screen.getByText('3 ahead · 1 behind')).toBeTruthy();
    expect(screen.getByText('3 commits')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Ready to publish');
  });

  it('runs checks and opens readiness from the face', () => {
    renderFace();
    fireEvent.click(screen.getByRole('button', { name: 'Check changes' }));
    expect(controller.current.inspect).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open checks and approval' }));
    expect(openGitPrReadiness).toHaveBeenCalledWith('run-1');
  });

  it('shows the created pull request link', () => {
    renderFace({ pullRequestUrl: 'https://github.com/acme/app/pull/7' });
    expect(screen.getByText('https://github.com/acme/app/pull/7')).toBeTruthy();
  });

  it('disables publish-affecting controls for read-only nodes', () => {
    renderFace({ locked: true });
    expect(screen.getByRole('button', { name: 'Open checks and approval' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — modules not found.

- [ ] **Step 3: Implement.**

Perform the helper move, then create `GitPrNodeFace.tsx`:

```tsx
import { useCallback, useMemo, type JSX } from 'react';
import { GitBranch, GitPullRequest, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';

import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';
import { gitPrConfiguration, gitPrNodeDataPatch } from './configuration.js';
import { useGitPrNodeController } from './useGitPrNodeController.js';

/**
 * Git delivery face: operational strip with the run target, compact
 * branch/remote settings, ahead/behind + commit/file chips, CI/readiness
 * status, and the created pull-request link. Push and pull-request plan
 * confirmations remain in the inspector panel until 2d — they are modal,
 * focus-trapped flows.
 */
export function GitPrNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const configuration = useMemo(
    () => gitPrConfiguration(data, session.settings.gitRemote),
    [data, session.settings.gitRemote],
  );
  const nodeLabels = useMemo(
    () => session.nodeRoster.map((entry) => ({ id: entry.id, data: { title: entry.title } })),
    [session.nodeRoster],
  );
  const onPullRequestCreated = useCallback(
    (pullRequestUrl: string) => {
      session.recordHistory();
      session.updateNodeData(id, gitPrNodeDataPatch({ pullRequestUrl }));
    },
    [id, session],
  );
  const controller = useGitPrNodeController({
    projectId: session.project.id,
    configuration,
    nodes: nodeLabels,
    agents: session.runnableAgents,
    onError: session.reportError,
    onPullRequestCreated,
  });
  const inspection =
    controller.inspection !== null &&
    controller.inspection.targetRunId === configuration.targetRunId &&
    controller.inspection.remote === configuration.remote &&
    controller.inspection.destinationBranch === configuration.destinationBranch &&
    controller.inspection.requestedBaseBranch === configuration.baseBranch
      ? controller.inspection
      : null;
  const busy = controller.busy !== null;
  const targetRunId = configuration.targetRunId;

  const change = (patch: Parameters<typeof gitPrNodeDataPatch>[0]): void => {
    session.recordHistory();
    session.updateNodeData(id, gitPrNodeDataPatch(patch));
  };

  return (
    <section className="node-face git-pr-node-face" aria-label="Publish changes" aria-busy={busy}>
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <GitPullRequest size={12} aria-hidden="true" /> Publish
        </span>
        <span
          className={`node-face-status ${controller.inspectionError === null ? '' : 'failed'}`}
          role="status"
        >
          {busy ? 'Working…' : inspection?.ready === true ? 'Ready to publish' : 'Check needed'}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        <fieldset className="git-pr-face-config" disabled={readOnly || busy}>
          <label>
            Finished agent run
            <select
              name={`node-${id}-git-pr-face-run`}
              aria-label="Finished agent run"
              value={targetRunId ?? ''}
              onChange={(event) =>
                change(
                  event.target.value === ''
                    ? { targetRunId: undefined }
                    : { targetRunId: event.target.value },
                )
              }
            >
              <option value="">Choose a finished run…</option>
              {targetRunId !== undefined &&
              !controller.agentRuns.some((run) => run.runId === targetRunId) ? (
                <option value={targetRunId}>Saved run · {targetRunId.slice(0, 8)}</option>
              ) : null}
              {controller.agentRuns.map((run) => (
                <option
                  key={run.runId}
                  value={run.runId}
                  disabled={run.worktreeState === 'cleanup-pending'}
                >
                  {run.nodeLabel} · {run.agentLabel} · {run.status}
                </option>
              ))}
            </select>
          </label>
          <div className="task-face-grid">
            <label>
              Remote
              <input
                name={`node-${id}-git-pr-face-remote`}
                aria-label="Remote"
                maxLength={128}
                value={configuration.remote}
                onChange={(event) => change({ remote: event.target.value })}
              />
            </label>
            <label>
              Base branch
              <input
                name={`node-${id}-git-pr-face-base`}
                aria-label="Base branch"
                maxLength={1024}
                value={configuration.baseBranch}
                onChange={(event) => change({ baseBranch: event.target.value })}
              />
            </label>
          </div>
          <label>
            Destination branch
            <input
              name={`node-${id}-git-pr-face-destination`}
              aria-label="Destination branch"
              maxLength={1024}
              value={configuration.destinationBranch}
              onChange={(event) => change({ destinationBranch: event.target.value })}
            />
          </label>
        </fieldset>

        <div className="node-face-row git-pr-face-actions">
          <button
            type="button"
            aria-label="Check changes"
            disabled={targetRunId === undefined || busy}
            onClick={controller.inspect}
          >
            {controller.busy === 'inspect' ? (
              <LoaderCircle className="spin" size={12} aria-hidden="true" />
            ) : (
              <GitBranch size={12} aria-hidden="true" />
            )}
            Check changes
          </button>
          <button
            type="button"
            aria-label="Check CI results"
            disabled={
              targetRunId === undefined ||
              inspection === null ||
              controller.githubStatus?.authenticated !== true ||
              busy
            }
            onClick={controller.checkCi}
          >
            <RefreshCw size={12} aria-hidden="true" /> CI
          </button>
          <button
            type="button"
            aria-label="Open checks and approval"
            disabled={readOnly || targetRunId === undefined || busy}
            onClick={() => {
              if (targetRunId !== undefined) session.openGitPrReadiness(targetRunId);
            }}
          >
            <ShieldCheck size={12} aria-hidden="true" /> Open checks and approval
          </button>
        </div>

        {controller.inspectionError !== null ? (
          <p role="alert" className="git-pr-face-error">
            {controller.inspectionError}
          </p>
        ) : null}

        {inspection !== null ? (
          <>
            <p className="git-pr-face-route">
              {inspection.sourceBranch} → {inspection.remote}/{inspection.requestedBaseBranch}
            </p>
            <div className="node-face-chips">
              <span>
                {inspection.ahead} ahead · {inspection.behind} behind
              </span>
              <span>
                {inspection.commitCount} commit{inspection.commitCount === 1 ? '' : 's'}
              </span>
              <span>
                {inspection.fileCount} files · +{inspection.additions} −{inspection.deletions}
              </span>
              {controller.ciStatus !== null ? (
                <span>
                  CI · {controller.ciStatus.runs.length} run
                  {controller.ciStatus.runs.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
            {inspection.readiness.length > 0 ? (
              <ul className="review-gate-face-reasons" aria-label="Publish blockers">
                {inspection.readiness.slice(0, 3).map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        {configuration.pullRequestUrl !== undefined ? (
          <p className="git-pr-face-link">
            Pull request · <code>{configuration.pullRequestUrl}</code>
          </p>
        ) : null}
      </div>
    </section>
  );
}
```

`node-face-registry.tsx` — import + entry `'git-pr': GitPrNodeFace,`. `node-face.css` — append:

```css
.git-pr-face-config {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.git-pr-face-actions {
  flex-wrap: wrap;
}
.git-pr-face-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
}
.git-pr-face-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
.git-pr-face-route {
  margin: 0;
  font-family: ui-monospace, monospace;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-pr-face-error {
  margin: 0;
  color: #d06870;
}
.git-pr-face-link {
  margin: 0;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run tests + typecheck.** New face test → PASS; run the whole git-pr slice `.../components/workspace/git-pr` and `.../components/workspace/shell` (WorkspaceInspector helper move) → PASS; registry test extended. Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/git-pr/configuration.ts apps/desktop/src/renderer/src/components/workspace/git-pr/GitPrNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/git-pr/GitPrNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/git-pr/index.ts apps/desktop/src/renderer/src/components/workspace/shell/WorkspaceInspector.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: git-pr operational strip renders on the node face

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Test-runner face

**Files:**

- Create: `src/renderer/src/components/workspace/workflows/test-node/TestNodeFace.tsx`
- Create: `src/renderer/src/components/workspace/workflows/test-node/TestNodeFace.test.tsx`
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx` (register `test`)
- Modify: `src/renderer/src/components/workspace/canvas/faces/node-face.css` (append)

- [ ] **Step 1: Write the failing test** (`TestNodeFace.test.tsx`):

```tsx
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { WorkflowExecutionView } from '../../../../../../shared/workflow/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { CanvasNodeInteractionProvider } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import {
  AgentSessionProvider,
  type AgentSessionContextValue,
} from '../../runs/agent-session/AgentSessionContext.js';
import {
  WorkflowRuntimeProvider,
  type WorkflowRuntimeContextValue,
} from '../WorkflowRuntimeContext.js';
import { TestNodeFace } from './TestNodeFace.js';

const startNode = vi.fn();
const cancelNode = vi.fn();
const revealArtifact = vi.fn(async () => undefined);
const openArtifact = vi.fn(async () => undefined);

afterEach(cleanup);
beforeEach(() => {
  startNode.mockClear();
  cancelNode.mockClear();
  revealArtifact.mockClear();
  openArtifact.mockClear();
});

function sessionValue(): AgentSessionContextValue {
  return {
    project: { id: 'p1' },
    graphReadOnly: false,
    updateNodeData: vi.fn(),
    recordHistory: vi.fn(),
    reportError: vi.fn(),
  } as unknown as AgentSessionContextValue;
}

function runtimeValue(
  executions: readonly WorkflowExecutionView[] = [],
  overrides: Partial<WorkflowRuntimeContextValue> = {},
): WorkflowRuntimeContextValue {
  return {
    executions,
    interactionEvents: [],
    busyAction: null,
    mutationsAuthorized: true,
    reviewGateFor: () => null,
    pendingDecisionFor: () => null,
    requestDecision: vi.fn(),
    startNode,
    cancelNode,
    revealArtifact,
    openArtifact,
    ...overrides,
  } as WorkflowRuntimeContextValue;
}

function execution(overrides: Record<string, unknown> = {}): WorkflowExecutionView {
  return {
    id: 'x1',
    updatedAt: '2026-07-20T10:00:00.000Z',
    nodeRuns: [{ nodeId: 'n1', attempt: 1, status: 'running' }],
    testResults: [],
    approvals: [],
    humanDecisions: [],
    revisionEscapes: [],
    ...overrides,
  } as unknown as WorkflowExecutionView;
}

function nodeData(overrides: Partial<WorkshopNodeData> = {}): WorkshopNodeData {
  return {
    kind: 'test',
    title: 'Unit tests',
    description: '',
    status: 'idle',
    locked: false,
    collapsed: false,
    color: '#64a774',
    command: { executable: 'pnpm', arguments: ['test'] },
    ...overrides,
  } as WorkshopNodeData;
}

function renderFace(
  overrides: Partial<WorkshopNodeData> = {},
  runtime: WorkflowRuntimeContextValue = runtimeValue(),
) {
  return render(
    <CanvasNodeInteractionProvider readOnly={false} setCollapsed={() => undefined}>
      <AgentSessionProvider value={sessionValue()}>
        <WorkflowRuntimeProvider value={runtime}>
          <TestNodeFace id="n1" data={nodeData(overrides)} />
        </WorkflowRuntimeProvider>
      </AgentSessionProvider>
    </CanvasNodeInteractionProvider>,
  );
}

describe('TestNodeFace', () => {
  it('shows the command summary and starts a run', () => {
    renderFace();
    expect(screen.getByText('pnpm test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and run' }));
    expect(startNode).toHaveBeenCalledWith('n1');
  });

  it('offers Cancel while an attempt is active', () => {
    renderFace({}, runtimeValue([execution()]));
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Running');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelNode).toHaveBeenCalledWith({ executionId: 'x1', nodeId: 'n1', attempt: 1 });
  });

  it('shows the latest attempt summary and artifact actions', () => {
    const runtime = runtimeValue([
      execution({
        nodeRuns: [{ nodeId: 'n1', attempt: 1, status: 'succeeded' }],
        testResults: [
          {
            nodeId: 'n1',
            attempt: 1,
            checkExecutionId: 'chk-1',
            status: 'passed',
            output: 'Tests: 12 passed, 12 total',
            outputTruncated: false,
            summary: { parser: 'jest', passed: 12, failed: 0, skipped: 0, total: 12 },
            startedAt: '2026-07-20T09:00:00.000Z',
            endedAt: '2026-07-20T09:01:00.000Z',
            artifacts: [
              {
                executionId: 'x1',
                nodeId: 'n1',
                attempt: 1,
                projectId: 'p1',
                relativePath: 'coverage/index.html',
                sha256: 'abc',
                label: 'report',
              },
            ],
          },
        ],
      }),
    ]);
    renderFace({}, runtime);
    expect(screen.getByRole('status')).toHaveProperty('textContent', 'Passed');
    expect(screen.getByText('12 passed · 0 failed · 12 total')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal report' }));
    expect(revealArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'coverage/index.html', checkExecutionId: 'chk-1' }),
    );
  });

  it('blocks starting without a configured command or authorization', () => {
    renderFace({ command: { executable: '', arguments: [] } });
    expect(screen.getByRole('button', { name: 'Review and run' })).toHaveProperty('disabled', true);
    cleanup();
    renderFace({}, runtimeValue([], { mutationsAuthorized: false }));
    expect(screen.getByRole('button', { name: 'Review and run' })).toHaveProperty('disabled', true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.**

`src/renderer/src/components/workspace/workflows/test-node/TestNodeFace.tsx`:

```tsx
import type { JSX } from 'react';
import { CircleStop, ExternalLink, FolderOpen, Play, RefreshCw, TestTube2 } from 'lucide-react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { useWorkflowRuntime } from '../WorkflowRuntimeContext.js';
import type { TestNodeArtifact } from './contracts.js';
import { testNodeAttempts, testStatusLabel } from './view-model.js';

/**
 * Test-runner face: command summary, run status, Start/Cancel, latest-attempt
 * summary, attempt count, and verified artifact actions. Command configuration
 * and full output/history stay in the inspector panel until 2d.
 */
export function TestNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const runtime = useWorkflowRuntime();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const attempts = testNodeAttempts(id, runtime.executions, runtime.interactionEvents);
  const current = attempts[0] ?? null;
  const executable = data.command?.executable ?? '';
  const commandLine = [executable, ...(data.command?.arguments ?? [])].join(' ').trim();
  const commandConfigured = executable.trim() !== '';
  const operationBusy = runtime.busyAction !== null;
  const canStart =
    !readOnly &&
    !operationBusy &&
    current?.active !== true &&
    commandConfigured &&
    runtime.mutationsAuthorized;
  const artifacts = (current?.artifacts ?? []).filter(
    (artifact) => artifact.nodeId === id && artifact.projectId === session.project.id,
  );

  const invokeArtifact = async (
    action: (input: Parameters<typeof runtime.revealArtifact>[0]) => Promise<void>,
    artifact: TestNodeArtifact,
  ): Promise<void> => {
    if (current?.checkExecutionId === undefined) return;
    try {
      await action({
        checkExecutionId: current.checkExecutionId,
        executionId: artifact.executionId,
        nodeId: artifact.nodeId,
        attempt: artifact.attempt,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
      });
    } catch (cause) {
      session.reportError(
        cause instanceof Error ? cause.message : 'The test artifact could not be opened.',
      );
    }
  };

  return (
    <section className="node-face test-node-face" aria-label="Test runner">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">
          <TestTube2 size={12} aria-hidden="true" /> Test runner
        </span>
        <span
          className={`node-face-status ${current?.status === 'failed' ? 'failed' : ''}`}
          role="status"
        >
          {current === null ? 'Not run' : testStatusLabel(current)}
        </span>
      </div>
      <div className="node-face-body nowheel nodrag">
        {commandConfigured ? (
          <code className="test-face-command">{commandLine}</code>
        ) : (
          <p role="alert" className="test-face-warning">
            Set up a command in the panel before running this test.
          </p>
        )}

        <div className="node-face-row">
          {current?.active === true ? (
            <button
              type="button"
              aria-label="Cancel"
              disabled={operationBusy || !runtime.mutationsAuthorized}
              onClick={() =>
                runtime.cancelNode({
                  executionId: current.executionId,
                  nodeId: id,
                  attempt: current.attempt,
                })
              }
            >
              <CircleStop size={12} aria-hidden="true" />
              {operationBusy ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : (
            <button
              type="button"
              aria-label="Review and run"
              disabled={!canStart}
              onClick={() => runtime.startNode(id)}
            >
              {current === null ? (
                <Play size={12} aria-hidden="true" />
              ) : (
                <RefreshCw size={12} aria-hidden="true" />
              )}
              Review and run
            </button>
          )}
          <span className="node-face-status">
            {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
          </span>
        </div>

        {current?.summary !== null && current?.summary !== undefined ? (
          <p className="test-face-summary">
            {current.summary.passed} passed · {current.summary.failed} failed ·{' '}
            {current.summary.total} total
          </p>
        ) : null}
        {current?.approvalRequired === true ? (
          <p role="status" className="test-face-warning">
            Waiting for your approval in the Workflows panel.
          </p>
        ) : null}
        {current?.statusReason !== undefined ? (
          <p className="test-face-warning">{current.statusReason}</p>
        ) : null}

        {artifacts.length > 0 && current?.checkExecutionId !== undefined ? (
          <div className="test-face-artifacts" aria-label="Verified test artifacts">
            {artifacts.map((artifact) => (
              <div
                className="node-face-row"
                key={`${artifact.executionId}:${artifact.attempt}:${artifact.relativePath}`}
              >
                <code>{artifact.relativePath}</code>
                <button
                  type="button"
                  aria-label={`Reveal ${artifact.label}`}
                  onClick={() => void invokeArtifact(runtime.revealArtifact, artifact)}
                >
                  <FolderOpen size={11} aria-hidden="true" /> Reveal {artifact.label}
                </button>
                <button
                  type="button"
                  aria-label={`Open ${artifact.label}`}
                  onClick={() => void invokeArtifact(runtime.openArtifact, artifact)}
                >
                  <ExternalLink size={11} aria-hidden="true" /> Open {artifact.label}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
```

`node-face-registry.tsx` — `import { TestNodeFace } from '../../workflows/test-node/TestNodeFace.js';`, entry `test: TestNodeFace,`.

`node-face.css` — append:

```css
.test-face-command {
  display: block;
  padding: 4px 6px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface-raised);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.test-face-summary {
  margin: 0;
  color: var(--text-soft);
}
.test-face-warning {
  margin: 0;
  color: #c9964f;
}
.test-face-artifacts {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.test-face-artifacts code {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 4: Run tests + typecheck.** `TestNodeFace.test.tsx` → PASS; `test-node/TestNodePanel.test.tsx` → PASS unchanged; registry test extended with `test` (the first registry case now asserts all eleven registered kinds). Typecheck → clean.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/renderer/src/components/workspace/workflows/test-node/TestNodeFace.tsx apps/desktop/src/renderer/src/components/workspace/workflows/test-node/TestNodeFace.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face-registry.test.tsx apps/desktop/src/renderer/src/components/workspace/canvas/faces/node-face.css
git commit -m "feat: test runner status and controls render on the node face

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification

- [ ] **Step 1:** `corepack pnpm --dir apps/desktop typecheck` → clean.
- [ ] **Step 2:** From the worktree root: `corepack pnpm lint` → clean; `corepack pnpm test:unit` → green (record any pre-existing failures and confirm they fail identically on the pre-task baseline commit before ignoring).
- [ ] **Step 3:** Focused slices (must all pass): `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace`.
- [ ] **Step 4:** Manual smoke via `corepack pnpm --dir apps/desktop dev` — NOTE: launching Electron from this worktree requires the electron-dist clone fix (copy `dist/` + `path.txt` from the main checkout's electron package into this worktree's; see the project memory "Worktree Electron fix"):
  - Every one of the eight kinds: add the node → face renders at its stated default size; resize respects the stated minimum; collapse → 35px pill and back; lock disables face editing; the inspector panel for the same node still works alongside the face.
  - `diagram`: type source on the face → preview re-renders debounced without flashing; Edit/Preview toggles; invalid source shows the error; inspector split view still renders.
  - `whiteboard`: click shapes in the preview to select; Tools popover adds rectangle/annotation; deleting the selected element works; inspector element editor still edits the same document.
  - `brief`: markdown edit-in-place, checklist and done-when rows add/toggle/remove; version popover saves and restores; undo (recordHistory) steps each edit.
  - `note-image`: note edits; Choose image opens the project chooser and the grid shows the image; missing images labeled.
  - `task`: status/assignee/priority/criteria edit on the face; assignee list shows only agent nodes and refreshes after adding an agent.
  - `review-gate`: required-check toggles persist; run a workflow to a gate → face shows "Waiting for you" and "Review and decide" opens the existing decision dialog; deciding clears the action.
  - `git-pr`: pick a finished run, Check changes → route line, ahead/behind and commit/file chips appear; Open checks and approval opens the Git review dialog; a created PR URL shows on the face.
  - `test`: Review and run starts the launch-approval flow; Cancel during a run; summary counts and artifact Reveal/Open work.
  - Scroll inside every face body scrolls content (nowheel), dragging by the node header still moves the node, and canvas zoom is unaffected.
- [ ] **Step 5:** Check off this plan's boxes and commit the plan file: `git add docs/superpowers/plans/2026-07-20-document-status-faces.md && git commit -m "docs: document and status faces plan executed"` (with the co-author trailer).
