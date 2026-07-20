# Content on every node — design (Phase 2)

Date: 2026-07-20
Status: Approved (decomposed into sub-plans 2a–2d)

## Goal

Every node kind renders its actual content on the node face — websites, terminals, files, diffs, docs, diagrams — always visible on the canvas, freely resizable, exactly like the agent session windows shipped in Phase 1. The right-hand inspector sidebar is removed entirely at the end; anything it still hosts moves onto nodes or into small node-anchored popovers.

Reference pattern (already shipped): `AgentSessionNode` rendered from `CanvasNode` for `kind === 'agent'`, services injected via `AgentSessionContext`, per-kind dimensions in `node-dimensions.ts`, per-kind CSS via `data-node-kind`.

## Decisions

- **Web previews: in-DOM `<webview>` now** (user decision). The native `WebContentsView` overlay (positioned in absolute window pixels from main, cannot zoom/clip with the canvas) is replaced by an in-DOM Electron `<webview>` that scales, clips, and stacks like any node content. Security is re-architected before anything ships (below).
- Editors live on the node (user: "everything inside the nodes UI") — markdown, checklists, and config edit in place on the face; popovers only for rarely-used management (file assignment, whiteboard toolbars).
- One kind at a time lands; the sidebar is deleted only in the final sub-plan when nothing renders in it.

## Sub-plan decomposition

### 2a. Webview preview architecture + preview node faces

- **Security model** (prerequisite): enable `webviewTag` for the workspace window only; in main, on `app` `web-contents-created`, detect `webview` contents and enforce: `setWindowOpenHandler` → deny + `openExternal` via existing policy, `will-navigate` filtered through the existing `url-policy.ts` allowlist, `session` partition `preview:<projectId>:<nodeId>` (non-persistent), no `nodeIntegration`, `contextIsolation` on, no preload. Existing WebContents-level policies port over — audit `security-policy.ts` and mirror every enforcement onto webview contents. The old `PreviewSurfaceRuntime` (WebContentsView) path is removed once faces ship; the full-screen `PreviewSurface` modal switches to the same webview component (one architecture).
- **Node faces — port-only (user decision: "literally just inputting a port and it showing up, nothing extra"):** the face is a single compact **port input** (plus a small reload glyph) in the strip; once a port is set, `<webview src="http://localhost:<port>/">` fills the body. No URL bar, no back/forward, no dev-server start/stop controls, no preset pickers on the face. `mobile-preview` is identical but renders the webview inside the device frame at the node's stored preset (existing `previewPreset` default), CSS-scaled to fit. Port stored as `previewPort?: number` on node data. Navigation policy: same-origin localhost (localhost/127.0.0.1 on that port) allowed; everything else denied with `openExternal` handoff. Both faces keep `nowheel nodrag` semantics. The existing dev-server lifecycle IPC remains for other flows but is not surfaced on the face.
- Dimensions: web-preview default 640×480 min 400×300; mobile-preview default 420×640 min 320×480.

### 2b. Document & status faces (pure DOM/SVG — the easy eight)

- `diagram`: rendered mermaid SVG on the face (cached, re-rendered debounced on source change); source editor toggles on the face.
- `whiteboard`: the existing interactive SVG preview becomes the face; shape toolbar in a popover.
- `brief`: rendered markdown + checklist + acceptance criteria on the face, editable in place (`MarkdownComposer` embedded); version history in a popover.
- `note-image`: markdown + image grid on the face; image add via the existing chooser.
- `task`: status/assignee/priority/acceptance as compact inline-editable rows.
- `review-gate`: gate state + required checks + approval action on the face.
- `git-pr`: operational strip face — branch/remote config compact, commit list, ahead/behind, CI/readiness chips, PR link/actions.
- `test`: command summary, run status, attempts, artifact links, Start/Cancel on the face.
- Each gets registry dimensions + `data-node-kind` CSS; content replaces the generic `.node-body`.

### 2c. Terminal, file, diff faces (heavy embeds)

- `terminal`: mirror of the agent embed — `TerminalSurface` + `useTerminalNodeController` on the face; executable/args/cwd/env editing in a compact config strip (reuses `CommandBuilder` pieces); launch review overlay in-node.
- `file`: Monaco (`FileEditorWorkspace`) on the face, lazy-mounted (only when expanded and above minimum size); file assignment via `ProjectFileBrowser` popover. One Monaco instance per visible expanded file node; collapse unmounts.
- `diff`: `GitDiffViewer` + compact file list on the face; the existing `GitReviewDialog` remains as a maximize affordance from the node.

### 2d. Sidebar retirement

- Comments (shared/local) → node-anchored popover with count chip on every node.
- Edge editing (`TypedEdgeInspector`) → small floating popover near the selected edge.
- Remaining inspector-only flows audited and rehomed; `WorkspaceInspector` and its shell deleted; `AgentSessionContext` generalizes to `NodeServicesContext` if 2a–2c haven't already done so.
- The orphaned retired-panel subtree from Phase 1 (`AgentNodePanel` etc.) is deleted here once its user WIP is resolved.

## Constraints

- Renderer + narrowly-scoped main changes (webview security, window webPreferences). No changes to run/terminal IPC contracts.
- Dirty-tree staging protocol from Phase 1 applies to every commit.
- Per-kind faces must keep collapse (35px pill), lock, group, resize behaviors intact.
- Performance: heavy embeds (webview, Monaco, xterm) mount only while expanded; collapsed/offscreen nodes must not hold live engines (webview may keep its session via `src` retention on remount where feasible).

## Testing

- 2a: main-process webview policy tests (navigation denied outside allowlist, window.open denied, partition per node); face tests with `<webview>` stubbed.
- 2b: per-face render + inline-edit tests (markdown/checklist/SVG present on the node).
- 2c: terminal face mirrors agent tests; file face lazy-mount tests; diff face render tests.
- 2d: inspector deletion — canvas-level tests that every former inspector capability is reachable from nodes/popovers.

## Out of scope

- Canvas-level chrome from the October reference (dock, minimap restyle, project chat pill).
- Extension-kind node faces (extensions keep their declarative inspector until the extension API grows a face contract).
