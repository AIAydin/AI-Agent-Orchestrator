# 2d — Delete the right-hand inspector sidebar ("everything lives in the nodes")

Goal: remove `WorkspaceInspector` entirely. Every capability it uniquely hosts moves onto
the canvas (node faces, a node-header details popover, or an edge popover) so nothing is lost.
Base: `main` @ e165c13 (all 14 node faces already exist). Integration branch:
`feature/sidebar-deletion-2d`.

## Decisions (user, 2026-07-21)

- Edge editing → **popover anchored on the edge** (React Flow `EdgeLabelRenderer`).
- Comments (local + shared) + run history → **node-header popover** (💬 / 🕐 affordances).
- Node title/description/accent color → on the node (inline rename + a small settings popover).
- Scope → **full clean cutover**: relocate everything, add faces for `extension` + `group-frame`,
  then delete the inspector.

## Inspector-only capabilities being relocated (source refs in feature/agent-peer-channels tree)

Universal: title (`WorkspaceInspector.tsx:198`), description (`:205`), color (`:215`),
local comments (`:404`), shared comments (`:405`), run history (`:403`).
Edge: `TypedEdgeInspector` (`:146`, `canvas/TypedEdgeInspector.tsx`).
Faceless kinds: extension `DeclarativeExtensionInspector` (`:225`), group-frame `GroupFrameInspector` (`:250`).
Per-kind remainders (fold onto existing faces): brief attachments/prompt-vars, note-image alt/relink,
whiteboard element-editing/export/context-share, preview dev-server/presets/orientation/comparison,
task related-files, review-gate reviewer-config/evidence/lint+tests toggles, test command/output,
git-pr push/PR-plan confirm.
Drop: empty-state `CanvasInspector` (`:707`), header clear-selection.

## Shared contracts

- **Node-header details popover**: one popover host mounted from `CanvasNode` header, opened by
  header buttons. Sections: Settings (title rename + description + color), Comments (Local+Shared),
  History (NodeRunHistory). Reuse existing components (`comments/LocalComments`,
  `collaboration/comments/SharedComments`, `node-history/NodeRunHistory`) verbatim — do not rewrite them.
  `nowheel nodrag`, readOnly = `graphReadOnly || data.locked`. Agent nodes: settings still available
  (inline rename already on the agent face — don't duplicate the rename there, but the popover host is generic).
- **Inline title rename**: generic double-click-to-rename on the node header title, mirroring
  `AgentSessionNode.tsx:317` (unique-name commit on blur, Esc cancels). Applies to all kinds.
- **Edge popover**: extract type/data editing from `TypedEdgeInspector` into an
  `EdgeConfigPopover` rendered via `EdgeLabelRenderer`, anchored at the edge midpoint, shown when the
  edge is selected. Wire `onUpdateEdgeType` / `onUpdateEdgeData` through the existing edge component path.
- **New faces**: `ExtensionNodeFace`, `GroupFrameNodeFace` registered in
  `canvas/faces/node-face-registry.tsx`. Follow the `NodeFaceProps = {id, data}` pattern; read services
  from context, not props. Additive registry/test/CSS edits (keep both sides on merge).
- **Per-kind remainders**: add the missing controls to each existing `*NodeFace`, behind the face's
  config popover where one exists. Faithful port of the inspector logic — same graph mutations.

## Waves

- **W1 (foundation, parallel):** node-details-popover+rename (CanvasNode) · edge-popover · extension+group-frame faces.
- **W2 (per-kind remainders, parallel):** content (brief/note-image/whiteboard) · preview · workflows (task/review-gate/test) · git-pr.
- **W3 (deletion, last):** delete `WorkspaceInspector.tsx` + `TypedEdgeInspector` inspector usage, unwire mount/layout/CSS
  (`Workspace.tsx`, `useWorkspaceSidebarLayout.ts`, `sidebar-resize.ts`, `workspace-shell.css`, `inspector.css`,
  `responsive.css`), and do test surgery (`WorkspaceInspector.test.tsx` removed;
  `WorkspacePersistence/GitReviewTarget/PermissionSelection` mocks dropped; sidebar-resize tests pruned of inspector cases).

## Verify (each agent, in its worktree)

`corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit <touched paths>`;
`corepack pnpm --dir apps/desktop typecheck`; `corepack pnpm lint`. Prove any stale-test failure pre-existing vs base e165c13.
