import {
  currentReviewGateEvidence,
  parseWorkflowExecutionRuntime,
  type OutputPublication,
  type WorkflowExecutionRuntime,
} from '@forgeboard/core';
import type { CanvasNode } from '@forgeboard/core/domain';
import type { RepositoryService } from '@forgeboard/git-engine';

import { CheckIdSchema, type CheckId } from '../../../shared/checks/contracts.js';
import {
  GitDeliveryWorkflowBindingSchema,
  type GitDeliveryReadinessTarget,
  type GitDeliveryCompatibleWorkflowExecution,
  type GitDeliveryWorkflowBinding,
  type GitDeliverySourceIdentity,
} from '../../../shared/git/readiness/index.js';
import type { WorkflowExecutionRecord } from '../../storage/workflow/contracts.js';
import type { GitTargetResolver } from '../git-target-resolver.js';
import { stableSha256 } from './fingerprints.js';
import { assertReviewedGitIdentity } from './reviewed-git-identity.js';

export interface WorkflowExecutionReader {
  getWorkflowExecution(executionId: string): WorkflowExecutionRecord | undefined;
  listProjectWorkflowExecutions(
    projectId: string,
    options?: { readonly canvasId?: string; readonly limit?: number },
  ): WorkflowExecutionRecord[];
}

export interface BoundWorkflowGateAuthority {
  readonly binding: GitDeliveryWorkflowBinding;
  readonly mandatoryCheckIds: readonly CheckId[];
}

export interface DeliveryWorkflowGateOperations {
  bind(target: GitDeliveryReadinessTarget, executionId: string): BoundWorkflowGateAuthority;
  assertCurrent(
    target: GitDeliveryReadinessTarget,
    expected: GitDeliveryWorkflowBinding,
  ): BoundWorkflowGateAuthority;
  assertReviewedGitIdentity(
    target: GitDeliveryReadinessTarget,
    expected: GitDeliveryWorkflowBinding,
    expectedSource: GitDeliverySourceIdentity,
    expectedBaseCommit?: string,
  ): Promise<void>;
  listCompatible(target: GitDeliveryReadinessTarget): GitDeliveryCompatibleWorkflowExecution[];
}

/** Main-owned authority for turning one exact successful workflow result into delivery evidence. */
export class DeliveryWorkflowGateAuthority {
  public constructor(
    private readonly executions: WorkflowExecutionReader,
    private readonly targets?: GitTargetResolver,
    private readonly repositories?: RepositoryService,
  ) {}

  public bind(target: GitDeliveryReadinessTarget, executionId: string): BoundWorkflowGateAuthority {
    const execution = this.executions.getWorkflowExecution(executionId);
    if (execution === undefined) throw new Error('The selected workflow execution does not exist.');
    if (execution.projectId !== target.projectId) {
      throw new Error('The selected workflow execution belongs to another project.');
    }
    if (execution.status !== 'succeeded') {
      throw new Error('The selected workflow execution has not succeeded.');
    }

    const runtime = parseWorkflowExecutionRuntime(execution.runtime.payload);
    if (
      runtime.run.id !== execution.id ||
      runtime.run.canvasId !== execution.canvasId ||
      runtime.canvas.id !== execution.canvasId ||
      runtime.run.status !== 'succeeded'
    ) {
      throw new Error('The workflow execution record does not match its succeeded runtime.');
    }
    const matching = matchingPassedGates(runtime, target.runId);
    if (matching.length === 0) {
      throw new Error('No passed Review Gate currently validates this managed agent run.');
    }

    const sourceNodeIds = new Set(matching.map((entry) => entry.sourceNodeId));
    const sourceAttempts = new Set(matching.map((entry) => entry.sourceAttempt));
    const outputDigests = new Set(matching.map((entry) => entry.sourceOutputDigest));
    if (sourceNodeIds.size !== 1 || sourceAttempts.size !== 1 || outputDigests.size !== 1) {
      throw new Error('Matching Review Gates do not bind one exact workflow source output.');
    }

    const gates = matching
      .map((entry) => ({
        gateNodeId: entry.gate.id,
        gateAttempt: entry.gateAttempt,
        evidenceDigest: entry.evidenceDigest,
        derivedCheckIds: entry.derivedCheckIds,
      }))
      .sort((left, right) => left.gateNodeId.localeCompare(right.gateNodeId));
    const bindingAuthority = {
      executionId: execution.id,
      executionRevision: execution.revision,
      canvasId: execution.canvasId,
      sourceNodeId: matching[0]!.sourceNodeId,
      sourceAttempt: matching[0]!.sourceAttempt,
      sourceOutputDigest: matching[0]!.sourceOutputDigest,
      gates,
    };
    const binding = GitDeliveryWorkflowBindingSchema.parse({
      ...bindingAuthority,
      bindingDigest: stableSha256({ schemaVersion: 1, ...bindingAuthority }),
    });
    return {
      binding,
      mandatoryCheckIds: uniqueChecks(gates.flatMap((gate) => gate.derivedCheckIds)),
    };
  }

  public listCompatible(
    target: GitDeliveryReadinessTarget,
  ): GitDeliveryCompatibleWorkflowExecution[] {
    return this.executions
      .listProjectWorkflowExecutions(target.projectId, { limit: 100 })
      .flatMap((execution) => {
        if (execution.status !== 'succeeded') return [];
        try {
          const authority = this.bind(target, execution.id);
          return [
            {
              executionId: execution.id,
              canvasId: execution.canvasId,
              executionRevision: execution.revision,
              endedAt: execution.updatedAt,
              derivedCheckIds: [...authority.mandatoryCheckIds],
            },
          ];
        } catch {
          return [];
        }
      });
  }

  public assertCurrent(
    target: GitDeliveryReadinessTarget,
    expected: GitDeliveryWorkflowBinding,
  ): BoundWorkflowGateAuthority {
    const current = this.bind(target, expected.executionId);
    if (
      current.binding.bindingDigest !== expected.bindingDigest ||
      JSON.stringify(current.binding) !== JSON.stringify(expected)
    ) {
      throw new Error('The workflow Review Gate evidence changed after readiness was prepared.');
    }
    return current;
  }

  public async assertReviewedGitIdentity(
    target: GitDeliveryReadinessTarget,
    expected: GitDeliveryWorkflowBinding,
    expectedSource: GitDeliverySourceIdentity,
    expectedBaseCommit?: string,
  ): Promise<void> {
    if (this.targets === undefined || this.repositories === undefined) {
      throw new Error('Reviewed Git identity verification is unavailable.');
    }
    this.assertCurrent(target, expected);
    const execution = this.executions.getWorkflowExecution(expected.executionId);
    if (execution === undefined) throw new Error('The selected workflow execution does not exist.');
    const runtime = parseWorkflowExecutionRuntime(execution.runtime.payload);
    const output = runtime.evidence.nodeCompletionOutputs[expected.sourceNodeId];
    if (
      output === undefined ||
      output.runId !== expected.executionId ||
      output.nodeId !== expected.sourceNodeId ||
      output.nodeAttempt !== expected.sourceAttempt ||
      output.sourceRunId !== target.runId ||
      output.contentDigest !== `sha256:${expected.sourceOutputDigest}`
    ) {
      throw new Error('The workflow binding has no exact private reviewed output artifact.');
    }
    const resolved = await this.targets.resolve(target);
    if (
      resolved.ownership.id !== expectedSource.worktreeId ||
      resolved.state.branchOid !== expectedSource.sourceHead ||
      (expectedBaseCommit !== undefined && resolved.ownership.baseCommit !== expectedBaseCommit)
    ) {
      throw new Error('The managed Git authority changed during reviewed-output verification.');
    }
    await assertReviewedGitIdentity(this.repositories, {
      sourceRunId: target.runId,
      artifactWorktreePath: output.worktreePath,
      artifactContent: output.artifactContent,
      artifactDigest: expected.sourceOutputDigest,
      worktreePath: resolved.worktreeRepositoryPath,
      baseCommit: expectedBaseCommit ?? resolved.ownership.baseCommit,
      sourceHead: expectedSource.sourceHead,
      expectedSourceTree: expectedSource.sourceTree,
    });
  }
}

interface MatchingGate {
  readonly gate: Extract<CanvasNode, { type: 'review-gate' }>;
  readonly gateAttempt: number;
  readonly sourceNodeId: string;
  readonly sourceAttempt: number;
  readonly sourceOutputDigest: string;
  readonly derivedCheckIds: readonly CheckId[];
  readonly evidenceDigest: string;
}

function matchingPassedGates(
  runtime: WorkflowExecutionRuntime,
  targetRunId: string,
): MatchingGate[] {
  const referenceId = `agent-run:${targetRunId}`;
  const result: MatchingGate[] = [];
  for (const gate of runtime.canvas.nodes) {
    if (gate.type !== 'review-gate') continue;
    const sourceNodeIds = reviewedSourceIds(runtime, gate.id);
    const relevantSourceNodeIds = sourceNodeIds.filter((sourceNodeId) =>
      currentSourcePublications(runtime, sourceNodeId).some((publication) =>
        publication.referenceIds.includes(referenceId),
      ),
    );
    if (relevantSourceNodeIds.length === 0) continue;
    if (sourceNodeIds.length !== 1 || relevantSourceNodeIds.length !== 1) {
      throw new Error(`Review Gate ${gate.id} has ambiguous reviewed sources for this agent run.`);
    }
    assertProductionReviewer(runtime, gate);
    const sourceNodeId = sourceNodeIds[0]!;
    const sourceRun = runtime.run.nodeRuns[sourceNodeId];
    const gateRun = runtime.run.nodeRuns[gate.id];
    if (sourceRun === undefined) {
      throw new Error(`Review Gate ${gate.id} has no current reviewed source attempt.`);
    }
    if (gateRun?.status !== 'succeeded') {
      throw new Error(`Review Gate ${gate.id} did not succeed for this agent run.`);
    }
    const publications = currentSourcePublications(runtime, sourceNodeId).filter((publication) =>
      publication.referenceIds.includes(referenceId),
    );
    if (publications.length === 0) continue;
    const completionOutput = runtime.evidence.nodeCompletionOutputs[sourceNodeId];
    if (
      completionOutput === undefined ||
      completionOutput.runId !== runtime.run.id ||
      completionOutput.nodeId !== sourceNodeId ||
      completionOutput.nodeAttempt !== sourceRun.attempt ||
      completionOutput.sourceRunId !== targetRunId
    ) {
      throw new Error(`Review Gate ${gate.id} has no exact current reviewed completion output.`);
    }
    const evidence = currentReviewGateEvidence(runtime, gate.id);
    if (evidence.evaluation.status !== 'passed') {
      throw new Error(`Review Gate ${gate.id} is not currently passing.`);
    }
    const derivedCheckIds = gateCheckIds(gate);
    const sourceOutputDigest = parseOutputDigest(completionOutput.contentDigest);
    result.push({
      gate,
      gateAttempt: gateRun.attempt,
      sourceNodeId,
      sourceAttempt: sourceRun.attempt,
      sourceOutputDigest,
      derivedCheckIds,
      evidenceDigest: stableSha256({
        schemaVersion: 1,
        workflowRunId: runtime.run.id,
        gateNode: gate,
        gateRun,
        sourceNodeId,
        sourceRun,
        completionOutput,
        publications,
        checks: evidence.checks,
        reviewerAssessment: evidence.reviewerAssessment ?? null,
        humanApproval: runtime.evidence.humanApprovals[gate.id] ?? null,
        evaluation: evidence.evaluation,
      }),
    });
  }
  return result;
}

function assertProductionReviewer(
  runtime: WorkflowExecutionRuntime,
  gate: Extract<CanvasNode, { type: 'review-gate' }>,
): void {
  const reviewerId = gate.data.reviewerAgentId;
  if (reviewerId === undefined) return;
  const reviewer = runtime.canvas.nodes.find((node) => node.id === reviewerId);
  if (reviewer?.type !== 'agent') {
    throw new Error(`Review Gate ${gate.id} has no valid configured reviewer agent.`);
  }
}

function reviewedSourceIds(runtime: WorkflowExecutionRuntime, gateNodeId: string): string[] {
  const ids = new Set<string>();
  for (const edge of runtime.canvas.edges) {
    if (edge.type === 'review' && edge.targetNodeId === gateNodeId) ids.add(edge.sourceNodeId);
    if (
      edge.type === 'execute' &&
      edge.config.approval === 'review-gate' &&
      edge.config.approvalGateNodeId === gateNodeId
    ) {
      ids.add(edge.sourceNodeId);
    }
  }
  for (const loop of runtime.canvas.revisionLoops) {
    if (loop.reviewNodeId === gateNodeId) ids.add(loop.implementationNodeId);
  }
  return [...ids].sort();
}

function currentSourcePublications(
  runtime: WorkflowExecutionRuntime,
  sourceNodeId: string,
): OutputPublication[] {
  const attempt = runtime.run.nodeRuns[sourceNodeId]?.attempt;
  return Object.values(runtime.evidence.outputPublications)
    .filter(
      (publication) =>
        publication.runId === runtime.run.id &&
        publication.producerNodeId === sourceNodeId &&
        publication.producerAttempt === attempt,
    )
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function gateCheckIds(gate: Extract<CanvasNode, { type: 'review-gate' }>): CheckId[] {
  const values = [
    ...gate.data.requiredCheckIds,
    ...(gate.data.lintRequired ? ['lint'] : []),
    ...(gate.data.testsRequired ? ['test'] : []),
  ];
  return uniqueChecks(values.map((value) => CheckIdSchema.parse(value)));
}

function uniqueChecks(checkIds: readonly CheckId[]): CheckId[] {
  return [...new Set(checkIds)].sort((left, right) => String(left).localeCompare(String(right)));
}

function parseOutputDigest(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(value);
  if (match === null) throw new Error('The reviewed workflow output has no exact SHA-256 digest.');
  return match[1]!;
}
