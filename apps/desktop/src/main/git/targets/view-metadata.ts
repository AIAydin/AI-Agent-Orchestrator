import type { GitReviewTargetView, GitTargetInput } from '../../../shared/git/contracts.js';

export function targetInput(target: GitReviewTargetView): GitTargetInput {
  return target.kind === 'primary'
    ? target
    : { kind: target.kind, projectId: target.projectId, runId: target.runId };
}

export function targetKey(target: GitReviewTargetView): string {
  return target.kind === 'primary'
    ? `primary:${target.projectId}`
    : `agent-worktree:${target.projectId}:${target.runId}`;
}

export function auditTargetMetadata(target: GitReviewTargetView): Record<string, unknown> {
  return target.kind === 'primary'
    ? { projectId: target.projectId, targetKind: target.kind }
    : {
        projectId: target.projectId,
        targetKind: target.kind,
        runId: target.runId,
        worktreeId: target.worktreeId,
      };
}

export function auditInputTargetMetadata(target: GitTargetInput): Record<string, unknown> {
  return {
    projectId: target.projectId,
    targetKind: target.kind,
    ...(target.kind === 'agent-worktree' ? { runId: target.runId } : {}),
  };
}
