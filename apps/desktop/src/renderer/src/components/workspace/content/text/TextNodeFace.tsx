import { useEffect, useRef, useState } from 'react';

import type { NodeFaceProps } from '../../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { onTextEditRequest } from './text-edit-bus.js';
import './text-node-face.css';

const TEXT_LIMIT = 10_000;

/**
 * Text face: a bare, borderless label the user can drop anywhere on the
 * canvas. Mounts straight into edit mode when empty, otherwise shows the
 * committed text and re-enters editing on double click or an edit-bus
 * request (used by the canvas toolbar's "edit" affordance).
 */
export function TextNodeFace({ id, data }: NodeFaceProps) {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const text = data.text ?? '';
  const [editing, setEditing] = useState(() => !readOnly && text === '');
  const startedRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(
    () =>
      onTextEditRequest((nodeId) => {
        if (nodeId === id && !readOnly) setEditing(true);
      }),
    [id, readOnly],
  );

  useEffect(() => {
    if (!editing) {
      startedRef.current = false;
      return;
    }
    if (!startedRef.current) {
      startedRef.current = true;
      session.recordHistory();
    }
    const editor = editorRef.current;
    if (editor !== null) {
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
      editor.style.height = 'auto';
      editor.style.height = `${editor.scrollHeight}px`;
    }
  }, [editing, session]);

  if (readOnly && editing) setEditing(false);

  if (editing && !readOnly) {
    return (
      <section className="node-face text-node-face" data-text-size={data.fontSize ?? 'm'}>
        <textarea
          ref={editorRef}
          className="text-face-editor nodrag nowheel"
          name={`node-${id}-text`}
          aria-label="Text content"
          value={text}
          rows={1}
          onChange={(event) => {
            session.updateNodeData(id, { text: event.target.value.slice(0, TEXT_LIMIT) });
            event.target.style.height = 'auto';
            event.target.style.height = `${event.target.scrollHeight}px`;
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setEditing(false);
            }
          }}
        />
      </section>
    );
  }

  return (
    <section className="node-face text-node-face" data-text-size={data.fontSize ?? 'm'}>
      <div
        className={text === '' ? 'text-face-display text-face-placeholder' : 'text-face-display'}
        {...(readOnly ? {} : { onDoubleClick: () => setEditing(true) })}
      >
        {text === '' ? 'Type…' : text}
      </div>
    </section>
  );
}
