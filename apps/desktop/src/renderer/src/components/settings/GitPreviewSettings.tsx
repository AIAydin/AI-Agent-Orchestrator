import { unwrap } from '../../lib/ipc.js';
import { CommandEditor, SettingsSection, type AsyncSettingsProps } from './shared.js';

export function GitPreviewSettings({ draft, setDraft, perform }: AsyncSettingsProps) {
  async function chooseExecutable(onSelected: (path: string) => void) {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected) onSelected(selected);
    });
  }

  return (
    <>
      <SettingsSection
        title="Git worktrees"
        description="Writable agents are isolated from your primary checkout by default."
      >
        <label>
          Branch prefix
          <input
            name="git-branch-prefix"
            aria-label="Branch prefix"
            value={draft.branchPrefix}
            onChange={(event) => setDraft({ ...draft, branchPrefix: event.target.value })}
          />
          <small>
            Creates &lt;prefix&gt;&lt;task&gt;/&lt;agent&gt;-&lt;id&gt;. Examples: forgeboard/ or
            team/agents/.
          </small>
        </label>
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
              onClick={() =>
                void perform(async () => {
                  const selected = unwrap(await window.forgeboard.projects.pickParent());
                  if (selected) setDraft((current) => ({ ...current, worktreeRoot: selected }));
                })
              }
            >
              Browse
            </button>
          </span>
          <small>
            Forgeboard never cleans a worktree or branch without an impact-specific confirmation.
          </small>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Development preview"
        description="The preview command is stored as an executable plus literal arguments—never as a shell string. Leave it blank to choose a detected package script per preview node."
      >
        <CommandEditor
          label="Development server"
          name="development-server"
          value={draft.developmentCommand}
          onChange={(developmentCommand) => setDraft({ ...draft, developmentCommand })}
          onBrowse={() =>
            void chooseExecutable((executable) =>
              setDraft((current) => ({
                ...current,
                developmentCommand: { ...current.developmentCommand, executable },
              })),
            )
          }
        />
      </SettingsSection>
      <SettingsSection
        title="Previews"
        description="Forgeboard binds previews to loopback by default and validates trusted hosts."
      >
        <div className="two-column">
          <label>
            Preview port start
            <input
              type="number"
              name="preview-port-start"
              min="1024"
              max="65534"
              value={draft.previewPortStart}
              onChange={(event) =>
                setDraft({ ...draft, previewPortStart: event.target.valueAsNumber })
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
              value={draft.previewPortEnd}
              onChange={(event) =>
                setDraft({ ...draft, previewPortEnd: event.target.valueAsNumber })
              }
            />
          </label>
        </div>
        <label>
          Trusted preview hosts
          <input
            name="preview-trusted-hosts"
            value={draft.previewTrustedHosts.join(', ')}
            onChange={(event) =>
              setDraft({
                ...draft,
                previewTrustedHosts: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      </SettingsSection>
    </>
  );
}
