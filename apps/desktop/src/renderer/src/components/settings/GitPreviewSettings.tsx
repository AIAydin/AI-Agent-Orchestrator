import { unwrap } from '../../lib/ipc.js';
import { numericDraftValue } from './fields/numeric-draft.js';
import { FolderReadinessEvidence } from './readiness/FolderReadinessEvidence.js';
import type { FolderReadinessStatus } from './readiness/useSettingsFolderReadiness.js';
import { SettingsSection, type AsyncSettingsProps } from './shared.js';

interface GitPreviewSettingsProps extends AsyncSettingsProps {
  readonly managedWorktreeReadiness?: FolderReadinessStatus | undefined;
}

export function GitPreviewSettings({
  draft,
  setDraft,
  busy,
  perform,
  managedWorktreeReadiness,
}: GitPreviewSettingsProps) {
  return (
    <>
      <SettingsSection
        title="Git worktrees"
        description="Agents that change files work in separate copies (worktrees), so your main copy stays untouched."
      >
        <div className="settings-form-field">
          <label htmlFor="managed-worktree-location">Managed worktree location</label>
          <span className="path-picker">
            <input
              id="managed-worktree-location"
              name="managed-worktree-location"
              value={draft.worktreeRoot}
              onChange={(event) => setDraft({ ...draft, worktreeRoot: event.target.value })}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const selected = unwrap(await window.forgeboard.projects.pickParent());
                  if (selected)
                    setDraft((current) => ({
                      ...current,
                      worktreeRoot: selected,
                    }));
                })
              }
            >
              Browse
            </button>
          </span>
          <small>Artemis asks before deleting a worktree or branch.</small>
          <FolderReadinessEvidence status={managedWorktreeReadiness} />
        </div>
        {draft.worktreeCleanupPolicy !== 'manual' && (
          <div>
            <p className="recovery-guidance warning" role="status">
              An older version saved the “{draft.worktreeCleanupPolicy}” cleanup policy. It never
              runs automatically — switch to manual cleanup before saving.
            </p>
            <button
              className="button"
              type="button"
              onClick={() => setDraft({ ...draft, worktreeCleanupPolicy: 'manual' })}
            >
              Switch to manual cleanup
            </button>
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        title="Previews"
        description="The local ports Artemis uses to open app previews."
      >
        <div className="two-column">
          <label>
            Preview port start
            <input
              type="number"
              name="preview-port-start"
              min="1024"
              max="65534"
              value={numericDraftValue(draft.previewPortStart)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  previewPortStart: event.target.valueAsNumber,
                })
              }
            />
          </label>
          <label>
            Preview port end
            <input
              type="number"
              name="preview-port-end"
              min="1025"
              max="65535"
              value={numericDraftValue(draft.previewPortEnd)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  previewPortEnd: event.target.valueAsNumber,
                })
              }
            />
          </label>
        </div>
      </SettingsSection>
    </>
  );
}
