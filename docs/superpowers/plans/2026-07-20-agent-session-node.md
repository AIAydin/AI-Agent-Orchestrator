# Agent Session Node (October-style CLI windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent nodes become macOS-style floating windows on the canvas with the real provider CLI (claude/codex/opencode) running in an embedded terminal; config moves onto the node; the inspector sidebar disappears for agent nodes.

**Architecture:** Renderer-only. The node body reuses the existing hardened terminal stack (`useTerminalNodeController` → terminal IPC → `TerminalService` PTY) with a provider-derived launch configuration instead of a user-typed command. The headless run pipeline (flow runs) is untouched; its status/summary surfaces on the node. Provider themes and per-kind dimensions come from small pure modules.

**Tech Stack:** React 19, @xyflow/react v12, xterm via existing `TerminalSurface`, zod contracts (untouched), plain CSS with design tokens, vitest + testing-library.

**Spec:** `docs/superpowers/specs/2026-07-20-agent-node-chat-design.md` (v2 hybrid).

## Global Constraints

- **No main-process changes.** Do not touch `main/terminal/*`, `main/runs/*`, or any IPC contract. All new code lives in `apps/desktop/src/renderer/` and `apps/desktop/src/shared/canvas/node-dimensions.ts`.
- **Working tree is dirty with unrelated changes.** Never `git add -A`. Stage only the exact files each task touches (`git add <paths>` / `git commit -- <paths>`). Work in the main checkout, no worktree.
- UX preferences: terse copy; selects over free text where an option list exists; provider connection gate must keep blocking session start.
- Agent node dimensions: default **560×480**, minimum **400×320**. Other kinds unchanged (320×180 / 210×92).
- Commit message suffix: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run scoped tests with `corepack pnpm exec vitest run <file>` from `apps/desktop/`; if vitest reports no config there, run the same command from the repo root. Typecheck: `corepack pnpm --dir apps/desktop typecheck`.
- All paths below are relative to `apps/desktop/` unless they start with `docs/`.

---

### Task 1: Per-kind node dimensions

**Files:**
- Modify: `src/shared/canvas/node-dimensions.ts`
- Modify: `src/renderer/src/components/workspace/model/node-persistence.ts:10-31`
- Modify: `src/renderer/src/components/workspace/canvas/CanvasNode.tsx:187` (minimum selection) and `:9` (imports)
- Modify: `src/renderer/src/styles/workspace/canvas.css` (after the `.react-flow__node-workshop` rules at `:135-147`)
- Test: `src/renderer/src/components/workspace/model/node-persistence.test.ts`

**Interfaces:**
- Consumes: existing `DEFAULT_CANVAS_NODE_DIMENSIONS`, `CANVAS_NODE_MINIMUM_DIMENSIONS`.
- Produces: `AGENT_NODE_DEFAULT_DIMENSIONS = { width: 560, height: 480 }` and `AGENT_NODE_MINIMUM_DIMENSIONS = { width: 400, height: 320 }` exported from `src/shared/canvas/node-dimensions.ts`; `initialWorkshopNodeDimensions('agent')` returns the agent default; `persistedWorkshopNodeDimensions` floors agent nodes at the agent minimum. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing tests** — append to `node-persistence.test.ts` (match its existing test style):

```ts
it('gives agent nodes the larger session-window dimensions', () => {
  expect(initialWorkshopNodeDimensions('agent')).toEqual({ width: 560, height: 480 });
});

it('floors persisted agent nodes at the agent minimum', () => {
  const node = {
    data: { kind: 'agent' } as WorkshopNode['data'],
    width: 100,
    height: 100,
  };
  expect(persistedWorkshopNodeDimensions(node)).toEqual({ width: 400, height: 320 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm exec vitest run src/renderer/src/components/workspace/model/node-persistence.test.ts`
Expected: FAIL — agent gets `{ width: 320, height: 180 }` / floor `{ width: 210 … }`.

- [ ] **Step 3: Implement**

`src/shared/canvas/node-dimensions.ts` — append:

```ts
/** Initial dimensions for an agent session window (embedded CLI terminal). */
export const AGENT_NODE_DEFAULT_DIMENSIONS = {
  width: 560,
  height: 480,
} as const;

/** Smallest agent session window that still fits a usable terminal. */
export const AGENT_NODE_MINIMUM_DIMENSIONS = {
  width: 400,
  height: 320,
} as const;
```

`node-persistence.ts` — import both new constants, then:

```ts
export function initialWorkshopNodeDimensions(kind: NodeKind): {
  readonly width: number;
  readonly height: number;
} {
  if (kind === 'group-frame') return { ...DEFAULT_GROUP_FRAME_DIMENSIONS };
  if (kind === 'agent') return { ...AGENT_NODE_DEFAULT_DIMENSIONS };
  return { ...DEFAULT_CANVAS_NODE_DIMENSIONS };
}
```

and in `persistedWorkshopNodeDimensions` replace the `minimum` ternary:

```ts
const minimum =
  node.data.kind === 'group-frame'
    ? GROUP_FRAME_MINIMUM_DIMENSIONS
    : node.data.kind === 'agent'
      ? AGENT_NODE_MINIMUM_DIMENSIONS
      : CANVAS_NODE_MINIMUM_DIMENSIONS;
```

`CanvasNode.tsx` — import `AGENT_NODE_MINIMUM_DIMENSIONS` alongside `CANVAS_NODE_MINIMUM_DIMENSIONS`, and change line 187:

```ts
const minimum = groupFrame
  ? GROUP_FRAME_MINIMUM
  : data.kind === 'agent'
    ? AGENT_NODE_MINIMUM_DIMENSIONS
    : CANVAS_NODE_MINIMUM_DIMENSIONS;
```

`canvas.css` — after the `:has(> .canvas-node.group-frame)` rule:

```css
.react-flow__node-workshop:has(> .canvas-node[data-node-kind='agent']:not(.collapsed)) {
  min-width: 400px;
  min-height: 320px;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `corepack pnpm exec vitest run src/renderer/src/components/workspace/model/node-persistence.test.ts` → PASS
Run: `corepack pnpm --dir apps/desktop typecheck` (from repo root) → clean

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/canvas/node-dimensions.ts apps/desktop/src/renderer/src/components/workspace/model/node-persistence.ts apps/desktop/src/renderer/src/components/workspace/model/node-persistence.test.ts apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx apps/desktop/src/renderer/src/styles/workspace/canvas.css
git commit -m "feat: larger per-kind dimensions for agent session nodes"
```

---

### Task 2: Provider theme map

**Files:**
- Create: `src/renderer/src/components/workspace/node-registry/provider-themes.ts`
- Test: `src/renderer/src/components/workspace/node-registry/provider-themes.test.ts`

**Interfaces:**
- Produces (used by Tasks 5 and 6):

```ts
export interface ProviderTheme {
  readonly id: string;
  readonly label: string;      // window title-bar provider label, e.g. "Claude Code"
  readonly monogram: string;   // 1–2 chars for the start card / palette badge
  readonly accent: string;     // hex accent
  readonly titleBarTint: string; // translucent tint for the window title bar
}
export function providerTheme(adapterId: string | undefined): ProviderTheme | null;
```

- [ ] **Step 1: Write the failing test** (`provider-themes.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { providerTheme } from './provider-themes.js';

describe('providerTheme', () => {
  it('themes the known first-party providers', () => {
    expect(providerTheme('claude')?.label).toBe('Claude Code');
    expect(providerTheme('claude')?.accent).toBe('#d97757');
    expect(providerTheme('codex')?.label).toBe('Codex');
    expect(providerTheme('gemini')?.monogram).toBe('G');
    expect(providerTheme('opencode')?.label).toBe('opencode');
  });

  it('returns null for unknown or missing adapters', () => {
    expect(providerTheme(undefined)).toBeNull();
    expect(providerTheme('extension:acme:1.0.0:bot')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement** (`provider-themes.ts`):

```ts
export interface ProviderTheme {
  readonly id: string;
  readonly label: string;
  readonly monogram: string;
  readonly accent: string;
  readonly titleBarTint: string;
}

const THEMES: Readonly<Record<string, ProviderTheme>> = Object.freeze({
  claude: theme('claude', 'Claude Code', 'C', '#d97757'),
  codex: theme('codex', 'Codex', 'X', '#10a37f'),
  gemini: theme('gemini', 'Gemini CLI', 'G', '#4e86f6'),
  opencode: theme('opencode', 'opencode', 'O', '#8a63d2'),
  'test-agent': theme('test-agent', 'Test agent', 'T', '#82909b'),
});

export function providerTheme(adapterId: string | undefined): ProviderTheme | null {
  return adapterId === undefined ? null : (THEMES[adapterId] ?? null);
}

function theme(id: string, label: string, monogram: string, accent: string): ProviderTheme {
  return {
    id,
    label,
    monogram,
    accent,
    titleBarTint: `color-mix(in srgb, ${accent} 14%, transparent)`,
  };
}
```

- [ ] **Step 4: Run test** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/node-registry/provider-themes.ts apps/desktop/src/renderer/src/components/workspace/node-registry/provider-themes.test.ts
git commit -m "feat: provider theme map for agent session windows"
```

---

### Task 3: Agent session launch configuration

**Files:**
- Create: `src/renderer/src/components/workspace/runs/agent-session/launch-config.ts`
- Test: `src/renderer/src/components/workspace/runs/agent-session/launch-config.test.ts`

**Interfaces:**
- Consumes: `AgentDetection`, `PermissionProfile` from `src/shared/application/contracts.ts`; `TerminalNodeConfiguration` from `../../terminal/types.js`.
- Produces (used by Task 5):

```ts
export function agentSessionUnavailableReason(agent: AgentDetection | undefined): string | null;
export interface AgentSessionLaunch {
  readonly configuration: TerminalNodeConfiguration;
  /** Non-null when the selected profile is not enforceable interactively. */
  readonly profileNote: string | null;
}
export function agentSessionLaunch(
  agent: AgentDetection,
  model: string | undefined,
  profile: PermissionProfile,
): AgentSessionLaunch;
```

- [ ] **Step 1: Write the failing tests** (`launch-config.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import type { AgentDetection } from '../../../../../../shared/application/contracts.js';
import { agentSessionLaunch, agentSessionUnavailableReason } from './launch-config.js';

const claude: AgentDetection = {
  id: 'claude',
  label: 'Anthropic Claude Code',
  installed: true,
  executable: '/usr/local/bin/claude',
  version: '2.1.0',
  providerDisclosure: 'runs claude',
};
const codex: AgentDetection = { ...claude, id: 'codex', label: 'Codex', executable: '/usr/local/bin/codex' };

describe('agentSessionUnavailableReason', () => {
  it('requires a detected executable', () => {
    expect(agentSessionUnavailableReason(undefined)).toMatch(/pick an installed agent/i);
    expect(agentSessionUnavailableReason({ ...claude, executable: null })).toMatch(/isn't installed/i);
    expect(agentSessionUnavailableReason(claude)).toBeNull();
  });
});

describe('agentSessionLaunch', () => {
  it('maps claude plan profile and model to CLI flags', () => {
    const launch = agentSessionLaunch(claude, 'claude-sonnet-5', 'plan-read-only');
    expect(launch.configuration).toEqual({
      executable: '/usr/local/bin/claude',
      arguments: ['--permission-mode', 'plan', '--model', 'claude-sonnet-5'],
      cwdRelative: '',
      environmentVariableNames: [],
    });
    expect(launch.profileNote).toBeNull();
  });

  it('maps codex read-only sandbox', () => {
    const launch = agentSessionLaunch(codex, undefined, 'plan-read-only');
    expect(launch.configuration.arguments).toEqual(['--sandbox', 'read-only']);
  });

  it('notes non-enforceable profiles and passes no flags for them', () => {
    const launch = agentSessionLaunch(claude, undefined, 'worktree-write');
    expect(launch.configuration.arguments).toEqual([]);
    expect(launch.profileNote).toMatch(/project root/i);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement** (`launch-config.ts`):

```ts
import type {
  AgentDetection,
  PermissionProfile,
} from '../../../../../../shared/application/contracts.js';
import type { TerminalNodeConfiguration } from '../../terminal/types.js';

export interface AgentSessionLaunch {
  readonly configuration: TerminalNodeConfiguration;
  readonly profileNote: string | null;
}

/** Why an interactive session cannot start, or null when it can. */
export function agentSessionUnavailableReason(agent: AgentDetection | undefined): string | null {
  if (agent === undefined) return 'Pick an installed agent to start a session.';
  if (!agent.installed || agent.executable === null) {
    return `${agent.label} isn't installed on this computer. Install it or pick another agent.`;
  }
  return null;
}

export function agentSessionLaunch(
  agent: AgentDetection,
  model: string | undefined,
  profile: PermissionProfile,
): AgentSessionLaunch {
  const executable = agent.executable ?? '';
  const trimmedModel = model?.trim() ?? '';
  const args: string[] = [];
  let enforced = profile === 'custom';
  if (agent.id === 'claude') {
    if (profile === 'plan-read-only') {
      args.push('--permission-mode', 'plan');
      enforced = true;
    }
    if (trimmedModel !== '') args.push('--model', trimmedModel);
  } else if (agent.id === 'codex') {
    if (profile === 'plan-read-only') {
      args.push('--sandbox', 'read-only');
      enforced = true;
    }
    if (trimmedModel !== '') args.push('-m', trimmedModel);
  }
  return {
    configuration: {
      executable,
      arguments: args,
      cwdRelative: '',
      environmentVariableNames: [],
    },
    profileNote: enforced
      ? null
      : 'Interactive sessions run at the project root; this profile fully applies to flow runs. The CLI asks before writing.',
  };
}
```

Note: `plan-read-only` on adapters other than claude/codex also produces the note (`enforced` stays false) — that is intended.

- [ ] **Step 4: Run tests** → PASS. Typecheck → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/runs/agent-session/launch-config.ts apps/desktop/src/renderer/src/components/workspace/runs/agent-session/launch-config.test.ts
git commit -m "feat: provider launch configuration for interactive agent sessions"
```

---

### Task 4: AgentSessionContext (canvas ↔ workspace bridge)

**Files:**
- Create: `src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx`
- Modify: `src/renderer/src/components/workspace/shell/Workspace.tsx` — wrap the `<WorkspaceCanvas …>` element (find it with `grep -n "<WorkspaceCanvas" Workspace.tsx`) in the provider.
- Test: `src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.test.tsx`

**Interfaces:**
- Produces (consumed by Task 5's `AgentSessionNode`):

```tsx
export interface AgentSessionContextValue {
  readonly project: Project;
  readonly settings: AppSettings;
  readonly runnableAgents: readonly (AgentDetection & { id: RunAdapterId })[];
  readonly graphReadOnly: boolean;
  gateFor(adapterId: string): AgentProviderGate | null;
  recheckProvider(adapterId: string): void;
  openSettings(): void;
  reportError(message: string): void;
  updateNodeData(nodeId: string, data: Partial<WorkshopNodeData>): void;
  recordHistory(): void;
  nodeTitle(nodeId: string): string | null;
  removeAgentContext(agentNodeId: string, attachmentNodeId: string): void;
  requestDeleteNode(nodeId: string): void;
}
export const AgentSessionProvider: React.FC<{ value: AgentSessionContextValue; children: React.ReactNode }>;
export function useAgentSession(): AgentSessionContextValue; // throws outside provider
```

- [ ] **Step 1: Write the failing test** — `useAgentSession` throws outside a provider and returns the value inside one (renderHook with wrapper; a minimal stub object cast as the value is fine).

```tsx
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { AgentSessionProvider, useAgentSession, type AgentSessionContextValue } from './AgentSessionContext.js';

describe('useAgentSession', () => {
  it('throws without a provider', () => {
    expect(() => renderHook(() => useAgentSession())).toThrow(/AgentSessionProvider/);
  });

  it('returns the provided value', () => {
    const value = { graphReadOnly: true } as unknown as AgentSessionContextValue;
    const { result } = renderHook(() => useAgentSession(), {
      wrapper: ({ children }) => <AgentSessionProvider value={value}>{children}</AgentSessionProvider>,
    });
    expect(result.current.graphReadOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the module** — `createContext<AgentSessionContextValue | null>(null)`; `useAgentSession` throws `new Error('useAgentSession requires an AgentSessionProvider.')` on null.

- [ ] **Step 4: Wire the provider in `Workspace.tsx`.** Build the value with `useMemo` next to the `<WorkspaceCanvas>` render, reusing what Workspace already has:
  - `project`, `settings`, `runnableAgents` (defined at `Workspace.tsx:923`), `graphReadOnly: collaborationCanvas.graphReadOnly`.
  - Gate: Workspace already calls `useAgentProviderGate` (find with `grep -n "useAgentProviderGate(" Workspace.tsx`); expose its `gateFor` and wrap `recheck` as `recheckProvider(adapterId)` using `providerConnectionIdForAdapter` the same way the existing recheck handler does (copy that call site).
  - `openSettings: onOpenSettings`, `reportError: onError`.
  - `updateNodeData` from `useWorkspaceNodeMutations` (already in scope — grep `updateNodeData(`), `recordHistory: record`.
  - `nodeTitle: (id) => nodesRef.current.find((n) => n.id === id)?.data.title ?? null`.
  - `removeAgentContext`: reuse the existing handler passed to the inspector as `onRemoveAgentContext` (grep its definition).
  - `requestDeleteNode(nodeId)`: `setSelectedNodeId(nodeId)` then invoke the existing delete-selected handler (grep `onDeleteSelected` / `deleteSelected` in Workspace and call its underlying function; if it operates on `selectedNodeId` state asynchronously, change the underlying helper to accept an explicit id — smallest edit wins).

- [ ] **Step 5: Run test + typecheck** → PASS/clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.test.tsx apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx
git commit -m "feat: agent session context bridging canvas nodes to workspace services"
```

---

### Task 5: AgentSessionNode — the window with the CLI inside

**Files:**
- Create: `src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.tsx`
- Create: `src/renderer/src/components/workspace/runs/agent-session/agent-session.css`
- Modify: `src/renderer/src/components/workspace/canvas/CanvasNode.tsx` (agent branch, `data-provider`, drag-handle class)
- Modify: `src/renderer/src/components/workspace/shell/Workspace.tsx` (set `dragHandle` on agent nodes in `addNode`; also in the load-time hydration — grep `hydrateHistorySnapshot` for where nodes are built and map `dragHandle` there)
- Test: `src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx`

**Interfaces:**
- Consumes: `useAgentSession()` (Task 4), `agentSessionLaunch`/`agentSessionUnavailableReason` (Task 3), `providerTheme` (Task 2), `useTerminalNodeController` + `TerminalSurface` + `TerminalLaunchReviewDialog` + `terminalOperationsFromWindow` from `../../terminal/`, `useCanvasNodeInteractions`, `PERMISSION_PROFILE_OPTIONS` + `permissionProfileUnavailableReason` from `../../../permissions/permission-profile-ui.js`, `effectiveNodeModel` from `../agent-node/model-selection.js`.
- Produces: `export function AgentSessionNode({ id, data }: { id: string; data: WorkshopNodeData }): JSX.Element` and `export const AGENT_NODE_DRAG_HANDLE = '.agent-drag-handle';`

**Component behavior (implement exactly):**
1. Resolve `adapter` = `data.adapterId ?? settings.defaultAgent if runnable else 'test-agent'` (same fallback rule as `Workspace.tsx:927-930`), `agent` = `runnableAgents.find(a => a.id === adapter)`.
2. `launch = agent ? agentSessionLaunch(agent, effectiveNodeModel(agent, data.model, settings.agentDefaultModels[adapter]), data.permissionProfile ?? 'worktree-write') : null`.
3. `controller = useTerminalNodeController({ projectId: project.id, nodeId: id, configuration: launch?.configuration ?? { executable: '', arguments: [], cwdRelative: '', environmentVariableNames: [] }, onError: reportError, operations: terminalOperationsFromWindow() })`.
4. `readOnly = graphReadOnly || data.locked || interactions.readOnly`.
5. **Title bar** (`div.agent-window-titlebar.agent-drag-handle`): three traffic buttons (`button.traffic.close|collapse|zoom`, all `nodrag`, aria-labels "Delete node" / "Collapse node" / "Focus terminal") → `requestDeleteNode(id)` (guarded by `window.confirm('Delete this agent node?')`), `interactions.setCollapsed(id, true)`, and `surfaceRef.current?.focus()` (hold the `TerminalSurface` ref; no-op when no session). Then an `input.agent-title-input.nodrag` (value `data.title`, `onFocus={recordHistory}`, `onChange` → `updateNodeData(id, { title })`, disabled when `readOnly`), a `span.agent-provider-label` with `providerTheme(adapter)?.label ?? agent?.label ?? adapter`, and the existing run-status dot markup (`span.run-status ${data.status}`).
6. **Body**: when `controller.session !== null && controller.active` render `TerminalSurface` (`sessionId={controller.session.id}`, `output={controller.output}`, `inputEnabled={!readOnly}`, `onInput={(d) => controller.sendInput(d)}`, `onResize={(c, r) => controller.resize(c, r)}`) inside `div.agent-terminal.nowheel.nodrag`. When no active session: `div.agent-start-card` with the provider monogram (from theme), and either the unavailable reason (`agentSessionUnavailableReason(agent)`), the gate warning block (see 8), or a `button.button.primary` **Start session** → `void controller.prepareLaunch()`. When the last session exited (`controller.session?.status === 'exited'` or controller exposes exit info): `div.agent-exit-strip` with `Session ended` + **Restart** (same prepare call).
7. **Launch review**: when `controller.pendingPlan !== null` render `TerminalLaunchReviewDialog` (`plan={controller.pendingPlan}`, `busy={controller.busy === 'confirming'}`, `onCancel={() => void controller.cancelLaunch()}`, `onContinue={() => void controller.confirmLaunch()}`) inside the node (`div.agent-review-overlay.nodrag.nowheel`).
8. **Gate**: `gate = gateFor(adapter)`; when `gate !== null && gate.warning !== null` show `div.recovery-guidance.warning` with the warning text and buttons **{gate.actionLabel}** → `recheckProvider(adapter)` and **Open settings** → `openSettings()`; Start is not rendered while blocked (`gate.state !== 'connected'` when `gate !== null`).
9. **Bottom strip** (`div.agent-window-strip.nodrag`): Agent select (options = runnableAgents, value = adapter, onChange → `updateNodeData(id, { adapterId, ...(modelSelection ? {} : { model: undefined }) })` — copy the option-mapping from the old `AgentNodePanel.tsx:170-192`); Model input (compact, only when `agent?.capabilities?.modelSelection === true`); Permission select (`PERMISSION_PROFILE_OPTIONS`, disable options whose `permissionProfileUnavailableReason(...) !== null`); all disabled when `readOnly`. When `launch?.profileNote` is non-null render `small.agent-profile-note` with it. Run strip inline: `span.node-status-label ${data.status}` when `data.status !== 'idle'`, `data.lastRunSummary` text, and `<details class="agent-last-run"><summary>Last run output</summary><pre>{data.transcript}</pre></details>` only when `data.transcript` is non-empty. Context chips: `(data.contextAttachmentIds ?? []).map(cid => nodeTitle(cid))` as removable chips (`button` × → `removeAgentContext(id, cid)`), skip ids whose title resolves null.
10. **Errors**: when `controller.error !== null` render `p.recovery-guidance.warning` with the message above the bottom strip; same for `controller.notice` with class `agent-session-notice` (dim, not warning).
11. **Restart to apply**: keep `launchedKeyRef` (string of `executable + ' ' + arguments.join(' ')`) set when `confirmLaunch` is invoked; when a session is active and the current launch key differs, render `button.agent-restart-apply` **Restart to apply** → `void controller.terminate().then(() => controller.prepareLaunch())`.

**CanvasNode integration:** in the agent case render inside `<article>` (which keeps NodeResizer + Handles + selected/collapsed classes):

```tsx
{data.kind === 'agent' && !data.collapsed ? (
  <AgentSessionNode id={id} data={data} />
) : (
  /* existing <header> + node-body markup */
)}
```

- Collapsed agent nodes keep the existing `<header>`; add `agent-drag-handle` to that header's className when `data.kind === 'agent'` so the collapsed pill stays draggable.
- Add to the `<article>`: `data-provider={data.kind === 'agent' ? (providerTheme(data.adapterId)?.id ?? 'generic') : undefined}` and, for agent kind, the class `agent-window`; set `style={{ '--node-accent': theme?.accent ?? data.color, '--provider-tint': theme?.titleBarTint ?? 'transparent' }}`.
- `Workspace.tsx addNode` (at `:639` spread) and the hydration path both set `...(kind === 'agent' ? { dragHandle: AGENT_NODE_DRAG_HANDLE } : {})` on the node object (import from `AgentSessionNode.js`).

**CSS (`agent-session.css`, imported by `AgentSessionNode.tsx`; key rules, adjust values only if tokens differ):**

```css
.canvas-node.agent-window { display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; }
.canvas-node.agent-window::before { display: none; }
.agent-window-titlebar { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 10px; background: linear-gradient(var(--provider-tint), transparent), var(--surface-raised); border-bottom: 1px solid var(--line); cursor: grab; }
.traffic { width: 12px; height: 12px; border-radius: 50%; border: none; padding: 0; cursor: pointer; }
.traffic.close { background: #ff5f57; } .traffic.collapse { background: #febc2e; } .traffic.zoom { background: #28c840; }
.agent-title-input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--text); font-weight: 600; font-size: var(--text-sm, 13px); }
.agent-provider-label { color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.agent-terminal { flex: 1; min-height: 0; background: #0d0f12; }
.agent-terminal > div { height: 100%; }
.agent-start-card { flex: 1; display: grid; place-items: center; align-content: center; gap: 10px; background: #0d0f12; color: var(--text-soft); padding: 18px; text-align: center; }
.agent-monogram { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; font-weight: 700; font-size: 20px; color: #0d0f12; background: var(--node-accent); }
.agent-window-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 5px 8px; border-top: 1px solid var(--line); background: var(--surface-raised); font-size: var(--text-xs); }
.agent-window-strip select, .agent-window-strip input { font-size: var(--text-xs); max-width: 130px; }
.agent-review-overlay { position: absolute; inset: 34px 0 0 0; z-index: 5; overflow: auto; background: color-mix(in srgb, var(--surface) 88%, transparent); }
.agent-exit-strip { display: flex; gap: 8px; align-items: center; padding: 4px 8px; border-top: 1px solid var(--line); color: var(--text-soft); }
.agent-last-run pre { max-height: 140px; overflow: auto; white-space: pre-wrap; }
```

- [ ] **Step 1: Write failing tests** (`AgentSessionNode.test.tsx`). Mock the terminal module and context:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const controller = {
  session: null, sessions: [], output: [], pendingPlan: null, busy: null, error: null,
  notice: null, active: false, replayWindowLimited: false,
  chooseExecutable: vi.fn(), prepareLaunch: vi.fn(async () => {}), confirmLaunch: vi.fn(async () => {}),
  cancelLaunch: vi.fn(async () => {}), refresh: vi.fn(async () => {}), selectSession: vi.fn(async () => {}),
  sendInput: vi.fn(), resize: vi.fn(), interrupt: vi.fn(async () => {}), terminate: vi.fn(async () => {}),
};
vi.mock('../../terminal/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTerminalNodeController: () => controller,
  terminalOperationsFromWindow: () => ({}),
  TerminalSurface: () => <div data-testid="terminal-surface" />,
}));
```

(If `../../terminal/index.js` does not re-export `useTerminalNodeController`, mock the individual module paths instead — check `terminal/index.ts` first.)

Tests (context value stubbed with a claude runnable agent, connected gate, spies):
1. renders Start session on the start card and calls `prepareLaunch` on click;
2. gate warning (`gateFor` → `{ state: 'unknown', warning: 'needs a refresh', actionLabel: 'Refresh status', … }`) hides Start, renders the warning and recheck button;
3. `controller.session = { id: 's1', status: 'running' } as never; controller.active = true` → renders `terminal-surface`;
4. permission select change calls `updateNodeData(id, { permissionProfile: 'plan-read-only' })`;
5. title input change calls `updateNodeData(id, { title: 'Hermes' })`;
6. `data.transcript = 'run log'` → "Last run output" details present.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the component + CSS exactly as specified above.

- [ ] **Step 4: Integrate into `CanvasNode.tsx` and `Workspace.tsx`** (agent branch, `data-provider`, `agent-drag-handle` on collapsed header, `dragHandle` on node objects in `addNode` + hydration).

- [ ] **Step 5: Run tests + typecheck**

Run: `corepack pnpm exec vitest run src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx` → PASS
Run existing canvas tests: `corepack pnpm exec vitest run src/renderer/src/components/workspace/canvas/WorkspaceCanvas.test.tsx` — fix any breakage caused by the new agent branch (update expectations, do not weaken assertions).
Typecheck → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/runs/agent-session/ apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx
git commit -m "feat: agent nodes are live CLI session windows on the canvas"
```

---

### Task 6: Provider entries in the node palette

**Files:**
- Modify: `src/renderer/src/components/workspace/shell/WorkspaceRail.tsx` (new "Agents" section above "Node templates", new props)
- Modify: `src/renderer/src/components/workspace/shell/Workspace.tsx` (`addNode` overrides param, `addAgentNode`, pass new rail props)
- Test: `src/renderer/src/components/workspace/shell/WorkspaceRail.test.tsx` (extend)

**Interfaces:**
- `addNode(kind: NodeKind, position?: {x,y}, dataOverrides?: Partial<WorkshopNodeData>)` — overrides spread LAST into `data`.
- Rail props added: `runnableAgents: readonly (AgentDetection & { id: RunAdapterId })[]`, `onAddAgentNode: (adapterId: RunAdapterId) => void`.

- [ ] **Step 1: Write failing test** — rail renders an "Agents" section with a "Claude Code" button when `runnableAgents` contains claude; clicking calls `onAddAgentNode('claude')`. Follow the existing test file's render/props pattern.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Rail section (before the `template-section` at `WorkspaceRail.tsx:219`):

```tsx
<section className="template-section">
  <header>
    <h2>Agents</h2>
    <span>{runnableAgents.length}</span>
  </header>
  <div className="template-list">
    {runnableAgents.map((agent) => {
      const theme = providerTheme(agent.id);
      return (
        <button type="button" key={agent.id} onClick={() => onAddAgentNode(agent.id)}>
          <span className="agent-monogram-badge" style={{ background: theme?.accent ?? '#d4a85b' }}>
            {theme?.monogram ?? 'A'}
          </span>
          <span>
            <strong>{theme?.label ?? agent.label}</strong>
            <small>Live CLI session window</small>
          </span>
          <ChevronRight size={13} />
        </button>
      );
    })}
  </div>
</section>
```

Add `.agent-monogram-badge { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #101210; }` to the stylesheet the rail already uses (grep which css file styles `.template-section`).

In `Workspace.tsx`:

```ts
const addAgentNode = useCallback(
  (adapterId: RunAdapterId, position?: { x: number; y: number }) => {
    const theme = providerTheme(adapterId);
    addNode('agent', position, {
      adapterId,
      ...(theme === null ? {} : { title: theme.label, color: theme.accent }),
    });
  },
  [addNode],
);
```

and extend `addNode` with the `dataOverrides` param spread after the existing data fields. Pass `runnableAgents` and `onAddAgentNode={addAgentNode}` where `<WorkspaceRail` is rendered.

- [ ] **Step 4: Run rail tests + typecheck** → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/shell/WorkspaceRail.tsx apps/desktop/src/renderer/src/components/workspace/shell/WorkspaceRail.test.tsx apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx
git commit -m "feat: per-provider agent entries in the node palette"
```

(Include the css file in the `git add` if one was edited.)

---

### Task 7: Retire the agent inspector panel

**Files:**
- Modify: `src/renderer/src/components/workspace/shell/WorkspaceInspector.tsx` (agent branch at `:390-429`; early-return for agent kind before the shared fieldset at `:206`)
- Modify: `src/renderer/src/components/workspace/shell/Workspace.tsx` (drop now-unused inspector props/wiring)
- Delete (only if unreferenced after the edits — verify each with `grep -rn "<name>" apps/desktop/src | grep -v test`): `AgentNodePanel.tsx` + its test, `AgentAttemptHistory.tsx` + hooks used only by it.
- Test: update `WorkspaceInspector`-related tests and `WorkspacePermissionSelection.test.tsx`.

- [ ] **Step 1: Write the failing test** — in the inspector test suite: selecting an agent node renders no "Agent run" section and no Title field (the inspector shows nothing for agent nodes).

- [ ] **Step 2: Run to verify failure** (panel currently renders).

- [ ] **Step 3: Implement.**
  - In `NodeInspector`, before the shared fieldset: `if (selectedNode.data.kind === 'agent') return null;` (keep the lock notice out too — the node itself communicates lock state). Remove the agent branch (`:390-429`) and the `AgentNodePanel` / `AgentContextDropZone` imports if now unused (`AgentContextDropZone` moves fully to the on-node chips from Task 5; the canvas drop-zone behavior in `WorkspaceCanvas` is separate and stays).
  - Remove from `WorkspaceInspectorProps` and the `Workspace.tsx` call site every prop that existed only for the panel: `runInput`, `agentRunActive`, `preparingRun`, `pendingRunControlAction`, `agentProviderGate`, `onRecheckAgentProvider`, `onRunInputChange`, `onSendRunInput`, `onControlRun`, `onPrepareRun`, `onRetryAgentAttempt`, `onResumeAgentAttempt`. Before deleting each, `grep -n "<propName>" WorkspaceInspector.tsx` — keep any that another branch (e.g. terminal, git-pr) still uses.
  - In `Workspace.tsx`, keep `useAgentRunController` ONLY if something still references its returns after the prop removal (`grep -n` each). The run-event subscription (`Workspace.tsx:278-330`), run history, reconciliation, and `RunApprovalDialog` stay if still referenced (flow runs continue to use them); delete only wiring that typecheck marks unused.
  - Delete `AgentNodePanel.tsx`/`.test.tsx`; then check `AgentAttemptHistory`, `useAgentAttemptHistory`, `attempt-actions.ts`, `tokenUsageRows` for remaining references before deleting each. Keep `agent-node.css` only if something still imports it.
  - Rewrite `WorkspacePermissionSelection.test.tsx` to assert the permission select now lives on the node (it can render `AgentSessionNode` with a stub context) — or, if that duplicates Task 5's test 4, reduce it to that assertion and note the move in the test description.

- [ ] **Step 4: Run the full workspace test slice + typecheck**

Run: `corepack pnpm exec vitest run src/renderer/src/components/workspace` → PASS (fix fallout — the goal is: no test references the retired panel).
Typecheck → clean.

- [ ] **Step 5: Commit**

```bash
git add -u apps/desktop/src/renderer/src/components/workspace
git commit -m "feat: retire the agent inspector panel; agent nodes are self-contained"
```

(`git add -u` scoped to the workspace directory only — verify with `git status --short apps/desktop/src/renderer/src/components/workspace` that nothing unrelated is staged; the pre-existing dirty files in git-review/file-editor/extensions must NOT be included — if any appear, stage files individually instead.)

---

### Task 8: Full verification

- [ ] **Step 1:** `corepack pnpm --dir apps/desktop typecheck` → clean.
- [ ] **Step 2:** From repo root: `corepack pnpm test:unit` → all green (pre-existing failures unrelated to these files may exist in the dirty tree; record any and confirm they fail identically on `git stash`-free baseline before ignoring).
- [ ] **Step 3:** Manual smoke via `corepack pnpm --dir apps/desktop dev`: add a Claude Code node from the palette, start a session, see the TUI, type into it, resize the node, collapse/expand, delete via the red traffic light. Verify wheel scrolls the terminal scrollback and the canvas does not pan while the cursor is over the terminal.
- [ ] **Step 4:** Update `docs/superpowers/specs/2026-07-20-agent-node-chat-design.md` status line to `Implemented` and commit the spec + plan checkboxes.
