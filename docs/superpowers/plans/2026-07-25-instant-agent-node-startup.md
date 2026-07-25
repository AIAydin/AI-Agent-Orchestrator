# Instant Agent Node Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking an agent in the rail creates a node whose CLI session starts immediately — no connection-gate clicks, no "Start session" click.

**Architecture:** Two changes in the renderer. (1) `AgentSessionNode` stops consulting the provider-connection gate; the CLI's own in-terminal login prompt covers the signed-out case, and the gate machinery survives untouched for Settings and the headless workflow-run path. (2) Agent-node creation stamps a transient `autoStart: true` on node data; the node consumes it exactly once on mount and launches through the existing `startSession()` path.

**Tech Stack:** React 18 (StrictMode ON — one-shot effects need a ref guard; refs survive the simulated remount), Vitest + Testing Library, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-25-instant-agent-node-startup-design.md`

## Global Constraints

- Never `git add -A`, `-u`, or `.`; stage only files this plan edits, by exact path. The tree carries unrelated user WIP (`IMPLEMENTATION_CHECKLIST.md`, `PreviewNodeFace.test.tsx`, `ChromeCompanionSurface.tsx`) — do not stage those.
- Copy is terse and friendly (owner preference); no new free-text inputs.
- Do not touch the orphaned `runs/agent-node/AgentNodePanel*` subtree (retained dead code carrying user WIP).
- Keep `useAgentProviderGate`, `Workspace.tsx`'s `providerGates`/`agentRunBlockReason`/`verifyAdapterConnection`, and Settings connection UI untouched.
- All commands run from the repo root `/Users/aydin/AI Agent Orchestrator`.

---

### Task 1: Remove the provider-connection gate from AgentSessionNode

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.tsx`
- Modify: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx:67-68`
- Modify: `apps/desktop/src/renderer/src/components/workspace/shell/runtime/useWorkspaceAgentSessionValue.ts`
- Modify: `apps/desktop/src/renderer/src/components/workspace/shell/runtime/useWorkspaceAgentSessionCallbacks.ts`
- Modify: `apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx:1289,1302-1303`
- Test: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx`

**Interfaces:**
- Consumes: existing `AgentSessionContextValue` (`AgentSessionContext.tsx`).
- Produces: `AgentSessionContextValue` WITHOUT `gateFor` and `recheckProvider` (`openSettings` stays — `PreviewNodeFace` uses it). Task 2 relies on `canStart` in `AgentSessionNode.tsx` meaning exactly `unavailableReason === null`.

- [ ] **Step 1: Rewrite the gate test as a no-gate contract test**

In `AgentSessionNode.test.tsx`:
- Delete the `let gate: AgentProviderGate | null = null;` variable, the `gate = null;` reset in `beforeEach`, the `gateFor`/`recheckProvider` entries in `spies`, the `gateFor`/`recheckProvider` lines in `contextValue()`, and the `AgentProviderGate` type import.
- Replace the whole test `it('hides Start behind a provider gate warning and rechecks the provider', …)` with:

```tsx
it('offers Start immediately — no provider connection gate on the node', () => {
  renderNode();
  expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull();
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `corepack pnpm --dir apps/desktop exec vitest --config config/tooling/vitest.config.ts run --project unit src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx`

Expected: FAIL — `contextValue()` no longer satisfies `AgentSessionContextValue` (missing `gateFor`/`recheckProvider`), and/or the component throws calling the removed `gateFor` mock. (Vitest may surface this as a type/runtime error; either counts as the failing state.)

- [ ] **Step 3: Strip the gate from the component and context**

In `AgentSessionNode.tsx`:
- Remove `gateFor`, `recheckProvider`, and `openSettings` from the `useAgentSession()` destructure (lines 61-63; `openSettings` has no remaining use in this file).
- Remove `const gate = gateFor(adapter);` (line 120) and `const blocked = gate !== null && gate.state !== 'connected';` (line 122).
- Change line 123 to `const canStart = unavailableReason === null;`.
- In the start card (lines 399-413), replace the three-way conditional with only the unavailable branch:

```tsx
{unavailableReason !== null ? (
  <p className="agent-start-reason">{unavailableReason}</p>
) : null}
```

In `AgentSessionContext.tsx`: delete the `gateFor(adapterId: string): AgentProviderGate | null;` and `recheckProvider(adapterId: string): void;` members (lines 67-68) and the now-unused `AgentProviderGate` import.

In `useWorkspaceAgentSessionValue.ts`: remove `gateFor` and `recheckProvider` from the input props type, the destructure (lines 28-29), the returned context value (lines 99-100), and the memo dependency array (lines ~125, ~133).

In `useWorkspaceAgentSessionCallbacks.ts`: delete the `recheckProvider` callback (line ~26) and drop it from the return object (line 46); remove any input params (e.g. the gate's `recheck`) that only it consumed.

In `Workspace.tsx`: at line 1289 drop `recheckProvider` from the destructure of `useWorkspaceAgentSessionCallbacks(...)` (and stop passing its now-removed inputs); at lines 1302-1303 drop `gateFor: providerGates.gateFor,` and `recheckProvider,`. Leave `providerGates` itself, `agentRunBlockReason` (line 876), and `verifyAdapterConnection` (line 947) exactly as they are.

- [ ] **Step 4: Run the node tests to verify they pass**

Run: `corepack pnpm --dir apps/desktop exec vitest --config config/tooling/vitest.config.ts run --project unit src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx`

Expected: PASS (all tests, including the rewritten one).

- [ ] **Step 5: Typecheck to catch stray gate references**

Run: `corepack pnpm --dir apps/desktop typecheck`

Expected: clean. If other files still reference the removed context members, fix them the same way (delete the dead consumption; never re-add the members).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionContext.tsx apps/desktop/src/renderer/src/components/workspace/shell/runtime/useWorkspaceAgentSessionValue.ts apps/desktop/src/renderer/src/components/workspace/shell/runtime/useWorkspaceAgentSessionCallbacks.ts apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx
git commit -m "feat: drop the provider-connection gate from agent session nodes

The CLI's own login prompt in the terminal covers the signed-out case;
Settings and the workflow-run path keep their gates.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Auto-start sessions for newly created agent nodes

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx:39` (WorkshopNodeData)
- Create: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/creation.ts`
- Create: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/creation.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx:668-677` (addAgentNode)
- Modify: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.tsx`
- Test: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx`

**Interfaces:**
- Consumes: `startSession()` and `canStart` from Task 1's `AgentSessionNode.tsx`; `providerTheme(adapterId)` from `../../node-registry/provider-themes.js`; `updateNodeData(id, change)` from `AgentSessionContextValue`.
- Produces: `WorkshopNodeData.autoStart?: boolean | undefined`; `agentNodeCreationOverrides(adapterId: RunAdapterId): Partial<WorkshopNodeData>` returning `{ adapterId, autoStart: true, color? }`.

- [ ] **Step 1: Write the failing creation-overrides test**

Create `creation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { agentNodeCreationOverrides } from './creation.js';

describe('agentNodeCreationOverrides', () => {
  it('stamps the adapter, its theme color, and a one-shot auto-start', () => {
    const overrides = agentNodeCreationOverrides('claude');
    expect(overrides.adapterId).toBe('claude');
    expect(overrides.autoStart).toBe(true);
    expect(typeof overrides.color).toBe('string');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `corepack pnpm --dir apps/desktop exec vitest --config config/tooling/vitest.config.ts run --project unit src/renderer/src/components/workspace/runs/agent-session/creation.test.ts`

Expected: FAIL — `./creation.js` does not exist.

- [ ] **Step 3: Add the field, the helper, and wire addAgentNode**

In `CanvasNode.tsx`, after `permissionProfile?: PermissionProfile;` (line 39) add:

```ts
  /** One-shot: set at creation so the session node launches immediately, then cleared. */
  autoStart?: boolean | undefined;
```

Create `creation.ts`:

```ts
import type { RunAdapterId } from '../../../../../../shared/application/contracts.js';
import type { WorkshopNodeData } from '../../canvas/CanvasNode.js';
import { providerTheme } from '../../node-registry/provider-themes.js';

/** Node data for a freshly created agent node: adapter, provider tint, one-shot auto-start. */
export function agentNodeCreationOverrides(adapterId: RunAdapterId): Partial<WorkshopNodeData> {
  const theme = providerTheme(adapterId);
  return {
    adapterId,
    autoStart: true,
    ...(theme === null ? {} : { color: theme.accent }),
  };
}
```

(`RunAdapterId` comes from `shared/application/contracts.js`, same as `Workspace.tsx:23` and `runs/agent-node/attempt-actions.ts:1` — the relative depth above is for `runs/agent-session/`.)

In `Workspace.tsx`, replace the body of `addAgentNode` (lines 668-677) with a call to the helper and drop the now-local `providerTheme` usage if nothing else in the file needs it:

```ts
const addAgentNode = useCallback(
  (adapterId: RunAdapterId, position?: { x: number; y: number }) => {
    addNode('agent', position, agentNodeCreationOverrides(adapterId));
  },
  [addNode],
);
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `corepack pnpm --dir apps/desktop exec vitest --config config/tooling/vitest.config.ts run --project unit src/renderer/src/components/workspace/runs/agent-session/creation.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing auto-start node tests**

Append to the `describe('AgentSessionNode', …)` block in `AgentSessionNode.test.tsx`:

```tsx
it('auto-starts a freshly created node and clears the one-shot flag', async () => {
  renderNode(nodeData({ autoStart: true }));
  await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
  expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, { autoStart: undefined });
});

it('auto-starts only once across re-renders', async () => {
  const view = render(nodeTree(nodeData({ autoStart: true })));
  await waitFor(() => expect(controller.prepareLaunch).toHaveBeenCalledOnce());
  view.rerender(nodeTree(nodeData({ autoStart: true })));
  await waitFor(() => expect(spies.updateNodeData).toHaveBeenCalled());
  expect(controller.prepareLaunch).toHaveBeenCalledOnce();
});

it('clears the flag without starting when the node is read-only', async () => {
  renderNode(nodeData({ autoStart: true, locked: true }));
  await waitFor(() =>
    expect(spies.updateNodeData).toHaveBeenCalledWith(NODE_ID, { autoStart: undefined }),
  );
  expect(provisionMock).not.toHaveBeenCalled();
  expect(controller.prepareLaunch).not.toHaveBeenCalled();
});

it('does not auto-start without the flag', () => {
  renderNode();
  expect(provisionMock).not.toHaveBeenCalled();
  expect(controller.prepareLaunch).not.toHaveBeenCalled();
});
```

(`nodeTree` is the existing helper in this file; reuse it rather than duplicating the provider stack.)

- [ ] **Step 6: Run the node tests to verify the new ones fail**

Run: `corepack pnpm --dir apps/desktop exec vitest --config config/tooling/vitest.config.ts run --project unit src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx`

Expected: the three `autoStart` tests FAIL (no launch happens; the flag is never cleared); `does not auto-start without the flag` may already pass.

- [ ] **Step 7: Implement the one-shot auto-start effect**

In `AgentSessionNode.tsx`, directly below `const startSession = (): void => provisionAndRelaunch();` (line ~226) add:

```tsx
// Auto-start: nodes created from the rail/palette carry a one-shot `autoStart` flag so the
// CLI opens without a Start click. The ref makes consumption idempotent (StrictMode re-runs
// effects without resetting refs); clearing the flag keeps reopened workspaces on the
// ordinary Start card instead of spawning a session per saved node.
const autoStartConsumedRef = useRef(false);
useEffect(() => {
  if (data.autoStart !== true || autoStartConsumedRef.current) return;
  autoStartConsumedRef.current = true;
  updateNodeData(id, { autoStart: undefined });
  if (readOnly || !canStart || hasActiveSession) return;
  startSession();
});
```

Note the deliberate absence of a dependency array: the effect runs after every render and the ref guard makes it fire at most once. Do not add a `[]` array — with StrictMode's double-invoked effects plus a dependency-less closure over the first render's `startSession`, the no-array form is the one that stays correct and lint-clean.

- [ ] **Step 8: Run the full node test file to verify everything passes**

Run: `corepack pnpm --dir apps/desktop exec vitest --config config/tooling/vitest.config.ts run --project unit src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx`

Expected: PASS, all tests.

- [ ] **Step 9: Typecheck and lint**

Run: `corepack pnpm --dir apps/desktop typecheck && corepack pnpm lint`

Expected: typecheck clean. Lint: clean for the touched files (lint is known-red on main for unrelated files — compare against pre-change output if anything is flagged).

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/canvas/CanvasNode.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/creation.ts apps/desktop/src/renderer/src/components/workspace/runs/agent-session/creation.test.ts apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.tsx apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.test.tsx
git commit -m "feat: auto-start freshly created agent nodes

Clicking an agent in the rail opens its CLI session immediately; the
one-shot autoStart flag is cleared on consumption so saved workspaces
still reopen idle.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Full-suite verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything above.
- Produces: green evidence for the branch.

- [ ] **Step 1: Run the workspace-adjacent unit suites**

Run: `corepack pnpm --dir apps/desktop exec vitest --config config/tooling/vitest.config.ts run --project unit src/renderer/src/components/workspace`

Expected: PASS. Known-flaky/environment-dependent failures (per repo memory: peer-mcp needs a prior package build) are pre-existing only if they also fail on the base commit — verify with `git stash` only if needed, never assume.

- [ ] **Step 2: Typecheck**

Run: `corepack pnpm --dir apps/desktop typecheck`

Expected: clean.
