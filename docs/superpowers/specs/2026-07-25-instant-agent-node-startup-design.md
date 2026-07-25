# Instant agent node startup

**Date:** 2026-07-25
**Status:** Approved (node gate: remove entirely; auto-start: new nodes only)

## Problem

Opening an agent session today takes several interactions on every app launch:
click the agent in the rail → the node blocks on "connection status needs a
refresh" → click "Refresh status" → approve a native confirmation → wait for the
provider status CLI → click "Start session". The provider-connection status
cache (`ProviderConnectionService.#statuses`) is in-memory only, so the gate
re-blocks after every restart. Non-gated agents (Gemini, opencode) still need
the extra "Start session" click.

The owner wants: click the agent, the CLI opens.

## Design

Two changes, both scoped to the interactive session-node path.

### 1. Remove the provider-connection gate from agent session nodes

`AgentSessionNode` no longer consults `gateFor` — no blocking banner, no
"Refresh status"/"Open settings" actions on the node, and `canStart` depends
only on `agentSessionUnavailableReason`. The session node runs the real CLI in
a PTY; when the user is signed out the CLI renders its own login flow in the
terminal, which is strictly better recovery than our banner.

Untouched:

- Settings → Agents & runtime keeps the single connection-status UI
  (connect / disconnect / refresh with native confirmation).
- The headless workflow-run path (`useAgentRunController` →
  `verifyAdapterConnection`) keeps its approval-time gate.
- `useAgentProviderGate` itself stays (Settings and the run controller use its
  machinery); only the session node stops consuming `gateFor`/`recheck`.
  If `gateFor`/`recheckProvider` end up with no consumers in
  `AgentSessionContext`, drop them from the context value.

### 2. Auto-start sessions for newly created agent nodes

Creating an agent node (rail click, palette, canvas drop → `addAgentNode`)
marks the node data with a transient `autoStart: true`. On mount,
`AgentSessionNode` consumes the flag: it clears it via `updateNodeData` and
invokes the existing `startSession()` path (fresh peer provision → launch →
auto-confirm) provided the node is startable (`agent` resolved, not
read-only/locked). Because the flag is cleared on consumption and never set on
load, reopening a saved workspace shows the normal Start card instead of
spawning a CLI per node.

Unchanged: the exit strip's "Restart" stays an explicit click; the Start card
(with "Start session") remains for nodes without a live session, e.g. after
workspace reload.

## Error handling

- Signed-out provider: the CLI shows its login prompt inside the terminal.
- Missing/invalid executable: launch fails through the existing controller
  error path (`controller.error` renders on the node), same as a manual Start.
- Read-only graph / locked node / collaboration read-only: auto-start is
  skipped; the Start card renders as today.

## Testing

- `AgentSessionNode` unit tests: gate no longer blocks (a disconnected/unknown
  provider still shows the Start card, not the banner); auto-start fires once
  for `autoStart: true` nodes, clears the flag, and skips when read-only.
- `Workspace`/`addAgentNode` test: newly added agent nodes carry
  `autoStart: true`.
- Update existing tests that assert the banner/gate behavior on the node.
