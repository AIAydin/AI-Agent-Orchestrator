import { useRef } from 'react';
import { RotateCw } from 'lucide-react';

import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { snappedRotation } from './text-rotation.js';

export function TextRotateHandle({ id }: { readonly id: string }) {
  const session = useAgentSession();
  const recorded = useRef(false);

  return (
    <button
      type="button"
      className="text-rotate-handle nodrag"
      aria-label="Rotate text"
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        recorded.current = false;
        const article = event.currentTarget.closest('.canvas-node');
        if (article === null) return;
        const bounds = article.getBoundingClientRect();
        const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        const move = (pointer: PointerEvent) => {
          if (!recorded.current) {
            recorded.current = true;
            session.recordHistory();
          }
          const raw =
            (Math.atan2(pointer.clientY - center.y, pointer.clientX - center.x) * 180) / Math.PI +
            90;
          session.updateNodeData(id, { rotationDeg: snappedRotation(raw, pointer.shiftKey) });
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      }}
    >
      <RotateCw size={12} aria-hidden="true" />
    </button>
  );
}
