import { BookOpenCheck, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';

import { MarkdownComposer } from '../../content/markdown/MarkdownComposer.js';
import type { WorkshopNode } from '../canvas/CanvasNode.js';
import { NoteImageInspector } from './note-image/NoteImageInspector.js';
import './content-inspector.css';

interface BuiltInContentInspectorProps {
  readonly projectId: string;
  readonly node: WorkshopNode;
  readonly nodes: readonly WorkshopNode[];
  readonly readOnly: boolean;
  readonly onRecord: () => void;
  readonly onUpdate: (data: Partial<WorkshopNode['data']>) => void;
  readonly onError: (message: string) => void;
}

export function BuiltInContentInspector(props: BuiltInContentInspectorProps) {
  if (props.node.data.kind === 'brief') return <ProductBriefInspector {...props} />;
  if (props.node.data.kind === 'note-image') return <NoteImageInspector {...props} />;
  return null;
}

function ProductBriefInspector({ node, nodes, onRecord, onUpdate }: BuiltInContentInspectorProps) {
  const checklist = node.data.checklist ?? [];
  const criteria = node.data.acceptanceCriteria ?? [];
  const attachmentIds = new Set(node.data.attachmentIds ?? []);
  const versions = node.data.versions ?? [];
  const variables = Object.entries(node.data.variables ?? {});
  const attachmentCandidates = nodes.filter(
    (candidate) =>
      candidate.id !== node.id &&
      ['file', 'task', 'diagram', 'note-image'].includes(candidate.data.kind),
  );
  const markdown = node.data.markdown ?? '';
  const latestVersion = versions.at(-1);

  return (
    <section className="content-node-inspector" aria-label="Product brief settings">
      <header>
        <div>
          <BookOpenCheck size={14} />
          <h3>Product brief</h3>
        </div>
        <span>{versions.length} versions</span>
      </header>
      <MarkdownComposer
        label="Requirements"
        value={markdown}
        readOnly={node.data.locked}
        emptyLabel="Write the product requirements, constraints, and how you'll know it's done."
        onBeginEdit={onRecord}
        onChange={(value) => onUpdate({ markdown: value })}
      />

      <ContentListHeader
        title="Checklist"
        count={checklist.length}
        addLabel="Add checklist item"
        onAdd={() => {
          onRecord();
          onUpdate({
            checklist: [
              ...checklist,
              { id: crypto.randomUUID(), label: 'New requirement', checked: false },
            ],
          });
        }}
      />
      <div className="content-edit-list">
        {checklist.length === 0 ? <p>No checklist items yet.</p> : null}
        {checklist.map((item, index) => (
          <div className="content-edit-row" key={item.id}>
            <input
              type="checkbox"
              name={`brief-checklist-complete-${item.id}`}
              checked={item.checked}
              aria-label={`Complete ${item.label}`}
              onFocus={onRecord}
              onChange={(event) =>
                onUpdate({
                  checklist: checklist.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, checked: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <input
              name={`brief-checklist-label-${item.id}`}
              value={item.label}
              aria-label={`Checklist item ${index + 1}`}
              onFocus={onRecord}
              onChange={(event) =>
                onUpdate({
                  checklist: checklist.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, label: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <IconAction
              label={`Remove ${item.label}`}
              onClick={() => {
                onRecord();
                onUpdate({ checklist: checklist.filter((candidate) => candidate.id !== item.id) });
              }}
            />
          </div>
        ))}
      </div>

      <ContentListHeader
        title="Done when"
        count={criteria.length}
        addLabel="Add a done condition"
        onAdd={() => {
          onRecord();
          onUpdate({
            acceptanceCriteria: [
              ...criteria,
              {
                id: crypto.randomUUID(),
                description: 'New done condition',
                satisfied: false,
              },
            ],
          });
        }}
      />
      <div className="content-edit-list">
        {criteria.length === 0 ? <p>No done conditions yet.</p> : null}
        {criteria.map((criterion, index) => (
          <div className="content-edit-row" key={criterion.id}>
            <input
              type="checkbox"
              name={`brief-criterion-satisfied-${criterion.id}`}
              checked={criterion.satisfied}
              aria-label={`Mark ${criterion.description} as done`}
              onFocus={onRecord}
              onChange={(event) =>
                onUpdate({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, satisfied: event.target.checked }
                      : candidate,
                  ),
                })
              }
            />
            <textarea
              name={`brief-criterion-description-${criterion.id}`}
              rows={2}
              value={criterion.description}
              aria-label={`Done condition ${index + 1}`}
              onFocus={onRecord}
              onChange={(event) =>
                onUpdate({
                  acceptanceCriteria: criteria.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, description: event.target.value.slice(0, 10_000) }
                      : candidate,
                  ),
                })
              }
            />
            <IconAction
              label={`Remove ${criterion.description}`}
              onClick={() => {
                onRecord();
                onUpdate({
                  acceptanceCriteria: criteria.filter((candidate) => candidate.id !== criterion.id),
                });
              }}
            />
          </div>
        ))}
      </div>

      <section className="content-attachments" aria-label="Brief attachments">
        <header>
          <strong>Attached items</strong>
          <span>{attachmentIds.size}</span>
        </header>
        {attachmentCandidates.length === 0 ? (
          <p>Add a file, task, diagram, or note to the canvas to attach it here.</p>
        ) : (
          attachmentCandidates.map((candidate) => (
            <label key={candidate.id}>
              <input
                type="checkbox"
                name={`brief-attachment-${candidate.id}`}
                aria-label={`Attach ${candidate.data.title}`}
                checked={attachmentIds.has(candidate.id)}
                onFocus={onRecord}
                onChange={(event) => {
                  const next = new Set(attachmentIds);
                  if (event.target.checked) next.add(candidate.id);
                  else next.delete(candidate.id);
                  onUpdate({ attachmentIds: [...next] });
                }}
              />
              <span>{candidate.data.title}</span>
              <small>{candidate.data.kind}</small>
            </label>
          ))
        )}
      </section>

      <ContentListHeader
        title="Prompt variables"
        count={variables.length}
        addLabel="Add prompt variable"
        onAdd={() => {
          onRecord();
          const name = uniqueVariableName(node.data.variables ?? {});
          onUpdate({ variables: { ...(node.data.variables ?? {}), [name]: '' } });
        }}
      />
      <div className="content-edit-list">
        {variables.length === 0 ? (
          <p>No variables yet. Add one to reuse the same text in agent prompts.</p>
        ) : null}
        {variables.map(([name, value], index) => (
          <div className="content-variable-row" key={name}>
            <input
              name="brief-variable-name"
              value={name}
              aria-label={`Variable name ${index + 1}`}
              onFocus={onRecord}
              onChange={(event) => {
                const nextName = normalizedVariableName(event.target.value);
                if (
                  nextName === '' ||
                  (nextName !== name && variables.some(([key]) => key === nextName))
                ) {
                  return;
                }
                onUpdate({ variables: renamedVariable(node.data.variables ?? {}, name, nextName) });
              }}
            />
            <textarea
              name="brief-variable-value"
              rows={2}
              value={value}
              aria-label={`Variable value ${name}`}
              onFocus={onRecord}
              onChange={(event) =>
                onUpdate({
                  variables: {
                    ...(node.data.variables ?? {}),
                    [name]: event.target.value.slice(0, 100_000),
                  },
                })
              }
            />
            <IconAction
              label={`Remove variable ${name}`}
              onClick={() => {
                onRecord();
                const next = { ...(node.data.variables ?? {}) };
                delete next[name];
                onUpdate({ variables: next });
              }}
            />
          </div>
        ))}
      </div>

      <section className="brief-versions" aria-label="Brief version history">
        <button
          type="button"
          disabled={markdown.trim() === '' || latestVersion?.markdown === markdown}
          onClick={() => {
            onRecord();
            onUpdate({
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
          <Save size={13} /> Save brief version
        </button>
        {versions.length === 0 ? (
          <p>No saved versions yet. Your edits are still saved automatically with the canvas.</p>
        ) : (
          <ol>
            {versions
              .slice()
              .reverse()
              .map((version) => (
                <li key={version.id}>
                  <span>
                    {new Date(version.createdAt).toLocaleString()} · {version.authorId}
                  </span>
                  <small>{version.markdown.length.toLocaleString()} characters</small>
                  <button
                    type="button"
                    disabled={version.markdown === markdown}
                    aria-label={`Restore brief version from ${new Date(version.createdAt).toLocaleString()}`}
                    onClick={() => {
                      onRecord();
                      onUpdate({ markdown: version.markdown });
                    }}
                  >
                    <RotateCcw size={12} /> Restore
                  </button>
                </li>
              ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function ContentListHeader({
  title,
  count,
  addLabel,
  onAdd,
}: {
  readonly title: string;
  readonly count: number;
  readonly addLabel: string;
  readonly onAdd: () => void;
}) {
  return (
    <header className="content-list-header">
      <strong>
        {title} <span>{count}</span>
      </strong>
      <button type="button" aria-label={addLabel} onClick={onAdd}>
        <Plus size={13} /> Add
      </button>
    </header>
  );
}

function IconAction({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button type="button" className="icon-button danger-text" aria-label={label} onClick={onClick}>
      <Trash2 size={13} />
    </button>
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
