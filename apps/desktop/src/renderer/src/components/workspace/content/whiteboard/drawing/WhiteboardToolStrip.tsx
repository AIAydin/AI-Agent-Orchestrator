import type { JSX, ReactNode } from 'react';
import { ArrowRight, Circle, Diamond, MousePointer2, Pencil, Square, Type } from 'lucide-react';

import type { WhiteboardTool } from './useWhiteboardDrawing.js';

const TOOLS: readonly { readonly tool: WhiteboardTool; readonly label: string; readonly icon: ReactNode }[] = [
  { tool: 'select', label: 'Select', icon: <MousePointer2 size={13} aria-hidden="true" /> },
  { tool: 'rectangle', label: 'Draw rectangle', icon: <Square size={13} aria-hidden="true" /> },
  { tool: 'ellipse', label: 'Draw ellipse', icon: <Circle size={13} aria-hidden="true" /> },
  { tool: 'diamond', label: 'Draw diamond', icon: <Diamond size={13} aria-hidden="true" /> },
  { tool: 'arrow', label: 'Draw arrow', icon: <ArrowRight size={13} aria-hidden="true" /> },
  { tool: 'text', label: 'Add text', icon: <Type size={13} aria-hidden="true" /> },
  { tool: 'freedraw', label: 'Draw freehand', icon: <Pencil size={13} aria-hidden="true" /> },
];

/** The always-visible tool selector in the node header. Tools are modes, so they cannot live in a popover. */
export function WhiteboardToolStrip({
  tool,
  readOnly,
  onSelectTool,
}: {
  readonly tool: WhiteboardTool;
  readonly readOnly: boolean;
  readonly onSelectTool: (tool: WhiteboardTool) => void;
}): JSX.Element {
  return (
    <div className="whiteboard-tool-strip" role="group" aria-label="Whiteboard tools">
      {TOOLS.map((entry) => (
        <button
          key={entry.tool}
          type="button"
          aria-label={entry.label}
          aria-pressed={tool === entry.tool}
          disabled={readOnly}
          onClick={() => {
            onSelectTool(entry.tool);
          }}
        >
          {entry.icon}
        </button>
      ))}
    </div>
  );
}
