/**
 * Session partition for in-DOM preview webviews. No `persist:` prefix — the
 * session is in-memory and dies with the guest. Ids are URI-encoded so the
 * colon-delimited shape stays parseable.
 */
const PARTITION_PATTERN =
  /^(?:persist:)?preview:[^:]+:[^:]+(?::(?:comparison-left|comparison-right))?$/;

export function previewWebviewPartition(
  projectId: string,
  nodeId: string,
  slot?: 'comparison-left' | 'comparison-right',
  persistent = false,
): string {
  const scope = `${persistent ? 'persist:' : ''}preview:${encodeURIComponent(projectId)}:${encodeURIComponent(nodeId)}`;
  return slot === undefined ? scope : `${scope}:${slot}`;
}

export interface PreviewWebviewPartitionIdentity {
  readonly projectId: string;
  readonly nodeId: string;
  readonly slot: 'comparison-left' | 'comparison-right' | null;
  readonly persistent: boolean;
}

export function parsePreviewWebviewPartition(
  candidate: unknown,
): PreviewWebviewPartitionIdentity | null {
  if (!isPreviewWebviewPartition(candidate)) return null;
  const persistent = candidate.startsWith('persist:');
  const parts = candidate.slice(persistent ? 'persist:'.length : 0).split(':');
  try {
    return {
      projectId: decodeURIComponent(parts[1] ?? ''),
      nodeId: decodeURIComponent(parts[2] ?? ''),
      slot: parts[3] === 'comparison-left' || parts[3] === 'comparison-right' ? parts[3] : null,
      persistent,
    };
  } catch {
    return null;
  }
}

export function isPreviewWebviewPartition(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && PARTITION_PATTERN.test(candidate);
}
