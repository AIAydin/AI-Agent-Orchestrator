import { useState, type JSX } from 'react';
import { History, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';

import { MarkdownComposer } from '../../content/markdown/MarkdownComposer.js';
import type { NodeFaceProps } from '../canvas/faces/node-face-registry.js';
import { useCanvasNodeInteractions } from '../canvas/interactions/CanvasNodeInteractionContext.js';
import { useAgentSession } from '../runs/agent-session/AgentSessionContext.js';

/**
 * Product-brief face: markdown, checklist, done conditions, attachments, and
 * prompt variables all edit in place; version history lives in a popover.
 */
export function BriefNodeFace({ id, data }: NodeFaceProps): JSX.Element {
  const session = useAgentSession();
  const interactions = useCanvasNodeInteractions();
  const readOnly = session.graphReadOnly || data.locked || interactions.readOnly;
  const markdown = data.markdown ?? '';
  const checklist = data.checklist ?? [];
  const criteria = data.acceptanceCriteria ?? [];
  const versions = data.versions ?? [];
  const latestVersion = versions.at(-1);
  const attachmentIds = new Set(data.attachmentIds ?? []);
  const attachmentCandidates = session.nodeRoster.filter(
    (candidate) =>
      candidate.id !== id &&
      ['file', 'task', 'diagram', 'note-image'].includes(candidate.kind),
  );
  const variables = Object.entries(data.variables ?? {});
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

        <div className="node-face-list-header">
          <strong>
            Done when <span>{criteria.length}</span>
          </strong>
          <button
            type="button"
            aria-label="Add a done condition"
            disabled={readOnly}
            onClick={() => {
              session.recordHistory();
              update({
                acceptanceCriteria: [
                  ...criteria,
                  { id: crypto.randomUUID(), description: 'New done condition', satisfied: false },
                ],
              });
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add
          </button>
        </div>
        {criteria.map((criterion, index) => (
          <div className="node-face-row" key={criterion.id}>
            <input
              type="checkbox"
              name={`brief-face-criterion-satisfied-${criterion.id}`}
              checked={criterion.satisfied}
              disabled={readOnly}
              aria-label={`Mark ${criterion.description} as done`}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, satisfied: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <input
              name={`brief-face-criterion-description-${criterion.id}`}
              value={criterion.description}
              readOnly={readOnly}
              aria-label={`Done condition ${index + 1}`}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, description: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <button
              type="button"
              className="icon-button danger-text"
              aria-label={`Remove ${criterion.description}`}
              disabled={readOnly}
              onClick={() => {
                session.recordHistory();
                update({
                  acceptanceCriteria: criteria.filter(
                    (candidate) => candidate.id !== criterion.id,
                  ),
                });
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}

        <div className="node-face-list-header">
          <strong>
            Attached items <span>{attachmentIds.size}</span>
          </strong>
        </div>
        {attachmentCandidates.length === 0 ? (
          <p className="node-face-hint">
            Add a file, task, diagram, or note to the canvas to attach it here.
          </p>
        ) : (
          attachmentCandidates.map((candidate) => (
            <label className="brief-face-attachment" key={candidate.id}>
              <input
                type="checkbox"
                name={`brief-face-attachment-${candidate.id}`}
                aria-label={`Attach ${candidate.title}`}
                checked={attachmentIds.has(candidate.id)}
                disabled={readOnly}
                onFocus={() => session.recordHistory()}
                onChange={(event) => {
                  const next = new Set(attachmentIds);
                  if (event.target.checked) next.add(candidate.id);
                  else next.delete(candidate.id);
                  update({ attachmentIds: [...next] });
                }}
              />
              <span>{candidate.title}</span>
              <small>{candidate.kind}</small>
            </label>
          ))
        )}

        <div className="node-face-list-header">
          <strong>
            Prompt variables <span>{variables.length}</span>
          </strong>
          <button
            type="button"
            aria-label="Add prompt variable"
            disabled={readOnly}
            onClick={() => {
              session.recordHistory();
              const name = uniqueVariableName(data.variables ?? {});
              update({ variables: { ...(data.variables ?? {}), [name]: '' } });
            }}
          >
            <Plus size={12} aria-hidden="true" /> Add
          </button>
        </div>
        {variables.length === 0 ? (
          <p className="node-face-hint">
            No variables yet. Add one to reuse the same text in agent prompts.
          </p>
        ) : null}
        {variables.map(([name, value], index) => (
          <div className="brief-face-variable-row" key={name}>
            <input
              name="brief-face-variable-name"
              value={name}
              readOnly={readOnly}
              aria-label={`Variable name ${index + 1}`}
              onFocus={() => session.recordHistory()}
              onChange={(event) => {
                const nextName = normalizedVariableName(event.target.value);
                if (
                  nextName === '' ||
                  (nextName !== name && variables.some(([key]) => key === nextName))
                ) {
                  return;
                }
                update({ variables: renamedVariable(data.variables ?? {}, name, nextName) });
              }}
            />
            <textarea
              name="brief-face-variable-value"
              rows={2}
              value={value}
              readOnly={readOnly}
              aria-label={`Variable value ${name}`}
              onFocus={() => session.recordHistory()}
              onChange={(event) =>
                update({
                  variables: {
                    ...(data.variables ?? {}),
                    [name]: event.target.value.slice(0, 100_000),
                  },
                })
              }
            />
            <button
              type="button"
              className="icon-button danger-text"
              aria-label={`Remove variable ${name}`}
              disabled={readOnly}
              onClick={() => {
                session.recordHistory();
                const next = { ...(data.variables ?? {}) };
                delete next[name];
                update({ variables: next });
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

function uniqueVariableName(variables: Readonly<Record<string, string>>): string {
  let index = Object.keys(variables).length + 1;
  while (`variable_${index}` in variables) index += 1;
  return `variable_${index}`;
}

function normalizedVariableName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_]/gu, '_')
    .slice(0, 128);
}

function renamedVariable(
  variables: Readonly<Record<string, string>>,
  previous: string,
  next: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).map(([name, value]) => [name === previous ? next : name, value]),
  );
}
