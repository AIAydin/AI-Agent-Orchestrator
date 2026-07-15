import { CanvasEdgeSchema, type CanvasEdge } from '@forgeboard/core/domain';

import { booleanValue, jsonRecord, stringArray, stringValue, unknownRecord } from './json.js';
import type { CanvasMigrationIssue, LegacyCanvasEdge } from './types.js';

export function canonicalEdgeFromLegacy(
  edge: LegacyCanvasEdge,
  previous: CanvasEdge | undefined,
  updatedAt: string,
): { readonly edge?: CanvasEdge; readonly issue?: CanvasMigrationIssue } {
  const metadata = jsonRecord(edge.data ?? {});
  if (metadata === undefined) {
    return {
      issue: {
        code: 'NON_JSON_METADATA',
        entityId: edge.id,
        message: 'Canvas edge metadata must contain only finite JSON values.',
      },
    };
  }
  const matchingPrevious = previous?.type === edge.type ? previous : undefined;
  const configuration = edgeConfiguration(edge, matchingPrevious);
  const parsed = CanvasEdgeSchema.safeParse({
    id: edge.id,
    sourceNodeId: edge.source,
    targetNodeId: edge.target,
    ...(edge.sourceHandle === undefined || edge.sourceHandle === null
      ? {}
      : { sourceHandle: edge.sourceHandle }),
    ...(edge.targetHandle === undefined || edge.targetHandle === null
      ? {}
      : { targetHandle: edge.targetHandle }),
    ...(matchingPrevious?.label === undefined ? {} : { label: matchingPrevious.label }),
    ...(matchingPrevious?.status === undefined ? {} : { status: matchingPrevious.status }),
    type: edge.type,
    config: configuration,
    inspector: { ...(matchingPrevious?.inspector ?? {}), legacyData: metadata },
    createdAt: matchingPrevious?.createdAt ?? updatedAt,
  });
  if (parsed.success) return { edge: parsed.data };
  return {
    issue: {
      code: 'INVALID_TYPED_EDGE',
      entityId: edge.id,
      message: parsed.error.issues.map((issue) => issue.message).join('; '),
    },
  };
}

export function legacyEdgeFromCanonical(edge: CanvasEdge): LegacyCanvasEdge {
  const legacyData = unknownRecord(edge.inspector['legacyData']) ?? {};
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
    ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
    type: edge.type,
    data: { ...legacyData, config: edge.config },
  };
}

function edgeConfiguration(
  edge: LegacyCanvasEdge,
  previous: CanvasEdge | undefined,
): Record<string, unknown> {
  const metadata = unknownRecord(edge.data);
  const candidate = unknownRecord(metadata?.['config']) ?? metadata ?? {};
  const previousConfig = previous?.config ?? {};
  switch (edge.type) {
    case 'context': {
      const attachments = stringArray(candidate['attachmentIds']);
      return {
        attachmentMode: 'explicit',
        required: booleanValue(candidate['required']) ?? value(previousConfig, 'required') ?? true,
        attachmentIds: attachments ?? arrayValue(previousConfig, 'attachmentIds') ?? [edge.source],
      };
    }
    case 'execute': {
      const approval = enumValue(
        candidate['approval'],
        ['none', 'human', 'review-gate'],
        enumValue(value(previousConfig, 'approval'), ['none', 'human', 'review-gate'], 'none'),
      );
      const approvalGateNodeId =
        stringValue(candidate['approvalGateNodeId']) ??
        stringValue(value(previousConfig, 'approvalGateNodeId'));
      return {
        trigger: enumValue(
          candidate['trigger'],
          ['on-success', 'on-completion'],
          enumValue(
            value(previousConfig, 'trigger'),
            ['on-success', 'on-completion'],
            'on-success',
          ),
        ),
        approval,
        ...(approval === 'review-gate' && approvalGateNodeId !== undefined
          ? { approvalGateNodeId }
          : {}),
      };
    }
    case 'output':
      return {
        outputKind: enumValue(
          candidate['outputKind'],
          ['branch', 'diff', 'preview', 'test-result', 'artifact'],
          enumValue(
            value(previousConfig, 'outputKind'),
            ['branch', 'diff', 'preview', 'test-result', 'artifact'],
            'artifact',
          ),
        ),
        required: booleanValue(candidate['required']) ?? value(previousConfig, 'required') ?? true,
      };
    case 'review':
      return {
        reviewer: enumValue(
          candidate['reviewer'],
          ['human', 'agent', 'gate'],
          enumValue(value(previousConfig, 'reviewer'), ['human', 'agent', 'gate'], 'human'),
        ),
        requireApproval:
          booleanValue(candidate['requireApproval']) ??
          value(previousConfig, 'requireApproval') ??
          true,
        structuredFindings:
          booleanValue(candidate['structuredFindings']) ??
          value(previousConfig, 'structuredFindings') ??
          true,
      };
    case 'revision': {
      const loopId =
        stringValue(candidate['loopId']) ?? stringValue(value(previousConfig, 'loopId'));
      return {
        ...(loopId === undefined ? {} : { loopId }),
        actionableFeedbackRequired: true,
      };
    }
    case 'dependency':
      return { requiredStatus: 'succeeded' };
  }
}

function value(record: object, key: string): unknown {
  return (record as Record<string, unknown>)[key];
}

function arrayValue(record: object, key: string): string[] | undefined {
  return stringArray(value(record, key));
}

function enumValue<const TValue extends string>(
  value: unknown,
  values: readonly TValue[],
  fallback: TValue,
): TValue {
  return typeof value === 'string' && values.includes(value as TValue)
    ? (value as TValue)
    : fallback;
}
