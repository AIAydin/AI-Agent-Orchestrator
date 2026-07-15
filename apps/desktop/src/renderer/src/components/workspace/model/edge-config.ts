import type { CanvasEdge } from '@forgeboard/core/domain';

export type EdgeKind = CanvasEdge['type'];

type EdgeConfiguration<TKind extends EdgeKind> = Extract<CanvasEdge, { type: TKind }>['config'];

export interface RevisionLoopConfiguration {
  maximumAttempts: number;
  stopConditions: ('review-approved' | 'tests-passed' | 'human-accepted')[];
  humanEscapeInstructions: string;
}

type StandardEdgeKind = Exclude<EdgeKind, 'revision'>;
type StandardEdgeData = {
  [TKind in StandardEdgeKind]: {
    edgeType: TKind;
    config: EdgeConfiguration<TKind>;
  };
}[StandardEdgeKind];

export type WorkshopEdgeData =
  | StandardEdgeData
  | {
      edgeType: 'revision';
      config: EdgeConfiguration<'revision'>;
      loop: RevisionLoopConfiguration;
    };

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
      const loop = asRecord(record?.['loop']);
      return {
        edgeType,
        config: {
          ...(loopId === undefined ? {} : { loopId }),
          actionableFeedbackRequired: true,
        },
        loop: {
          maximumAttempts: integerValue(loop?.['maximumAttempts'], 3, 1, 100),
          stopConditions: stopConditions(loop?.['stopConditions']),
          humanEscapeInstructions:
            stringValue(loop?.['humanEscapeInstructions']) ??
            'Pause after the final attempt and ask a human to accept the current result or cancel the workflow.',
        },
      };
    }
    case 'dependency':
      return { edgeType, config: { requiredStatus: 'succeeded' } };
  }
}

export function edgeDataForPersistence(data: WorkshopEdgeData | undefined): UnknownRecord {
  if (data === undefined) return {};
  return data.edgeType === 'revision'
    ? { config: data.config, loop: data.loop }
    : { config: data.config };
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function integerValue(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stopConditions(value: unknown): RevisionLoopConfiguration['stopConditions'] {
  const parsed = Array.isArray(value) ? [...new Set(value.filter(isStopCondition))] : [];
  if (!parsed.includes('review-approved') && !parsed.includes('tests-passed')) {
    parsed.unshift('review-approved');
  }
  return parsed;
}

function isStopCondition(
  value: unknown,
): value is RevisionLoopConfiguration['stopConditions'][number] {
  return (
    typeof value === 'string' &&
    (['review-approved', 'tests-passed', 'human-accepted'] as const).includes(
      value as RevisionLoopConfiguration['stopConditions'][number],
    )
  );
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
