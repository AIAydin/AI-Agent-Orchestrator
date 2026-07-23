const MIN_DESKTOP_WIDTH = 1_280;
const MIN_DESKTOP_HEIGHT = 720;
const MAX_VIEWPORT_WIDTH = 2_560;
const MAX_VIEWPORT_HEIGHT = 1_600;

/**
 * Keeps the node's exact aspect ratio while giving responsive websites a
 * desktop-sized CSS viewport. The returned frame can therefore fill the node
 * edge-to-edge without stretching or triggering a mobile site layout.
 */
export function chromeViewportForNode(
  nodeWidth: number,
  nodeHeight: number,
): { width: number; height: number } {
  const width = Math.max(1, nodeWidth);
  const height = Math.max(1, nodeHeight);
  const desiredScale = Math.max(1, MIN_DESKTOP_WIDTH / width, MIN_DESKTOP_HEIGHT / height);
  const maximumScale = Math.min(MAX_VIEWPORT_WIDTH / width, MAX_VIEWPORT_HEIGHT / height);
  const scale = Math.max(1, Math.min(desiredScale, maximumScale));
  return {
    width: clamp(Math.round(width * scale), 320, MAX_VIEWPORT_WIDTH),
    height: clamp(Math.round(height * scale), 200, MAX_VIEWPORT_HEIGHT),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
