import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  GitHubCommandOptions,
  GitHubCommandResult,
  GitHubCommandRunner,
} from '@forgeboard/git-engine';

import {
  StoredGitHubCliBindingSchema,
  type StoredGitHubCliBinding,
} from '../../storage/github-cli/contracts.js';
import {
  assertGitHubCliExecutableCurrent,
  captureGitHubCliExecutable,
  sameGitHubCliExecutable,
  type CapturedGitHubCliExecutable,
} from './identity.js';

const SELECTION_TTL_MS = 5 * 60_000;
const MAX_PENDING_SELECTIONS = 128;
const MAX_PENDING_PER_OWNER = 8;
const VERSION_ARGUMENTS = ['--version'] as const;

export type GitHubCliSource = 'automatic' | 'custom';

export interface GitHubCliBindingStore {
  getGitHubCliBinding(): StoredGitHubCliBinding | undefined;
  saveGitHubCliBinding(binding: StoredGitHubCliBinding): StoredGitHubCliBinding;
  clearGitHubCliBinding(): boolean;
}

/** Path-free executable evidence safe for validated renderer IPC. */
export interface GitHubCliPublicIdentity {
  readonly source: GitHubCliSource;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly version: string | null;
}

/** Exact structural match for the shared renderer selection-plan contract. */
export interface GitHubCliSelectionPlan {
  readonly kind: 'github-cli-selection';
  readonly planId: string;
  readonly expiresAt: string;
  readonly source: GitHubCliSource;
  readonly candidate: GitHubCliPublicIdentity | null;
  readonly networkAccess: false;
}

/** Main-only native-confirmation details. Never send this object through renderer IPC. */
export interface GitHubCliSelectionReview extends GitHubCliSelectionPlan {
  readonly executablePath: string | null;
  readonly versionArguments: readonly ['--version'] | null;
}

export type GitHubCliSelectionAuthorizer = (
  review: GitHubCliSelectionReview,
) => Promise<'approved' | 'denied'>;

/** Main-owned admission that surrounds only the approved configuration mutation. */
export type GitHubCliSelectionMutationAdmission = <Output>(
  operation: () => Promise<Output>,
) => Promise<Output>;

/** Exact structural match for the shared renderer status contract. */
export interface GitHubCliPublicStatus {
  readonly source: GitHubCliSource;
  readonly state: 'unavailable' | 'unverified' | 'ready' | 'changed';
  readonly identity: GitHubCliPublicIdentity | null;
  readonly verifiedAt: string | null;
  readonly checkedAt: string;
}

/** Main-only executable disclosure for outbound native confirmation. */
export interface GitHubCliExecutionReview {
  readonly source: GitHubCliSource;
  readonly executablePath: string;
  readonly identity: GitHubCliPublicIdentity;
}

export interface GitHubCliCommandRuntime {
  readonly source: GitHubCliSource;
  /** True only after the exact executable has produced a valid GitHub CLI version. */
  readonly available: boolean;
  /** Main-process-only executable path. Never send this value through renderer IPC. */
  readonly executable: string;
  readonly identityFingerprint: string;
  /** Present for both ready and passively detected-but-unverified executables. */
  readonly review: GitHubCliExecutionReview | null;
  readonly status: GitHubCliPublicStatus;
  readonly runner: GitHubCommandRunner;
}

export type GitHubCliBeforeSpawn = (
  executable: string,
  args: readonly string[],
) => void | Promise<void>;

/** Redacted, exact process evidence required immediately before a validation spawn. */
export interface GitHubCliValidationSpawnReview {
  readonly kind: 'version';
  readonly source: GitHubCliSource;
  readonly identity: GitHubCliPublicIdentity;
  readonly arguments: readonly ['--version'];
  readonly credentialAccess: false;
}

export interface GitHubCliRuntimeDependencies {
  /**
   * Must construct a direct, shell-free runner without starting it. Production passes the second
   * argument to GitHubCliExecutor's beforeSpawn hook.
   */
  readonly createRunner: (
    executable: string,
    beforeSpawn?: GitHubCliBeforeSpawn,
  ) => GitHubCommandRunner;
  /**
   * Optional credential-free runner used only for exact `--version` validation, either after a
   * selection confirmation or inside an explicitly approved GitHub status check. Production
   * supplies a minimal environment rather than inheriting GitHub tokens or auth state.
   */
  readonly createValidationRunner?: (
    executable: string,
    beforeSpawn?: GitHubCliBeforeSpawn,
  ) => GitHubCommandRunner;
  /** Must persist the required audit record or reject, which prevents the process from spawning. */
  readonly authorizeValidationSpawn?: (
    review: GitHubCliValidationSpawnReview,
  ) => void | Promise<void>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

interface PendingSelectionBase {
  readonly planId: string;
  readonly ownerId: string;
  readonly expiresAtMs: number;
  readonly expiresAt: string;
  readonly expectedConfigurationFingerprint: string;
  readonly expectedSelectionRevision: number;
}

interface PendingCustomSelection extends PendingSelectionBase {
  readonly source: 'custom';
  readonly captured: CapturedGitHubCliExecutable;
}

interface PendingAutomaticSelection extends PendingSelectionBase {
  readonly source: 'automatic';
  readonly captured: CapturedGitHubCliExecutable | null;
}

type PendingSelection = PendingCustomSelection | PendingAutomaticSelection;

interface AutomaticInspection {
  readonly runner: GitHubCommandRunner;
  readonly captured: CapturedGitHubCliExecutable | null;
}

interface AutomaticValidation {
  readonly captured: CapturedGitHubCliExecutable;
  readonly version: string;
  readonly validatedAt: string;
}

interface ConfirmationResult {
  readonly status: GitHubCliPublicStatus;
  readonly binding?: StoredGitHubCliBinding;
}

/** Main-owned selection, persistence, and per-command identity authority for the optional gh CLI. */
export class GitHubCliRuntimeService {
  readonly #pending = new Map<string, PendingSelection>();
  readonly #createRunner: GitHubCliRuntimeDependencies['createRunner'];
  readonly #createValidationRunner: GitHubCliRuntimeDependencies['createRunner'];
  readonly #authorizeValidationSpawn: NonNullable<
    GitHubCliRuntimeDependencies['authorizeValidationSpawn']
  >;
  readonly #now: () => Date;
  readonly #createId: () => string;
  #automaticValidation: AutomaticValidation | undefined;
  #confirmationActive = false;
  #selectionRevision = 0;

  public constructor(
    private readonly store: GitHubCliBindingStore,
    dependencies: GitHubCliRuntimeDependencies,
  ) {
    if (typeof dependencies.createRunner !== 'function') {
      throw new Error('GitHub CLI runtime requires a trusted command-runner factory.');
    }
    this.#createRunner = dependencies.createRunner;
    this.#createValidationRunner = dependencies.createValidationRunner ?? dependencies.createRunner;
    this.#authorizeValidationSpawn = dependencies.authorizeValidationSpawn ?? (() => undefined);
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  /** Captures a native-picker result without starting it or changing persisted configuration. */
  public async prepareCustomSelection(
    ownerId: string,
    candidatePath: string,
  ): Promise<GitHubCliSelectionPlan> {
    assertOwnerId(ownerId);
    const captured = await captureGitHubCliExecutable(candidatePath);
    return this.#addSelection(ownerId, { source: 'custom', captured });
  }

  /** Resolves desktop PATH passively and stages automatic mode without clearing a custom binding. */
  public async prepareAutomaticSelection(ownerId: string): Promise<GitHubCliSelectionPlan> {
    assertOwnerId(ownerId);
    const inspection = await this.#inspectAutomatic();
    return this.#addSelection(ownerId, {
      source: 'automatic',
      captured: inspection.captured,
    });
  }

  /**
   * Confirms either staged source. The plan is owner-bound and single-use; denial and failed
   * validation preserve the currently stored custom binding.
   */
  public async confirmSelection(
    ownerId: string,
    planId: string,
    authorize: GitHubCliSelectionAuthorizer,
    signal?: AbortSignal,
    assertCurrent: () => void = () => undefined,
    withMutationAdmission: GitHubCliSelectionMutationAdmission = directAdmission,
  ): Promise<GitHubCliPublicStatus | null> {
    return (
      (
        await this.#confirmSelection(
          ownerId,
          planId,
          undefined,
          authorize,
          signal,
          assertCurrent,
          withMutationAdmission,
        )
      )?.status ?? null
    );
  }

  /** Narrow helper retained for callers that need the newly persisted custom binding. */
  public async confirmCustomSelection(
    ownerId: string,
    planId: string,
    authorize: GitHubCliSelectionAuthorizer,
    signal?: AbortSignal,
    assertCurrent: () => void = () => undefined,
    withMutationAdmission: GitHubCliSelectionMutationAdmission = directAdmission,
  ): Promise<StoredGitHubCliBinding | null> {
    const result = await this.#confirmSelection(
      ownerId,
      planId,
      'custom',
      authorize,
      signal,
      assertCurrent,
      withMutationAdmission,
    );
    return result?.binding ?? null;
  }

  /** Applies reviewed automatic mode, including the valid no-executable state. */
  public async confirmAutomaticSelection(
    ownerId: string,
    planId: string,
    authorize: GitHubCliSelectionAuthorizer,
    signal?: AbortSignal,
    assertCurrent: () => void = () => undefined,
    withMutationAdmission: GitHubCliSelectionMutationAdmission = directAdmission,
  ): Promise<GitHubCliPublicStatus | null> {
    return (
      (
        await this.#confirmSelection(
          ownerId,
          planId,
          'automatic',
          authorize,
          signal,
          assertCurrent,
          withMutationAdmission,
        )
      )?.status ?? null
    );
  }

  /** Cancels exactly one owner-bound plan without revealing whether another owner created it. */
  public cancelSelection(ownerId: string, planId: string): boolean {
    assertOwnerId(ownerId);
    this.#discardExpired();
    const selection = this.#pending.get(planId);
    if (selection === undefined || selection.ownerId !== ownerId) return false;
    this.#pending.delete(planId);
    return true;
  }

  public discardOwner(ownerId: string): void {
    assertOwnerId(ownerId);
    for (const [planId, selection] of this.#pending) {
      if (selection.ownerId === ownerId) this.#pending.delete(planId);
    }
  }

  public clearPendingSelections(): void {
    this.#pending.clear();
  }

  /** Clears every in-memory selection and validation artifact during a privacy reset. */
  public resetForPrivacy(): void {
    this.#pending.clear();
    this.#automaticValidation = undefined;
    this.#selectionRevision += 1;
  }

  /** Returns only path-free, non-throwing status suitable for validated IPC exposure. */
  public async getPublicStatus(): Promise<GitHubCliPublicStatus> {
    let binding: StoredGitHubCliBinding | undefined;
    try {
      binding = this.store.getGitHubCliBinding();
    } catch {
      return customUnavailableStatus(this.#timestamp());
    }
    if (binding !== undefined) {
      let captured: CapturedGitHubCliExecutable;
      try {
        captured = capturedFromBinding(binding);
      } catch {
        return customUnavailableStatus(this.#timestamp());
      }
      try {
        await assertGitHubCliExecutableCurrent(captured);
      } catch {
        return customChangedStatus(binding, this.#timestamp());
      }
      return customReadyStatus(binding, this.#timestamp());
    }
    let inspection: AutomaticInspection;
    try {
      inspection = await this.#inspectAutomatic();
    } catch {
      return automaticUnavailableStatus(this.#timestamp());
    }
    if (inspection.captured === null) {
      this.#automaticValidation = undefined;
      return automaticUnavailableStatus(this.#timestamp());
    }
    return this.#automaticDetectedStatus(inspection.captured, this.#timestamp());
  }

  /** Resolves one identity-bound runner; it re-hashes before launch and after every command. */
  public async resolveCommandRuntime(): Promise<GitHubCliCommandRuntime> {
    const binding = this.store.getGitHubCliBinding();
    if (binding === undefined) return await this.#automaticRuntime();
    const captured = capturedFromBinding(binding);
    await assertGitHubCliExecutableCurrent(captured);
    const runner = this.#createIdentityBoundRunner(captured);
    const identity = publicIdentity('custom', captured, binding.version);
    return {
      source: 'custom',
      available: true,
      executable: runner.executable,
      identityFingerprint: identityFingerprint('custom', captured),
      review: {
        source: 'custom',
        executablePath: runner.executable,
        identity,
      },
      status: customReadyStatus(binding, this.#timestamp()),
      runner,
    };
  }

  async #confirmSelection(
    ownerId: string,
    planId: string,
    expectedSource: GitHubCliSource | undefined,
    authorize: GitHubCliSelectionAuthorizer,
    signal: AbortSignal | undefined,
    assertCurrent: () => void,
    withMutationAdmission: GitHubCliSelectionMutationAdmission,
  ): Promise<ConfirmationResult | null> {
    if (this.#confirmationActive) {
      throw new Error('Another GitHub CLI selection review is already in progress.');
    }
    this.#confirmationActive = true;
    try {
      const selection = this.#takeSelection(ownerId, planId);
      if (expectedSource !== undefined && selection.source !== expectedSource) {
        throw new Error('The GitHub CLI selection source does not match this confirmation action.');
      }
      assertCurrent();
      this.#assertSelectionCurrent(selection);
      const decision = await authorize(selectionReview(selection));
      assertCurrent();
      if (decision !== 'approved') return null;
      if (selection.expiresAtMs <= this.#validNow().getTime()) {
        throw new Error('The GitHub CLI review expired. Choose the program again.');
      }
      this.#assertSelectionCurrent(selection);
      return await withMutationAdmission(async () => {
        assertCurrent();
        this.#assertSelectionCurrent(selection);
        const result =
          selection.source === 'custom'
            ? await this.#applyCustomSelection(selection, signal, assertCurrent)
            : await this.#applyAutomaticSelection(selection, signal, assertCurrent);
        this.#selectionRevision += 1;
        return result;
      });
    } finally {
      this.#confirmationActive = false;
    }
  }

  async #applyCustomSelection(
    selection: PendingCustomSelection,
    signal: AbortSignal | undefined,
    assertCurrent: () => void,
  ): Promise<ConfirmationResult> {
    assertCurrent();
    await assertGitHubCliExecutableCurrent(selection.captured);
    const runner = this.#createIdentityBoundRunner(
      selection.captured,
      assertCurrent,
      this.#createValidationRunner,
      this.#validationSpawnAuthorizer('custom', selection.captured),
    );
    const version = await validateVersion(runner, signal);
    assertCurrent();
    await assertGitHubCliExecutableCurrent(selection.captured);
    assertCurrent();
    this.#assertSelectionCurrent(selection);
    const binding = this.store.saveGitHubCliBinding(
      StoredGitHubCliBindingSchema.parse({
        schemaVersion: 1,
        executablePath: selection.captured.executablePath,
        executableFileName: selection.captured.executableFileName,
        executableIdentity: selection.captured.executableIdentity,
        version,
        validatedAt: this.#timestamp(),
      }),
    );
    this.#automaticValidation = undefined;
    return { binding, status: customReadyStatus(binding, this.#timestamp()) };
  }

  async #applyAutomaticSelection(
    selection: PendingAutomaticSelection,
    signal: AbortSignal | undefined,
    assertCurrent: () => void,
  ): Promise<ConfirmationResult> {
    assertCurrent();
    const current = await this.#inspectAutomatic();
    assertCurrent();
    const currentCaptured = current.captured;
    if (!optionalExecutablesMatch(selection.captured, currentCaptured)) {
      throw new Error(
        'The automatically found GitHub CLI changed. Review the automatic option again.',
      );
    }
    if (currentCaptured === null) {
      this.#assertSelectionCurrent(selection);
      this.store.clearGitHubCliBinding();
      this.#automaticValidation = undefined;
      return { status: automaticUnavailableStatus(this.#timestamp()) };
    }
    const runner = this.#createIdentityBoundRunner(
      currentCaptured,
      assertCurrent,
      this.#createValidationRunner,
      this.#validationSpawnAuthorizer('automatic', currentCaptured),
    );
    const version = await validateVersion(runner, signal);
    assertCurrent();
    await assertGitHubCliExecutableCurrent(currentCaptured);
    assertCurrent();
    this.#assertSelectionCurrent(selection);
    const validatedAt = this.#timestamp();
    this.store.clearGitHubCliBinding();
    this.#automaticValidation = {
      captured: currentCaptured,
      version,
      validatedAt,
    };
    return {
      status: automaticReadyStatus(currentCaptured, version, validatedAt, this.#timestamp()),
    };
  }

  async #automaticRuntime(): Promise<GitHubCliCommandRuntime> {
    const inspection = await this.#inspectAutomatic();
    if (inspection.captured === null) {
      this.#automaticValidation = undefined;
      return {
        source: 'automatic',
        available: false,
        executable: inspection.runner.executable,
        identityFingerprint: sha256('automatic:missing'),
        review: null,
        status: automaticUnavailableStatus(this.#timestamp()),
        runner: inspection.runner,
      };
    }
    const captured = inspection.captured;
    const status = this.#automaticDetectedStatus(captured, this.#timestamp());
    const ready = status.state === 'ready';
    const runner = ready
      ? this.#createAutomaticCommandRunner(captured)
      : this.#createAutomaticValidationGate(captured);
    const identity =
      status.identity ?? publicIdentity('automatic', captured, null /* structurally unreachable */);
    return {
      source: 'automatic',
      available: ready,
      executable: runner.executable,
      identityFingerprint: identityFingerprint('automatic', captured),
      review: {
        source: 'automatic',
        executablePath: runner.executable,
        identity,
      },
      status,
      runner,
    };
  }

  async #inspectAutomatic(): Promise<AutomaticInspection> {
    const runner = this.#createRunner('gh');
    if (!path.isAbsolute(runner.executable)) {
      if (runner.executableResolution === 'missing') return { runner, captured: null };
      throw new Error('Forgeboard could not confirm whether the GitHub CLI is installed.');
    }
    if (runner.executableResolution !== undefined && runner.executableResolution !== 'resolved') {
      throw new Error('Forgeboard could not verify the GitHub CLI program it found automatically.');
    }
    const captured = await captureGitHubCliExecutable(runner.executable);
    assertRunnerExecutable(runner, captured.executablePath);
    return { runner, captured };
  }

  #createIdentityBoundRunner(
    captured: CapturedGitHubCliExecutable,
    assertCurrent: () => void = () => undefined,
    createRunner: GitHubCliRuntimeDependencies['createRunner'] = this.#createRunner,
    authorizeSpawn: ((args: readonly string[]) => void | Promise<void>) | undefined = undefined,
  ): GitHubCommandRunner {
    const beforeSpawn: GitHubCliBeforeSpawn = async (executable, args) => {
      assertCurrent();
      if (!pathsEqual(executable, captured.executablePath)) {
        throw new Error('The GitHub CLI about to run does not match the reviewed program.');
      }
      await assertGitHubCliExecutableCurrent(captured);
      assertCurrent();
      await authorizeSpawn?.(args);
      assertCurrent();
    };
    const delegate = createRunner(captured.executablePath, beforeSpawn);
    assertRunnerExecutable(delegate, captured.executablePath);
    return {
      executable: delegate.executable,
      run: async (
        args: readonly string[],
        options?: GitHubCommandOptions,
      ): Promise<GitHubCommandResult> => {
        assertCurrent();
        await assertGitHubCliExecutableCurrent(captured);
        assertCurrent();
        const result = await delegate.run(args, options);
        assertCurrent();
        await assertGitHubCliExecutableCurrent(captured);
        assertCurrent();
        assertRunnerExecutable(delegate, captured.executablePath);
        if (!pathsEqual(result.executable, captured.executablePath)) {
          throw new Error('The GitHub CLI returned a response for a different program.');
        }
        return result;
      },
    };
  }

  /**
   * Keeps a passively detected automatic executable unavailable until an outbound, natively
   * reviewed status action runs the exact identity-bound `--version` command successfully. The
   * validation runner is production-wired with a minimal environment, so it receives no ambient
   * GitHub authentication state. Only that literal probe can unlock the normal command runner.
   */
  #createAutomaticValidationGate(captured: CapturedGitHubCliExecutable): GitHubCommandRunner {
    const commandRunner = this.#createAutomaticCommandRunner(captured);
    const validationRunner = this.#createIdentityBoundRunner(
      captured,
      () => undefined,
      this.#createValidationRunner,
      this.#validationSpawnAuthorizer('automatic', captured),
    );
    let validated = false;

    return {
      executable: commandRunner.executable,
      run: async (
        args: readonly string[],
        options?: GitHubCommandOptions,
      ): Promise<GitHubCommandResult> => {
        if (!validated) {
          if (!isVersionCommand(args)) throw automaticValidationRequired();
          this.#assertAutomaticPathCurrent(captured);
          const result = await validationRunner.run(args, options);
          const version = validatedVersion(result);
          this.#assertAutomaticPathCurrent(captured);
          this.#automaticValidation = {
            captured,
            version,
            validatedAt: this.#timestamp(),
          };
          validated = true;
          return result;
        }
        return await commandRunner.run(args, options);
      },
    };
  }

  #createAutomaticCommandRunner(captured: CapturedGitHubCliExecutable): GitHubCommandRunner {
    const runner = this.#createIdentityBoundRunner(captured);
    return {
      executable: runner.executable,
      run: async (
        args: readonly string[],
        options?: GitHubCommandOptions,
      ): Promise<GitHubCommandResult> => {
        this.#assertAutomaticPathCurrent(captured);
        return await runner.run(args, options);
      },
    };
  }

  #validationSpawnAuthorizer(
    source: GitHubCliSource,
    captured: CapturedGitHubCliExecutable,
  ): (args: readonly string[]) => Promise<void> {
    return async (args) => {
      if (!isVersionCommand(args)) {
        throw new Error('GitHub CLI validation may run only the exact --version command.');
      }
      await this.#authorizeValidationSpawn({
        kind: 'version',
        source,
        identity: publicIdentity(source, captured, null),
        arguments: VERSION_ARGUMENTS,
        credentialAccess: false,
      });
    };
  }

  #assertAutomaticPathCurrent(captured: CapturedGitHubCliExecutable): void {
    const current = this.#createRunner('gh');
    if (
      this.store.getGitHubCliBinding() !== undefined ||
      !path.isAbsolute(current.executable) ||
      (current.executableResolution !== undefined && current.executableResolution !== 'resolved') ||
      !pathsEqual(current.executable, captured.executablePath)
    ) {
      throw new Error(
        'The automatically found GitHub CLI changed during the version check. Check GitHub again.',
      );
    }
  }

  #automaticDetectedStatus(
    captured: CapturedGitHubCliExecutable,
    checkedAt: string,
  ): GitHubCliPublicStatus {
    const validation = this.#automaticValidation;
    if (validation === undefined) return automaticUnverifiedStatus(captured, checkedAt);
    if (!sameGitHubCliExecutable(validation.captured, captured)) {
      this.#automaticValidation = undefined;
      return automaticUnverifiedStatus(captured, checkedAt);
    }
    return automaticReadyStatus(captured, validation.version, validation.validatedAt, checkedAt);
  }

  #addSelection(
    ownerId: string,
    input:
      | Pick<PendingCustomSelection, 'source' | 'captured'>
      | Pick<PendingAutomaticSelection, 'source' | 'captured'>,
  ): GitHubCliSelectionPlan {
    assertOwnerId(ownerId);
    this.#discardExpired();
    this.#makeCapacity(ownerId);
    const now = this.#validNow();
    const expiresAtMs = now.getTime() + SELECTION_TTL_MS;
    const selection: PendingSelection = {
      ...input,
      planId: this.#validId(),
      ownerId,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expectedConfigurationFingerprint: this.#configurationFingerprint(),
      expectedSelectionRevision: this.#selectionRevision,
    };
    this.#pending.set(selection.planId, selection);
    return publicSelection(selection);
  }

  #takeSelection(ownerId: string, planId: string): PendingSelection {
    assertOwnerId(ownerId);
    this.#discardExpired();
    const selection = this.#pending.get(planId);
    if (selection === undefined || selection.ownerId !== ownerId) {
      throw new Error(
        'The GitHub CLI review is missing, expired, already used, or belongs to another window.',
      );
    }
    this.#pending.delete(planId);
    return selection;
  }

  #assertSelectionCurrent(selection: PendingSelection): void {
    if (
      selection.expectedSelectionRevision !== this.#selectionRevision ||
      selection.expectedConfigurationFingerprint !== this.#configurationFingerprint()
    ) {
      throw new Error('The GitHub CLI setup changed. Review the selection again.');
    }
  }

  #configurationFingerprint(): string {
    const binding = this.store.getGitHubCliBinding();
    return sha256(
      JSON.stringify(
        binding === undefined
          ? { source: 'automatic' }
          : {
              source: 'custom',
              binding: StoredGitHubCliBindingSchema.parse(binding),
            },
      ),
    );
  }

  #makeCapacity(ownerId: string): void {
    const owned = [...this.#pending.values()].filter((selection) => selection.ownerId === ownerId);
    if (owned.length >= MAX_PENDING_PER_OWNER) this.#pending.delete(owned[0]!.planId);
    if (this.#pending.size >= MAX_PENDING_SELECTIONS) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
  }

  #discardExpired(): void {
    const nowMs = this.#validNow().getTime();
    for (const [planId, selection] of this.#pending) {
      if (selection.expiresAtMs <= nowMs) this.#pending.delete(planId);
    }
  }

  #validId(): string {
    const id = this.#createId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new Error('GitHub CLI selection IDs must be UUIDs.');
    }
    if (this.#pending.has(id)) throw new Error('GitHub CLI selection IDs must be unique.');
    return id;
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new Error('GitHub CLI runtime time must be valid.');
    return now;
  }

  #timestamp(): string {
    return this.#validNow().toISOString();
  }
}

function publicSelection(selection: PendingSelection): GitHubCliSelectionPlan {
  return {
    kind: 'github-cli-selection',
    planId: selection.planId,
    expiresAt: selection.expiresAt,
    source: selection.source,
    candidate:
      selection.captured === null
        ? null
        : publicIdentity(selection.source, selection.captured, null),
    networkAccess: false,
  };
}

function selectionReview(selection: PendingSelection): GitHubCliSelectionReview {
  return {
    ...publicSelection(selection),
    executablePath: selection.captured?.executablePath ?? null,
    versionArguments: selection.captured === null ? null : VERSION_ARGUMENTS,
  };
}

function capturedFromBinding(binding: StoredGitHubCliBinding): CapturedGitHubCliExecutable {
  const parsed = StoredGitHubCliBindingSchema.parse(binding);
  return {
    executablePath: parsed.executablePath,
    executableFileName: parsed.executableFileName,
    executableIdentity: parsed.executableIdentity,
  };
}

function publicIdentity(
  source: GitHubCliSource,
  captured: CapturedGitHubCliExecutable,
  version: string | null,
): GitHubCliPublicIdentity {
  return {
    source,
    filename: captured.executableFileName,
    sizeBytes: captured.executableIdentity.size,
    sha256: captured.executableIdentity.sha256,
    version,
  };
}

function customReadyStatus(
  binding: StoredGitHubCliBinding,
  checkedAt: string,
): GitHubCliPublicStatus {
  return {
    source: 'custom',
    state: 'ready',
    identity: publicIdentity('custom', capturedFromBinding(binding), binding.version),
    verifiedAt: binding.validatedAt,
    checkedAt,
  };
}

function customChangedStatus(
  binding: StoredGitHubCliBinding,
  checkedAt: string,
): GitHubCliPublicStatus {
  return {
    source: 'custom',
    state: 'changed',
    identity: publicIdentity('custom', capturedFromBinding(binding), binding.version),
    verifiedAt: null,
    checkedAt,
  };
}

function customUnavailableStatus(checkedAt: string): GitHubCliPublicStatus {
  return {
    source: 'custom',
    state: 'unavailable',
    identity: null,
    verifiedAt: null,
    checkedAt,
  };
}

function automaticUnavailableStatus(checkedAt: string): GitHubCliPublicStatus {
  return {
    source: 'automatic',
    state: 'unavailable',
    identity: null,
    verifiedAt: null,
    checkedAt,
  };
}

function automaticUnverifiedStatus(
  captured: CapturedGitHubCliExecutable,
  checkedAt: string,
): GitHubCliPublicStatus {
  return {
    source: 'automatic',
    state: 'unverified',
    identity: publicIdentity('automatic', captured, null),
    verifiedAt: null,
    checkedAt,
  };
}

function automaticReadyStatus(
  captured: CapturedGitHubCliExecutable,
  version: string,
  verifiedAt: string,
  checkedAt: string,
): GitHubCliPublicStatus {
  return {
    source: 'automatic',
    state: 'ready',
    identity: publicIdentity('automatic', captured, version),
    verifiedAt,
    checkedAt,
  };
}

async function validateVersion(
  runner: GitHubCommandRunner,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runner.run(VERSION_ARGUMENTS, {
    allowNonZeroExit: true,
    timeoutMs: 10_000,
    ...(signal === undefined ? {} : { signal }),
  });
  return validatedVersion(result);
}

function validatedVersion(result: GitHubCommandResult): string {
  if (result.exitCode !== 0) {
    throw new Error('The selected program did not finish the GitHub CLI version check.');
  }
  const version = parseGitHubCliVersion(result.stdout);
  if (version === null) {
    throw new Error('The selected program did not return a valid GitHub CLI version.');
  }
  return version;
}

function isVersionCommand(args: readonly string[]): boolean {
  return args.length === VERSION_ARGUMENTS.length && args[0] === VERSION_ARGUMENTS[0];
}

function automaticValidationRequired(): Error {
  return new Error(
    'Forgeboard found the GitHub CLI automatically but has not verified it yet. Use Check GitHub, or review the automatic setup in Settings, before signing in or running GitHub commands.',
  );
}

function parseGitHubCliVersion(stdout: string): string | null {
  const version = /^gh version ([A-Za-z0-9][A-Za-z0-9.+_-]*)(?:\s|$)/mu.exec(stdout)?.[1];
  return version !== undefined && version.length <= 128 ? version : null;
}

function identityFingerprint(
  source: GitHubCliSource,
  executable: CapturedGitHubCliExecutable,
): string {
  return sha256(JSON.stringify({ source, ...executable }));
}

function optionalExecutablesMatch(
  left: CapturedGitHubCliExecutable | null,
  right: CapturedGitHubCliExecutable | null,
): boolean {
  return left === null || right === null ? left === right : sameGitHubCliExecutable(left, right);
}

function assertRunnerExecutable(runner: GitHubCommandRunner, expected: string): void {
  if (!pathsEqual(runner.executable, expected)) {
    throw new Error('The GitHub CLI runner does not match the selected program.');
  }
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertOwnerId(ownerId: string): void {
  if (
    ownerId.length < 1 ||
    ownerId.length > 512 ||
    [...ownerId].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error('GitHub CLI selection owner identity is invalid.');
  }
}

async function directAdmission<Output>(operation: () => Promise<Output>): Promise<Output> {
  return await operation();
}

export function gitHubCliSelectionsMatch(
  binding: StoredGitHubCliBinding,
  captured: CapturedGitHubCliExecutable,
): boolean {
  return sameGitHubCliExecutable(capturedFromBinding(binding), captured);
}
