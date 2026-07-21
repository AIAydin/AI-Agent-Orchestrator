/* eslint-disable @typescript-eslint/unbound-method */
import { useState, type JSX } from 'react';

import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { uniqueNodeTitle } from './unique-title.js';

/**
 * The generic canvas-node title shown in every node header. Double-clicking the title swaps it for
 * an editable input (autofocus + select-all); Enter or blur commits, Escape cancels. Commits run
 * the title through {@link uniqueNodeTitle} so a rename never duplicates another node's name — the
 * same de-duplication the canvas applies elsewhere. Read-only nodes (view-only role or locked)
 * render the title as plain, non-editable text.
 *
 * Agent nodes render their own inline rename inside AgentSessionNode's title bar, so CanvasNode does
 * not mount this component for them (no double rename affordance).
 */
export function CanvasNodeHeaderTitle({
  id,
  title,
  readOnly,
}: {
  readonly id: string;
  readonly title: string;
  readonly readOnly: boolean;
}): JSX.Element {
  const { updateNodeData, recordHistory, nodeRoster } = useAgentSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const begin = (): void => {
    if (readOnly) return;
    setDraft(title);
    setEditing(true);
  };
  const commit = (): void => {
    setEditing(false);
    const next = uniqueNodeTitle(draft, id, nodeRoster);
    if (next !== '' && next !== title) updateNodeData(id, { title: next });
  };
  const cancel = (): void => setEditing(false);

  if (editing) {
    return (
      <input
        className="canvas-node-title-input nodrag"
        aria-label="Node title"
        name={`node-${id}-title`}
        value={draft}
        autoFocus
        onFocus={(event) => {
          recordHistory();
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
        onBlur={commit}
      />
    );
  }

  return (
    <strong
      className="canvas-node-title"
      title={title}
      {...(readOnly ? {} : { onDoubleClick: begin })}
    >
      {title}
    </strong>
  );
}
