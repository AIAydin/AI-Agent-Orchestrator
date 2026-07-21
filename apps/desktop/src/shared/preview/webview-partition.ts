/**
 * Session partition for in-DOM preview webviews. No `persist:` prefix — the
 * session is in-memory and dies with the guest. Ids are URI-encoded so the
 * colon-delimited shape stays parseable.
 */
const PARTITION_PATTERN = /^preview:[^:]+:[^:]+(?::(?:comparison-left|comparison-right))?$/;

export function previewWebviewPartition(
  projectId: string,
  nodeId: string,
  slot?: 'comparison-left' | 'comparison-right',
): string {
  const scope = `preview:${encodeURIComponent(projectId)}:${encodeURIComponent(nodeId)}`;
  return slot === undefined ? scope : `${scope}:${slot}`;
}

export function isPreviewWebviewPartition(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && PARTITION_PATTERN.test(candidate);
}
