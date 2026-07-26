import type { JSX } from 'react';

import { MarkdownComposer } from '../../../content/markdown/MarkdownComposer.js';
import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';

/**
 * Simple note face: just the note text. Rename the node from its header.
 * Legacy note-image saves may still carry image fields; they are ignored.
 */
export function NoteNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  return (
    <section className="node-face note-node-face" aria-label="Note">
      <div className="node-face-body nowheel nodrag">
        <MarkdownComposer
          label="Note"
          value={data.markdown ?? ''}
          readOnly={readOnly}
          emptyLabel="Write a note that stays on this device."
          onBeginEdit={() => session.recordHistory()}
          onChange={(markdown) => session.updateNodeData(id, { markdown })}
        />
      </div>
    </section>
  );
}
