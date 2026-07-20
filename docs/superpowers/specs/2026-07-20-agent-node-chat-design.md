# Agent node chat — design

Date: 2026-07-20
Status: Approved

## Goal

Turn the Agent node on the flow canvas into an embedded, scrollable chat with its agent — the Claude Code chat experience inside the node. Sending a message is instant (no Review & run dialog), output streams back as distinct turns, and agent/model/permission are adjustable from the chat itself. The inspector sidebar shrinks to node metadata only. Agent nodes get a larger default size.

## Decisions made during brainstorming

- **Chat model:** live session per node. Each Agent node holds one ongoing conversation with its agent. Flow-triggered runs append turns to the same conversation.
- **Approval:** no per-message or per-run review dialog in the chat path. Safety = permission profile + provider connection gate. Launch details remain visible as activity turns.
- **Sidebar:** node meta only (title, description, accent, context attachments).
- **Implementation approach:** structured turns (a real conversation model on node data), not a relocation of the existing single-blob transcript panel.

## 1. The node becomes the chat

For `data.kind === 'agent'`, `CanvasNode` renders a new `AgentNodeChat` component as the node body instead of the title/description/status/permission-chip stack:

- Scrollable message thread filling the node's height.
- Composer pinned to the bottom (textarea + send button).
- Node header unchanged: kind icon, kind label, collapse button; title shows in the header. Collapse behavior unchanged (35px pill).
- Thread and composer carry React Flow `nowheel` and `nodrag` classes so wheel scrolls the chat (not the canvas) and drag selects text (not the node).
- Agent nodes set React Flow `dragHandle` to the node header, so the node moves only by its header.

## 2. Structured conversation model

New field on `WorkshopNodeData`:

```ts
conversation?: AgentChatTurn[]

interface AgentChatTurn {
  id: string
  role: 'user' | 'assistant' | 'activity' | 'notice'
  text: string
  runId?: string
  ts: number
  meta?: {
    source?: 'typed' | 'flow'      // user turns: typed in chat vs triggered by orchestration
    collapsed?: boolean            // activity turns render collapsed by default
    action?: 'refresh-provider' | 'retry-run' | 'resend'  // notice/user turn affordances
    failed?: boolean
  }
}
```

- **user** — right-aligned bubble. Flow-triggered prompts get a small "flow" chip (`meta.source === 'flow'`).
- **assistant** — markdown-rendered reply text, streamed in as it arrives.
- **activity** — dim, collapsible group: lifecycle events, tool/stream noise, worktree created, files changed, the exact launched command.
- **notice** — inline warnings/errors with action buttons (refresh connection, retry).

Turns are built in the existing `runs.onEvent` pipeline: `summarizeRunEvent` (`model/helpers.ts`) is extended to emit turn deltas; the `Workspace.tsx` event handler merges them into `node.data.conversation` (append or extend the current streaming assistant/activity turn). The conversation is capped by a character budget equivalent to today's 100 000-char transcript cap (oldest turns dropped whole).

**Migration:** nodes with an existing `transcript` and no `conversation` get a single collapsed activity turn containing the old transcript on first load. The `transcript` field keeps updating as-is during the transition so nothing else breaks; display switches to `conversation`.

## 3. Sending — chat-first, no dialog

- **Enter** sends; **Shift+Enter** inserts a newline.
- **Idle node:** sending resumes the node's agent session with the message (continuation/resume when a prior session exists and the agent supports it; otherwise a fresh run with the message as prompt). The run is prepared and auto-approved programmatically — the `RunApprovalDialog` is not shown for chat sends.
- **Running node:** sending delivers the message as live input (`runs.sendInput`).
- A **stop** control interrupts the active run.
- **Connection gate (kept):** when `useAgentProviderGate` reports a warning, a notice turn appears with **Refresh status** / **Open settings** actions and sending is blocked until the provider is ready. This preserves the existing run-gate-on-connection behavior.
- Launch details (cwd/worktree, exact command) appear as an activity turn at run start, so auto-approval doesn't hide anything.

## 4. In-chat configuration

A compact control row sits above the composer with three selects:

- **Agent** (runnable agents, e.g. Anthropic Claude Code)
- **Model** (options gated on the agent's `modelSelection` capability)
- **Permission profile** (existing `PERMISSION_PROFILE_OPTIONS`)

Changing a select calls `updateNodeData` with the same patches the sidebar panel makes today. Selects (not free-text) per existing UX preference.

## 5. Sidebar → meta only

`WorkspaceInspector` for `kind === 'agent'` keeps:

- Shared fieldset: Title / Description / Accent colour
- `AgentContextDropZone` (context attachments)

`AgentNodePanel` (agent-run config, prompt textarea, live output, run controls, attempt history sections) is retired. Its logic is not deleted — it's rehomed:

- A new **`AgentRunContext`** provider (mounted in `Workspace.tsx`, wrapping `WorkspaceCanvas`) exposes the run controller surface to in-canvas components: `sendMessage(nodeId, text)`, `stop(nodeId)`, `updateNodeData`, provider-gate state, `runnableAgents`, permission options. `AgentNodeChat` consumes it — no prop drilling through React Flow.
- `useAgentProviderGate`, `useAgentRunController`, and continuation hooks are reused behind that context.

## 6. Node sizing

- Agent nodes: default **420×540** (today 320×180), minimum **340×360**.
- Other node kinds keep current defaults (320×180 / 210×92).
- The node-kind registry gains per-kind default/minimum dimensions; `node-persistence.ts` and `NodeResizer` bounds read from it.
- Nodes remain freely resizable; the chat flexes to fill.

## 7. Error handling

- Run fails → notice turn with the error summary and a **Retry** action (re-sends the last user turn as a continuation).
- Send fails (IPC/launch error) → the user turn is marked failed with a **Resend** affordance.
- Provider disconnect mid-session → notice turn via the gate, composer blocked until refreshed.

## 8. Testing

- **Conversation builder:** unit tests mapping run-event sequences → expected turn arrays (streaming append, activity grouping, caps, migration from `transcript`).
- **`AgentNodeChat`:** send on Enter / newline on Shift+Enter, composer disabled states under the gate, running-state input routing (sendInput vs new run), stop control, config selects patch node data.
- **`CanvasNode`:** agent kind renders chat body; other kinds unchanged; drag-handle and `nowheel`/`nodrag` classes present.
- **`WorkspaceInspector`:** agent selection shows meta-only panel; `AgentNodePanel` tests migrate to the new components.

## Out of scope

- A persistent long-lived process per node (true daemon sessions). The existing run + resume/continuation + mid-run input machinery is the session backbone.
- Changes to non-agent node kinds beyond registry-driven sizing plumbing.
- Reworking the approval system for flow-level (multi-node) orchestration runs.
