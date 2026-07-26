# Instant agent node startup

**Date:** 2026-07-25
**Status:** Approved (node gate: remove entirely; auto-start: revised same day —
owner rejected any Start button: "it should literally just be open instantly
into claude code or any other agent")

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

### 2. Zero-click sessions: agent nodes launch whenever they lack a live one

There is no "Start session" button. An agent node IS its CLI: on mount, once
`useTerminalNodeController`'s initial session listing settles (a new
`loaded: boolean` on the controller — true after the first `refresh()`
completes, success or failure), the node launches a session through the
existing `startSession()` path (fresh peer provision → launch → auto-confirm)
unless one of these holds:

- a live session was reattached (`controller.active`) — just show it;
- the node is read-only (graph read-only, locked, collab read-only);
- the agent is unavailable (`agentSessionUnavailableReason`);
- the controller already reported an error.

The launch fires at most once per mount (ref guard; StrictMode-safe). This
covers creation (rail/palette/drop) and workspace reopen alike — a persisted
_ended_ session from a previous app run is relaunched over, not parked behind
a button. A session that ends while the node is mounted stays on the exit
strip ("Restart"), which also bounds a crash-looping CLI to one launch per
mount.

Start-card states: unavailable reason (as today); "Retry" button when a launch
errored (`controller.error`); otherwise a terse "Starting…" line. The exit
strip's "Restart" stays an explicit click. No `autoStart` node-data flag —
always-launch makes creation-time marking unnecessary.

## Error handling

- Signed-out provider: the CLI shows its login prompt inside the terminal.
- Missing/invalid executable: launch fails through the existing controller
  error path (`controller.error` renders on the node) and the card offers
  "Retry".
- Read-only graph / locked node / collaboration read-only: auto-launch is
  skipped; the card shows only the monogram (nothing to click).

## Testing

- `useTerminalNodeController` tests: `loaded` flips true once the initial
  session listing settles (including on failure).
- `AgentSessionNode` unit tests: no gate/Start/Refresh buttons; auto-launch
  fires once when `loaded` with no active session (including over a persisted
  ended session); no launch before `loaded`, when read-only, over a live
  session, or when the controller has an error; "Retry" relaunches after an
  error; Restart on the exit strip still provisions fresh.
- Update existing tests that clicked "Start session" to drive the auto-launch
  path (`controller.loaded = true`) instead.
