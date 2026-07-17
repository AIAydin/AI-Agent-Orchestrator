import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  buildAttachmentManifest,
  contextAttachmentsForNode,
  type AttachmentManifest,
  type CanvasNode,
} from '@forgeboard/core';

import type { LocalStore } from '../../storage.js';
import { AGENT_CONTEXT_TOTAL_MAX_BYTES } from '../../agent-execution/context/limits.js';
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
import {
  isWorkflowCanvasContextNode,
  serializeWorkflowCanvasContext,
  WorkflowCanvasContextSourceSchema,
  type WorkflowCanvasContextSource,
} from '../context/canvas-source.js';

export type WorkflowContextResolverStore = Pick<LocalStore, 'getProject' | 'appendAudit'>;

/** Resolves opaque IDs to reviewed files or immutable canvas-source snapshots in main. */
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
      const manifest =
        request.files.length === 0
          ? undefined
          : await buildAttachmentManifest({
              projectId: request.projectId,
              projectRoot: project.path,
              receivingAdapterId: 'forgeboard-workflow',
              receivingProvider: 'Forgeboard local workflow verifier',
              relativePaths: request.files.map((file) => file.relativePath),
            });
      const sources = request.canvasSources.map((source) =>
        WorkflowCanvasContextSourceSchema.parse(source),
      );
      const selectedFiles = manifest?.files ?? [];
      assertAggregateContextSize(selectedFiles, sources);
      const proof = {
        schemaVersion: 1 as const,
        attachmentIds: [...request.attachmentIds],
        contentDigest: contextSelectionDigest(
          selectedFiles,
          sources,
          request.files.map(({ attachmentId }) => attachmentId),
          request.attachmentIds,
        ),
      };
      const resolvedIds = new Set([
        ...request.files.map((file) => file.attachmentId),
        ...sources.map(({ attachmentId }) => attachmentId),
      ]);
      if (
        resolvedIds.size !== request.attachmentIds.length ||
        request.attachmentIds.some((attachmentId) => !resolvedIds.has(attachmentId))
      ) {
        throw new Error('Workflow context evidence does not match the selected attachment IDs.');
      }
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
        attachmentIds: [...request.attachmentIds],
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

    const selectedNodes = request.attachmentIds.map((attachmentId) =>
      requireContextNode(request.runtime.canvas.nodes, request.projectId, attachmentId),
    );
    const fileNodes = selectedNodes.filter(
      (node): node is Extract<CanvasNode, { type: 'file' }> => node.type === 'file',
    );
    const canvasSources = selectedNodes
      .filter(isWorkflowCanvasContextNode)
      .map(serializeWorkflowCanvasContext);
    const relativePaths = fileNodes.map(({ data }) => data.file!.relativePath);
    const manifest =
      relativePaths.length === 0
        ? undefined
        : await buildAttachmentManifest({
            projectId: request.projectId,
            projectRoot: project.path,
            receivingAdapterId: adapterId,
            receivingProvider: adapterId,
            relativePaths,
          });
    const filesByPath = new Map((manifest?.files ?? []).map((file) => [file.relativePath, file]));
    const filesByAttachment = new Map(
      fileNodes.map((node) => {
        const relativePath = node.data.file!.relativePath;
        const file = filesByPath.get(relativePath);
        if (file === undefined) {
          throw new Error(`Context manifest omitted the selected file node "${node.id}".`);
        }
        return [node.id, file] as const;
      }),
    );
    const sourcesByAttachment = new Map(
      canvasSources.map((source) => [source.attachmentId, source] as const),
    );
    assertAggregateContextSize(manifest?.files ?? [], canvasSources);
    for (const edge of contextAttachmentsForNode(request.runtime, request.nodeId)) {
      if (edge.verifierId !== WORKFLOW_EVIDENCE_VERIFIER_ID) {
        throw new Error(`Context edge "${edge.edgeId}" was verified by an unsupported policy.`);
      }
      const files = edge.attachmentIds.flatMap((id) => {
        const file = filesByAttachment.get(id);
        return file === undefined ? [] : [file];
      });
      const sources = edge.attachmentIds.flatMap((id) => {
        const source = sourcesByAttachment.get(id);
        return source === undefined ? [] : [source];
      });
      if (files.length + sources.length !== edge.attachmentIds.length) {
        throw new Error(`Context edge "${edge.edgeId}" references unresolved canvas context.`);
      }
      const fileIds = edge.attachmentIds.filter((id) => filesByAttachment.has(id));
      if (
        edge.contentDigest !==
        `sha256:${contextSelectionDigest(files, sources, fileIds, edge.attachmentIds)}`
      ) {
        throw new Error(
          `Context edge "${edge.edgeId}" changed after its evidence was verified. Review a fresh launch.`,
        );
      }
    }
    const attachments = selectedNodes.map((node) => {
      const file = filesByAttachment.get(node.id);
      const source = sourcesByAttachment.get(node.id);
      const generatedPath =
        source === undefined ? undefined : logicalCanvasContextPath(project.path, source);
      return {
        attachmentId: node.id,
        attachment:
          file === undefined
            ? {
                path: generatedPath!,
                kind: 'file' as const,
                label: `${node.title} (${source!.sourceType} snapshot)`,
                explicitlyApproved: true as const,
                sha256: source!.sha256,
              }
            : {
                path: file.canonicalPath,
                kind: 'file' as const,
                label: node.title,
                explicitlyApproved: true as const,
                sha256: file.sha256,
              },
      };
    });
    const generatedArtifacts = canvasSources.map((source) => ({
      attachmentId: source.attachmentId,
      artifact: {
        path: logicalCanvasContextPath(project.path, source),
        content: source.content,
        sha256: source.sha256,
      },
    }));
    const digest = contextSelectionDigest(
      manifest?.files ?? [],
      canvasSources,
      fileNodes.map(({ id }) => id),
      request.attachmentIds,
    );
    return {
      attachments,
      ...(generatedArtifacts.length === 0 ? {} : { generatedArtifacts }),
      manifestId: manifest?.id ?? `workflow-canvas-context-v1:${digest.slice(0, 64)}`,
      manifestDigest: digest,
    };
  }
}

function requireContextNode(
  nodes: readonly CanvasNode[],
  projectId: string,
  attachmentId: string,
): CanvasNode {
  const node = nodes.find((candidate) => candidate.id === attachmentId);
  if (node === undefined) {
    throw new Error(`Workflow context attachment "${attachmentId}" no longer exists.`);
  }
  if (isWorkflowCanvasContextNode(node)) return node;
  if (node.type !== 'file' || node.data.file === undefined) {
    throw new Error(
      `Workflow context attachment "${attachmentId}" must be a File, Product Brief, Task, Diagram, or Note node.`,
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

function contextSelectionDigest(
  files: AttachmentManifest['files'],
  sources: readonly WorkflowCanvasContextSource[],
  fileAttachmentIds: readonly string[],
  attachmentOrder: readonly string[],
): string {
  if (files.length !== fileAttachmentIds.length) {
    throw new Error('Workflow context file identities do not match the resolved manifest.');
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        attachmentOrder: [...attachmentOrder],
        files: files
          .map((file, index) => ({ file, attachmentId: fileAttachmentIds[index]! }))
          .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId))
          .map(({ file, attachmentId }) => ({
            attachmentId,
            relativePath: file.relativePath,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            policy: file.policy,
            overrideApprovalId: file.overrideApprovalId ?? null,
          })),
        canvasSources: [...sources]
          .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId))
          .map((source) => ({
            attachmentId: source.attachmentId,
            sourceType: source.sourceType,
            sha256: source.sha256,
          })),
      }),
    )
    .digest('hex');
}

function assertAggregateContextSize(
  files: AttachmentManifest['files'],
  sources: readonly WorkflowCanvasContextSource[],
): void {
  const total =
    files.reduce((sum, file) => sum + file.sizeBytes, 0) +
    sources.reduce((sum, source) => sum + Buffer.byteLength(source.content, 'utf8'), 0);
  if (total > AGENT_CONTEXT_TOTAL_MAX_BYTES) {
    throw new Error('Workflow context exceeds the 32 MiB aggregate limit.');
  }
}

function logicalCanvasContextPath(
  projectRoot: string,
  source: WorkflowCanvasContextSource,
): string {
  const safeId = source.sourceNodeId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 160);
  const idDigest = createHash('sha256').update(source.sourceNodeId).digest('hex').slice(0, 12);
  return path.resolve(
    projectRoot,
    '.forgeboard-context',
    `${source.sourceType}-${safeId}-${idDigest}-${source.sha256.slice(0, 12)}.md`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 20_000) : 'Unknown context error';
}
