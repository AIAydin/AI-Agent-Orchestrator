import type { CanvasEdge } from '@forgeboard/core/domain';

export type EdgeKind = CanvasEdge['type'];

type EdgeConfiguration<TKind extends EdgeKind> = Extract<CanvasEdge, { type: TKind }>['config'];

export type WorkshopEdgeData = {
  [TKind in EdgeKind]: {
    edgeType: TKind;
    config: EdgeConfiguration<TKind>;
  };
}[EdgeKind];

type UnknownRecord = Readonly<Record<string, unknown>>;

export function createEdgeData(
  edgeType: EdgeKind,
  sourceNodeId: string,
  value?: unknown,
): WorkshopEdgeData {
  const record = asRecord(value);
  const candidate = asRecord(record?.['config']) ?? record;
  switch (edgeType) {
    case 'context':
      return {
        edgeType,
        config: {
          attachmentMode: 'explicit',
          required: booleanValue(candidate?.['required'], true),
          attachmentIds: entityIds(candidate?.['attachmentIds'], [sourceNodeId]),
        },
      };
    case 'execute': {
      const approval = enumValue(candidate?.['approval'], ['none', 'human', 'review-gate'], 'none');
      const approvalGateNodeId = entityId(candidate?.['approvalGateNodeId']);
      return {
        edgeType,
        config: {
          trigger: enumValue(candidate?.['trigger'], ['on-success', 'on-completion'], 'on-success'),
          approval,
          ...(approval === 'review-gate' && approvalGateNodeId !== undefined
            ? { approvalGateNodeId }
            : {}),
        },
      };
    }
    case 'output':
      return {
        edgeType,
        config: {
          outputKind: enumValue(
            candidate?.['outputKind'],
            ['branch', 'diff', 'preview', 'test-result', 'artifact'],
            'artifact',
          ),
          required: booleanValue(candidate?.['required'], true),
        },
      };
    case 'review':
      return {
        edgeType,
        config: {
          reviewer: enumValue(candidate?.['reviewer'], ['human', 'agent', 'gate'], 'human'),
          requireApproval: booleanValue(candidate?.['requireApproval'], true),
          structuredFindings: booleanValue(candidate?.['structuredFindings'], true),
        },
      };
    case 'revision': {
      const loopId = entityId(candidate?.['loopId']);
      return {
        edgeType,
        config: {
          ...(loopId === undefined ? {} : { loopId }),
          actionableFeedbackRequired: true,
        },
      };
    }
    case 'dependency':
      return { edgeType, config: { requiredStatus: 'succeeded' } };
  }
}

export function edgeDataForPersistence(data: WorkshopEdgeData | undefined): UnknownRecord {
  return data === undefined ? {} : { config: data.config };
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function entityId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function entityIds(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return fallback.filter(entityIdValue);
  const normalized = [...new Set(value.filter(entityIdValue))];
  return normalized.length === 0 ? fallback.filter(entityIdValue) : normalized;
}

function entityIdValue(value: unknown): value is string {
  return entityId(value) !== undefined;
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
