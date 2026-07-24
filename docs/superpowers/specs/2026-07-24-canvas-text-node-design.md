# Canvas text node design

Date: 2026-07-24. Status: approved by the user in conversation before implementation planning.

## Summary

Add a first-class `text` canvas node: a frameless, Canva-style text box that a user drops anywhere
on the Workshop canvas, types into immediately, moves, resizes, and rotates. It is a pure
annotation surface. It renders no card chrome, exposes no connection handles, and never
participates in workflow runs or agent context.

## Goals

- Frictionless text labels on the canvas: create, type, click away.
- Full citizenship in existing canvas machinery: selection, drag, lock, duplicate, group
  membership, keyboard movement, undo/redo checkpoints, autosave, snapshots, portable
  export/import, and collaboration sync with the same classification as other node data.
- Rotation with a Canva-style drag handle plus an accessible numeric fallback.

## Non-goals (v1)

- Rich text (bold/italic/underline), colors, alignment controls, markdown rendering.
- Connection edges to or from text nodes.
- Rotation for any other node type.
- Fonts beyond the application theme font.

## UX behavior

Creation. A `Text` entry appears in the node templates palette like any other node. In addition,
double-clicking empty canvas creates a text box centered on the click point and opens its inline
editor with the caret ready. The canvas engine's default double-click zoom is disabled; zooming
remains available via scroll, pinch, and the zoom controls. Double-clicking a node, group, or
other interactive surface is unaffected.

Editing. Double-clicking an existing text box, or pressing Enter while it has canvas focus, opens
the inline editor. Escape or clicking elsewhere commits the text. A text box committed with only
whitespace is deleted automatically. Pasted content is flattened to plain text. Newlines are
allowed.

Selection and movement. Clicking selects the box with the standard selection ring and resize
handles. Dragging moves it; arrow keys move it per existing canvas keyboard rules; existing
locking, duplication, grouping, and comment affordances apply unchanged.

Sizing. Side resize handles set the box width; text wraps and the height follows content
automatically. The floating node toolbar offers three font size presets: Small, Medium, Large
(Medium default). Only side (left/right) resize handles are shown; height always follows content.

Rotation. A rotate handle floats above the selected box. Dragging it rotates the node around its
center with live preview. Holding Shift snaps to 15 degree increments; releasing within 3 degrees
of 0/90/180/270 snaps to that cardinal angle. The node details panel shows a numeric degrees field
(-180 to 180) so rotation is fully operable by keyboard and assistive technology. The node's face,
selection ring, and handles rotate together as one transform.

Locked and read-only. A locked text node cannot be moved, resized, rotated, or edited. Read-only
collaboration roles see text nodes but cannot change them, matching other node types.

## Data model

Core schema (`packages/core/src/model/domain.ts`): add `TextNodeSchema` to the
`CanvasNodeSchema` discriminated union:

```ts
export const TextNodeSchema = createNodeSchema(
  'text',
  z
    .object({
      text: z.string().max(10_000).default(''),
      fontSize: z.enum(['s', 'm', 'l']).default('m'),
      rotationDeg: z.number().min(-180).max(180).default(0),
    })
    .strict(),
);
```

Position, size, `locked`, `groupId`, `comments`, timestamps, and the required `title` come from
`baseNodeShape`. The node title defaults to `Text` and is not rendered on the face; it appears
only where titles already appear (history, details panel). Renderer node kind is `text`, mapped in
persistence exactly as other kinds are (`model/node-persistence.ts`), with a
`node-name-migration.ts` entry only if a rename ever occurs (none needed at introduction).

## Renderer architecture

- Registry: `builtin('text', 'Text', 'A floating text label', '#8f9bb3', Type)` in
  `node-registry/registry.ts` (lucide `Type` icon), plus a new per-definition capability flag
  `frameless: true`.
- Shell: `CanvasNode.tsx` consults `frameless` to skip the header, card border, background, and
  connection `Handle`s while keeping selection, `NodeResizer` (side handles only), the details
  popover trigger, and lock chrome. The rotation transform wraps the shell content container.
- Face: `content/text/TextNodeFace.tsx` renders the text (or the inline plain-text editor while
  editing) at the preset size using theme tokens, with auto height.
- Rotation control: a small component in `canvas/interactions/` computing the angle from the
  pointer via `atan2` against the node center, following the engine's rotatable-node pattern.
  `rotationDeg` persists through the same node-data update path as other node edits.
- Creation gesture: `WorkspaceCanvas.tsx` sets `zoomOnDoubleClick={false}` and handles pane
  double-click by creating a `text` node at the flow position and entering edit mode.
- Edge policy: `text` is excluded from valid edge sources/targets wherever edge eligibility is
  computed, and renders no handles, so no rotated-anchor geometry ever arises.

## Persistence, collaboration, limits

The node persists through existing canvas persistence and schema versioning; portable JSON
export/import and snapshots inherit it via the union. Collaboration sync treats `text`,
`fontSize`, and `rotationDeg` as ordinary allowlisted node data with the same conflict handling as
other same-field edits (pause for review rather than overwrite). The 10k character cap bounds
sync payloads and storage.

## Security and validation

Plain text only: the face renders text content as text nodes, never as HTML or markdown. Paste is
flattened. Schema caps length; rotation is clamped; imports revalidate through the same zod
schema as every node.

## Testing

- Core: schema round-trip, defaults, clamps, union membership, import revalidation.
- Renderer unit: registry definition (frameless flag), face editing (commit, cancel,
  whitespace-only auto-delete), size presets, rotation numeric field clamp, locked/read-only
  behavior, pane double-click creation path.
- E2E (Playwright, existing patterns): double-click empty canvas, type, commit, rotate via
  details panel, reload, assert persistence and rendering.
- Full `corepack pnpm verify` passes before PR.

## Risks and mitigations

- Rotation vs. engine geometry: mitigated by excluding edges/handles from text nodes and rotating
  the whole shell content (the engine's supported pattern). Resize handles rotate with the node;
  this matches Canva behavior.
- Double-click zoom removal is a global canvas behavior change: zoom remains on scroll, pinch,
  and controls; the gesture now creates value instead of duplicating an existing zoom path.
- Frameless flag touches the shared `CanvasNode` shell: implemented as opt-in so all existing
  node kinds render byte-identically when the flag is absent.
