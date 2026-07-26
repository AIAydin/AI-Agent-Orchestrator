# Agent node chat — design (v2, hybrid)

Date: 2026-07-20
Status: Implemented (commits 3140da4..4140497; final whole-branch review passed after fix wave).
The managed-worktree interactive-session follow-up was completed on 2026-07-23.

Implementation deviations of record: green traffic light focuses the terminal (not resize); the §5 description/accent overflow popover was not built (agent description currently editable nowhere — follow-up); interactive model flags map claude/codex/gemini/opencode, others hide the Model field. Known pending: commits depend on untracked provider-gate scaffolding (user WIP) — needs a dedicated scaffolding commit for isolated builds.

## Goal

Every Agent node's face is a live, scrollable session with its agent — visible directly on the canvas, not behind a click-through. Interactive chatting uses the **real provider CLI** (Claude Code, Codex, opencode) running in an embedded terminal inside the node, so every feature — slash commands, plan mode, model switching, permission prompts — works natively with nothing to re-implement. Flow-triggered orchestration keeps the existing **structured headless run pipeline** (approval, worktrees, transcripts, tokens/cost). Agent nodes get no right-sidebar inspector: everything lives on the node. Provider nodes look distinctly branded. Agent nodes are much bigger by default.

## Decisions made during brainstorming

- **Hybrid surface:** interactive session = real CLI TUI in a PTY (reuses the terminal-node infrastructure); flow runs = existing headless run pipeline, untouched.
- **Chat visible on the node itself** — the terminal renders in the node body on the canvas, always (when not collapsed), never behind a click-in panel.
- **Slash commands:** provided natively by the embedded CLIs (`/compact`, `/model`, custom commands like `/goal`). No custom command menu is built.
- **Everything adjustable on the node:** agent, model, permission profile selects; inline title edit; context-attachment chips.
- **Sidebar:** removed for agent nodes in this round ("agent-first"); other node kinds keep their panels for a later pass.
- **Session start friction:** one explicit Start per session; a built-in worktree session is reconstructed and authorized automatically in Electron main, while unsupported/custom paths retain native terminal review. Typing inside the session is the CLI's own instant loop. The provider connection gate (run-gate on connection) still blocks starting.
- **Provider looks:** distinct brand themes per provider — palette entries per provider, same layout, different identity.

## 1. Node face: a floating app window with the real CLI inside

Reference: the "October"-style canvas — agent nodes read as **macOS-style app windows** floating on the canvas, each showing a live CLI session. For `data.kind === 'agent'`, `CanvasNode` renders a new **`AgentSessionNode`** with window chrome (replacing the generic node header/body):

- **Window title bar** (the drag handle): traffic-light dots — red = delete node (existing delete flow + confirm), yellow = collapse to pill, green = expand toward default size; then **inline-editable title** (the agent's name, e.g. "Hermes") and a dim provider label ("· Claude Code"); status dot on the right. Rounded corners, window drop shadow.
- **Terminal body** — `TerminalSurface` (xterm) filling the window, streaming the provider CLI session — the actual Claude Code / Codex TUI, dark terminal styling regardless of app theme. Carries `nowheel nodrag` so wheel/selection stay in the terminal.
- **Idle state** — start card with provider monogram, a **Start session** button, and "not installed" / gate guidance when applicable. Session exit shows an exit strip with the code and **Restart**.
- **Bottom control strip** (compact, October-style): **Agent** select ▾, **Model**, **Permission profile** ▾, run-status chip + `lastRunSummary`, expandable **Last run output** (structured-run transcript), and context-attachment chips (removable). Config changes apply to the next session; while a session is live a **Restart to apply** affordance appears instead of silently switching.
- Collapse behavior unchanged (35 px pill). The PTY session keeps running while collapsed.

## 2. Session lifecycle (reusing terminal infrastructure)

- Renderer: `useTerminalNodeController` (existing) drives the session with a **provider-derived `TerminalNodeConfiguration`** instead of a user-typed command. Start = `prepareLaunch()` → automatic `confirmLaunch()`; Electron main either reconstructs an eligible built-in worktree command or falls back to native review. Input, resize, interrupt, terminate, replay: all existing controller methods.
- Sessions are keyed per node (existing owner model), survive node deselection, and are terminated by the existing service shutdown rules.
- **Provider gate kept:** the Start button is blocked (with inline warning + **Refresh status** / **Open settings** actions) while `useAgentProviderGate` reports the provider disconnected/unknown — same copy and actions as today.

## 3. Provider launch resolution

A renderer module `runs/agent-session/launch-config.ts` maps node config → the existing
`TerminalNodeConfiguration`. The session continues through `TerminalService` for main-process
authorization, audit, and PTY ownership. The managed-worktree follow-up adds a path-free workspace
request to that contract; Electron main validates the persisted Agent node and selected profile,
provisions the worktree, reconstructs built-in executable/model/peer arguments from main-owned
state, and revalidates command and ownership immediately before spawn.

- **Executable:** from agent detection (`AgentDetection.executable`; detection already honors `agentExecutableOverrides`). Missing executable → start card shows "not installed" guidance instead of Start.
- **Arguments per provider:**
  - `claude`: `['--permission-mode', 'plan']` when profile is `plan-read-only`; `['--model', <model>]` when a model is set.
  - `codex`: `['--sandbox', 'read-only']` when profile is `plan-read-only`; `['-m', <model>]` when a model is set.
  - `opencode` / others: no flags (best-effort; the CLI's own controls apply).
- **cwd:** `plan-read-only` and profiles without interactive enforcement use the project root.
  Selecting `worktree-write` creates a fresh application-owned worktree for that Agent session and
  starts the provider CLI at its exact root. Separate Agent launches receive separate worktree
  ownership records and branches; the renderer receives only the durable run ID and branch, never a
  filesystem path. `docker-isolated` interactive enforcement remains a follow-up and is disclosed
  inline instead of being presented as enforced.
- **Environment allowlist:** empty (`environmentVariableNames: []`) — provider CLIs read their own config/auth files.

## 4. Flow runs: unchanged pipeline, visible on the node

The headless run pipeline (prepare/approve, run events, transcript, summaries, tokens/cost, run
history) is untouched. Its output surfaces on the node via the run strip (§1). The interactive
terminal and orchestration runs are separate lanes of the same node. They share the node's adapter,
model, and permission configuration, while every writable attempt or session owns its exact managed
worktree.

## 5. No sidebar for agent nodes

Selecting an agent node shows **no inspector panel** (the inspector renders nothing for `kind === 'agent'`). `AgentNodePanel` and the agent branch of `WorkspaceInspector` are removed; title/description/accent editing moves to the node (title inline; description and accent become node-level edits in a small overflow popover on the node header — kept terse). `AgentContextDropZone` management moves to the on-node context chips. Other node kinds keep their inspector panels this round.

## 6. Provider-themed nodes

- **Palette:** one entry per runnable provider ("Claude Code", "Codex", "opencode", …) creating an agent node with `adapterId`, themed color, and provider label pre-set. The generic "Agent" entry remains.
- **Theme map** (`node-registry/provider-themes.ts`): per-provider accent, title-bar tint, and monogram, applied to the window chrome via a `data-provider` attribute + scoped CSS custom properties; switching the Agent select re-themes live. The terminal body stays terminal-dark for every provider (the TUIs bring their own colors). Unknown providers fall back to generic styling.

## 7. Node sizing

- Agent nodes: default **560×480**, minimum **400×320** (a usable ~80×24 terminal at 12 px). Other kinds keep current defaults (320×180 / 210×92). Registry-driven per-kind dimensions; `NodeResizer` and persistence floors read per kind. Still freely resizable; xterm refits on resize.

## 8. Error handling

- Gate warning blocks Start with inline refresh actions (existing copy).
- Launch failure → inline error strip on the node with Retry.
- Session exit (crash or clean) → exit strip with code and **Restart**.

## 9. Testing

- `launch-config` unit tests: per-provider argument matrix (profile × model), missing-executable handling, project-root cwd, profile-note reasons.
- `AgentSessionNode` tests: start-card → review → running states, gate blocking, config selects patch node data, restart-after-config-change affordance, run strip renders summary/transcript details, inline title edit commits.
- `CanvasNode` tests: agent kind renders session body, `data-provider` attribute, drag-handle and `nowheel`/`nodrag` presence, other kinds unchanged.
- `WorkspaceInspector` tests: agent selection renders no panel.
- Dimension/persistence tests updated for per-kind sizes.

## Out of scope

- Docker-isolated interactive sessions (flow runs keep Docker isolation).
- Sidebar removal for non-agent node kinds (follow-up pass).
- Structured turn model / custom chat renderer / custom slash-command menu (superseded by the real TUI).
- Driving the interactive TUI from flow orchestration (flows keep the headless pipeline).
- Parsing TUI output for structured data (tokens/cost stay run-pipeline-only).

## Known limitations

- xterm inside the zoomed canvas: text selection accuracy can drift at extreme zoom levels; usable at normal zoom.
- Interactive session transcripts are raw terminal streams; Artemis does not extract structured data from them.
