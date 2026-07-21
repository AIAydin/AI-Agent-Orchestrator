/* eslint-disable @typescript-eslint/unbound-method */
import { useEffect, useRef, useState, type JSX } from 'react';
import { History, MessageSquare, SlidersHorizontal, X } from 'lucide-react';

import type { WorkshopNodeData } from '../CanvasNode.js';
import { useAgentSession } from '../../runs/agent-session/AgentSessionContext.js';
import { useWorkflowRuntime } from '../../workflows/WorkflowRuntimeContext.js';
import { NodeRunHistory } from '../../node-history/NodeRunHistory.js';
import { LocalComments } from '../../comments/LocalComments.js';
import { SharedComments } from '../../collaboration/comments/SharedComments.js';
import { useNodeComments } from './NodeCommentsContext.js';

type DetailsTab = 'settings' | 'comments' | 'history';

/**
 * Header affordance that opens a popover anchored to the node with the three capabilities that used
 * to live only in the WorkspaceInspector: Settings (description + accent colour), Comments
 * (local + shared), and History (workflow run history). Each section wires to the exact same graph
 * mutations and reusable components the inspector uses — settings through AgentSessionContext,
 * comments through NodeCommentsContext, history through WorkflowRuntimeContext — so this is purely a
 * second home for the data, not a fork of it. The inspector is left untouched.
 *
 * The popover carries `nowheel nodrag` so scrolling and typing inside it never pan or drag the
 * canvas node, and it is read-only aware: locked or view-only nodes can still read comments and
 * history but cannot edit settings or post comments.
 */
export function CanvasNodeDetailsPopover({
  id,
  data,
  readOnly,
}: {
  readonly id: string;
  readonly data: WorkshopNodeData;
  readonly readOnly: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DetailsTab>('settings');
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (hostRef.current !== null && !hostRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  return (
    <div className="canvas-node-details" ref={hostRef}>
      <button
        type="button"
        className="node-details-button nodrag"
        aria-label={`Node details for ${data.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="node-details-popover nowheel nodrag"
          role="dialog"
          aria-label={`${data.title} details`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <header className="node-details-popover-header">
            <div className="node-details-tabs" role="tablist" aria-label="Node details sections">
              <DetailsTabButton
                icon={<SlidersHorizontal size={13} aria-hidden="true" />}
                label="Settings"
                selected={tab === 'settings'}
                onSelect={() => setTab('settings')}
              />
              <DetailsTabButton
                icon={<MessageSquare size={13} aria-hidden="true" />}
                label="Comments"
                selected={tab === 'comments'}
                onSelect={() => setTab('comments')}
              />
              <DetailsTabButton
                icon={<History size={13} aria-hidden="true" />}
                label="History"
                selected={tab === 'history'}
                onSelect={() => setTab('history')}
              />
            </div>
            <button
              type="button"
              className="node-details-close nodrag"
              aria-label="Close node details"
              onClick={() => setOpen(false)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>
          <div className="node-details-body" role="tabpanel">
            {tab === 'settings' && <SettingsSection id={id} data={data} readOnly={readOnly} />}
            {tab === 'comments' && <CommentsSection id={id} />}
            {tab === 'history' && <HistorySection id={id} />}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailsTabButton({
  icon,
  label,
  selected,
  onSelect,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={`node-details-tab${selected ? ' selected' : ''} nodrag`}
      onClick={onSelect}
    >
      {icon}
      {label}
    </button>
  );
}

function SettingsSection({
  id,
  data,
  readOnly,
}: {
  readonly id: string;
  readonly data: WorkshopNodeData;
  readonly readOnly: boolean;
}): JSX.Element {
  const { updateNodeData, recordHistory } = useAgentSession();
  return (
    <fieldset className="node-details-fields" disabled={readOnly} aria-label="Node settings">
      <label>
        Description
        <textarea
          name={`node-${id}-details-description`}
          rows={4}
          value={data.description}
          onFocus={recordHistory}
          onChange={(event) => updateNodeData(id, { description: event.target.value })}
        />
      </label>
      <label>
        Accent colour
        <input
          type="color"
          name={`node-${id}-details-accent-color`}
          value={data.color}
          onFocus={recordHistory}
          onChange={(event) => updateNodeData(id, { color: event.target.value })}
        />
      </label>
    </fieldset>
  );
}

function CommentsSection({ id }: { readonly id: string }): JSX.Element {
  const comments = useNodeComments();
  return (
    <>
      <LocalComments
        comments={comments.localCommentsFor(id)}
        onCreate={(body) => comments.createLocalComment(id, body)}
      />
      <SharedComments
        comments={comments.sharedCommentsFor(id)}
        rejectedCommentEntries={comments.rejectedSharedCommentsFor(id)}
        roomEnabled={comments.roomEnabled}
        canComment={comments.canComment}
        onCreate={(body) => comments.createSharedComment(id, body)}
        onDiscardRejected={comments.discardRejectedComment}
      />
    </>
  );
}

function HistorySection({ id }: { readonly id: string }): JSX.Element {
  const { executions } = useWorkflowRuntime();
  return <NodeRunHistory nodeId={id} executions={executions} />;
}
