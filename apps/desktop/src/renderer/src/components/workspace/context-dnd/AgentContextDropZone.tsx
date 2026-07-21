import { useState, type DragEvent } from 'react';
import { FileCode2, Link2, Lock, X } from 'lucide-react';

import type { WorkshopNode } from '../canvas/CanvasNode.js';
import {
  hasWorkspaceContextDrag,
  readWorkspaceContextDrag,
  type WorkspaceContextDragPayload,
} from './contracts.js';
import { MAX_AGENT_CONTEXT_ATTACHMENTS } from './linking.js';
import './AgentContextDropZone.css';

interface AgentContextDropZoneProps {
  readonly agent: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly readOnly: boolean;
  readonly onAttach: (payload: WorkspaceContextDragPayload) => Promise<void>;
  readonly onRemove: (attachmentNodeId: string) => void;
}

export function AgentContextDropZone({
  agent,
  nodes,
  readOnly,
  onAttach,
  onRemove,
}: AgentContextDropZoneProps) {
  const [draggingOver, setDraggingOver] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attachmentIds = agent.data.contextAttachmentIds ?? [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const disabled = readOnly || pending;

  const acceptDrag = (event: DragEvent<HTMLElement>): void => {
    if (disabled || !hasWorkspaceContextDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDraggingOver(true);
  };

  return (
    <section
      className={`agent-context-drop-zone${draggingOver ? ' dragging-over' : ''}${disabled ? ' disabled' : ''}`}
      aria-label="Files for this agent"
      aria-disabled={disabled}
      onDragEnter={acceptDrag}
      onDragOver={acceptDrag}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingOver(false);
      }}
      onDrop={(event) => {
        setDraggingOver(false);
        if (disabled) return;
        const payload = readWorkspaceContextDrag(event.dataTransfer);
        if (payload === null) {
          setMessage("That can't be attached. Drag a file from the project files list.");
          return;
        }
        event.preventDefault();
        setPending(true);
        setMessage(null);
        void onAttach(payload)
          .catch((cause: unknown) => {
            setMessage(
              cause instanceof Error ? cause.message : "The file couldn't be attached. Try again.",
            );
          })
          .finally(() => setPending(false));
      }}
    >
      <header>
        <div>
          <Link2 size={14} aria-hidden="true" />
          <h3>Files for this agent</h3>
        </div>
        <span>
          {attachmentIds.length}/{MAX_AGENT_CONTEXT_ATTACHMENTS}
        </span>
      </header>
      {readOnly ? (
        <p className="agent-context-read-only" role="status">
          <Lock size={13} aria-hidden="true" />
          Unlock this agent and get edit access to change these files.
        </p>
      ) : (
        <p>
          Drop a project file or editor tab here to share it with this agent. The saved file is
          checked again before the agent runs.
        </p>
      )}
      {pending ? <p role="status">Checking the saved file…</p> : null}
      {message !== null ? (
        <p className="agent-context-error" role="alert">
          {message}
        </p>
      ) : null}
      {attachmentIds.length === 0 ? (
        <p className="agent-context-empty">No files shared yet.</p>
      ) : (
        <ul>
          {attachmentIds.map((attachmentNodeId) => {
            const node = nodesById.get(attachmentNodeId);
            const reference = node?.data.kind === 'file' ? node.data.file : undefined;
            const unavailable =
              node === undefined ||
              reference === undefined ||
              reference.kind !== 'file' ||
              reference.missing;
            const attachmentTitle = node?.data.title ?? 'File no longer available';
            const attachmentPath = reference?.relativePath ?? attachmentNodeId;
            return (
              <li key={attachmentNodeId} className={unavailable ? 'unavailable' : ''}>
                <FileCode2 size={13} aria-hidden="true" />
                <span>
                  <strong title={attachmentTitle}>{attachmentTitle}</strong>
                  <code title={attachmentPath}>{attachmentPath}</code>
                  {unavailable ? (
                    <small>This file can't be found — remove it or relink it.</small>
                  ) : null}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${node?.data.title ?? attachmentNodeId} from this agent`}
                  onClick={() => onRemove(attachmentNodeId)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
