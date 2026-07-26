import { useState, type JSX } from 'react';
import { History, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';

import { MarkdownComposer } from '../../content/markdown/MarkdownComposer.js';
import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';

/**
 * Product-brief face: markdown requirements plus a checklist, edited in place;
 * version history lives in a popover.
 */
export function BriefNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const markdown = data.markdown ?? '';
  const checklist = data.checklist ?? [];
  const versions = data.versions ?? [];
  const latestVersion = versions.at(-1);
  const [historyOpen, setHistoryOpen] = useState(false);

  const update = (patch: Parameters<typeof session.updateNodeData>[1]): void => {
    session.updateNodeData(id, patch);
  };

  return (
    <section className="node-face brief-node-face" aria-label="Product brief">
      <div className="node-face-strip nodrag">
        <span className="node-face-strip-label">Product brief</span>
        <button
          type="button"
          aria-label="Version history"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <History size={12} aria-hidden="true" /> {versions.length}
        </button>
      </div>
      <div className="node-face-body nowheel nodrag">
        <MarkdownComposer
          label="Requirements"
          value={markdown}
          readOnly={readOnly}
          emptyLabel="Write the product requirements, constraints, and how you'll know it's done."
          onBeginEdit={() => session.recordHistory()}
          onChange={(value) => update({ markdown: value })}
        />

        <div className="node-face-list-header">
          <strong>
            Checklist <span>{checklist.length}</span>
          </strong>
          <button
            type="button"
            aria-label="Add checklist item"
            disabled={readOnly}
            onClick={() => {
              session.recordHistory();
              update({
                checklist: [
                  ...checklist,
                  { id: crypto.randomUUID(), label: 'New requirement', checked: false },
                ],
              });
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add
          </button>
        </div>
        {checklist.map((item, index) => (
          <div className="node-face-row" key={item.id}>
            <input
              type="checkbox"
              name={`brief-face-checklist-complete-${item.id}`}
              checked={item.checked}
              disabled={readOnly}
              aria-label={`Complete ${item.label}`}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({
                  checklist: checklist.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, checked: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <input
              name={`brief-face-checklist-label-${item.id}`}
              value={item.label}
              readOnly={readOnly}
              aria-label={`Checklist item ${index + 1}`}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({
                  checklist: checklist.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, label: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <button
              type="button"
              className="icon-button danger-text"
              aria-label={`Remove ${item.label}`}
              disabled={readOnly}
              onClick={() => {
                session.recordHistory();
                update({ checklist: checklist.filter((candidate) => candidate.id !== item.id) });
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}

        {historyOpen ? (
          <div className="node-face-popover" role="dialog" aria-label="Brief version history">
            <button
              type="button"
              aria-label="Save brief version"
              disabled={readOnly || markdown.trim() === '' || latestVersion?.markdown === markdown}
              onClick={() => {
                session.recordHistory();
                update({
                  versions: [
                    ...versions,
                    {
                      id: crypto.randomUUID(),
                      createdAt: new Date().toISOString(),
                      markdown,
                      authorId: 'local-user',
                    },
                  ],
                });
              }}
            >
              <Save size={12} aria-hidden="true" /> Save brief version
            </button>
            {versions.length === 0 ? (
              <p>No saved versions yet. Edits still save automatically with the canvas.</p>
            ) : (
              <ol className="brief-face-versions">
                {versions
                  .slice()
                  .reverse()
                  .map((version) => (
                    <li key={version.id}>
                      <span>{new Date(version.createdAt).toLocaleString()}</span>
                      <button
                        type="button"
                        disabled={readOnly || version.markdown === markdown}
                        aria-label={`Restore brief version from ${new Date(version.createdAt).toLocaleString()}`}
                        onClick={() => {
                          session.recordHistory();
                          update({ markdown: version.markdown });
                        }}
                      >
                        <RotateCcw size={11} aria-hidden="true" /> Restore
                      </button>
                    </li>
                  ))}
              </ol>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
