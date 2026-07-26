# Distinct node names — design

Date: 2026-07-21
Status: Approved (brainstorm), pending implementation plan

## Goal

Every node on the Artemis canvas carries a **distinct, friendly name** shown prominently at the top of the node. That name is the single identifier both the user and agents use to refer to the node — the peer channels (`list_agents` / `send_message`) already address agents by `node.title`, so the shown name and the addressable name are the same thing.

## Problem today

- New nodes default their `title` to the generic kind label (`title: definition.label`), so every agent is "Agent", every terminal "Terminal" — **not distinct**, no way to tell them apart or reference one unambiguously (`Workspace.tsx` `addNode`).
- Only agent-session nodes show `title` at the top (the window title bar). Face-based kinds (brief, diff, terminal, preview, git-pr, diagram, whiteboard, note-image, file, test) show only the **kind label** in their header, not a per-node name (`CanvasNode.tsx`).
- The peer identifier **is** `node.title` (`peer-graph.ts` `resolvePeers`), but nothing enforces title distinctness — the only dedup is a transient `" (2)"` suffix applied at message-resolution time, so the shown title and the addressable name can silently diverge.

## Decisions made during brainstorming

- **Naming scheme:** friendly names from a curated pool (mythology / constellations — Hermes, Atlas, Orion, Vega, Juno…), not kind-numbered or short codes.
- **Uniqueness:** names are always distinct. Auto-assign the first unused pool name at creation; auto-suffix a colliding rename (`Alice` → `Alice 2`).
- **Scope:** every node kind gets a name badge at the top.
- **Reuse `title`** as the name (not a separate `name`/`handle` field) — the shown name _is_ the peer identifier; no second field to keep in sync.
- **Migration:** on canvas load, only nodes whose title is still a bare generic kind label (or empty) are given a distinct friendly name; **user-customized titles are never touched**.
- **Kind still conveyed by the header icon** — the friendly name is the prominent header text; the kind icon sits beside it (the kind label text is replaced by the name).

## Architecture

### 1. Name pool + assignment (new pure module)

`renderer/.../node-registry/node-names.ts` (pure, unit-tested):

```ts
export const NODE_NAME_POOL: readonly string[]; // ~70 curated friendly names

// First pool name not in `inUse`; if the pool is exhausted, the first "<name> N"
// (N≥2 over the pool) not in `inUse`.
export function assignNodeName(inUse: ReadonlySet<string>): string;

// Returns `desired` if free; otherwise `desired` + " N" (smallest N≥2) not in `inUse`.
// Comparison is case-insensitive and trimmed, matching peer-graph name resolution.
export function ensureUniqueNodeName(desired: string, inUse: ReadonlySet<string>): string;
```

`inUse` is built from the current canvas nodes' titles (case-insensitive, trimmed). Both functions are deterministic given `inUse` insertion order of the pool.

### 2. Creation

`addNode` / `addAgentNode` (`Workspace.tsx`) set the new node's `title` to `assignNodeName(titlesInUse)` instead of `definition.label` / `theme.label`. The provider/kind is still shown separately (agent nodes keep the `· Claude Code` provider label; other kinds keep the kind icon).

### 3. Rename

Both edit paths run the input through `ensureUniqueNodeName(input, titlesInUseExcludingThisNode)` before writing:

- Agent inline edit — `AgentSessionNode.tsx` `commitTitleEdit`.
- Inspector Title field — `WorkspaceInspector.tsx` `onUpdateSelected({ title })`.

An empty rename falls back to `assignNodeName` (never persists an empty title).

### 4. Name badge at the top of every kind

A shared presentation so the node's name is the prominent top identifier on every kind:

- **Agent nodes:** already render `title` in the window title bar — no change beyond it now being the friendly name.
- **All other kinds:** the `CanvasNode` header renders `data.title` (the name) as its primary text, with the existing kind icon beside it, replacing the current kind-label-only header text. Collapsed and Face-based kinds included.

### 5. Migration (canvas load)

A normalization pass over loaded nodes: for each node whose `title` is empty or exactly equals its kind's generic label (`definition.label`, or the provider theme label for agents), reassign a distinct friendly name via `assignNodeName`, threading the growing in-use set so the batch stays internally distinct. Nodes with any other (user-customized) title are left unchanged. Runs once per canvas load, before render; persisted on the next autosave.

### 6. Peer identifier

Unchanged mechanism: `peer-graph.ts` keeps deriving the peer `name` from `node.title`. Because titles are now guaranteed distinct, the resolved peer name equals the shown title and the transient `" (2)"` dedup effectively never fires (it stays as a harmless safety net). No change to `resolvePeers` / `findPeerByName`.

## Data flow

New node → `assignNodeName(titlesInUse)` → `title` set → rendered in header/title bar → (if agent, connected by a context edge) `resolvePeers` reads `title` → agents see it in `list_agents` and address it in `send_message`.

## Error handling

- Empty / whitespace rename → `assignNodeName` fallback (never empty).
- Pool exhausted → numeric suffix continues past the pool.
- Migration is idempotent (a node already carrying a distinct friendly name is not a generic label, so it's skipped on subsequent loads).

## Testing

- `node-names` unit: `assignNodeName` picks first unused; skips in-use; suffixes past pool exhaustion; `ensureUniqueNodeName` returns desired when free, suffixes on collision, case-insensitive/trimmed match; empty input handling.
- Creation: `addNode`/`addAgentNode` assign a distinct name; two quick creations of the same kind get different names.
- Rename: colliding rename auto-suffixes; empty rename falls back.
- Migration: generic-label / empty titles are renamed distinctly; a user-customized title is preserved; second load is a no-op.
- Rendering: name badge shows at the top for a representative faceless kind, a Face-based kind, and an agent node; kind icon still present.
- Peer-graph: unchanged tests still pass; distinct titles resolve to equal peer names (no "(2)").

## Out of scope

- Renaming the peer-identifier mechanism or adding a separate handle field.
- A global rename/registry UI beyond the existing inline + inspector edits.
- Names for edges (only nodes).
