# Agent peer channels — design

Date: 2026-07-20
Status: Approved (brainstorm), pending implementation plan

## Goal

A `context` edge between two live agent session nodes becomes a working channel: each embedded CLI session gets Artemis-provided MCP tools to discover, read, and message the agents it is connected to. Today the edge is consumed only by the headless flow-run pipeline (`main/workflow/evidence/bridge.ts` `#reconcileContext`); interactive sessions ignore it entirely. This gives the interactive lane the semantics the flow lane already has. The flow-run pipeline is untouched.

## Decisions made during brainstorming

- **Agents talk to each other** (not one-way feed, shared file, or manual relay): each session gets MCP tools to read connected peers and send them messages.
- **Delivery = typed into the peer's terminal**: a message arrives as typed input in the receiving CLI, so the peer starts working on it immediately and the exchange is visible on the canvas. No inbox, no human gate per message.
- **All four provider CLIs** (claude, codex, gemini, opencode) get peer tools in v1, via one uniform stdio shim.
- Channels are **edge-scoped and bidirectional**: peers are agent nodes directly connected by a `context` edge, either direction. No multi-hop traversal.
- `send_message` **never auto-starts** a peer session (run-gate on connection stays with the user); it reports "no live session" instead.

## Architecture

### Peer hub (Electron main)

A new `agent-peers` service, started with the app:

- Localhost-only HTTP endpoint (`127.0.0.1`, random port).
- At session launch, Artemis mints a per-session bearer token binding the MCP connection to its node id. Token → node resolution happens in main; a stolen token grants only that node's peer view.
- Peer resolution reads the workspace edge graph: agent nodes adjacent via `context` edges. Non-agent context edges (file/brief attachments) keep their current meaning and are not peers.

### Transport: one stdio shim for all providers

`forgeboard-peer-mcp` — a small script shipped with the app — is a stdio MCP server that bridges to the hub over localhost HTTP. It reads `FORGEBOARD_PEER_URL` and `FORGEBOARD_PEER_TOKEN` from its environment. Every CLI's MCP config format supports "spawn command X with env Y", so this one shim covers all four providers uniformly.

### Config injection (`runs/agent-session/launch-config.ts`)

Per-provider step that registers the shim for the session being launched:

- `claude`: `--mcp-config <per-session temp file>` (additive; do not use `--strict-mcp-config` — the user's own MCP servers must survive).
- `codex`: `-c mcp_servers.forgeboard.…` per-invocation overrides.
- `gemini`, `opencode`: merged settings/config file (project- or user-scoped as the CLI requires).

Exact flags/formats are verified against the installed CLI versions during implementation. If injection is not possible for a provider/version, the session launches normally without peer tools and the node shows a terse "peer tools unavailable" hint.

## MCP tools (identical on every provider)

- **`list_agents`** — peers' names (node titles, deduped), provider, and whether their session is live. The tool description doubles as orientation: "you are a node on a Artemis canvas; these are your collaborators; replies arrive as `[from <name>]` messages in your input."
- **`send_message`** — delivers text into the peer's PTY via the existing terminal input path (`terminal:send-input` → `TerminalService.sendInput`): bracketed-paste the body prefixed `[from <sender>]`, then Enter to submit. Multi-line bodies stay one prompt thanks to bracketed paste. Returns delivered / no-live-session / muted / rate-limited.
- **`read_screen`** — returns the peer's current terminal text (xterm buffer serialization requested from the renderer over IPC), so an agent can check what a collaborator is doing without interrupting it. For alt-screen TUIs this is the visible screen; for inline TUIs it includes scrollback.

## Data flow

1. User starts a session on an agent node → launch config injects shim + per-session token.
2. CLI spawns shim → shim connects to hub with token → hub binds connection to node id.
3. Agent calls `send_message("Hermes", …)` → hub resolves Hermes among the caller's context-edge peers → checks mute + rate limit → writes prefixed, bracketed-pasted input + Enter into Hermes' PTY session → edge pulses on the canvas.
4. Hermes' CLI treats it as typed input (queued if mid-task), works, and replies with its own `send_message`.

## Safety rails

- **Rate limit** per edge, default 6 messages/minute — bounds runaway ping-pong without blocking real collaboration.
- **Mute toggle** in the edge popover — instantly pauses a channel; `send_message` returns "muted".
- Existing `TERMINAL_MAX_INPUT_BYTES` (64KB) cap applies to deliveries.
- Every delivery is logged through the existing terminal audit trail.

## Canvas feedback

The context edge pulses when a message transits it. Delivery is literally typed into the target terminal, so the conversation itself is visible in both windows. No new panels; terse copy throughout.

## Error handling

- Peer has no live session → tool result says so, suggests the user start it. Never auto-starts.
- Hub down / token rejected → shim reports an MCP error; CLI shows its normal MCP failure UI.
- Injection unsupported for a provider → session launches without peer tools + node hint (no hard failure).
- Renderer unavailable for `read_screen` (e.g. window closing) → tool returns a clear error, not a hang.

## Testing

- Unit: peer resolution from the edge graph (agent↔agent only, either direction, no multi-hop); per-provider injection matrix; token↔node auth binding; delivery formatting (prefix, bracketed paste, submit); rate limit and mute behavior.
- Component: edge pulse on transit; "peer tools unavailable" hint; mute toggle in the edge popover.
- Manual smoke: two claude sessions completing a message round trip on the canvas.

## Out of scope (this round)

- Multi-hop or canvas-wide discovery beyond direct edges.
- Peer tools in the headless flow-run lane.
- Message history UI on the edge (audit log covers forensics).
- Shared artifacts/task lists between agents (file system already serves this).

## Implementation deviations of record

Implemented on branch `feature/agent-peer-channels` (tasks 1–12). Where the build diverged from this design, the reasons:

1. **`read_screen` reads main-side transcript files, not renderer xterm serialization.** No serialize addon exists and xterm unmounts when a node collapses; the persisted terminal transcript is always available. `TerminalService.readTranscriptTail` serves the last 64 KiB → ANSI-stripped → last 200 lines.

2. **The mute toggle lives in the existing sidebar `TypedEdgeInspector`,** not a floating edge popover (which does not exist yet). A `muted: boolean` (default false) was added to `ContextEdgeSchema`.

3. **Provider config was verified against the installed CLIs and diverged from the plan's guessed flags:**
   - **claude** — `--mcp-config <0600 file>` in a per-provision scratch dir under `userData` (never the repo, never argv).
   - **gemini / opencode** — their MCP-server child _inherits_ the parent/PTY env (verified by spawning a real probe server), so the peer token is **omitted** from the project-root config files (`.gemini/settings.json`, `opencode.json`); only `ELECTRON_RUN_AS_NODE` is written. The token reaches the shim via the PTY env (deviation 4).
   - **codex** — env inheritance was _disproved_, so it uses a `0600` TOML profile under `$CODEX_HOME` selected via `--profile <name>` (only the profile name touches argv).

4. **The peer token is minted and injected entirely main-side.** The renderer passes only an opaque `peerProvisionId` (uuid) over IPC; `FORGEBOARD_PEER_URL`/`FORGEBOARD_PEER_TOKEN` values are resolved from the injected provider and spread into the PTY env at spawn — never over IPC, never logged, never in the renderer schema/event payload.

5. **Message-delivery hardening at the PTY write boundary** (beyond the design's sketch): `sender`/`message` are sanitized (ESC/CSI/OSC/control bytes stripped, `\n` kept) to prevent bracketed-paste escape injection, and the formatted envelope is size-capped to `TERMINAL_MAX_INPUT_BYTES` (sender ≤ 512 bytes, message truncated to fit) — both by code point, never mid-character.

6. **Concurrency limit for gemini/opencode (accepted product decision):** their peer config is merged into a **shared project-root file**, and all agent sessions in a project run at that root. Running **two gemini (or two opencode) peer sessions on the same project at once is unsupported** — they cross-wire (both shims load) — so the supported model is one such session per project at a time. Entry keys are provision-scoped (`forgeboard-<provisionId>`) and cleanup is non-destructive (never deletes a file it did not create or one with other keys) so concurrency never corrupts the file. **claude and codex are fully isolated** (private per-provision files) and unaffected.

7. **Agent-peer events reach only WebContents that have called `provision`** (mirrors the terminal IPC owner model). This is correct for the single-window app — the canvas window is the one that provisions sessions and consumes edge-pulse events. A future multi-window canvas would need wider event fan-out.

8. **The peer hub is admitted to the git-worktree cleanup quiescence** so a provision write cannot race a worktree cleanup.
