import {
  CanvasNodeSchema,
  type CanvasNode,
  type CanvasNodeType,
  type NodeStatus,
} from '@forgeboard/core/domain';

import { booleanValue, jsonRecord, stringArray, stringValue, unknownRecord } from './json.js';
import type { CanvasMigrationIssue, LegacyCanvasNode } from './types.js';

const KIND_ALIASES: Readonly<Record<string, CanvasNodeType>> = {
  agent: 'agent',
  brief: 'product-brief',
  'product-brief': 'product-brief',
  task: 'task',
  file: 'file',
  diff: 'diff-review',
  'diff-review': 'diff-review',
  terminal: 'terminal',
  'web-preview': 'web-preview',
  'mobile-preview': 'mobile-preview',
  test: 'test',
  'review-gate': 'review-gate',
  'git-pr': 'git-pr',
  diagram: 'diagram',
  whiteboard: 'whiteboard-mockup',
  'whiteboard-mockup': 'whiteboard-mockup',
  'note-image': 'note-image',
  'group-frame': 'group-frame',
  extension: 'extension',
};

const LEGACY_KINDS: Readonly<Record<CanvasNodeType, string>> = {
  agent: 'agent',
  'product-brief': 'brief',
  task: 'task',
  file: 'file',
  'diff-review': 'diff',
  terminal: 'terminal',
  'web-preview': 'web-preview',
  'mobile-preview': 'mobile-preview',
  test: 'test',
  'review-gate': 'review-gate',
  'git-pr': 'git-pr',
  diagram: 'diagram',
  'whiteboard-mockup': 'whiteboard',
  'note-image': 'note-image',
  'group-frame': 'group-frame',
  extension: 'extension',
};

export function canonicalNodeFromLegacy(
  node: LegacyCanvasNode,
  previous: CanvasNode | undefined,
  updatedAt: string,
): { readonly node?: CanvasNode; readonly issue?: CanvasMigrationIssue } {
  const metadata = jsonRecord(node.data);
  if (metadata === undefined) {
    return {
      issue: {
        code: 'NON_JSON_METADATA',
        entityId: node.id,
        message: 'Canvas node metadata must contain only finite JSON values.',
      },
    };
  }
  const kindValue = stringValue(node.data['kind']) ?? node.type;
  const type = KIND_ALIASES[kindValue];
  if (type === undefined) {
    return {
      issue: {
        code: 'INVALID_NODE_KIND',
        entityId: node.id,
        message: `Unsupported canvas node kind: ${kindValue}`,
      },
    };
  }
  const matchingPrevious = previous?.type === type ? previous : undefined;
  const typedData = canonicalData(type, node.data, matchingPrevious?.data);
  const parsed = CanvasNodeSchema.safeParse({
    id: node.id,
    type,
    title: stringValue(node.data['title']) ?? matchingPrevious?.title ?? titleFor(type),
    color: colorValue(node.data['color']) ?? matchingPrevious?.color ?? '#82909b',
    icon: stringValue(node.data['icon']) ?? matchingPrevious?.icon ?? LEGACY_KINDS[type],
    position: node.position,
    size: {
      width: positiveNumber(node.width) ?? matchingPrevious?.size.width ?? 320,
      height: positiveNumber(node.height) ?? matchingPrevious?.size.height ?? 180,
    },
    collapsed: booleanValue(node.data['collapsed']) ?? matchingPrevious?.collapsed ?? false,
    locked: booleanValue(node.data['locked']) ?? matchingPrevious?.locked ?? false,
    ...(matchingPrevious?.groupId === undefined ? {} : { groupId: matchingPrevious.groupId }),
    comments: matchingPrevious?.comments ?? [],
    status: legacyStatus(node.data['canonicalStatus'] ?? node.data['status']),
    runHistoryIds: mergeRunHistory(matchingPrevious?.runHistoryIds ?? [], node.data['runId']),
    inspector: { ...(matchingPrevious?.inspector ?? {}), legacyData: metadata },
    resources: matchingPrevious?.resources ?? {},
    createdAt: matchingPrevious?.createdAt ?? updatedAt,
    updatedAt,
    data: typedData,
  });
  if (parsed.success) return { node: parsed.data };
  return {
    issue: {
      code: type === 'extension' ? 'INVALID_EXTENSION_NODE' : 'INVALID_TYPED_NODE',
      entityId: node.id,
      message: parsed.error.issues.map((issue) => issue.message).join('; '),
    },
  };
}

export function legacyNodeFromCanonical(node: CanvasNode): LegacyCanvasNode {
  const legacyData = unknownRecord(node.inspector['legacyData']) ?? {};
  return {
    id: node.id,
    type: LEGACY_KINDS[node.type],
    position: node.position,
    width: node.size.width,
    height: node.size.height,
    data: {
      ...legacyData,
      ...legacyDataFromCanonical(node),
      kind: LEGACY_KINDS[node.type],
      title: node.title,
      color: node.color,
      locked: node.locked,
      collapsed: node.collapsed,
      status: canonicalStatus(node.status),
      canonicalStatus: node.status,
    },
  };
}

function canonicalData(
  type: CanvasNodeType,
  raw: Readonly<Record<string, unknown>>,
  previous: CanvasNode['data'] | undefined,
): Record<string, unknown> {
  const base = previous === undefined ? {} : { ...previous };
  switch (type) {
    case 'agent':
      return compact({
        ...base,
        adapterId: stringValue(raw['adapterId']),
        model: stringValue(raw['model']),
        permissionProfileId: stringValue(raw['permissionProfile']),
        promptDraft: typeof raw['prompt'] === 'string' ? raw['prompt'] : undefined,
        worktreeId: stringValue(raw['worktreeId']),
        branch: stringValue(raw['branch']),
        contextAttachmentIds: stringArray(raw['contextAttachmentIds']),
      });
    case 'product-brief':
      return compact({
        ...base,
        markdown: typeof raw['markdown'] === 'string' ? raw['markdown'] : undefined,
        checklist: raw['checklist'],
        attachmentIds: stringArray(raw['attachmentIds']),
        acceptanceCriteria: raw['acceptanceCriteria'],
        versions: raw['versions'],
        variables: raw['variables'],
      });
    case 'task':
      return compact({
        ...base,
        description:
          typeof raw['taskDescription'] === 'string'
            ? raw['taskDescription']
            : typeof raw['description'] === 'string'
              ? raw['description']
              : undefined,
        priority: raw['priority'],
        assigneeId: stringValue(raw['assigneeId']),
        dependencyTaskIds: stringArray(raw['dependencyTaskIds']),
        acceptanceCriteria: raw['acceptanceCriteria'],
        relatedFiles: raw['relatedFiles'],
        taskStatus: raw['taskStatus'],
      });
    case 'file':
      return compact({
        ...base,
        file: raw['file'],
        language: stringValue(raw['language']),
        dirty: booleanValue(raw['dirty']),
        historyRefs: stringArray(raw['historyRefs']),
        readOnly: booleanValue(raw['readOnly']),
      });
    case 'diff-review':
      return compact({
        ...base,
        reviewTarget: rendererValueOrPrevious(raw, previous, 'reviewTarget'),
        baseRef: stringValue(raw['baseRef']),
        headRef: stringValue(raw['headRef']),
        worktreeId: stringValue(raw['worktreeId']),
        files: stringArray(raw['files']) ?? stringArray(raw['changedFiles']),
        viewMode: raw['viewMode'],
        showWhitespace: booleanValue(rendererValueOrPrevious(raw, previous, 'showWhitespace')),
        ignoreWhitespace: booleanValue(raw['ignoreWhitespace']),
        hunkDecisions: raw['hunkDecisions'],
        lineCommentIds: stringArray(rendererValueOrPrevious(raw, previous, 'lineCommentIds')),
        revisionRequest:
          typeof raw['revisionRequest'] === 'string' ? raw['revisionRequest'] : undefined,
        approval: raw['approval'],
      });
    case 'terminal':
      return compact({
        ...base,
        cwdRelative: stringValue(raw['cwdRelative']),
        permissionProfileId: stringValue(raw['permissionProfile']),
        command: commandValue(raw['command']),
      });
    case 'web-preview':
      return compact({
        ...base,
        serverId: stringValue(raw['serverId']),
        worktreeId: stringValue(raw['worktreeId']),
        url: stringValue(raw['previewUrl']) ?? stringValue(raw['url']),
        viewport: raw['viewport'],
      });
    case 'mobile-preview':
      return compact({
        ...base,
        serverId: stringValue(raw['serverId']),
        worktreeId: stringValue(raw['worktreeId']),
        url: stringValue(raw['previewUrl']) ?? stringValue(raw['url']),
        viewports: raw['viewports'],
        synchronizedNavigation: booleanValue(raw['synchronizedNavigation']),
      });
    case 'test':
      return compact({
        ...base,
        command: commandValue(raw['command']),
        runIds: stringArray(raw['runIds']),
        summary: raw['summary'],
        artifactIds: stringArray(raw['artifactIds']),
      });
    case 'review-gate':
      return compact({
        ...base,
        humanApprovalRequired: booleanValue(raw['humanApprovalRequired']),
        requiredCheckIds: stringArray(raw['requiredCheckIds']),
        lintRequired: booleanValue(raw['lintRequired']),
        testsRequired: booleanValue(raw['testsRequired']),
        reviewerAgentId: stringValue(raw['reviewerAgentId']),
        retryPolicy: raw['retryPolicy'],
        gateState: raw['gateState'],
      });
    case 'git-pr':
      return compact({
        ...base,
        worktreeId: stringValue(raw['worktreeId']),
        branch: stringValue(raw['branch']),
        baseBranch: stringValue(raw['baseBranch']),
        remote: stringValue(raw['remote']),
        commitIds: stringArray(raw['commitIds']),
        ahead: raw['ahead'],
        behind: raw['behind'],
        mergeReadiness: raw['mergeReadiness'],
        pullRequestUrl: stringValue(raw['pullRequestUrl']),
        checkIds: stringArray(raw['checkIds']),
      });
    case 'diagram':
      return compact({
        ...base,
        mermaidSource: raw['mermaidSource'],
        agentEditable: raw['agentEditable'],
      });
    case 'whiteboard-mockup':
      return compact({
        ...base,
        excalidraw: raw['excalidraw'],
        annotationIds: raw['annotationIds'],
      });
    case 'note-image':
      return compact({
        ...base,
        markdown: raw['markdown'],
        images: raw['images'],
        altText: raw['altText'],
      });
    case 'group-frame':
      return compact({
        ...base,
        purpose: raw['purpose'] ?? (previous === undefined ? 'custom' : undefined),
        childNodeIds: stringArray(raw['childNodeIds']),
        layout: raw['layout'],
        autoFit: booleanValue(raw['autoFit']),
      });
    case 'extension':
      return compact({
        ...base,
        extensionId: stringValue(raw['extensionId']),
        extensionVersion: stringValue(raw['extensionVersion']),
        nodeTypeId: stringValue(raw['extensionNodeTypeId']),
        definition: raw['extensionDefinition'],
        values: raw['extensionValues'],
        availability: raw['extensionAvailability'],
      });
  }
}

function legacyDataFromCanonical(node: CanvasNode): Record<string, unknown> {
  switch (node.type) {
    case 'agent':
      return compact({
        adapterId: node.data.adapterId,
        model: node.data.model,
        permissionProfile: node.data.permissionProfileId,
        prompt: node.data.promptDraft,
        worktreeId: node.data.worktreeId,
        branch: node.data.branch,
        contextAttachmentIds: node.data.contextAttachmentIds,
      });
    case 'extension':
      return {
        extensionId: node.data.extensionId,
        extensionVersion: node.data.extensionVersion,
        extensionNodeTypeId: node.data.nodeTypeId,
        extensionDefinition: node.data.definition,
        extensionValues: node.data.values,
        extensionAvailability: node.data.availability,
      };
    default:
      return { ...node.data };
  }
}

function commandValue(value: unknown): Record<string, unknown> | undefined {
  const command = unknownRecord(value);
  const executable = stringValue(command?.['executable']);
  if (executable === undefined) return undefined;
  return compact({
    executable,
    args: stringArray(command?.['args']) ?? stringArray(command?.['arguments']) ?? [],
    cwdRelative: stringValue(command?.['cwdRelative']),
    environmentNames: stringArray(command?.['environmentNames']) ?? [],
  });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function rendererValueOrPrevious(
  raw: Readonly<Record<string, unknown>>,
  previous: CanvasNode['data'] | undefined,
  key: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : unknownRecord(previous)?.[key];
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function colorValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(value)
    ? value
    : undefined;
}

function legacyStatus(value: unknown): NodeStatus {
  if (value === 'idle') return 'draft';
  if (value === 'waiting') return 'waiting-for-approval';
  if (
    typeof value === 'string' &&
    [
      'draft',
      'ready',
      'queued',
      'running',
      'waiting-for-approval',
      'paused',
      'cancelling',
      'failed',
      'succeeded',
      'cancelled',
      'lost',
      'blocked',
    ].includes(value)
  ) {
    return value as NodeStatus;
  }
  return 'draft';
}

function canonicalStatus(status: NodeStatus): string {
  if (status === 'draft' || status === 'ready') return 'idle';
  if (status === 'waiting-for-approval' || status === 'paused' || status === 'cancelling') {
    return 'waiting';
  }
  if (status === 'lost' || status === 'blocked') return 'failed';
  return status;
}

function mergeRunHistory(existing: readonly string[], runId: unknown): string[] {
  const candidate = stringValue(runId);
  return candidate === undefined ? [...existing] : [...new Set([...existing, candidate])];
}

function titleFor(type: CanvasNodeType): string {
  return type
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
