import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { app } from 'electron';

/**
 * Output of `writeProviderPeerMaterial`. Consumed by the provision IPC (Task 9): `extraArguments`
 * is appended to the CLI argv the renderer builds; `cleanup` is registered with the peer-hub so
 * every on-disk artifact this module wrote is undone when the session/provision tears down (see
 * `AgentPeersService.registerCleanup`/`releaseSession`).
 */
export interface ProviderPeerMaterial {
  readonly available: boolean;
  readonly hint: string | null;
  readonly extraArguments: readonly string[];
  readonly cleanup: () => Promise<void>;
}

export interface WriteProviderPeerMaterialInput {
  readonly adapterId: string;
  /** Per-provision scratch dir under `app.getPath('userData')/agent-peers/<provisionId>`. */
  readonly provisionDir: string;
  /** Project root -- gemini/opencode merge their MCP config into a file inside this tree. */
  readonly projectRoot: string;
  /** FORGEBOARD_PEER_URL/TOKEN. Written only into 0600 files the caller cannot commit by
   * accident (provisionDir, or -- for codex -- CODEX_HOME); never into argv, never into a
   * project-root file. */
  readonly environment: Record<string, string>;
}

const NO_HINT_UNAVAILABLE = 'Peer tools unavailable for this agent.';

/** `basename(provisionDir)` -- everything after the final `/` -- flows verbatim into a filename
 * (codex's `<provisionId>.config.toml`) and, for gemini/opencode, into a JSON object key. A
 * plain safe token only; nothing that could act as a path segment (`..`, embedded separators) or
 * otherwise corrupt a filename/key. */
const PROVISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALID_PROVISION_ID_HINT =
  'Peer tools unavailable: provision directory name is not a safe token.';

/** Validates the provision id before it is used in a filename or JSON key. Returns `null` --
 * rather than sanitizing -- so a path-hostile value is rejected outright instead of silently
 * mutated into something that merely looks safe. */
function resolveProvisionId(provisionDir: string): string | null {
  const id = basename(provisionDir);
  return PROVISION_ID_PATTERN.test(id) ? id : null;
}

function unavailableMaterial(hint: string): ProviderPeerMaterial {
  return {
    available: false,
    hint,
    extraArguments: [],
    cleanup: async () => {
      // Nothing was ever written.
    },
  };
}

/**
 * Resolves the `forgeboard-peer-mcp` shim's entry point. Packaged: the extraResources copy
 * (`build.extraResources` in apps/desktop/package.json) lands at
 * `process.resourcesPath/peer-mcp/main.js`. Dev: resolved relative to `process.cwd()`, which is
 * `apps/desktop` for every way this app is actually launched in dev (`pnpm dev`, `pnpm build` --
 * see their `predev`/`prebuild` scripts), mirroring the identical pattern already used for
 * test-agent's cli.js (apps/desktop/src/main/ipc.ts:290-292). A bundled build collapses the
 * main-process source tree, so this intentionally does NOT use `import.meta.url`-relative
 * resolution -- `process.cwd()` is the stable anchor here, not the module's own location.
 */
export function shimEntryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'peer-mcp', 'main.js')
    : resolve(process.cwd(), '../../packages/peer-mcp/dist/main.js');
}

export async function writeProviderPeerMaterial(
  input: WriteProviderPeerMaterialInput,
): Promise<ProviderPeerMaterial> {
  switch (input.adapterId) {
    case 'claude':
      return await writeClaudeMaterial(input);
    case 'codex':
      return await writeCodexMaterial(input);
    case 'gemini':
      return await writeGeminiMaterial(input);
    case 'opencode':
      return await writeOpencodeMaterial(input);
    default:
      return unavailableMaterial(NO_HINT_UNAVAILABLE);
  }
}

// ---------------------------------------------------------------------------------------
// claude -- --mcp-config <path to a JSON file written into the per-provision scratch dir>
// ---------------------------------------------------------------------------------------

/**
 * Verified against installed Claude Code 2.1.216: `claude --help` lists
 * `--mcp-config <configs...>  Load MCP servers from JSON files or strings (space-separated)`.
 * The scratch dir lives under `app.getPath('userData')`, never the project repo, so writing the
 * live token into this file (at 0600) is the accepted design -- see task-8-report.md.
 */
async function writeClaudeMaterial(
  input: WriteProviderPeerMaterialInput,
): Promise<ProviderPeerMaterial> {
  const configPath = join(input.provisionDir, 'mcp.json');
  const content = {
    mcpServers: {
      forgeboard: {
        command: process.execPath,
        args: [shimEntryPath()],
        env: { ELECTRON_RUN_AS_NODE: '1', ...input.environment },
      },
    },
  };
  await mkdir(input.provisionDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  return {
    available: true,
    hint: null,
    extraArguments: ['--mcp-config', configPath],
    cleanup: async () => {
      await unlinkBestEffort(configPath);
    },
  };
}

// ---------------------------------------------------------------------------------------
// codex -- --profile <name>, layering a 0600 TOML file under CODEX_HOME
// ---------------------------------------------------------------------------------------

/**
 * DEVIATION from the task brief's original codex plan (documented in task-8-report.md /
 * task-8-brief.md Step 5 contingency). The brief assumed codex's spawned MCP server child
 * inherits the parent (PTY) environment, matching gemini/opencode. Empirical verification
 * (codex-cli 0.144.6, spawning a trivial env-dumping stdio MCP server registered via
 * `-c mcp_servers.<n>.env={...}`) showed the opposite: the child's env contained *only* the
 * keys explicitly listed in `mcp_servers.<name>.env` -- FORGEBOARD_PEER_URL/TOKEN came back
 * `null` when omitted, confirming codex does NOT inherit. `-c` overrides land in argv (world
 * readable via `ps`), so the token can never go through `-c`.
 *
 * The fallback: `--profile <name>` layers `$CODEX_HOME/<name>.config.toml` on top of the base
 * config (verified empirically: the layered `mcp_servers.dumpenv` entry was reachable and its
 * `env` block's values -- including our two secret-shaped test values -- arrived in the child's
 * process.env; the base config's other real `mcp_servers` entries kept working alongside it,
 * i.e. this is an additive layer, not a wholesale replace). That file is written at 0600 under
 * `join(homedir(), '.codex')` -- deliberately NOT a `CODEX_HOME` override read from the main
 * process's own environment, since codex actually runs inside the terminal PTY, whose env can
 * never carry a custom `CODEX_HOME` (see `resolveCodexHome` below for the full argument) -- named
 * after the provision so concurrent provisions never collide, and only the profile *name* -- never
 * the token -- appears in `extraArguments`/argv.
 */
async function writeCodexMaterial(
  input: WriteProviderPeerMaterialInput,
): Promise<ProviderPeerMaterial> {
  const provisionId = resolveProvisionId(input.provisionDir);
  if (provisionId === null) return unavailableMaterial(INVALID_PROVISION_ID_HINT);
  const codexHome = resolveCodexHome();
  const profileName = `forgeboard-${provisionId}`;
  const profilePath = join(codexHome, `${profileName}.config.toml`);
  const toml = codexProfileToml(process.execPath, shimEntryPath(), input.environment);
  await mkdir(codexHome, { recursive: true });
  await writeFile(profilePath, toml, { mode: 0o600 });
  return {
    available: true,
    hint: null,
    extraArguments: ['--profile', profileName],
    cleanup: async () => {
      await unlinkBestEffort(profilePath);
    },
  };
}

/**
 * Deliberately ignores a `CODEX_HOME` override in the MAIN process's own environment.
 *
 * codex actually runs inside the terminal PTY, not the main process, and the PTY's environment
 * is built by `baseTerminalEnvironment()` (apps/desktop/src/main/terminal/pty-process.ts) -- a
 * fixed allowlist that does not include `CODEX_HOME` -- layered with the reviewed allowlist
 * (empty for agent sessions: `environmentVariableNames: []`, see
 * apps/desktop/src/renderer/src/components/workspace/runs/agent-session/launch-config.ts) and
 * the peer-hub's `peerEnvironment` (only ever `FORGEBOARD_PEER_URL`/`FORGEBOARD_PEER_TOKEN`, see
 * `AgentPeersService.environmentForProvision`). So codex-in-the-PTY can never see a custom
 * `CODEX_HOME` and always resolves its config home to `join(homedir(), '.codex')`. If this
 * function preferred `process.env['CODEX_HOME']` as read here (main-process env), a main process
 * launched from a shell that exports a custom `CODEX_HOME` would write the `--profile` TOML to a
 * directory codex-in-the-PTY never reads, and `--profile forgeboard-<id>` would fail to resolve
 * -- potentially failing the entire codex session, not just peer tools. Always writing to the
 * same `join(homedir(), '.codex')` the PTY resolves keeps the write location and the read
 * location provably in agreement.
 */
function resolveCodexHome(): string {
  return join(homedir(), '.codex');
}

function codexProfileToml(
  execPath: string,
  shimPath: string,
  environment: Record<string, string>,
): string {
  // A Map (not array spread) so a caller-supplied ELECTRON_RUN_AS_NODE in `environment` (outside
  // the documented contract, which only ever carries FORGEBOARD_PEER_URL/TOKEN) overrides the
  // default the same way claude's `{ ELECTRON_RUN_AS_NODE: '1', ...environment }` spread does,
  // instead of emitting a second `ELECTRON_RUN_AS_NODE` key -- which TOML rejects as invalid.
  const env = new Map<string, string>([
    ['ELECTRON_RUN_AS_NODE', '1'],
    ...Object.entries(environment),
  ]);
  const lines = [
    '[mcp_servers.forgeboard]',
    `command = ${tomlString(execPath)}`,
    `args = [${tomlString(shimPath)}]`,
    '',
    '[mcp_servers.forgeboard.env]',
    ...[...env].map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`),
    '',
  ];
  return lines.join('\n');
}

/** TOML basic string: backslash and double-quote must be escaped; everything else is literal. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------------------
// gemini -- merge into <projectRoot>/.gemini/settings.json (mcpServers.forgeboard)
// ---------------------------------------------------------------------------------------

/**
 * Verified against installed Gemini CLI 0.25.2: `gemini mcp add <name> <command> [args...] -s
 * project` (default scope is `project`) writes `mcpServers` into `.gemini/settings.json` at the
 * project root -- confirmed by actually running it in a scratch project. No CLI flag is required
 * for gemini to pick this file up; `extraArguments` is empty.
 *
 * Env-inheritance finding (drives the token decision): a trivial env-dumping stdio MCP server,
 * registered with *no* `env` block in `.gemini/settings.json`, still received the parent
 * process's `FORGEBOARD_PEER_URL`/`FORGEBOARD_PEER_TOKEN` when gemini spawned it -- gemini's MCP
 * child inherits the parent environment. Per the task's security rules, the token is therefore
 * OMITTED from this project-root file (which lives inside the user's git repo and could be
 * committed by accident); only the non-secret `ELECTRON_RUN_AS_NODE=1` (required so
 * `process.execPath` runs the shim as plain Node rather than launching Electron's GUI) is
 * written. The shim itself reads FORGEBOARD_PEER_URL/TOKEN from its own inherited process.env.
 *
 * LIMITATION: every agent session in a project runs at the same project root, so this file is
 * SHARED by all of them. The entry is keyed `forgeboard-<provisionId>` (provision-scoped, not a
 * fixed name) so two concurrent gemini sessions on one project write distinct keys instead of
 * clobbering each other, and `cleanup()` only ever removes its own key -- never destroys the
 * file or another session's entry. The supported model is still one gemini peer session per
 * project at a time; running two concurrently is unsupported (both shims end up registered,
 * i.e. cross-wired) but is now safe from data loss.
 */
async function writeGeminiMaterial(
  input: WriteProviderPeerMaterialInput,
): Promise<ProviderPeerMaterial> {
  const provisionId = resolveProvisionId(input.provisionDir);
  if (provisionId === null) return unavailableMaterial(INVALID_PROVISION_ID_HINT);
  const entryKey = `forgeboard-${provisionId}`;
  const settingsPath = join(input.projectRoot, '.gemini', 'settings.json');
  const entry = {
    command: process.execPath,
    args: [shimEntryPath()],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const existedBefore = await mergeJsonEntry(settingsPath, 'mcpServers', entryKey, entry);
  return {
    available: true,
    hint: null,
    extraArguments: [],
    cleanup: async () => {
      await cleanupJsonEntry(settingsPath, 'mcpServers', entryKey, existedBefore);
    },
  };
}

// ---------------------------------------------------------------------------------------
// opencode -- merge into <projectRoot>/opencode.json (mcp.forgeboard)
// ---------------------------------------------------------------------------------------

/**
 * Verified against installed OpenCode 1.3.17: the bundled SDK's `Config` type
 * (@opencode-ai/sdk/dist/gen/types.gen.d.ts) declares a top-level `mcp?: { [name]: McpLocalConfig
 * | McpRemoteConfig }` and `McpLocalConfig = { type: "local"; command: string[]; environment?:
 * {...} }`, matching the shape written here. `opencode.json` at the project root is the
 * documented project config file opencode loads automatically; no CLI flag is required.
 *
 * Env-inheritance finding: identical to gemini -- a trivial env-dumping stdio MCP server
 * registered via `opencode.json` with no `environment` block still received the parent's
 * FORGEBOARD_PEER_URL/TOKEN when `opencode run` spawned it. The token is therefore OMITTED from
 * this project-root file for the same accidental-commit reason as gemini; only
 * `ELECTRON_RUN_AS_NODE` is written.
 *
 * LIMITATION: same shared-file caveat as gemini above -- `opencode.json` is one file per project
 * root, shared by every session. The entry is keyed `forgeboard-<provisionId>` so concurrent
 * opencode sessions on one project write distinct keys, and `cleanup()` only removes its own key
 * and never destroys the file or another session's entry. One opencode peer session per project
 * at a time is the supported model; concurrent sessions cross-wire (unsupported) but can no
 * longer corrupt this file.
 */
async function writeOpencodeMaterial(
  input: WriteProviderPeerMaterialInput,
): Promise<ProviderPeerMaterial> {
  const provisionId = resolveProvisionId(input.provisionDir);
  if (provisionId === null) return unavailableMaterial(INVALID_PROVISION_ID_HINT);
  const entryKey = `forgeboard-${provisionId}`;
  const configPath = join(input.projectRoot, 'opencode.json');
  const entry = {
    type: 'local',
    command: [process.execPath, shimEntryPath()],
    environment: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const existedBefore = await mergeJsonEntry(configPath, 'mcp', entryKey, entry);
  return {
    available: true,
    hint: null,
    extraArguments: [],
    cleanup: async () => {
      await cleanupJsonEntry(configPath, 'mcp', entryKey, existedBefore);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Shared JSON merge/cleanup helpers (gemini, opencode)
// ---------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Reads `path` as a JSON object, tolerating a missing or invalid file by treating it as `{}`.
 * `existed` reflects only whether the file was present on disk -- never whether it parsed --
 * so cleanup can tell "we created this file" from "this file pre-existed but was broken" and
 * never delete something it didn't create. */
async function readJsonObject(
  path: string,
): Promise<{ existed: boolean; value: Record<string, unknown> }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return { existed: false, value: {} };
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return { existed: true, value: isRecord(parsed) ? parsed : {} };
  } catch {
    return { existed: true, value: {} };
  }
}

/** Merges `{ [containerKey]: { [entryKey]: entryValue } }` into the JSON object at `path`,
 * preserving every other top-level and sibling key. Returns whether the file already existed
 * before this write, so cleanup knows whether it is allowed to delete it later. */
async function mergeJsonEntry(
  path: string,
  containerKey: string,
  entryKey: string,
  entryValue: unknown,
): Promise<boolean> {
  const { existed, value } = await readJsonObject(path);
  const container = isRecord(value[containerKey]) ? { ...value[containerKey] } : {};
  container[entryKey] = entryValue;
  const merged = { ...value, [containerKey]: container };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return existed;
}

/** Removes only `[containerKey][entryKey]` from the JSON object at `path`. If the file did not
 * exist before our write (`existedBefore === false`) and removing our entry leaves the object
 * empty, the file is deleted; otherwise the reduced object is written back, leaving every
 * unrelated key -- including other entries in the same container -- untouched. Best-effort and
 * fully async: every failure is caught here so a broken cleanup can never escape and block the
 * peer-hub's teardown. */
async function cleanupJsonEntry(
  path: string,
  containerKey: string,
  entryKey: string,
  existedBefore: boolean,
): Promise<void> {
  try {
    const { existed, value } = await readJsonObject(path);
    if (!existed) return;
    const container = isRecord(value[containerKey]) ? { ...value[containerKey] } : {};
    delete container[entryKey];
    const next: Record<string, unknown> = { ...value };
    if (Object.keys(container).length === 0) {
      delete next[containerKey];
    } else {
      next[containerKey] = container;
    }
    if (!existedBefore && Object.keys(next).length === 0) {
      await unlinkBestEffort(path);
      return;
    }
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort: a cleanup failure must never block hub teardown.
  }
}

async function unlinkBestEffort(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isEnoent(error)) {
      // Best-effort: swallow so a cleanup failure can never escape and block teardown, but a
      // real delete failure (e.g. EACCES) can leave live token material on disk -- surface it
      // rather than fail silently.
      console.warn(`[agent-peers] failed to remove ${path} during peer material cleanup:`, error);
    }
  }
}
