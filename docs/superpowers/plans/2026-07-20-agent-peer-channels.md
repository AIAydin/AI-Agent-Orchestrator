# Agent Peer Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `context` edge between two live agent session nodes a working channel: each embedded CLI gets MCP tools (`list_agents`, `send_message`, `read_screen`) to discover, read, and message its connected peers.

**Architecture:** A new main-process `AgentPeersService` runs a localhost-only HTTP hub with per-session bearer tokens minted at launch. A dependency-free stdio MCP shim (`packages/peer-mcp`), shipped via `extraResources` and run with `ELECTRON_RUN_AS_NODE`, bridges each CLI to the hub. Message delivery writes bracketed-pasted input into the peer's PTY through new trusted TerminalService hooks; `read_screen` serves an ANSI-stripped tail of the persisted terminal transcript.

**Tech Stack:** Electron main (node:http, node:crypto), zod 3.25.67, vitest 3.2.4, @testing-library/react, xyflow, pnpm workspace. **No new npm dependencies** — the shim hand-rolls newline-delimited JSON-RPC (MCP stdio) and uses Node's built-in `fetch`.

## Global Constraints

- **Dirty-tree staging protocol (MANDATORY, from project memory):** the main checkout carries a large uncommitted user WIP layer. NEVER run `git add -A`, `git add -u`, or `git add .`; never pass pathspecs to `git commit`. Before editing any EXISTING file, run `git status --porcelain -- <file>`; if it is already modified, snapshot `git diff -- <file>` to the scratchpad first, and after editing stage ONLY your own hunks: `git diff -- <file> > /tmp/hunks.patch`, delete every hunk that is not yours, then `git apply --cached /tmp/hunks.patch`. Brand-new files are staged normally with `git add <exact path>`.
- **No new runtime dependencies** anywhere in this plan.
- Env var names (exact): `FORGEBOARD_PEER_URL` and `FORGEBOARD_PEER_TOKEN`. They are injected into the PTY env **by the main process only**; the renderer never sees token values.
- Rate limit: **6 messages per 60 s per edge**. Message prefix: `[from <sender>] `. Delivery = ESC`[200~` + prefixed body + ESC`[201~` + `\r` (bracketed paste, then submit).
- `read_screen`: last **64 KiB** of transcript, ANSI-stripped, last **200 lines**.
- Copy is terse (project UX preference). All user-visible strings ≤ 1 short sentence.
- Tests: run a single file with `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit <path>` from the repo root. jsdom component tests start with `// @vitest-environment jsdom`.
- **Spec deviations of record** (rationale documented here, spec `docs/superpowers/specs/2026-07-20-agent-peer-channels-design.md` stays as approved): (1) `read_screen` reads main-side transcript files, not renderer xterm serialization — no serialize addon exists and xterm unmounts on node collapse; transcripts work always. (2) The mute toggle lives in the existing sidebar `TypedEdgeInspector` — the phase-2 edge popover does not exist yet. (3) All four providers receive the peer env via PTY environment injected in main; file-based provider configs additionally carry the values so MCP-server spawn env quirks can't break claude/gemini/opencode; codex relies on PTY inheritance (verified in Task 8).

---

### Task 1: `muted` flag on context edge config

**Files:**

- Modify: `packages/core/src/model/domain.ts:679-688` (`ContextEdgeSchema`)
- Modify: `apps/desktop/src/renderer/src/components/workspace/model/edge-config.ts:39-47` (context case of `createEdgeData`)
- Test: `apps/desktop/src/renderer/src/components/workspace/model/edge-config.test.ts` (exists — append)

**Interfaces:**

- Consumes: nothing.
- Produces: `ContextEdgeSchema` config gains `muted: z.boolean().default(false)`; renderer `WorkshopEdgeData` for `'context'` gains `muted: boolean`. Task 4 reads `edge.config.muted`; Task 2 toggles it.

- [ ] **Step 1: Write the failing tests** (append to `edge-config.test.ts`, matching its existing style):

```ts
describe('context edge muted flag', () => {
  it('defaults muted to false', () => {
    const data = createEdgeData('context', 'node-1');
    expect(data).toMatchObject({ edgeType: 'context', config: { muted: false } });
  });

  it('preserves an explicit muted value', () => {
    const data = createEdgeData('context', 'node-1', { config: { muted: true } });
    expect(data.config).toMatchObject({ muted: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit apps/desktop/src/renderer/src/components/workspace/model/edge-config.test.ts`
Expected: FAIL — `muted` missing from config.

- [ ] **Step 3: Implement.** In `domain.ts`, inside the `ContextEdgeSchema` config object (after `attachmentIds`):

```ts
      muted: z.boolean().default(false),
```

In `edge-config.ts`, the `'context'` case becomes:

```ts
    case 'context':
      return {
        edgeType,
        config: {
          attachmentMode: 'explicit',
          required: booleanValue(candidate?.['required'], true),
          muted: booleanValue(candidate?.['muted'], false),
          attachmentIds: entityIds(candidate?.['attachmentIds'], [sourceNodeId]),
        },
      };
```

The zod default makes old persisted canvases parse cleanly (`.strict()` objects still apply defaults for absent keys).

- [ ] **Step 4: Run the same test file — PASS. Also run the core package tests:** `corepack pnpm exec vitest --config config/tooling/vitest.config.ts run --project unit packages/core` — expected PASS (schema default is additive).

- [ ] **Step 5: Commit** (both files may carry user WIP — follow the Global Constraints staging protocol):

```bash
git status --porcelain -- packages/core/src/model/domain.ts apps/desktop/src/renderer/src/components/workspace/model/edge-config.ts apps/desktop/src/renderer/src/components/workspace/model/edge-config.test.ts
# stage only your hunks per protocol, then:
git commit -m "feat: add muted flag to context edge config"
```

---

### Task 2: Mute toggle in the context edge inspector

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/workspace/canvas/TypedEdgeInspector.tsx` (context form inside `EdgeConfiguration`)
- Test: `apps/desktop/src/renderer/src/components/workspace/canvas/TypedEdgeInspector.test.tsx` (exists — append)

**Interfaces:**

- Consumes: Task 1's `muted` field on context config.
- Produces: UI checkbox labeled `Muted` calling `onChange({ edgeType: 'context', config: { ...config, muted } })`. No other tasks depend on it.

- [ ] **Step 1: Write the failing test** (append; mirror the file's existing render helpers/props):

```tsx
it('toggles muted on a context edge', () => {
  const onChange = vi.fn();
  renderInspector({ edgeType: 'context', onChange }); // use the file's existing setup helper
  fireEvent.click(screen.getByLabelText('Muted'));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      edgeType: 'context',
      config: expect.objectContaining({ muted: true }),
    }),
  );
});
```

- [ ] **Step 2: Run to verify failure** (same single-file command pattern). Expected: FAIL — no `Muted` control.

- [ ] **Step 3: Implement.** In the context branch of `EdgeConfiguration`, next to the existing `required` checkbox, add (copy the exact className/markup pattern of the `required` row):

```tsx
<label>
  <input
    type="checkbox"
    checked={data.config.muted}
    disabled={readOnly}
    onChange={(event) =>
      onChange({
        edgeType: 'context',
        config: { ...data.config, muted: event.target.checked },
      })
    }
  />
  Muted
</label>
```

- [ ] **Step 4: Run test — PASS.** Also rerun the whole file to catch regressions.

- [ ] **Step 5: Commit** (staging protocol; message `feat: mute toggle on context edges`).

---

### Task 3: `packages/peer-mcp` — the stdio MCP shim

**Files:**

- Create: `packages/peer-mcp/package.json`, `packages/peer-mcp/tsconfig.json`, `packages/peer-mcp/src/protocol.ts`, `packages/peer-mcp/src/main.ts`
- Test: `packages/peer-mcp/src/protocol.test.ts`

**Interfaces:**

- Consumes: env vars `FORGEBOARD_PEER_URL`, `FORGEBOARD_PEER_TOKEN` (set by Task 7); hub HTTP wire protocol (implemented in Task 6): `GET /v1/peers` → `{ agents: [{ name, provider, live, muted }] }`; `POST /v1/message` body `{ to, message }` → `{ result: 'delivered' | 'muted' | 'rate-limited' | 'no-live-session' | 'unknown-peer' }`; `GET /v1/screen?agent=<name>` → `{ text }`. All with `Authorization: Bearer <token>`; non-2xx → `{ error: string }`.
- Produces: `dist/main.js` — a standalone script; `handleMessage(message, hub)` pure handler for tests.

- [ ] **Step 1: Scaffold the package.** Create `packages/peer-mcp/package.json` with the workspace's
      standard TypeScript builder scripts, name it `@forgeboard/peer-mcp`, use `src/main.ts` as the
      entry and `dist/main.js` as the output, and add no runtime dependencies. Verify
      `pnpm-workspace.yaml` globs `packages/*`; run `pnpm install` to register the package.

- [ ] **Step 2: Write the failing protocol tests** (`src/protocol.test.ts`):

```ts
import { describe, expect, it, vi } from 'vitest';
import { handleMessage, type HubClient } from './protocol.js';

const hub: HubClient = {
  peers: vi.fn(async () => ({
    agents: [{ name: 'Hermes', provider: 'claude', live: true, muted: false }],
  })),
  message: vi.fn(async () => ({ result: 'delivered' as const })),
  screen: vi.fn(async () => ({ text: 'hello world' })),
};

describe('peer-mcp protocol', () => {
  it('answers initialize echoing the client protocol version', async () => {
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        },
      },
      hub,
    );
    expect(reply).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'forgeboard-peer-mcp' },
      },
    });
  });

  it('lists the three tools', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, hub);
    const names = (reply as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual(['list_agents', 'send_message', 'read_screen']);
  });

  it('routes tools/call send_message to the hub and returns text content', async () => {
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'send_message', arguments: { to: 'Hermes', message: 'hi' } },
      },
      hub,
    );
    expect(hub.message).toHaveBeenCalledWith('Hermes', 'hi');
    expect(reply).toMatchObject({
      id: 3,
      result: { content: [{ type: 'text', text: expect.stringContaining('delivered') }] },
    });
  });

  it('returns isError content when the hub rejects', async () => {
    const failing: HubClient = {
      ...hub,
      screen: vi.fn(async () => {
        throw new Error('unknown peer');
      }),
    };
    const reply = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_screen', arguments: { agent: 'Nobody' } },
      },
      failing,
    );
    expect(reply).toMatchObject({ id: 4, result: { isError: true } });
  });

  it('ignores notifications (no id) and answers ping', async () => {
    expect(
      await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, hub),
    ).toBeNull();
    expect(await handleMessage({ jsonrpc: '2.0', id: 5, method: 'ping' }, hub)).toMatchObject({
      id: 5,
      result: {},
    });
  });
});
```

- [ ] **Step 3: Run to verify failure** (`... run --project unit packages/peer-mcp/src/protocol.test.ts`). Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/protocol.ts`:**

```ts
type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

export interface HubClient {
  peers(): Promise<{
    agents: { name: string; provider: string | null; live: boolean; muted: boolean }[];
  }>;
  message(to: string, message: string): Promise<{ result: string }>;
  screen(agent: string): Promise<{ text: string }>;
}

const TOOLS = [
  {
    name: 'list_agents',
    description:
      'You are one agent node on a ForgeBoard canvas. List the agents connected to you by context edges — your collaborators. Messages from them arrive in your input prefixed "[from <name>]"; reply with send_message only when a reply is needed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_message',
    description:
      'Send a message to a connected agent. It is typed directly into their terminal, so they start working on it. Never auto-starts a session.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, message: { type: 'string' } },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_screen',
    description: "Read a connected agent's current terminal text without interrupting them.",
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' } },
      required: ['agent'],
      additionalProperties: false,
    },
  },
] as const;

function text(id: number | string, body: string, isError = false) {
  return {
    jsonrpc: '2.0' as const,
    id,
    result: { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) },
  };
}

export async function handleMessage(message: JsonRpcMessage, hub: HubClient) {
  const { id, method, params } = message;
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0' as const,
        id,
        result: {
          protocolVersion: (params?.['protocolVersion'] as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'forgeboard-peer-mcp', version: '1.0.0' },
        },
      };
    case 'ping':
      return { jsonrpc: '2.0' as const, id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0' as const, id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = params?.['name'];
      const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;
      try {
        if (name === 'list_agents') {
          const { agents } = await hub.peers();
          return text(id, JSON.stringify(agents, null, 2));
        }
        if (name === 'send_message') {
          const outcome = await hub.message(
            String(args['to'] ?? ''),
            String(args['message'] ?? ''),
          );
          return text(id, outcome.result);
        }
        if (name === 'read_screen') {
          const { text: screen } = await hub.screen(String(args['agent'] ?? ''));
          return text(id, screen);
        }
        return text(id, `Unknown tool: ${String(name)}`, true);
      } catch (error) {
        return text(id, error instanceof Error ? error.message : String(error), true);
      }
    }
    default:
      return {
        jsonrpc: '2.0' as const,
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      };
  }
}
```

And `src/main.ts` (the runtime entry — line-delimited stdio loop + fetch-backed hub):

```ts
import { createInterface } from 'node:readline';
import { handleMessage, type HubClient } from './protocol.js';

const url = process.env['FORGEBOARD_PEER_URL'];
const token = process.env['FORGEBOARD_PEER_TOKEN'];
if (!url || !token) {
  process.stderr.write('forgeboard-peer-mcp: FORGEBOARD_PEER_URL/FORGEBOARD_PEER_TOKEN missing\n');
  process.exit(1);
}

async function call(path: string, init?: RequestInit): Promise<never | Record<string, unknown>> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof body['error'] === 'string' ? body['error'] : `hub error ${response.status}`,
    );
  return body;
}

const hub: HubClient = {
  peers: () => call('/v1/peers') as never,
  message: (to, message) =>
    call('/v1/message', { method: 'POST', body: JSON.stringify({ to, message }) }) as never,
  screen: (agent) => call(`/v1/screen?agent=${encodeURIComponent(agent)}`) as never,
};

// NOTE (review finding, fixed in implementation): track in-flight handler promises and
// drain them (Promise.allSettled) before exiting on stdin close — the naive exit(0) below
// drops replies to hub-bound calls still in flight.
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  void (async () => {
    let parsed: Parameters<typeof handleMessage>[0];
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const reply = await handleMessage(parsed, hub);
    if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
  })();
});
lines.on('close', () => process.exit(0));
```

- [ ] **Step 5: Run protocol tests — PASS. Build the package** (`pnpm --filter @forgeboard/peer-mcp build`) and confirm `packages/peer-mcp/dist/main.js` exists.

- [ ] **Step 6: Commit** (all new files — `git add packages/peer-mcp`; if `pnpm-lock.yaml` changed, check it for user WIP first, then stage only if clean): `feat: forgeboard-peer-mcp stdio shim package`.

---

### Task 4: Peer graph resolution (main, pure module)

**Files:**

- Create: `apps/desktop/src/main/agent-peers/peer-graph.ts`
- Test: `apps/desktop/src/main/agent-peers/peer-graph.test.ts`

**Interfaces:**

- Consumes: `CanvasNode`, `CanvasEdge` from `@forgeboard/core/domain` (agent nodes: `type === 'agent'`, fields `id`, `title`, `adapterId`; context edges: `type === 'context'`, `config.muted` from Task 1).
- Produces:

```ts
export interface PeerDescriptor {
  readonly nodeId: string;
  readonly name: string; // display title, deduped with " (2)" suffixes
  readonly provider: string | null;
  readonly edgeId: string;
  readonly muted: boolean;
}
export function resolvePeers(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  nodeId: string,
): PeerDescriptor[];
export function findPeerByName(
  peers: readonly PeerDescriptor[],
  name: string,
): PeerDescriptor | undefined; // case-insensitive
```

- [ ] **Step 1: Write the failing tests.** Build minimal node/edge literals (parse through `CanvasNodeSchema`/`CanvasEdgeSchema` to stay honest with required fields — copy fixture style from `apps/desktop/src/main/terminal/service.test.ts` for ids/timestamps). Cases: (a) agent↔agent context edge in either direction resolves as a peer; (b) context edge to a non-agent node is NOT a peer; (c) non-context edge between agents is NOT a peer; (d) no multi-hop (A—B—C: A's peers exclude C); (e) two peers with the same title come back as `Claude Code` and `Claude Code (2)`; (f) `muted` is carried from edge config; (g) `findPeerByName` matches case-insensitively.

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement:**

```ts
import type { CanvasEdge, CanvasNode } from '@forgeboard/core/domain';

export interface PeerDescriptor {
  readonly nodeId: string;
  readonly name: string;
  readonly provider: string | null;
  readonly edgeId: string;
  readonly muted: boolean;
}

export function resolvePeers(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  nodeId: string,
): PeerDescriptor[] {
  const agents = new Map(
    nodes.filter((node) => node.type === 'agent').map((node) => [node.id, node]),
  );
  if (!agents.has(nodeId)) return [];
  const seen = new Map<string, number>();
  const peers: PeerDescriptor[] = [];
  for (const edge of edges) {
    if (edge.type !== 'context') continue;
    const otherId =
      edge.sourceNodeId === nodeId
        ? edge.targetNodeId
        : edge.targetNodeId === nodeId
          ? edge.sourceNodeId
          : null;
    if (otherId === null) continue;
    const other = agents.get(otherId);
    if (other === undefined || peers.some((peer) => peer.nodeId === otherId)) continue;
    const base = other.title.trim() === '' ? 'Agent' : other.title.trim();
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    peers.push({
      nodeId: otherId,
      name: count === 1 ? base : `${base} (${count})`,
      provider:
        'adapterId' in other && typeof other.adapterId === 'string' ? other.adapterId : null,
      edgeId: edge.id,
      muted: edge.config.muted,
    });
  }
  return peers;
}

export function findPeerByName(
  peers: readonly PeerDescriptor[],
  name: string,
): PeerDescriptor | undefined {
  const wanted = name.trim().toLowerCase();
  return peers.find((peer) => peer.name.toLowerCase() === wanted);
}
```

(If the agent node schema stores `adapterId` differently, mirror the real field — check `AgentNodeSchema` at `packages/core/src/model/domain.ts:153` while writing the fixtures.)

- [ ] **Step 4: Run tests — PASS.**

- [ ] **Step 5: Commit** new files: `feat: peer graph resolution for agent peer channels`.

---

### Task 5: TerminalService peer hooks (find, deliver, transcript tail)

**Files:**

- Create: `apps/desktop/src/main/agent-peers/text.ts` (+ `text.test.ts`) — ANSI strip + delivery formatting
- Modify: `apps/desktop/src/main/terminal/service.ts`
- Test: `apps/desktop/src/main/terminal/service.test.ts` (exists — append; reuse its `fixture()` with fake ptyFactory)

**Interfaces:**

- Consumes: `ActiveTerminal` internals (`#active`, `view.projectId/nodeId/status`, `handle.write`), transcript replay (`this.#transcripts.replay`), `#safeAudit`.
- Produces (used by Task 6):

```ts
// agent-peers/text.ts
export function stripAnsi(raw: string): string;
export function formatPeerDelivery(sender: string, message: string): string; // "\x1b[200~[from <sender>] <message>\x1b[201~\r"
export function transcriptTailText(raw: string, maxLines?: number): string; // strip + last 200 lines

// terminal/service.ts — public, trusted (no ownerId; callers are main-side only)
public findActiveSessionByNode(projectId: string, nodeId: string): { sessionId: string } | null;
public async deliverPeerInput(sessionId: string, sender: string, message: string): Promise<'delivered' | 'no-live-session'>;
public async readTranscriptTail(sessionId: string, maxBytes: number): Promise<string | null>;
```

- [ ] **Step 1: Write failing tests for `text.ts`:** `stripAnsi` removes CSI (`\x1b[31m`), OSC (`\x1b]0;title\x07`), and lone controls but keeps `\n`; `formatPeerDelivery('Hermes', 'hi')` equals `'\x1b[200~[from Hermes] hi\x1b[201~\r'`; `transcriptTailText` returns only the last 200 lines.

- [ ] **Step 2: Run — FAIL. Implement `text.ts`:**

```ts
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/gu;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/gu;

export function stripAnsi(raw: string): string {
  return raw.replace(OSC, '').replace(CSI, '').replace(CONTROLS, '');
}

export function formatPeerDelivery(sender: string, message: string): string {
  return `\x1b[200~[from ${sender}] ${message}\x1b[201~\r`;
}

export function transcriptTailText(raw: string, maxLines = 200): string {
  const lines = stripAnsi(raw).split('\n');
  return lines
    .slice(Math.max(0, lines.length - maxLines))
    .join('\n')
    .trimEnd();
}
```

Run — PASS.

- [ ] **Step 3: Write failing service tests** (append to `service.test.ts`): launch a session via the fixture, then
  - `findActiveSessionByNode(projectId, nodeId)` returns its sessionId; wrong node/project → `null`; after terminate → `null`.
  - `deliverPeerInput(sessionId, 'Hermes', 'hi')` writes `formatPeerDelivery('Hermes', 'hi')` to the fake pty handle and returns `'delivered'`; unknown session → `'no-live-session'`; asserts an `input` audit entry with `metadata.source: 'agent-peer'`.
  - `readTranscriptTail` returns stripped text from the fake transcript store; unknown session → `null`.

- [ ] **Step 4: Run — FAIL. Implement in `service.ts`** (near `sendInput`, `service.ts:401`; import the two helpers from `../agent-peers/text.js`):

```ts
public findActiveSessionByNode(projectId: string, nodeId: string): { sessionId: string } | null {
  for (const [sessionId, active] of this.#active) {
    if (
      active.view.projectId === projectId &&
      active.view.nodeId === nodeId &&
      active.view.status === 'running'
    ) {
      return { sessionId };
    }
  }
  return null;
}

public async deliverPeerInput(
  sessionId: string,
  sender: string,
  message: string,
): Promise<'delivered' | 'no-live-session'> {
  const active = this.#active.get(sessionId);
  if (active === undefined || active.view.status !== 'running' || active.handle === null) {
    return 'no-live-session';
  }
  active.handle.write(formatPeerDelivery(sender, message));
  this.#safeAudit('input', 'allowed', { sessionId, source: 'agent-peer', sender });
  return 'delivered';
}

public async readTranscriptTail(sessionId: string, maxBytes: number): Promise<string | null> {
  // Reuse the replay path: page from the end. Mirror how replay() calls this.#transcripts,
  // requesting the final window (see replay() at service.ts:341) and concatenate chunk data
  // up to maxBytes from the tail, then:
  //   return transcriptTailText(concatenated);
  // Return null when the session/transcript is unknown.
}
```

For `readTranscriptTail`, follow `replay()`'s exact call shape into `this.#transcripts` (read it at `service.ts:341-360` while implementing) — request the last window(s) up to `maxBytes` and return `transcriptTailText(joined)`. Respect the same size math replay uses; do not add new transcript APIs unless the tail window is impossible with `replay`'s parameters, in which case add a `tail(sessionId, maxBytes)` method to `TerminalTranscriptFiles` (`apps/desktop/src/main/storage/terminal/transcript-files.ts`) with its own unit test.

- [ ] **Step 5: Run service tests — PASS.** Rerun the full existing `service.test.ts` to catch regressions.

- [ ] **Step 6: Commit** (service.ts likely carries user WIP — staging protocol): `feat: terminal peer hooks for agent peer channels`.

---

### Task 6: AgentPeersService — provisions, hub server, tool endpoints

**Files:**

- Create: `apps/desktop/src/main/agent-peers/service.ts`
- Test: `apps/desktop/src/main/agent-peers/service.test.ts`

**Interfaces:**

- Consumes: `resolvePeers`/`findPeerByName` (Task 4), the three TerminalService hooks (Task 5) via a narrow bridge interface, `store.loadCanvas(projectId)` + `store.appendAudit` (`apps/desktop/src/main/storage.ts:548,704`).
- Produces (used by Tasks 7, 9, 10):

```ts
export interface AgentPeersTerminalBridge {
  findActiveSessionByNode(projectId: string, nodeId: string): { sessionId: string } | null;
  deliverPeerInput(
    sessionId: string,
    sender: string,
    message: string,
  ): Promise<'delivered' | 'no-live-session'>;
  readTranscriptTail(sessionId: string, maxBytes: number): Promise<string | null>;
}
export interface AgentPeersStore {
  loadCanvas(projectId: string): { nodes: CanvasNode[]; edges: CanvasEdge[] } | null;
  appendAudit(
    category: string,
    action: string,
    outcome: 'allowed' | 'denied' | 'failed',
    metadata: Record<string, unknown>,
  ): void;
}
export interface PeerProvision {
  readonly provisionId: string; // uuid
  readonly url: string; // http://127.0.0.1:<port>
}
export class AgentPeersService {
  constructor(store: AgentPeersStore, bridge: AgentPeersTerminalBridge);
  async provision(projectId: string, nodeId: string): Promise<PeerProvision>; // starts hub lazily, mints token
  environmentForProvision(provisionId: string): Record<string, string> | null; // { FORGEBOARD_PEER_URL, FORGEBOARD_PEER_TOKEN } — single consumer: TerminalService at spawn
  bindSession(provisionId: string, sessionId: string): void;
  releaseSession(sessionId: string): void; // also runs any registered cleanup
  registerCleanup(provisionId: string, cleanup: () => Promise<void>): void; // Task 9 registers provider-config cleanup here
  onMessageDelivered(listener: (event: { projectId: string; edgeId: string }) => void): () => void;
  // lifecycle contract (ipc.ts wiring):
  pauseForShutdown(): Promise<void>;
  pauseForDataMutation(): Promise<void>;
  resetForPrivacy(): Promise<void>;
  resumeAfterPrivacyReset(): void;
  async dispose(): Promise<void>;
}
```

Wire protocol produced (consumed by Task 3's shim): exactly the endpoints listed in Task 3's Interfaces block. `send_message` results: `delivered`, `muted`, `rate-limited`, `no-live-session`, `unknown-peer`.

- [ ] **Step 1: Write the failing tests.** Use a fake store (in-memory canvas: two agent nodes + one context edge from Task 4's fixture style) and a fake bridge. Drive the hub over real HTTP (`await service.provision(...)` then `fetch` against `provision.url` with the token — read the token in tests via `environmentForProvision`). Cases:
  - `provision` returns a URL; hub answers only with a valid Bearer token (missing/wrong → 401 `{ error }`).
  - `GET /v1/peers` → the connected agent with `live` reflecting `findActiveSessionByNode`.
  - `POST /v1/message` happy path → bridge `deliverPeerInput` called with the CALLER's node title as sender; response `{ result: 'delivered' }`; `onMessageDelivered` fired with the edge id; audit `('agent-peers','message','allowed',…)`.
  - Muted edge → `{ result: 'muted' }`, bridge NOT called, audit `denied`.
  - 7th message inside 60 s on one edge → `{ result: 'rate-limited' }` (use `vi.useFakeTimers()` or inject a `now()` clock — inject the clock; `Date.now` is fine in main code but tests inject).
  - Peer without live session → `{ result: 'no-live-session' }`.
  - Unknown name → `{ result: 'unknown-peer' }`.
  - `GET /v1/screen?agent=…` → `{ text }` from `readTranscriptTail`; peer not found → 404 `{ error }`.
  - Message body > 60_000 bytes → 413 `{ error }` (keep under the 64 KiB terminal input cap after prefix+wrapping).
  - `releaseSession` invalidates the token (subsequent calls 401).

- [ ] **Step 2: Run — FAIL. Implement `service.ts`.** Core shape:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { findPeerByName, resolvePeers } from './peer-graph.js';

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_MESSAGE_BYTES = 60_000;
const SCREEN_TAIL_BYTES = 64 * 1024;

interface ProvisionRecord {
  readonly provisionId: string;
  readonly token: string;
  readonly projectId: string;
  readonly nodeId: string;
  sessionId: string | null;
  readonly createdAt: number;
}
```

- Provisions kept in two maps (`byId`, `byToken`); unbound provisions expire after 5 minutes (checked lazily on use).
- `#ensureListening()` — lazily `createServer(this.#handle).listen(0, '127.0.0.1')`, resolve the port from `server.address()`.
- `#handle(request, response)` — parse Bearer token → provision (else 401); route `GET /v1/peers`, `POST /v1/message` (read body ≤ `MAX_MESSAGE_BYTES`, else 413), `GET /v1/screen`; always JSON responses.
- Peer view per request: `const canvas = this.store.loadCanvas(provision.projectId)`; `resolvePeers(canvas.nodes, canvas.edges, provision.nodeId)`; caller's own display name = its node title (resolve from `canvas.nodes`).
- `message` flow: find peer by name → muted? → rate limiter (`Map<edgeId, number[]>` sliding window using injected `now`) → `bridge.findActiveSessionByNode(projectId, peer.nodeId)` → `bridge.deliverPeerInput(sessionId, callerName, message)` → emit `onMessageDelivered({ projectId, edgeId })` → audit. Every branch audits (`allowed` for delivered, `denied` with a `reason` for the rest).
- `screen` flow: peer by name → live session → `bridge.readTranscriptTail(sessionId, SCREEN_TAIL_BYTES)` → `{ text }` (empty transcript → `{ text: '' }`).
- Lifecycle: `pauseForShutdown`/`pauseForDataMutation`/`resetForPrivacy` = run all registered cleanups best-effort (`Promise.allSettled`, mirroring `releaseSession`), then close server + clear provisions; `resumeAfterPrivacyReset` = no-op (hub restarts lazily); `dispose` = run cleanups + close server, clear listeners. (Cleanups delete on-disk provider config carrying peer tokens — dropping them on `resetForPrivacy` would leak exactly what that path scrubs; review finding, fixed.)
- Tokens: `randomBytes(32).toString('hex')`.

- [ ] **Step 3: Run the new tests — PASS.**

- [ ] **Step 4: Commit** new files: `feat: agent peers hub service`.

---

### Task 7: Peer env injection at terminal launch

**Files:**

- Modify: `apps/desktop/src/shared/terminal/launch.ts:47` (`TerminalPrepareLaunchInputSchema` + plan view type if it mirrors fields)
- Modify: `apps/desktop/src/main/terminal/service.ts` (plan storage, `#launch`, exit finalization)
- Modify: `apps/desktop/src/main/terminal/pty-process.ts:93` (env spread)
- Modify: `apps/desktop/src/main/terminal/ipc.ts` (pass-through of the new field)
- Test: `apps/desktop/src/main/terminal/service.test.ts` (append)

**Interfaces:**

- Consumes: `AgentPeersService.environmentForProvision` / `bindSession` / `releaseSession` (Task 6).
- Produces:
  - `TerminalPrepareLaunchInputSchema` gains `peerProvisionId: z.string().uuid().optional()`.
  - `TerminalService` gains `setPeerEnvironmentProvider(provider)` with

```ts
export interface PeerEnvironmentProvider {
  environmentForProvision(provisionId: string): Record<string, string> | null;
  bindSession(provisionId: string, sessionId: string): void;
  releaseSession(sessionId: string): void;
}
```

- `ResolvedTerminalLaunch` gains `peerEnvironment?: Record<string, string>`; pty env becomes `{ ...baseTerminalEnvironment(), ...launch.environment, ...launch.peerEnvironment }`.

- [ ] **Step 1: Write failing service tests:** (a) prepare with `peerProvisionId` + a fake provider → the fake ptyFactory receives env containing `FORGEBOARD_PEER_URL`/`FORGEBOARD_PEER_TOKEN`, and `bindSession` was called with the launched sessionId; (b) session exit → `releaseSession(sessionId)`; (c) unknown provisionId → prepare fails with a clear error (`Peer session expired. Start again.`); (d) no `peerProvisionId` → env unchanged, provider untouched; (e) the native-review env name list (`TerminalLaunchNativeReview.exact.environmentVariableNames`) includes the two peer names when a provision is attached (transparency in the launch review).

- [ ] **Step 2: Run — FAIL. Implement:**
  - `launch.ts`: add the optional field to the strict schema.
  - `service.ts`: store `peerProvisionId` on `PendingLaunch`; in `#launch` (service.ts:589), before spawn: `const peerEnvironment = provisionId ? this.#peerProvider?.environmentForProvision(provisionId) : undefined;` — `null` → throw the clear error; attach to the resolved launch; after the session view exists, `this.#peerProvider?.bindSession(provisionId, sessionId)`. In the exit/finalize path (where `finalStatus` is set), call `this.#peerProvider?.releaseSession(sessionId)`. Add the two env NAMES into the exact-review name list when attached.
  - `pty-process.ts`: extend the spawn env spread with `...launch.peerEnvironment`.
  - `terminal/ipc.ts`: the prepare handler already zod-parses the shared schema — confirm the parsed field flows into the service input (add the field to any intermediate pick/map).

- [ ] **Step 3: Run — PASS** (plus the whole `service.test.ts` file).

- [ ] **Step 4: Commit** (all four modified files may carry WIP — staging protocol): `feat: inject peer env into agent session launches`.

---

### Task 8: Provider config artifacts + shim packaging

**Files:**

- Create: `apps/desktop/src/main/agent-peers/provider-config.ts` (+ `provider-config.test.ts`)
- Modify: `apps/desktop/package.json` (`build.extraResources` peer helper entry)
- Test: `provider-config.test.ts`

**Interfaces:**

- Consumes: provision env values (main-side), `process.resourcesPath`/dev dist path resolution (pattern: `apps/desktop/src/main/ipc.ts:290-292`), `process.execPath` + `ELECTRON_RUN_AS_NODE` spawn pattern (`apps/desktop/src/main/agent-execution/adapter-planner.ts:112-118`).
- Produces (used by Task 9's provision IPC):

```ts
export interface ProviderPeerMaterial {
  readonly available: boolean;
  readonly hint: string | null; // terse, e.g. "Peer tools unavailable for this agent."
  readonly extraArguments: readonly string[]; // appended to the CLI argv by the renderer
  readonly cleanup: () => Promise<void>; // undo any file writes
}
export function shimEntryPath(): string; // packaged: join(process.resourcesPath,'peer-mcp','main.js'); dev: packages/peer-mcp/dist/main.js
export async function writeProviderPeerMaterial(input: {
  adapterId: string;
  provisionDir: string; // per-provision scratch dir under app.getPath('userData')/agent-peers/<provisionId>
  projectRoot: string; // for gemini/opencode project-scoped config
  environment: Record<string, string>; // FORGEBOARD_PEER_URL/TOKEN — written ONLY into 0600 files, never argv
}): Promise<ProviderPeerMaterial>;
```

- [ ] **Step 1: Write failing tests** (temp dirs via `fs.mkdtemp`):
  - **claude:** writes `<provisionDir>/mcp.json` (mode `0o600`) containing `{"mcpServers":{"forgeboard":{"command":process.execPath,"args":[shimEntryPath()],"env":{"ELECTRON_RUN_AS_NODE":"1",...environment}}}}`; `extraArguments` = `['--mcp-config', <that path>]`.
  - **codex:** `extraArguments` = `['-c', 'mcp_servers.forgeboard.command=<execPath>', '-c', 'mcp_servers.forgeboard.args=["<shim>"]', '-c', 'mcp_servers.forgeboard.env={"ELECTRON_RUN_AS_NODE"="1"}']` — and asserts the token/url do NOT appear in any argument (argv is world-readable; codex gets them via PTY env inheritance).
  - **gemini:** merges `mcpServers.forgeboard` (same command/args/env shape) into `<projectRoot>/.gemini/settings.json`, preserving unrelated existing keys; `cleanup()` removes only our entry and deletes the file if we created it and it is otherwise empty.
  - **opencode:** same merge behavior into `<projectRoot>/opencode.json` under the `mcp` key (`{"type":"local","command":[execPath, shim],"environment":{...}}`).
  - **unknown adapter:** `available: false` with hint, no writes.

- [ ] **Step 2: Run — FAIL. Implement** with `node:fs/promises` (`readFile`/`writeFile` with `{ mode: 0o600 }`, JSON merge helpers that tolerate a missing/invalid existing file by treating it as `{}` but NEVER dropping unrelated keys). Every write is recorded so `cleanup` restores the prior content (keep the original text in memory; on cleanup, if we created the file → delete after removing our entry leaves it empty, else write back the merge-removal).

- [ ] **Step 3: Run — PASS.**

- [ ] **Step 4: Packaging.** In `apps/desktop/package.json` `build.extraResources`, add:

```json
{
  "from": "../../packages/peer-mcp/dist",
  "to": "peer-mcp",
  "filter": ["main.js", "main.js.map"]
}
```

Ensure the desktop prebuild produces `packages/peer-mcp/dist` before packaging and verify the
resource entry directly in `apps/desktop/package.json`.

- [ ] **Step 5: Verification against installed CLIs** (this validates the spec's deferred flags; record results in the commit message):

```bash
claude --help | grep -A2 mcp-config
codex --help | grep -E '^\s*-c'
gemini --help | head -40   # confirm it reads .gemini/settings.json (docs) — no flag needed
opencode --help | head -40 # confirm opencode.json mcp support
```

If a flag differs from the plan (e.g. claude's `--mcp-config` syntax changed), adjust the material builder + tests to the real syntax before committing. For codex, also verify MCP servers inherit the parent env (spawn a trivial `env`-dumping MCP server manually if unsure); if codex does NOT inherit, switch codex to a `0600` TOML file approach via `--config-file`-style flag if available, else mark codex `available: false` with hint `Peer tools unavailable for Codex sessions.`

- [ ] **Step 6: Commit** (package.json carries WIP risk — staging protocol): `feat: per-provider MCP config material for peer channels`.

---

### Task 9: IPC channels, preload bridge, main wiring, delivery events

**Files:**

- Create: `apps/desktop/src/shared/agent-peers/index.ts` (channels + zod schemas)
- Create: `apps/desktop/src/main/agent-peers/ipc.ts` (`AgentPeersIpcService`) (+ `ipc.test.ts` following `terminal/ipc.security.test.ts` patterns where practical)
- Modify: `apps/desktop/src/main/ipc.ts` (construct, register, lifecycle lists, `ApplicationServices`)
- Modify: `apps/desktop/src/preload/index.ts` (expose `agentPeers` API)

**Interfaces:**

- Consumes: `AgentPeersService` (Task 6), `writeProviderPeerMaterial` (Task 8), TerminalService bridge methods (Task 5), the IPC helper patterns in `main/ipc.ts:1143-1201` and preload `invokeValidated` (`preload/index.ts:101`), the main→renderer event pattern (`terminal/ipc.ts:292`).
- Produces:

```ts
// shared/agent-peers/index.ts
export const AGENT_PEERS_IPC_CHANNELS = Object.freeze({
  provision: 'agent-peers:provision',
  event: 'agent-peers:event',
});
export const AgentPeersProvisionInputSchema = z
  .object({
    projectId: z.string().uuid(),
    nodeId: EntityIdSchema,
    adapterId: z.string().min(1).max(100),
  })
  .strict();
export const AgentPeersProvisionViewSchema = z
  .object({
    provisionId: z.string().uuid(),
    available: z.boolean(),
    hint: z.string().nullable(),
    extraArguments: z.array(z.string()).max(64),
  })
  .strict();
export const AgentPeersEventSchema = z
  .object({
    projectId: z.string().uuid(),
    edgeId: EntityIdSchema,
  })
  .strict();
```

- Renderer API: `window.forgeboard.agentPeers.provision(input): Promise<AgentPeersProvisionView>` and `window.forgeboard.agentPeers.onEvent(cb): () => void`.

- [ ] **Step 1: Write failing tests** for the IpcService handler logic (instantiate with fake AgentPeersService/material writer): provision resolves project root (same lookup terminal launches use — follow how `terminal/ipc.ts` resolves the project path), calls `service.provision`, then `writeProviderPeerMaterial` with the provision env, registers the material's `cleanup` via `service.registerCleanup(provisionId, cleanup)`, and returns `{ provisionId, available, hint, extraArguments }`; delivery events fan out to registered webContents as `AGENT_PEERS_IPC_CHANNELS.event` payloads.

- [ ] **Step 2: Run — FAIL. Implement `AgentPeersIpcService`** mirroring `TerminalIpcService`'s shape (constructor takes the service + collaborators; `registerIpcHandlers()` registers the `provision` channel with the standard authority/zod/IpcResult pipeline; owner tracking per WebContents with cleanup on `destroyed`; subscribes `service.onMessageDelivered` and broadcasts to owners).

- [ ] **Step 3: Wire in `main/ipc.ts`** (follow the terminal pattern at ipc.ts:281-289 and every list in the explorer report):
  - Construct after the terminal service: `const agentPeers = new AgentPeersService(store, terminalService)` — the inner `TerminalService` instance must be extracted to a local (`const terminalCore = new TerminalService(...)`) so both `TerminalIpcService` and `AgentPeersService` share it; then `terminalCore.setPeerEnvironmentProvider(agentPeers)`.
  - Add `agentPeers: AgentPeersIpcService` to `ApplicationServices` (ipc.ts:201), call `agentPeers.registerIpcHandlers()` (~:1037), return it (~:1059).
  - Append to EVERY lifecycle list: `resumeDataServices` (:481), `pauseForShutdown` operations (:513), `pauseForDataImport` (:542/:557), privacy-delete reset (:998), `dispose` (:1118).

- [ ] **Step 4: Preload.** Add `createAgentPeersApi` next to `createTerminalApi` (preload/index.ts:94): `provision` via `invokeValidated` with the two schemas; `onEvent` via `ipcRenderer.on(AGENT_PEERS_IPC_CHANNELS.event, …)` validating with `AgentPeersEventSchema`, returning an unsubscribe. Extend the `ForgeboardApi` type accordingly.

- [ ] **Step 5: Run new tests — PASS. Typecheck the app** (`pnpm --filter desktop typecheck` if the script exists — check `apps/desktop/package.json` scripts; otherwise `pnpm typecheck` at root).

- [ ] **Step 6: Commit** (ipc.ts and preload/index.ts almost certainly carry WIP — staging protocol): `feat: agent peers IPC, preload bridge, and service wiring`.

---

### Task 10: Renderer — provision in the agent session launch flow

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/launch-config.ts`
- Modify: `apps/desktop/src/renderer/src/components/workspace/terminal/useTerminalNodeController.ts` (options + prepare input)
- Modify: `apps/desktop/src/renderer/src/components/workspace/terminal/types.ts` (`TerminalNodeConfiguration`)
- Modify: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/AgentSessionNode.tsx`
- Test: `apps/desktop/src/renderer/src/components/workspace/runs/agent-session/launch-config.test.ts`, `AgentSessionNode.test.tsx` (both exist — append)

**Interfaces:**

- Consumes: `window.forgeboard.agentPeers.provision` (Task 9), `peerProvisionId` in `TerminalPrepareLaunchInputSchema` (Task 7).
- Produces: `TerminalNodeConfiguration` gains `readonly peerProvisionId?: string`; `agentSessionLaunch` gains a 4th parameter `peers: { provisionId: string; extraArguments: readonly string[] } | null` and appends `extraArguments` to argv; `AgentSessionNode` calls provision before `prepareLaunch()` and shows the hint chip when `available === false`.

- [ ] **Step 1: Write failing `launch-config` tests:** with a peers argument, the returned configuration appends the extra arguments after the provider flags and sets `peerProvisionId`; with `null`, argv and fields are unchanged.

- [ ] **Step 2: Run — FAIL. Implement** in `launch-config.ts` (spread `...peers.extraArguments` into `args` at the end; add `peerProvisionId: peers?.provisionId`) and `types.ts`. In `useTerminalNodeController.prepareLaunch()`, include `...(configuration.peerProvisionId ? { peerProvisionId: configuration.peerProvisionId } : {})` in the parsed prepare input.

- [ ] **Step 3: Write failing `AgentSessionNode` tests** (mock `window.forgeboard.agentPeers`): (a) clicking Start calls `provision({ projectId, nodeId, adapterId })` before `prepareLaunch`, and the controller receives a configuration containing the provision's `extraArguments`; (b) provision resolving `{ available: false, hint }` still starts the session and renders the hint text (terse chip in the bottom control strip, e.g. `Peer tools unavailable.`); (c) provision rejecting (IPC failure) does not block the session — same fallback hint.

- [ ] **Step 4: Run — FAIL. Implement in `AgentSessionNode.tsx`:** in the Start handler, `await window.forgeboard.agentPeers.provision(...)` (guarded try/catch → `null`), stash the result in state, build `agentSessionLaunch(agent, model, profile, peerMaterial)`, then the existing `prepareLaunch()` path (auto-confirm effect untouched). Render the hint chip when the stashed result says unavailable. A provision is single-use: clear the stashed provision when the session exits so Restart provisions fresh.

- [ ] **Step 5: Run both test files — PASS.**

- [ ] **Step 6: Commit** (all four files carry WIP risk — staging protocol): `feat: provision peer tools when starting agent sessions`.

---

### Task 11: Edge pulse on message transit

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/workspace/shell/Workspace.tsx` (subscribe + transient class)
- Modify: the stylesheet defining `.workflow-edge-runtime` styles (locate: `grep -rn "workflow-edge-runtime" apps/desktop/src/renderer --include=*.css`)
- Test: `apps/desktop/src/renderer/src/components/workspace/shell/Workspace.test.tsx` if it exists (check; otherwise a focused hook test — create `apps/desktop/src/renderer/src/components/workspace/canvas/usePeerTransitPulse.ts` + `.test.ts` and keep Workspace's diff minimal)

**Interfaces:**

- Consumes: `window.forgeboard.agentPeers.onEvent` (Task 9); edge `className` passthrough (`Workspace.tsx:1193`).
- Produces: hook

```ts
export function usePeerTransitPulse(
  subscribe: (cb: (event: { edgeId: string }) => void) => () => void,
  durationMs?: number,
): ReadonlySet<string>; // edge ids currently pulsing
```

- [ ] **Step 1: Write the failing hook test** (`// @vitest-environment jsdom`, `renderHook` from `@testing-library/react`): emitting an event adds the edge id to the set; after `durationMs` (fake timers) it is removed; unsubscribes on unmount.

- [ ] **Step 2: Run — FAIL. Implement the hook** (`useState<Set<string>>`, `useEffect` subscribing once, `setTimeout` per event with cleanup; default duration 1600 ms).

- [ ] **Step 3: Wire into `Workspace.tsx`:** `const pulsingEdges = usePeerTransitPulse((cb) => window.forgeboard.agentPeers.onEvent((event) => { if (event.projectId === project.id) cb(event); }));` and in the edge-mapping at `Workspace.tsx:1193` append `peer-transit` to `edge.className` when `pulsingEdges.has(edge.id)`.

- [ ] **Step 4: CSS** (in the located stylesheet):

```css
.react-flow__edge.peer-transit .react-flow__edge-path {
  animation: peer-transit-pulse 0.8s ease-in-out 2;
}
@keyframes peer-transit-pulse {
  50% {
    stroke-width: 3.5;
    opacity: 1;
  }
}
```

- [ ] **Step 5: Run hook test — PASS. Typecheck.**

- [ ] **Step 6: Commit** (Workspace.tsx carries WIP — staging protocol): `feat: pulse context edges on peer message transit`.

---

### Task 12: End-to-end smoke + wrap-up

**Files:**

- Modify: `docs/superpowers/specs/2026-07-20-agent-peer-channels-design.md` (append a short "Implementation deviations of record" block mirroring Global Constraints deviations 1-3)

- [ ] **Step 1: Full test + typecheck sweep:** `pnpm test:unit` and the repo typecheck script — all green.

- [ ] **Step 2: Manual smoke (dev app):** launch the app (`pnpm dev` per repo scripts), create two claude agent nodes connected by a context edge, Start both sessions, and in one type: _"Use list_agents, then send_message asking the other agent to reply with the word pong."_ Verify: (a) tools appear (`/mcp` in the claude session shows `forgeboard`); (b) the message lands typed into the peer terminal with the `[from …]` prefix; (c) the edge pulses; (d) the peer's reply arrives back; (e) muting the edge in the inspector makes the next send return `muted`; (f) 7 rapid messages → `rate-limited`.

- [ ] **Step 3: Append the deviations block to the spec**, commit spec + any smoke fixes (staging protocol): `docs: record agent peer channels implementation deviations`.

- [ ] **Step 4: Verify clean history:** `git log --oneline -14` shows one commit per task; `git status` shows the user's WIP layer untouched (same dirty set as before Task 1).
