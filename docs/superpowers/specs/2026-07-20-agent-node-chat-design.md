# Agent node chat — design (v2, hybrid)

Date: 2026-07-20
Status: Approved (v2 pivot: real CLI terminal in the node + structured runs for orchestration)

## Goal

Every Agent node's face is a live, scrollable session with its agent — visible directly on the canvas, not behind a click-through. Interactive chatting uses the **real provider CLI** (Claude Code, Codex, opencode) running in an embedded terminal inside the node, so every feature — slash commands, plan mode, model switching, permission prompts — works natively with nothing to re-implement. Flow-triggered orchestration keeps the existing **structured headless run pipeline** (approval, worktrees, transcripts, tokens/cost). Agent nodes get no right-sidebar inspector: everything lives on the node. Provider nodes look distinctly branded. Agent nodes are much bigger by default.

## Decisions made during brainstorming

- **Hybrid surface:** interactive session = real CLI TUI in a PTY (reuses the terminal-node infrastructure); flow runs = existing headless run pipeline, untouched.
- **Chat visible on the node itself** — the terminal renders in the node body on the canvas, always (when not collapsed), never behind a click-in panel.
- **Slash commands:** provided natively by the embedded CLIs (`/compact`, `/model`, custom commands like `/goal`). No custom command menu is built.
- **Everything adjustable on the node:** agent, model, permission profile selects; inline title edit; context-attachment chips.
- **Sidebar:** removed for agent nodes in this round ("agent-first"); other node kinds keep their panels for a later pass.
- **Session start friction:** one explicit Start (with the existing terminal launch review) per session; typing inside the session is the CLI's own instant loop. The provider connection gate (run-gate on connection) still blocks starting.
- **Provider looks:** distinct brand themes per provider — palette entries per provider, same layout, different identity.

## 1. Node face: embedded provider terminal

For `data.kind === 'agent'`, `CanvasNode` renders a new **`AgentSessionNode`** body (replacing the title/description/chip stack):

- **Terminal area** — `TerminalSurface` (xterm) filling the node, streaming the provider CLI session. Carries `nowheel nodrag` classes so wheel/selection stay in the terminal; the node drags only by its header (`dragHandle` = node header selector).
- **Idle state** — before a session starts (or after exit): a start card with the provider logo/monogram, a **Start session** button, and the last session's tail if one existed. Session exit shows an exit strip with **Restart**.
- **Header** — unchanged chrome (kind icon, collapse, status dot) plus **inline title editing** (click the title to edit in place; commits on blur/Enter).
- **Config row** (above the terminal, compact selects): **Agent**, **Model** (gated on `modelSelection` capability), **Permission profile**. Changes apply to the next session; while a session is live, a **Restart with new settings** affordance appears instead of silently switching.
- **Context chips** — attached context nodes (`contextAttachmentIds`) render as removable chips on the node; the canvas drop-zone behavior is unchanged.
- **Run strip** — compact line showing orchestration state: status chip, `lastRunSummary`, cost when present, and an expandable **Last run output** `<details>` with the structured-run transcript (`data.transcript`). This keeps flow-run visibility after the sidebar goes away.
- Collapse behavior unchanged (35 px pill). The PTY session keeps running while collapsed.

## 2. Session lifecycle (reusing terminal infrastructure)

- Renderer: `useTerminalNodeController` (existing) drives the session with a **provider-derived `TerminalNodeConfiguration`** instead of a user-typed command. Start = `prepareLaunch()` → existing launch review (`TerminalLaunchReviewDialog`, once per session) → `confirmLaunch()`. Input, resize, interrupt, terminate, replay: all existing controller methods.
- Sessions are keyed per node (existing owner model), survive node deselection, and are terminated by the existing service shutdown rules.
- **Provider gate kept:** the Start button is blocked (with inline warning + **Refresh status** / **Open settings** actions) while `useAgentProviderGate` reports the provider disconnected/unknown — same copy and actions as today.

## 3. Provider launch resolution (main process)

New module `main/agent-sessions/launch-config.ts` maps node config → terminal launch input:

- **Executable:** from agent detection (`AgentDetection.executable`, honoring `agentExecutableOverrides`).
- **Arguments per provider:**
  - `claude`: `['--permission-mode', 'plan']` when profile is `plan-read-only`; `['--model', <model>]` when a model is set.
  - `codex`: `['-m', <model>]` when a model is set; profile `plan-read-only` adds its read-only sandbox flag.
  - `opencode` / others: no flags (documented as best-effort; the CLI's own controls apply).
- **cwd:** project root; for `worktree-write`, the node's persistent worktree — acquired through the same worktree machinery the run pipeline uses (created on first session, reused after).
- **`docker-isolated`:** not available for interactive sessions in this round — the permission select shows the existing "unavailable" pattern with a reason.
- Everything flows through the existing `TerminalService` (launch review, audit, PTY) — no new privileged paths.

## 4. Flow runs: unchanged pipeline, visible on the node

The headless run pipeline (prepare/approve, run events, transcript, summaries, tokens/cost, run history) is untouched. Its output surfaces on the node via the run strip (§1). The interactive terminal and orchestration runs are separate lanes of the same node; they share the node's config (adapter, model, permission profile) and worktree.

## 5. No sidebar for agent nodes

Selecting an agent node shows **no inspector panel** (the inspector renders nothing for `kind === 'agent'`). `AgentNodePanel` and the agent branch of `WorkspaceInspector` are removed; title/description/accent editing moves to the node (title inline; description and accent become node-level edits in a small overflow popover on the node header — kept terse). `AgentContextDropZone` management moves to the on-node context chips. Other node kinds keep their inspector panels this round.

## 6. Provider-themed nodes

- **Palette:** one entry per runnable provider ("Claude Code", "Codex", "opencode", …) creating an agent node with `adapterId`, themed color, and provider label pre-set. The generic "Agent" entry remains.
- **Theme map** (`node-registry/provider-themes.ts`): per-provider accent, surface tint, header treatment, monogram/logomark, and matching xterm theme (background/foreground/cursor). Applied via `data-provider` attribute + scoped CSS custom properties; switching the Agent select re-themes live. Unknown providers fall back to generic styling.

## 7. Node sizing

- Agent nodes: default **560×480**, minimum **400×320** (a usable ~80×24 terminal at 12 px). Other kinds keep current defaults (320×180 / 210×92). Registry-driven per-kind dimensions; `NodeResizer` and persistence floors read per kind. Still freely resizable; xterm refits on resize.

## 8. Error handling

- Gate warning blocks Start with inline refresh actions (existing copy).
- Launch failure → inline error strip on the node with Retry.
- Session exit (crash or clean) → exit strip with code and **Restart**.
- Worktree acquisition failure for `worktree-write` → inline error, session not started.

## 9. Testing

- `launch-config` unit tests: per-provider args/cwd matrix (profile × model), override handling, docker-unavailable reason.
- `AgentSessionNode` tests: start-card → review → running states, gate blocking, config selects patch node data, restart-after-config-change affordance, run strip renders summary/transcript details, inline title edit commits.
- `CanvasNode` tests: agent kind renders session body, `data-provider` attribute, drag-handle and `nowheel`/`nodrag` presence, other kinds unchanged.
- `WorkspaceInspector` tests: agent selection renders no panel.
- Dimension/persistence tests updated for per-kind sizes.

## Out of scope

- Docker-isolated interactive sessions.
- Sidebar removal for non-agent node kinds (follow-up pass).
- Structured turn model / custom chat renderer / custom slash-command menu (superseded by the real TUI).
- Driving the interactive TUI from flow orchestration (flows keep the headless pipeline).
- Parsing TUI output for structured data (tokens/cost stay run-pipeline-only).

## Known limitations

- xterm inside the zoomed canvas: text selection accuracy can drift at extreme zoom levels; usable at normal zoom.
- Interactive session transcripts are raw terminal streams; ForgeBoard does not extract structured data from them.
