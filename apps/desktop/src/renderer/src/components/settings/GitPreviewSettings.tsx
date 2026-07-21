import { GitRemoteSettingSchema, type Project } from '../../../../shared/application/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import type { CommandReadinessStatus } from '../configuration/useCommandReadiness.js';
import { numericDraftValue } from './fields/numeric-draft.js';
import { GitConnectionsSettings } from './git-connections/index.js';
import { FolderReadinessEvidence } from './readiness/FolderReadinessEvidence.js';
import type { FolderReadinessStatus } from './readiness/useSettingsFolderReadiness.js';
import { CommandEditor, SettingsSection, type AsyncSettingsProps } from './shared.js';
import { GitIdentityCheck } from './git-identity/GitIdentityCheck.js';

interface GitPreviewSettingsProps extends AsyncSettingsProps {
  readonly projects: readonly Project[];
  readonly activeProject: Project | null;
  readonly onError: (message: string) => void;
  readonly developmentReadiness?: CommandReadinessStatus | undefined;
  readonly managedWorktreeReadiness?: FolderReadinessStatus | undefined;
}

export function GitPreviewSettings({
  draft,
  setDraft,
  busy,
  perform,
  projects,
  activeProject,
  onError,
  developmentReadiness,
  managedWorktreeReadiness,
}: GitPreviewSettingsProps) {
  const gitRemoteValid = GitRemoteSettingSchema.safeParse(draft.gitRemote).success;

  async function chooseExecutable(onSelected: (path: string) => void) {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected) onSelected(selected);
    });
  }

  async function chooseExternalApplication(onSelected: (path: string) => void) {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExternalApplication());
      if (selected) onSelected(selected);
    });
  }

  return (
    <>
      <GitConnectionsSettings
        projects={projects}
        activeProject={activeProject}
        settingsBusy={busy}
        onError={onError}
      />
      <SettingsSection
        title="Git worktrees"
        description="Agents that change files work in separate copies (worktrees), so your main copy stays untouched."
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
            Branches are named &lt;prefix&gt;&lt;task&gt;/&lt;agent&gt;-&lt;id&gt;. Examples:
            forgeboard/ or team/agents/.
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
          <small>
            Forgeboard shows what will be removed and asks before deleting a worktree or branch.
          </small>
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
        title="Commit identity"
        description="The name and email on Forgeboard's commits. Leave both blank to use this repository's Git settings."
      >
        <div className="two-column">
          <label>
            Git identity name
            <input
              name="git-identity-name"
              autoComplete="name"
              maxLength={512}
              value={draft.gitIdentityName}
              onChange={(event) => setDraft({ ...draft, gitIdentityName: event.target.value })}
            />
          </label>
          <label>
            Git identity email
            <input
              type="email"
              name="git-identity-email"
              autoComplete="email"
              maxLength={512}
              value={draft.gitIdentityEmail}
              onChange={(event) => setDraft({ ...draft, gitIdentityEmail: event.target.value })}
            />
          </label>
        </div>
        <small>
          Fill in both fields or leave both empty. You'll confirm the exact name and email before
          every commit.
        </small>
        <GitIdentityCheck
          name={draft.gitIdentityName}
          email={draft.gitIdentityEmail}
          activeProject={activeProject}
          busy={busy}
          perform={perform}
        />
        <div className="settings-form-field">
          <label htmlFor="external-editor-executable">External application</label>
          <span className="path-picker">
            <input
              id="external-editor-executable"
              name="external-editor-executable"
              value={draft.externalEditorExecutable}
              placeholder="Use the system default"
              readOnly
            />
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void chooseExternalApplication((externalEditorExecutable) =>
                  setDraft((current) => ({
                    ...current,
                    externalEditorExecutable,
                  })),
                )
              }
            >
              Browse
            </button>
            <button
              type="button"
              disabled={draft.externalEditorExecutable === ''}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  externalEditorExecutable: '',
                }))
              }
            >
              Use system default
            </button>
          </span>
          <small>
            Pick an application bundle (macOS) such as Visual Studio Code.app, or an exact
            executable on any platform. Forgeboard opens the workspace without a shell. Leave empty
            to use your system default.
          </small>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Git remote"
        description="The default remote for Git and pull request steps. Every push, GitHub check, and pull request still needs your review."
      >
        <label>
          Default remote
          <input
            name="git-default-remote"
            value={draft.gitRemote}
            maxLength={128}
            aria-invalid={!gitRemoteValid}
            aria-describedby={
              gitRemoteValid
                ? 'git-default-remote-help'
                : 'git-default-remote-help git-default-remote-error'
            }
            onChange={(event) => setDraft({ ...draft, gitRemote: event.target.value })}
          />
        </label>
        <small id="git-default-remote-help">
          Before any push, you'll see the exact remote, branch, commits, and files. GitHub sign-in
          stays with the optional gh tool; Forgeboard stores no token.
        </small>
        {!gitRemoteValid ? (
          <p id="git-default-remote-error" className="recovery-guidance warning" role="alert">
            Enter a Git remote name using letters, numbers, dots, underscores, or hyphens.
            Forgeboard checks that it exists in the selected agent's worktree.
          </p>
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="Development preview"
        description="The command that starts your app in a preview — a program plus arguments, never shell text. Leave blank to pick a package script for each preview."
      >
        <CommandEditor
          label="Development server"
          name="development-server"
          value={draft.developmentCommand}
          purpose="preview"
          onChange={(developmentCommand) => setDraft({ ...draft, developmentCommand })}
          onBrowse={() =>
            void chooseExecutable((executable) =>
              setDraft((current) => ({
                ...current,
                developmentCommand: {
                  ...current.developmentCommand,
                  executable,
                },
              })),
            )
          }
          readiness={developmentReadiness}
        />
      </SettingsSection>
      <SettingsSection
        title="Previews"
        description="Previews only accept connections from this computer unless you add trusted hosts below."
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
        <label>
          Trusted preview hosts
          <input
            name="preview-trusted-hosts"
            value={draft.previewTrustedHosts.join(', ')}
            aria-describedby="preview-trusted-hosts-help"
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
        <small id="preview-trusted-hosts-help">
          Comma-separated host names or addresses allowed to open previews — for example: 127.0.0.1,
          localhost.
        </small>
      </SettingsSection>
    </>
  );
}
