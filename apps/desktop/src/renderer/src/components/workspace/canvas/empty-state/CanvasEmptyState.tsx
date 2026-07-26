import { Bot } from 'lucide-react';

interface CanvasEmptyStateProps {
  readOnly: boolean;
  onAddAgent: () => void;
}

/** Card shown while the canvas has no nodes. One action: add the default agent. */
export function CanvasEmptyState({ readOnly, onAddAgent }: CanvasEmptyStateProps) {
  return (
    <>
      <span className="empty-orbit">
        <Bot size={22} />
      </span>
      <h2>Start with an agent</h2>
      <p>It runs right here on the canvas. More node types live in the side panel.</p>
      <div>
        <button type="button" className="button primary" disabled={readOnly} onClick={onAddAgent}>
          Add an agent
        </button>
      </div>
    </>
  );
}
