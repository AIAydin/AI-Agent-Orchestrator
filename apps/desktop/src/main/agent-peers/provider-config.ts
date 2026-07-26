import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { app } from 'electron';

/**
 * Output of `writeProviderPeerMaterial`. Consumed by the provision IPC (Task 9): `extraArguments`
 * is appended to the CLI argv the renderer builds; `cleanup` is registered with the peer-hub so
 * every on-disk artifact this module wrote is undone when the session/provision tears down (see
 * `AgentPeersService.registerCleanup`/`releaseSession`).
 *
 * `cleanup` is idempotent and never rejects: several teardown routes can fire for one session
 * (PTY exit, terminate, unbound-provision expiry, app quit), and none of them may be blocked by
 * a cleanup failure.
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

/** Prefix of every JSON object key this module writes into a shared project-root config file. */
const AUTHORED_KEY_PREFIX = 'forgeboard-';

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
 * see their `predev`/`prebuild` scripts). A bundled build collapses the main-process source tree,
 * so this intentionally does NOT use `import.meta.url`-relative
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
 *
 * Because the file lives in the user's repo and a hard-killed app never gets to run `cleanup()`,
 * every write also sweeps LEAKED sibling entries -- see `sweepStaleAuthoredEntries`.
 */
async function writeGeminiMaterial(
  input: WriteProviderPeerMaterialInput,
): Promise<ProviderPeerMaterial> {
  const provisionId = resolveProvisionId(input.provisionDir);
  if (provisionId === null) return unavailableMaterial(INVALID_PROVISION_ID_HINT);
  return await writeSharedJsonMaterial({
    path: join(input.projectRoot, '.gemini', 'settings.json'),
    containerKey: 'mcpServers',
    entryKey: `${AUTHORED_KEY_PREFIX}${provisionId}`,
    entryValue: {
      command: process.execPath,
      args: [shimEntryPath()],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    isAuthoredEntry: isGeminiAuthoredEntry,
  });
}

/**
 * Recognises an `mcpServers` entry with the exact shape `writeGeminiMaterial` writes, so the
 * stale sweep can never delete a key the user happens to have named `forgeboard-*` themselves.
 * The shim path is matched by SUFFIX, not equality: a leaked entry points at whatever checkout
 * wrote it, which is usually not the one running now.
 */
function isGeminiAuthoredEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['command'] !== 'string') return false;
  const args = value['args'];
  if (!Array.isArray(args) || args.length !== 1) return false;
  const [entryPoint] = args as unknown[];
  if (typeof entryPoint !== 'string' || !isShimEntryPoint(entryPoint)) return false;
  const environment = value['env'];
  return isRecord(environment) && environment['ELECTRON_RUN_AS_NODE'] === '1';
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
 *
 * Because the file lives in the user's repo and a hard-killed app never gets to run `cleanup()`,
 * every write also sweeps LEAKED sibling entries -- see `sweepStaleAuthoredEntries`.
 */
async function writeOpencodeMaterial(
  input: WriteProviderPeerMaterialInput,
): Promise<ProviderPeerMaterial> {
  const provisionId = resolveProvisionId(input.provisionDir);
  if (provisionId === null) return unavailableMaterial(INVALID_PROVISION_ID_HINT);
  return await writeSharedJsonMaterial({
    path: join(input.projectRoot, 'opencode.json'),
    containerKey: 'mcp',
    entryKey: `${AUTHORED_KEY_PREFIX}${provisionId}`,
    entryValue: {
      type: 'local',
      command: [process.execPath, shimEntryPath()],
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    },
    isAuthoredEntry: isOpencodeAuthoredEntry,
  });
}

/** The opencode counterpart of `isGeminiAuthoredEntry` -- see there for why this exists. */
function isOpencodeAuthoredEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['type'] !== 'local') return false;
  const command = value['command'];
  if (!Array.isArray(command) || command.length !== 2) return false;
  const [executable, entryPoint] = command as unknown[];
  if (typeof executable !== 'string') return false;
  if (typeof entryPoint !== 'string' || !isShimEntryPoint(entryPoint)) return false;
  const environment = value['environment'];
  return isRecord(environment) && environment['ELECTRON_RUN_AS_NODE'] === '1';
}

/** Every path `shimEntryPath()` can ever produce ends in one of these: `peer-mcp/dist/main.js`
 * in dev, `peer-mcp/main.js` when packaged. Matching the tail (not the whole path) is what lets
 * the sweep recognise an entry written by a DIFFERENT checkout or a previous install. */
const SHIM_ENTRY_SUFFIXES = ['/peer-mcp/dist/main.js', '/peer-mcp/main.js'] as const;

function isShimEntryPoint(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return SHIM_ENTRY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

// ---------------------------------------------------------------------------------------
// Shared JSON merge/cleanup helpers (gemini, opencode)
// ---------------------------------------------------------------------------------------

/**
 * One provider's registration in a shared project-root JSON config file: which file, which
 * container object inside it, our provision-scoped key, the entry we write, and the predicate
 * that recognises an entry THIS module authored (used by the stale sweep).
 */
interface SharedJsonEntryPlan {
  readonly path: string;
  readonly containerKey: string;
  readonly entryKey: string;
  readonly entryValue: unknown;
  readonly isAuthoredEntry: (value: unknown) => boolean;
}

/** The pre-write state of a shared config file, captured once at registration time so cleanup
 * can put the file back exactly as it found it -- including deleting a file we created. */
interface SharedJsonBaseline {
  /** The file was present on disk before our write (regardless of whether it parsed). */
  readonly existed: boolean;
  /** The file parsed as a JSON object. Only then may `raw` be restored verbatim. */
  readonly parsed: boolean;
  /** Original bytes, so a restore is byte-identical (indentation, key order, trailing newline). */
  readonly raw: string | null;
  /** Parsed original, or `{}` when the file was absent or unparseable. */
  readonly value: Record<string, unknown>;
}

/** A baseline plus the one judgement that can only be made at registration time: whether the
 * container object was the user's to begin with, or something Forgeboard introduced. */
interface SharedJsonRegistration extends SharedJsonBaseline {
  /** The container key existed and held something other than Forgeboard's own entries, so
   * cleanup must leave the key in place even after emptying it. */
  readonly containerWasTheirs: boolean;
}

/**
 * Entry keys registered by THIS app instance and not yet cleaned up.
 *
 * The stale sweep exists because a config entry lives in the user's git repo while its owning
 * process may die without ever running `cleanup()` (SIGKILL, power loss, a crash before the
 * quit handlers run). Nothing on disk distinguishes "a concurrent session is using this" from
 * "a dead session leaked this" -- only this in-memory set does, and it is authoritative exactly
 * because a leaked entry by definition belongs to a process that no longer exists.
 */
const liveEntryKeys = new Set<string>();

/**
 * Shared config files THIS app instance created, i.e. they did not exist before it first wrote
 * one. Tracked per file rather than per provision because the session that created the file is
 * often not the last one to leave: with three sessions sharing one project root, the creator's
 * cleanup runs first and the third session's cleanup is the one that finds the file empty. An
 * entry is dropped again the moment the file is removed.
 */
const filesCreatedByThisInstance = new Set<string>();

/**
 * Top-level keys that hold no user data and that the provider CLI itself may add to a file we
 * created (opencode writes `$schema` into `opencode.json` when it normalises it). They are only
 * ever treated as disposable when the file did NOT exist before Forgeboard wrote it -- in that
 * case a file containing nothing but these plus our now-empty container is pure Forgeboard
 * residue, and removing it restores the project to its pre-Forgeboard state.
 */
const DISPOSABLE_METADATA_KEYS: ReadonlySet<string> = new Set(['$schema']);

/** In-flight tail of the read-modify-write chain for each shared config file. */
const fileOperationQueues = new Map<string, Promise<void>>();

/**
 * Serialises every read-modify-write of one shared config file.
 *
 * Registration and cleanup both re-read the whole file, edit one key, and write it back. Two of
 * those interleaved (two provisions racing on one project root, or a cleanup landing mid-write)
 * would let the later write clobber the earlier one's entry. The queue is per path, so unrelated
 * projects never wait on each other, and a rejection is absorbed so one failure cannot poison
 * the chain for every later caller.
 */
async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileOperationQueues.get(path) ?? Promise.resolve();
  const settled = previous.then(operation, operation);
  const tail = settled.then(
    () => undefined,
    () => undefined,
  );
  fileOperationQueues.set(path, tail);
  try {
    return await settled;
  } finally {
    if (fileOperationQueues.get(path) === tail) fileOperationQueues.delete(path);
  }
}

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

/** Structural equality for parsed JSON, ignoring key order (which `JSON.stringify` would not). */
function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length && left.every((item, index) => deepEqualJson(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]))
  );
}

/** Reads `path` as a JSON object, tolerating a missing or invalid file by treating it as `{}`.
 * `existed` reflects only whether the file was present on disk -- never whether it parsed --
 * so cleanup can tell "we created this file" from "this file pre-existed but was broken" and
 * never delete something it didn't create. */
async function readJsonObject(path: string): Promise<SharedJsonBaseline> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return { existed: false, parsed: false, raw: null, value: {} };
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed)
      ? { existed: true, parsed: true, raw, value: parsed }
      : { existed: true, parsed: false, raw, value: {} };
  } catch {
    return { existed: true, parsed: false, raw, value: {} };
  }
}

/** Registers one provision's entry in a shared project-root config file and hands back the
 * matching cleanup. The cleanup is memoised (`runOnce`) so the several teardown routes that can
 * all fire for one session -- PTY exit, terminate, provision expiry, app quit -- collapse into a
 * single idempotent run, and it never rejects. */
async function writeSharedJsonMaterial(plan: SharedJsonEntryPlan): Promise<ProviderPeerMaterial> {
  const baseline = await mergeJsonEntry(plan);
  return {
    available: true,
    hint: null,
    extraArguments: [],
    cleanup: runOnce(async () => {
      await cleanupJsonEntry(plan, baseline);
    }),
  };
}

/** Collapses repeat invocations into the first run's promise. */
function runOnce(run: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | null = null;
  return () => {
    started ??= run();
    return started;
  };
}

/**
 * Whether `container[key]` is an entry THIS module wrote: the key carries our `forgeboard-`
 * prefix followed by a well-formed provision id, AND the value has the exact shape the provider's
 * writer produces. A user's own MCP server -- including one they chose to name
 * `forgeboard-something` -- fails the shape test, so nothing the app did not author is ever
 * classified as ours.
 */
function isAuthoredEntry(
  container: Record<string, unknown>,
  key: string,
  plan: SharedJsonEntryPlan,
): boolean {
  if (!key.startsWith(AUTHORED_KEY_PREFIX)) return false;
  if (!PROVISION_ID_PATTERN.test(key.slice(AUTHORED_KEY_PREFIX.length))) return false;
  return plan.isAuthoredEntry(container[key]);
}

/**
 * Deletes every LEAKED Forgeboard entry from `container`, in place: one we authored, that is not
 * our own key, and that no live provision of this app instance owns (`liveEntryKeys`). Only an
 * entry whose owning process is gone can satisfy all three.
 */
function sweepStaleAuthoredEntries(
  container: Record<string, unknown>,
  plan: SharedJsonEntryPlan,
): void {
  for (const key of Object.keys(container)) {
    if (key === plan.entryKey) continue;
    if (liveEntryKeys.has(key)) continue;
    if (!isAuthoredEntry(container, key, plan)) continue;
    delete container[key];
  }
}

/** True when the container object held user content before we touched it. An absent container is
 * ours (we are about to create it); an empty one is treated as the user's, since an empty
 * `"mcp": {}` they wrote is indistinguishable from one they merely left behind. */
function containerBelongsToUser(
  baseline: Record<string, unknown>,
  plan: SharedJsonEntryPlan,
): boolean {
  const container = baseline[plan.containerKey];
  if (!isRecord(container)) return false;
  const keys = Object.keys(container);
  return keys.length === 0 || keys.some((key) => !isAuthoredEntry(container, key, plan));
}

/** Merges `{ [containerKey]: { [entryKey]: entryValue } }` into the JSON object at `plan.path`,
 * sweeping leaked sibling entries on the way through and preserving every other top-level and
 * sibling key. Returns the file's pre-write state so cleanup can restore it exactly. */
async function mergeJsonEntry(plan: SharedJsonEntryPlan): Promise<SharedJsonRegistration> {
  return await withFileLock(plan.path, async () => {
    const baseline = await readJsonObject(plan.path);
    const containerWasTheirs = containerBelongsToUser(baseline.value, plan);
    const existingContainer = baseline.value[plan.containerKey];
    const container = isRecord(existingContainer) ? { ...existingContainer } : {};
    sweepStaleAuthoredEntries(container, plan);
    container[plan.entryKey] = plan.entryValue;
    liveEntryKeys.add(plan.entryKey);
    if (!baseline.existed) filesCreatedByThisInstance.add(plan.path);
    const merged = { ...baseline.value, [plan.containerKey]: container };
    await mkdir(dirname(plan.path), { recursive: true });
    await writeFile(plan.path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    return { ...baseline, containerWasTheirs };
  });
}

/**
 * Removes only `[containerKey][entryKey]` from the JSON object at `plan.path` and then restores
 * as much of the pre-session state as is still ours to restore:
 *
 * - the file is one this app instance created and nothing but Forgeboard residue is left (an
 *   empty container, plus metadata-only keys such as a `$schema` pointer the CLI added on its
 *   own) -- the file is deleted, since that IS its pre-Forgeboard state;
 * - what remains is semantically identical to the baseline -- the original bytes are written
 *   back verbatim, so a pre-existing user file ends up byte-identical to how we found it;
 * - anything else (another session's entry, edits made while we ran, entries the sweep removed)
 *   -- the reduced object is serialised, leaving every unrelated key untouched.
 *
 * Best-effort and fully async: every failure is caught here so a broken cleanup can never escape
 * and block the peer-hub's teardown.
 */
async function cleanupJsonEntry(
  plan: SharedJsonEntryPlan,
  baseline: SharedJsonRegistration,
): Promise<void> {
  liveEntryKeys.delete(plan.entryKey);
  try {
    await withFileLock(plan.path, async () => {
      const current = await readJsonObject(plan.path);
      if (!current.existed) return;
      const currentContainer = current.value[plan.containerKey];
      const container = isRecord(currentContainer) ? { ...currentContainer } : {};
      delete container[plan.entryKey];
      const next: Record<string, unknown> = { ...current.value };
      // A container key the user already had stays, even when empty: removing it would be an
      // edit to their file, not a cleanup of ours.
      if (Object.keys(container).length === 0 && !baseline.containerWasTheirs) {
        delete next[plan.containerKey];
      } else {
        next[plan.containerKey] = container;
      }
      const weCreatedTheFile = !baseline.existed || filesCreatedByThisInstance.has(plan.path);
      if (weCreatedTheFile && isForgeboardResidueOnly(next, plan.containerKey)) {
        await unlinkBestEffort(plan.path);
        filesCreatedByThisInstance.delete(plan.path);
        return;
      }
      if (baseline.parsed && baseline.raw !== null && deepEqualJson(next, baseline.value)) {
        await writeFile(plan.path, baseline.raw);
        return;
      }
      await writeFile(plan.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    });
  } catch {
    // Best-effort: a cleanup failure must never block hub teardown.
  }
}

/** True when `value` holds no content worth keeping: at most an empty container plus
 * metadata-only keys. Only ever consulted for a file Forgeboard itself created. */
function isForgeboardResidueOnly(value: Record<string, unknown>, containerKey: string): boolean {
  return Object.entries(value).every(([key, entry]) => {
    if (key === containerKey) return isRecord(entry) && Object.keys(entry).length === 0;
    return DISPOSABLE_METADATA_KEYS.has(key) && typeof entry === 'string';
  });
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
