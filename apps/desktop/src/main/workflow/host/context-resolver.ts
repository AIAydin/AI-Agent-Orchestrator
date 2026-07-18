import { createHash } from 'node:crypto';

import {
  buildAttachmentManifest,
  contextAttachmentsForNode,
  type AttachmentManifest,
  type CanvasNode,
} from '@forgeboard/core';

import type { LocalStore } from '../../storage.js';
import type {
  WorkflowAgentContextResolution,
  WorkflowAgentContextResolutionRequest,
} from '../agents/executor-contracts.js';
import type {
  WorkflowContextEvidenceProof,
  WorkflowContextEvidenceRequest,
} from '../evidence/contracts.js';
import { WORKFLOW_EVIDENCE_VERIFIER_ID } from '../evidence/contracts.js';
import { assignedAgentForTask } from '../agents/task-delegation.js';

export type WorkflowContextResolverStore = Pick<LocalStore, 'getProject' | 'appendAudit'>;

/** Resolves opaque canvas attachment IDs to policy-checked local files in the main process. */
export class FileNodeWorkflowContextResolver {
  public constructor(private readonly store: WorkflowContextResolverStore) {}

  public readonly resolve = async (
    request: WorkflowAgentContextResolutionRequest,
  ): Promise<WorkflowAgentContextResolution> => {
    try {
      const resolution = await this.#resolve(request);
      this.store.appendAudit('workflow-context', 'resolve', 'allowed', {
        executionId: request.executionId,
        projectId: request.projectId,
        nodeId: request.nodeId,
        attempt: request.attempt,
        attachmentIds: [...request.attachmentIds],
        manifestId: resolution.manifestId ?? null,
        manifestDigest: resolution.manifestDigest ?? null,
      });
      return resolution;
    } catch (error) {
      this.store.appendAudit('workflow-context', 'resolve', 'denied', {
        executionId: request.executionId,
        projectId: request.projectId,
        nodeId: request.nodeId,
        attempt: request.attempt,
        attachmentIds: [...request.attachmentIds],
        reason: errorMessage(error),
      });
      throw error;
    }
  };

  /** Supplies the same policy-checked file hashes to deterministic context-edge provenance. */
  public readonly resolveEvidence = async (
    request: WorkflowContextEvidenceRequest,
  ): Promise<WorkflowContextEvidenceProof> => {
    try {
      const project = this.store.getProject(request.projectId);
      if (project === undefined || project.missing) {
        throw new Error('The workflow context project is no longer available.');
      }
      const manifest = await buildAttachmentManifest({
        projectId: request.projectId,
        projectRoot: project.path,
        receivingAdapterId: 'forgeboard-workflow',
        receivingProvider: 'Forgeboard local workflow verifier',
        relativePaths: request.files.map((file) => file.relativePath),
      });
      const proof = {
        schemaVersion: 1 as const,
        attachmentIds: request.files.map((file) => file.attachmentId),
        contentDigest: manifestDigest(manifest),
      };
      this.store.appendAudit('workflow-context', 'verify-edge', 'allowed', {
        executionId: request.executionId,
        projectId: request.projectId,
        edgeId: request.edgeId,
        targetNodeId: request.targetNodeId,
        targetAttempt: request.targetAttempt,
        attachmentIds: proof.attachmentIds,
        contentDigest: proof.contentDigest,
      });
      return proof;
    } catch (error) {
      this.store.appendAudit('workflow-context', 'verify-edge', 'denied', {
        executionId: request.executionId,
        projectId: request.projectId,
        edgeId: request.edgeId,
        attachmentIds: request.files.map((file) => file.attachmentId),
        reason: errorMessage(error),
      });
      throw error;
    }
  };

  async #resolve(
    request: WorkflowAgentContextResolutionRequest,
  ): Promise<WorkflowAgentContextResolution> {
    if (request.attachmentIds.length === 0) return { attachments: [] };
    const project = this.store.getProject(request.projectId);
    if (project === undefined || project.missing) {
      throw new Error('The workflow context project is no longer available.');
    }
    const target = request.runtime.canvas.nodes.find((node) => node.id === request.nodeId);
    if (target === undefined || (target.type !== 'agent' && target.type !== 'task')) {
      throw new Error(
        'Workflow context can only be resolved for a canonical Agent or assigned Task node.',
      );
    }
    const configuredAgent =
      target.type === 'agent' ? target : assignedAgentForTask(target, request.runtime.canvas.nodes);
    const adapterId = configuredAgent.data.adapterId;
    if (adapterId === undefined) {
      throw new Error('Choose an agent adapter before resolving workflow context.');
    }

    const resolvedNodes = request.attachmentIds.map((attachmentId) =>
      requireFileNode(request.runtime.canvas.nodes, request.projectId, attachmentId),
    );
    const relativePaths = resolvedNodes.map(({ data }) => data.file!.relativePath);
    const manifest = await buildAttachmentManifest({
      projectId: request.projectId,
      projectRoot: project.path,
      receivingAdapterId: adapterId,
      receivingProvider: adapterId,
      relativePaths,
    });
    const filesByPath = new Map(manifest.files.map((file) => [file.relativePath, file]));
    const filesByAttachment = new Map(
      resolvedNodes.map((node, index) => {
        const relativePath = relativePaths[index]!;
        const file = filesByPath.get(relativePath);
        if (file === undefined) {
          throw new Error(`Context manifest omitted the selected file node "${node.id}".`);
        }
        return [request.attachmentIds[index]!, file] as const;
      }),
    );
    for (const edge of contextAttachmentsForNode(request.runtime, request.nodeId)) {
      if (edge.verifierId !== WORKFLOW_EVIDENCE_VERIFIER_ID) {
        throw new Error(`Context edge "${edge.edgeId}" was verified by an unsupported policy.`);
      }
      const files = edge.attachmentIds.map((attachmentId) => {
        const file = filesByAttachment.get(attachmentId);
        if (file === undefined) {
          throw new Error(`Context edge "${edge.edgeId}" references an unresolved File node.`);
        }
        return file;
      });
      if (edge.contentDigest !== `sha256:${manifestFilesDigest(files)}`) {
        throw new Error(
          `Context link "${edge.edgeId}" changed after its evidence was verified. Review what will run.`,
        );
      }
    }
    const attachments = resolvedNodes.map((node, index) => {
      const file = filesByAttachment.get(request.attachmentIds[index]!)!;
      return {
        attachmentId: request.attachmentIds[index]!,
        attachment: {
          path: file.canonicalPath,
          kind: 'file' as const,
          label: node.title,
          explicitlyApproved: true as const,
          sha256: file.sha256,
        },
      };
    });
    return {
      attachments,
      manifestId: manifest.id,
      manifestDigest: manifestDigest(manifest),
    };
  }
}

function requireFileNode(
  nodes: readonly CanvasNode[],
  projectId: string,
  attachmentId: string,
): Extract<CanvasNode, { type: 'file' }> {
  const node = nodes.find((candidate) => candidate.id === attachmentId);
  if (node === undefined) {
    throw new Error(`Workflow context attachment "${attachmentId}" no longer exists.`);
  }
  if (node.type !== 'file' || node.data.file === undefined) {
    throw new Error(
      `Workflow context attachment "${attachmentId}" must be a configured File node.`,
    );
  }
  if (node.data.file.projectId !== projectId) {
    throw new Error(`Workflow context attachment "${attachmentId}" belongs to another project.`);
  }
  if (node.data.file.missing) {
    throw new Error(`Workflow context attachment "${attachmentId}" is marked as missing.`);
  }
  if (node.data.file.kind === 'directory') {
    throw new Error(
      `Workflow context attachment "${attachmentId}" is a directory. Select explicit File nodes instead.`,
    );
  }
  return node;
}

function manifestDigest(manifest: Awaited<ReturnType<typeof buildAttachmentManifest>>): string {
  return manifestFilesDigest(manifest.files);
}

function manifestFilesDigest(files: AttachmentManifest['files']): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...files]
          .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
          .map((file) => ({
            relativePath: file.relativePath,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            policy: file.policy,
            overrideApprovalId: file.overrideApprovalId ?? null,
          })),
      ),
    )
    .digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 20_000) : 'Unknown context error';
}
