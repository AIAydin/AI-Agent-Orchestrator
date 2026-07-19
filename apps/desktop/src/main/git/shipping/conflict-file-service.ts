import { createHash, randomUUID } from 'node:crypto';

import { loadProjectIgnoreMatcher } from '@forgeboard/core';
import type { BrowserWindow, Dialog } from 'electron';

import { assertFileContentAllowed } from '../../file-domain/policy.js';
import { readProjectDocument } from '../../file-domain/reader.js';
import { saveProjectDocument } from '../../file-domain/writer.js';
import type { GitReviewTargetView } from '../../../shared/git/contracts.js';
import {
  GitConflictFileViewSchema,
  GitConflictInspectionViewSchema,
  GitConflictResolutionPlanViewSchema,
  type GitConflictInspectionInput,
  type GitConflictInspectionView,
  type GitConflictResolutionPlanView,
  type GitConflictResolutionPrepareInput,
  type GitConflictResolutionResultView,
} from '../../../shared/git/conflict-resolution/contracts.js';
import type { ConflictRecoveryTarget } from './conflict-recovery-service.js';
import { conflictFileConfirmation } from './conflict-file-confirmation.js';
import type {
  ChangeService,
  InProgressGitOperation,
  RepositoryService,
} from '@forgeboard/git-engine';

const MAX_BYTES = 512 * 1024;
const MAX_CONFLICTS = 32;
const PLAN_TTL_MS = 5 * 60_000;

export interface PendingConflictFileResolution {
  readonly id: string;
  readonly ownerId: number;
  readonly expiresAtMs: number;
  readonly target: GitReviewTargetView;
  readonly repositoryRoot: string;
  readonly operation: InProgressGitOperation;
  readonly path: string;
  readonly expectedSha256: string;
  readonly content: string;
  readonly resolvedSha256: string;
  readonly sizeBytes: number;
}

interface Dependencies {
  readonly dialog: Pick<Dialog, 'showMessageBox'>;
  readonly repositories: RepositoryService;
  readonly changes: ChangeService;
  readonly resolveTarget: (
    input: GitConflictInspectionInput['target'],
  ) => Promise<ConflictRecoveryTarget>;
  readonly audit: (
    action: string,
    outcome: 'allowed' | 'denied',
    metadata: Record<string, unknown>,
  ) => void;
}

export class ConflictFileService {
  readonly #plans = new Map<string, PendingConflictFileResolution>();
  public constructor(private readonly dependencies: Dependencies) {}

  public async inspect(input: GitConflictInspectionInput): Promise<GitConflictInspectionView> {
    const target = await this.dependencies.resolveTarget(input.target);
    return await this.#inspectTarget(target);
  }

  public async prepare(
    ownerId: number,
    input: GitConflictResolutionPrepareInput,
  ): Promise<GitConflictResolutionPlanView> {
    const target = await this.dependencies.resolveTarget(input.target);
    const inspection = await this.#inspectTarget(target);
    const file = inspection.files.find((candidate) => candidate.path === input.path);
    if (file === undefined) throw new Error('That path is no longer conflicted. Refresh recovery.');
    if (file.currentSha256 !== input.expectedSha256)
      throw new Error('Conflict content changed. Refresh before applying a resolution.');
    const bytes = Buffer.from(input.content, 'utf8');
    if (bytes.byteLength > MAX_BYTES) throw new Error('Resolved conflict content is too large.');
    const plan: PendingConflictFileResolution = {
      id: randomUUID(),
      ownerId,
      expiresAtMs: Date.now() + PLAN_TTL_MS,
      target: inspection.target,
      repositoryRoot: target.repositoryRoot,
      operation: inspection.operation,
      path: input.path,
      expectedSha256: input.expectedSha256,
      content: input.content,
      resolvedSha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    };
    this.#plans.set(plan.id, plan);
    return GitConflictResolutionPlanViewSchema.parse({
      planId: plan.id,
      expiresAt: new Date(plan.expiresAtMs).toISOString(),
      target: plan.target,
      operation: plan.operation,
      path: plan.path,
      expectedSha256: plan.expectedSha256,
      resolvedSha256: plan.resolvedSha256,
      sizeBytes: plan.sizeBytes,
    });
  }

  public async confirm(options: {
    ownerId: number;
    planId: string;
    parent: BrowserWindow;
    assertCurrent: () => void;
  }): Promise<GitConflictResolutionResultView | null> {
    const plan = this.#plans.get(options.planId);
    this.#plans.delete(options.planId);
    if (plan === undefined || plan.ownerId !== options.ownerId || plan.expiresAtMs <= Date.now()) {
      throw new Error(
        'The conflict resolution plan is missing, expired, or belongs to another window.',
      );
    }
    const decision = await this.dependencies.dialog.showMessageBox(
      options.parent,
      conflictFileConfirmation(plan),
    );
    options.assertCurrent();
    const metadata = this.#auditMetadata(plan);
    if (decision.response !== 1) {
      this.dependencies.audit('resolve-conflict-file', 'denied', {
        ...metadata,
        reason: 'native-confirmation-cancelled',
      });
      return null;
    }
    const target = await this.dependencies.resolveTarget(targetInput(plan.target));
    if (
      target.repositoryRoot !== plan.repositoryRoot ||
      JSON.stringify(target.view) !== JSON.stringify(plan.target)
    )
      throw new Error('The conflict workspace changed after review.');
    const inspection = await this.#inspectTarget(target);
    const current = inspection.files.find((file) => file.path === plan.path);
    if (inspection.operation !== plan.operation || current?.currentSha256 !== plan.expectedSha256) {
      throw new Error('The conflict operation or file changed after review.');
    }
    const matcher = await loadProjectIgnoreMatcher(plan.repositoryRoot);
    assertFileContentAllowed(matcher, plan.path);
    await saveProjectDocument(
      plan.repositoryRoot,
      plan.target.projectId,
      plan.path,
      plan.content,
      plan.expectedSha256,
      {
        maxTextBytes: MAX_BYTES,
        beforeFinalValidation: () => {
          options.assertCurrent();
          this.dependencies.audit('resolve-conflict-file-write', 'allowed', {
            ...metadata,
            phase: 'authorized-before-write',
          });
          return Promise.resolve();
        },
      },
    );
    const latest = await this.dependencies.changes.continuationState(plan.repositoryRoot);
    if (latest.operation !== plan.operation || !latest.conflictedPaths.includes(plan.path)) {
      throw new Error('The conflict state changed before staging. Refresh recovery.');
    }
    await this.dependencies.changes.stageExactContent(
      plan.repositoryRoot,
      plan.path,
      Buffer.from(plan.content, 'utf8'),
      {
        beforeApply: () => {
          options.assertCurrent();
          this.dependencies.audit('resolve-conflict-file-stage', 'allowed', {
            ...metadata,
            phase: 'authorized-before-stage',
          });
        },
      },
    );
    const remaining = await this.dependencies.changes.continuationState(plan.repositoryRoot);
    return {
      stagedPath: plan.path,
      inspection: remaining.conflictedPaths.length === 0 ? null : await this.#inspectTarget(target),
    };
  }

  public clearOwner(ownerId: number): void {
    for (const [id, plan] of this.#plans) if (plan.ownerId === ownerId) this.#plans.delete(id);
  }
  public clear(): void {
    this.#plans.clear();
  }

  async #inspectTarget(target: ConflictRecoveryTarget): Promise<GitConflictInspectionView> {
    const state = await this.dependencies.changes.continuationState(target.repositoryRoot);
    if (state.operation === null || state.conflictedPaths.length === 0)
      throw new Error('There are no active text conflicts to resolve.');
    if (state.conflictedPaths.length > MAX_CONFLICTS)
      throw new Error(
        `Resolve the conflict set in smaller steps; more than ${String(MAX_CONFLICTS)} paths are active.`,
      );
    const matcher = await loadProjectIgnoreMatcher(target.repositoryRoot);
    const files = await Promise.all(
      state.conflictedPaths.map(async (path) => {
        assertFileContentAllowed(matcher, path);
        const current = await readProjectDocument(
          target.repositoryRoot,
          target.view.projectId,
          path,
          { maxTextBytes: MAX_BYTES },
        );
        if (current.contentKind !== 'text' || current.content === null || current.sha256 === null)
          throw new Error('Inline resolution supports bounded UTF-8 text conflicts only.');
        return GitConflictFileViewSchema.parse({
          path,
          current: current.content,
          currentSha256: current.sha256,
          base: await this.#stageText(target.repositoryRoot, 1, path),
          ours: await this.#stageText(target.repositoryRoot, 2, path),
          theirs: await this.#stageText(target.repositoryRoot, 3, path),
        });
      }),
    );
    return GitConflictInspectionViewSchema.parse({
      target: target.view,
      operation: state.operation,
      files,
    });
  }

  async #stageText(root: string, stage: 1 | 2 | 3, path: string): Promise<string | null> {
    const result = await this.dependencies.repositories.git.run(
      ['-C', root, 'cat-file', 'blob', `:${String(stage)}:${path}`],
      { allowNonZeroExit: true, maxOutputBytes: MAX_BYTES + 1 },
    );
    if (result.exitCode !== 0) return null;
    if (Buffer.byteLength(result.stdout, 'utf8') > MAX_BYTES || result.stdout.includes('\0'))
      throw new Error('Inline resolution supports bounded UTF-8 text conflicts only.');
    return result.stdout;
  }

  #auditMetadata(plan: PendingConflictFileResolution): Record<string, unknown> {
    return {
      targetKind: plan.target.kind,
      projectId: plan.target.projectId,
      ...(plan.target.kind === 'agent-worktree' ? { runId: plan.target.runId } : {}),
      operation: plan.operation,
      pathSha256: sha256(Buffer.from(plan.path, 'utf8')),
      expectedSha256: plan.expectedSha256,
      resolvedSha256: plan.resolvedSha256,
      sizeBytes: plan.sizeBytes,
    };
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function targetInput(target: GitReviewTargetView): GitConflictInspectionInput['target'] {
  return target.kind === 'primary'
    ? target
    : { kind: 'agent-worktree', projectId: target.projectId, runId: target.runId };
}
