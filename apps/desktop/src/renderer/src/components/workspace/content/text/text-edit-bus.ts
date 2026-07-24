/** In-memory request channel: the canvas asks a mounted text face to enter edit mode. */
const listeners = new Set<(nodeId: string) => void>();

export function requestTextEdit(nodeId: string): void {
  for (const listener of listeners) listener(nodeId);
}

export function onTextEditRequest(listener: (nodeId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
