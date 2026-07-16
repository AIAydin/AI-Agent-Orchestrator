import { AGENT_CONTEXT_ATTACHMENT_LIMIT } from '@forgeboard/core/domain';

import type { FileDocument } from '../../../../../shared/files/contracts.js';
import { NODE_DEFINITIONS, type WorkshopNode } from '../canvas/CanvasNode.js';
import type { WorkspaceContextDragPayload } from './contracts.js';

export const MAX_AGENT_CONTEXT_ATTACHMENTS = AGENT_CONTEXT_ATTACHMENT_LIMIT;

export type AgentContextLinkResult =
  | {
      readonly ok: true;
      readonly nodes: WorkshopNode[];
      readonly attachmentNodeId: string;
      readonly createdFileNode: boolean;
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly message: string };

export function linkProjectFileToAgent(input: {
  readonly projectId: string;
  readonly targetNodeId: string;
  readonly payload: WorkspaceContextDragPayload;
  readonly document: FileDocument;
  readonly nodes: readonly WorkshopNode[];
  readonly newNodeId: string;
}): AgentContextLinkResult {
  const target = input.nodes.find((node) => node.id === input.targetNodeId);
  if (target === undefined || target.data.kind !== 'agent') {
    return failure('Project files can only be attached to an Agent node.');
  }
  if (target.data.locked) return failure('Unlock the Agent node before changing its context.');
  if (input.payload.projectId !== input.projectId || input.document.projectId !== input.projectId) {
    return failure('The dragged file belongs to another project.');
  }
  if (
    input.document.relativePath !== input.payload.relativePath ||
    input.document.projectId !== input.payload.projectId
  ) {
    return failure('The verified file response does not match the dragged project file.');
  }

  const attachmentIds = target.data.contextAttachmentIds ?? [];
  const sameFileAttachment = attachmentIds.find((attachmentId) => {
    const attachment = input.nodes.find((node) => node.id === attachmentId);
    return (
      attachment?.data.kind === 'file' &&
      attachment.data.file?.kind === 'file' &&
      !attachment.data.file.missing &&
      attachment.data.file.projectId === input.projectId &&
      attachment.data.file.relativePath === input.payload.relativePath
    );
  });
  if (sameFileAttachment !== undefined && sameFileAttachment !== input.payload.sourceNodeId) {
    return {
      ok: true,
      nodes: [...input.nodes],
      attachmentNodeId: sameFileAttachment,
      createdFileNode: false,
      changed: false,
    };
  }

  const sourceResult = resolveSourceNode(input);
  if (!sourceResult.ok) return sourceResult;
  if (attachmentIds.includes(sourceResult.node.id)) {
    return {
      ok: true,
      nodes: sourceResult.nodes,
      attachmentNodeId: sourceResult.node.id,
      createdFileNode: sourceResult.created,
      changed: sourceResult.repaired,
    };
  }
  if (attachmentIds.length >= MAX_AGENT_CONTEXT_ATTACHMENTS) {
    return failure(
      `Agent context supports at most ${String(MAX_AGENT_CONTEXT_ATTACHMENTS)} files.`,
    );
  }

  const nodes = sourceResult.nodes.map((node) =>
    node.id === target.id
      ? {
          ...node,
          data: {
            ...node.data,
            contextAttachmentIds: [...attachmentIds, sourceResult.node.id],
          },
        }
      : node,
  );
  return {
    ok: true,
    nodes,
    attachmentNodeId: sourceResult.node.id,
    createdFileNode: sourceResult.created,
    changed: true,
  };
}

export function removeProjectFileFromAgent(input: {
  readonly targetNodeId: string;
  readonly attachmentNodeId: string;
  readonly nodes: readonly WorkshopNode[];
}): AgentContextLinkResult {
  const target = input.nodes.find((node) => node.id === input.targetNodeId);
  if (target === undefined || target.data.kind !== 'agent') {
    return failure('Project files can only be removed from an Agent node.');
  }
  if (target.data.locked) return failure('Unlock the Agent node before changing its context.');
  const current = target.data.contextAttachmentIds ?? [];
  if (!current.includes(input.attachmentNodeId)) {
    return {
      ok: true,
      nodes: [...input.nodes],
      attachmentNodeId: input.attachmentNodeId,
      createdFileNode: false,
      changed: false,
    };
  }
  return {
    ok: true,
    nodes: input.nodes.map((node) =>
      node.id === target.id
        ? {
            ...node,
            data: {
              ...node.data,
              contextAttachmentIds: current.filter((id) => id !== input.attachmentNodeId),
            },
          }
        : node,
    ),
    attachmentNodeId: input.attachmentNodeId,
    createdFileNode: false,
    changed: true,
  };
}

type SourceResolution =
  | {
      readonly ok: true;
      readonly nodes: WorkshopNode[];
      readonly node: WorkshopNode;
      readonly created: boolean;
      readonly repaired: boolean;
    }
  | { readonly ok: false; readonly message: string };

function resolveSourceNode(input: {
  readonly projectId: string;
  readonly targetNodeId: string;
  readonly payload: WorkspaceContextDragPayload;
  readonly document: FileDocument;
  readonly nodes: readonly WorkshopNode[];
  readonly newNodeId: string;
}): SourceResolution {
  const explicitSource =
    input.payload.sourceNodeId === undefined
      ? undefined
      : input.nodes.find((node) => node.id === input.payload.sourceNodeId);
  if (input.payload.sourceNodeId !== undefined && explicitSource === undefined) {
    return failure('The dragged File node no longer exists.');
  }
  if (explicitSource !== undefined) {
    const invalid = invalidFileSource(explicitSource, input);
    if (invalid !== null) return failure(invalid);
    return {
      ok: true,
      nodes: updateFileHash(input.nodes, explicitSource.id, input.document.sha256),
      node: withFileHash(explicitSource, input.document.sha256),
      created: false,
      repaired:
        input.document.sha256 !== null &&
        explicitSource.data.file?.lastKnownHash !== input.document.sha256,
    };
  }

  const reusable = input.nodes.find(
    (node) =>
      node.data.kind === 'file' &&
      node.data.file?.projectId === input.projectId &&
      node.data.file.relativePath === input.payload.relativePath,
  );
  if (reusable !== undefined) {
    if (reusable.data.locked) {
      return failure('Unlock the existing File node before linking it as context.');
    }
    if (reusable.data.file?.kind === 'file') {
      const repaired =
        reusable.data.file.missing || reusable.data.file.lastKnownHash !== input.document.sha256;
      const nextNode = {
        ...reusable,
        data: {
          ...reusable.data,
          file: verifiedReference(input, input.document.sha256),
        },
      };
      return {
        ok: true,
        nodes: input.nodes.map((node) => (node.id === reusable.id ? nextNode : node)),
        node: nextNode,
        created: false,
        repaired,
      };
    }
  }

  const target = input.nodes.find((node) => node.id === input.targetNodeId)!;
  const fileDefinition = NODE_DEFINITIONS.file;
  const node: WorkshopNode = {
    id: input.newNodeId,
    type: 'workshop',
    selected: false,
    position: {
      x: target.position.x - 320,
      y: target.position.y + (target.data.contextAttachmentIds?.length ?? 0) * 36,
    },
    data: {
      kind: 'file',
      title: fileName(input.payload.relativePath),
      description: fileDefinition.description,
      status: 'idle',
      locked: false,
      collapsed: false,
      color: fileDefinition.color,
      file: verifiedReference(input, input.document.sha256),
    },
  };
  if (input.nodes.some((candidate) => candidate.id === node.id)) {
    return failure('Could not allocate a unique File node for this context attachment.');
  }
  return { ok: true, nodes: [...input.nodes, node], node, created: true, repaired: false };
}

function invalidFileSource(
  node: WorkshopNode,
  input: {
    readonly projectId: string;
    readonly payload: WorkspaceContextDragPayload;
  },
): string | null {
  if (node.data.kind !== 'file' || node.data.file === undefined) {
    return 'Only a configured File node can be linked as agent context.';
  }
  if (node.data.locked) return 'Unlock the File node before linking it as context.';
  if (
    node.data.file.projectId !== input.projectId ||
    node.data.file.projectId !== input.payload.projectId
  ) {
    return 'The File node belongs to another project.';
  }
  if (node.data.file.relativePath !== input.payload.relativePath) {
    return 'The File node no longer matches the dragged editor tab.';
  }
  if (node.data.file.missing) return 'Choose a replacement for the missing File node first.';
  if (node.data.file.kind !== 'file') return 'Only regular File nodes can be agent context.';
  return null;
}

function updateFileHash(
  nodes: readonly WorkshopNode[],
  nodeId: string,
  sha256: string | null,
): WorkshopNode[] {
  return nodes.map((node) => (node.id === nodeId ? withFileHash(node, sha256) : node));
}

function withFileHash(node: WorkshopNode, sha256: string | null): WorkshopNode {
  const reference = node.data.file;
  if (reference === undefined) return node;
  return {
    ...node,
    data: {
      ...node.data,
      file: {
        ...reference,
        ...(sha256 === null ? {} : { lastKnownHash: sha256 }),
      },
    },
  };
}

function verifiedReference(
  input: { readonly projectId: string; readonly payload: WorkspaceContextDragPayload },
  sha256: string | null,
): NonNullable<WorkshopNode['data']['file']> {
  return {
    projectId: input.projectId,
    relativePath: input.payload.relativePath,
    kind: 'file',
    missing: false,
    ...(sha256 === null ? {} : { lastKnownHash: sha256 }),
  };
}

function fileName(relativePath: string): string {
  return relativePath.split('/').at(-1) ?? relativePath;
}

function failure(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}
