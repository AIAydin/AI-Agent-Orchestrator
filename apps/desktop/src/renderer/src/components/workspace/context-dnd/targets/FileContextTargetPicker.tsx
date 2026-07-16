import { useEffect, useMemo, useState } from 'react';
import { Link2 } from 'lucide-react';

import type { WorkshopNode } from '../../canvas/CanvasNode.js';
import type { WorkspaceContextDragPayload } from '../contracts.js';
import './FileContextTargetPicker.css';

interface FileContextTargetPickerProps {
  readonly projectId: string;
  readonly source: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly readOnly: boolean;
  readonly onAttach: (targetNodeId: string, payload: WorkspaceContextDragPayload) => Promise<void>;
}

/** Keyboard-accessible equivalent of dropping a configured File node onto an Agent. */
export function FileContextTargetPicker({
  projectId,
  source,
  nodes,
  readOnly,
  onAttach,
}: FileContextTargetPickerProps) {
  const agents = useMemo(
    () => nodes.filter((node) => node.data.kind === 'agent' && !node.data.locked),
    [nodes],
  );
  const [targetNodeId, setTargetNodeId] = useState(agents[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const reference = source.data.kind === 'file' ? source.data.file : undefined;
  const sourceAvailable =
    reference !== undefined &&
    reference.projectId === projectId &&
    reference.kind === 'file' &&
    !reference.missing &&
    !source.data.locked;

  useEffect(() => {
    if (!agents.some((agent) => agent.id === targetNodeId)) setTargetNodeId(agents[0]?.id ?? '');
  }, [agents, targetNodeId]);

  return (
    <section className="file-context-target-picker" aria-label="Attach file to Agent context">
      <header>
        <Link2 size={14} aria-hidden="true" />
        <h3>Use as Agent context</h3>
      </header>
      {agents.length === 0 ? (
        <p>Add and unlock an Agent node to attach this saved file.</p>
      ) : (
        <div>
          <label>
            Target Agent
            <select
              name="file-node-agent-context-target"
              value={targetNodeId}
              disabled={readOnly || pending || !sourceAvailable}
              onChange={(event) => setTargetNodeId(event.target.value)}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.data.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={readOnly || pending || !sourceAvailable || targetNodeId.length === 0}
            onClick={() => {
              if (reference === undefined || targetNodeId.length === 0) return;
              setPending(true);
              setMessage(null);
              void onAttach(targetNodeId, {
                schemaVersion: 1,
                kind: 'project-file',
                projectId,
                relativePath: reference.relativePath,
                sourceNodeId: source.id,
              })
                .then(() => setMessage('Attached the saved file to Agent context.'))
                .catch((cause: unknown) =>
                  setMessage(
                    cause instanceof Error ? cause.message : 'The file could not be attached.',
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            {pending ? 'Verifying…' : 'Attach saved disk file'}
          </button>
        </div>
      )}
      {message !== null ? (
        <p role={message.startsWith('Attached') ? 'status' : 'alert'}>{message}</p>
      ) : null}
    </section>
  );
}
