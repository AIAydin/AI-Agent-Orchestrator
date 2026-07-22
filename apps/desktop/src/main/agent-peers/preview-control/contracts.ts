import type {
  AgentPreviewAction,
  AgentPreviewActionIntent,
} from '../../previews/webview/preview-agent-browser.js';

export interface PreviewActionApprovalRequest {
  readonly projectId: string;
  readonly agentNodeId: string;
  readonly agentName: string;
  readonly previewNodeId: string;
  readonly previewName: string;
  readonly edgeId: string;
  readonly intent: AgentPreviewActionIntent;
}

export type PreviewActionAuthorizer = (request: PreviewActionApprovalRequest) => Promise<boolean>;

export function parseScrollRequest(value: unknown): { previewId: string; deltaY: number } | null {
  const record = unknownRecord(value);
  const previewId = record?.['previewId'];
  const deltaY = record?.['deltaY'];
  if (
    typeof previewId !== 'string' ||
    previewId.length < 1 ||
    previewId.length > 512 ||
    typeof deltaY !== 'number' ||
    !Number.isFinite(deltaY) ||
    deltaY === 0 ||
    Math.abs(deltaY) > 1_200
  )
    return null;
  return { previewId, deltaY };
}

export function parseActionRequest(
  value: unknown,
): { previewId: string; action: AgentPreviewAction } | null {
  const record = unknownRecord(value);
  const previewId = record?.['previewId'];
  const action = unknownRecord(record?.['action']);
  const kind = action?.['kind'];
  const elementHandle = action?.['elementHandle'];
  if (
    typeof previewId !== 'string' ||
    previewId.length < 1 ||
    previewId.length > 512 ||
    typeof elementHandle !== 'string' ||
    !UUID_PATTERN.test(elementHandle)
  )
    return null;
  if (kind === 'click') return { previewId, action: { kind, elementHandle } };
  if (
    kind !== 'type' ||
    typeof action?.['text'] !== 'string' ||
    action['text'].length < 1 ||
    action['text'].length > 4_000 ||
    typeof action['replace'] !== 'boolean'
  )
    return null;
  return {
    previewId,
    action: {
      kind,
      elementHandle,
      text: action['text'],
      replace: action['replace'],
    },
  };
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
