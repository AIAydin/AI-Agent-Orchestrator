import {
  CanvasNodeSchema,
  type CanvasNode,
  type CanvasNodeType,
  type NodeStatus,
} from '@forgeboard/core/domain';

import { booleanValue, jsonRecord, stringArray, stringValue, unknownRecord } from './json.js';
import {
  CANVAS_NODE_MINIMUM_DIMENSIONS,
  DEFAULT_CANVAS_NODE_DIMENSIONS,
  DEFAULT_GROUP_FRAME_DIMENSIONS,
  GROUP_FRAME_MINIMUM_DIMENSIONS,
} from './node-dimensions.js';
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
  const fallbackDimensions =
    type === 'group-frame' ? DEFAULT_GROUP_FRAME_DIMENSIONS : DEFAULT_CANVAS_NODE_DIMENSIONS;
  const minimumDimensions =
    type === 'group-frame' ? GROUP_FRAME_MINIMUM_DIMENSIONS : CANVAS_NODE_MINIMUM_DIMENSIONS;
  const parsed = CanvasNodeSchema.safeParse({
    id: node.id,
    type,
    title: stringValue(node.data['title']) ?? matchingPrevious?.title ?? titleFor(type),
    color: colorValue(node.data['color']) ?? matchingPrevious?.color ?? '#82909b',
    icon: stringValue(node.data['icon']) ?? matchingPrevious?.icon ?? LEGACY_KINDS[type],
    position: node.position,
    size: {
      width: Math.max(
        minimumDimensions.width,
        positiveNumber(node.width) ?? matchingPrevious?.size.width ?? fallbackDimensions.width,
      ),
      height: Math.max(
        minimumDimensions.height,
        positiveNumber(node.height) ?? matchingPrevious?.size.height ?? fallbackDimensions.height,
      ),
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
        pauseSupported: booleanValue(raw['pauseSupported']),
        interruptSupported: booleanValue(raw['interruptSupported']),
        resumeSupported: booleanValue(raw['resumeSupported']),
        tokenUsage: agentTokenUsage(raw['tokenUsage']),
        cost: agentCost(raw['cost']),
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
        ...canonicalPreviewConfiguration(raw, previous),
        serverId: stringValue(raw['serverId']),
        worktreeId: stringValue(raw['worktreeId']),
        url: stringValue(raw['previewUrl']) ?? stringValue(raw['url']),
        viewport: raw['viewport'],
      });
    case 'mobile-preview':
      return compact({
        ...base,
        ...canonicalPreviewConfiguration(raw, previous),
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
        artifactPaths: stringArray(raw['artifactPaths']),
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
        deliveryTarget: rendererValueOrPrevious(raw, previous, 'deliveryTarget'),
        // These legacy/cache fields remain display data. Only deliveryTarget resolves authority.
        worktreeId: stringValue(rendererValueOrPrevious(raw, previous, 'worktreeId')),
        branch: stringValue(rendererValueOrPrevious(raw, previous, 'branch')),
        remote: stringValue(rendererValueOrPrevious(raw, previous, 'remote')),
        destinationBranch: stringValue(rendererValueOrPrevious(raw, previous, 'destinationBranch')),
        baseBranch: stringValue(rendererValueOrPrevious(raw, previous, 'baseBranch')),
        pullRequestTitle: stringValue(rendererValueOrPrevious(raw, previous, 'pullRequestTitle')),
        pullRequestBody: stringRendererValueOrPrevious(raw, previous, 'pullRequestBody'),
        pullRequestDraft: booleanValue(rendererValueOrPrevious(raw, previous, 'pullRequestDraft')),
        commitIds: stringArray(rendererValueOrPrevious(raw, previous, 'commitIds')),
        ahead: rendererValueOrPrevious(raw, previous, 'ahead'),
        behind: rendererValueOrPrevious(raw, previous, 'behind'),
        mergeReadiness: rendererValueOrPrevious(raw, previous, 'mergeReadiness'),
        pullRequestUrl: stringValue(rendererValueOrPrevious(raw, previous, 'pullRequestUrl')),
        checkIds: stringArray(rendererValueOrPrevious(raw, previous, 'checkIds')),
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
        exportArtifactIds: raw['exportArtifactIds'],
        contextSpecificationArtifactId: raw['contextSpecificationArtifactId'],
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
        pauseSupported: node.data.pauseSupported,
        interruptSupported: node.data.interruptSupported,
        resumeSupported: node.data.resumeSupported,
        tokenUsage: node.data.tokenUsage,
        cost: node.data.cost,
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
    case 'terminal':
      return {
        ...node.data,
        command: legacyCommandFromCanonical(node.data.command),
      };
    case 'web-preview':
    case 'mobile-preview':
      return compact({
        ...node.data,
        previewTarget: node.data.target,
        previewCommand: legacyCommandFromCanonical(node.data.command),
        previewPackageScript: node.data.packageScript,
        previewCwdRelative: node.data.cwdRelative,
        previewReadinessPath: node.data.readinessPath,
        previewUrlPath: node.data.urlPath,
        previewPreset: node.data.preset,
        previewSecondaryPreset: node.data.secondaryPreset,
        previewOrientation: node.data.orientation,
        previewSideBySide: node.data.sideBySide,
        previewComparison: node.data.comparison,
      });
    default:
      return { ...node.data };
  }
}

function canonicalPreviewConfiguration(
  raw: Readonly<Record<string, unknown>>,
  previous: CanvasNode['data'] | undefined,
): Record<string, unknown> {
  const previewCommand = previewValueOrPrevious(raw, previous, 'previewCommand', 'command');
  return compact({
    target: previewValueOrPrevious(raw, previous, 'previewTarget', 'target'),
    command: commandValue(previewCommand),
    packageScript: stringValue(
      previewValueOrPrevious(raw, previous, 'previewPackageScript', 'packageScript'),
    ),
    cwdRelative: stringValue(
      previewValueOrPrevious(raw, previous, 'previewCwdRelative', 'cwdRelative'),
    ),
    readinessPath: stringValue(
      previewValueOrPrevious(raw, previous, 'previewReadinessPath', 'readinessPath'),
    ),
    urlPath: stringValue(previewValueOrPrevious(raw, previous, 'previewUrlPath', 'urlPath')),
    preset: previewValueOrPrevious(raw, previous, 'previewPreset', 'preset'),
    secondaryPreset: previewValueOrPrevious(
      raw,
      previous,
      'previewSecondaryPreset',
      'secondaryPreset',
    ),
    orientation: previewValueOrPrevious(raw, previous, 'previewOrientation', 'orientation'),
    sideBySide: booleanValue(
      previewValueOrPrevious(raw, previous, 'previewSideBySide', 'sideBySide'),
    ),
    comparison: previewValueOrPrevious(raw, previous, 'previewComparison', 'comparison'),
  });
}

function previewValueOrPrevious(
  raw: Readonly<Record<string, unknown>>,
  previous: CanvasNode['data'] | undefined,
  rendererKey: string,
  canonicalKey: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, rendererKey)) return raw[rendererKey];
  return unknownRecord(previous)?.[canonicalKey];
}

function legacyCommandFromCanonical(
  command: Extract<CanvasNode, { type: 'terminal' }>['data']['command'],
): Record<string, unknown> | undefined {
  if (command === undefined) return undefined;
  return compact({
    executable: command.executable,
    arguments: [...command.args],
    cwdRelative: command.cwdRelative,
    environmentNames: [...command.environmentNames],
  });
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

function agentTokenUsage(value: unknown): Record<string, number> | undefined {
  const usage = unknownRecord(value);
  const normalized = compact({
    inputTokens: nonnegativeInteger(usage?.['inputTokens']) ?? nonnegativeInteger(usage?.['input']),
    cachedInputTokens: nonnegativeInteger(usage?.['cachedInputTokens']),
    outputTokens:
      nonnegativeInteger(usage?.['outputTokens']) ?? nonnegativeInteger(usage?.['output']),
    totalTokens: nonnegativeInteger(usage?.['totalTokens']),
  });
  return Object.keys(normalized).length === 0 ? undefined : (normalized as Record<string, number>);
}

function agentCost(value: unknown): Record<string, unknown> | undefined {
  const cost = unknownRecord(value);
  const amount = nonnegativeNumber(cost?.['amount']);
  const currency = stringValue(cost?.['currency']);
  return amount === undefined || currency === undefined || currency.length !== 3
    ? undefined
    : { amount, currency };
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
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

function stringRendererValueOrPrevious(
  raw: Readonly<Record<string, unknown>>,
  previous: CanvasNode['data'] | undefined,
  key: string,
): string | undefined {
  const value = rendererValueOrPrevious(raw, previous, key);
  return typeof value === 'string' ? value : undefined;
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
  if (status === 'blocked') return 'failed';
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
