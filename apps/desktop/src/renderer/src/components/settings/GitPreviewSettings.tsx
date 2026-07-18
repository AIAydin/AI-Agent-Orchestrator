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
        description="Agents that can change files work in separate copies (worktrees) of your project, so your main copy stays untouched."
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
            Forgeboard always shows exactly what will be removed and asks before deleting a worktree
            or branch.
          </small>
          <FolderReadinessEvidence status={managedWorktreeReadiness} />
        </div>
        <label>
          Cleanup policy
          <select
            name="worktree-cleanup-policy"
            value={draft.worktreeCleanupPolicy}
            onChange={(event) =>
              setDraft({
                ...draft,
                worktreeCleanupPolicy: event.target.value as 'manual',
              })
            }
            aria-describedby="worktree-cleanup-policy-help"
          >
            <option value="manual">Manual · ask me first</option>
            {draft.worktreeCleanupPolicy !== 'manual' && (
              <option value={draft.worktreeCleanupPolicy} disabled>
                {draft.worktreeCleanupPolicy} · saved but not supported
              </option>
            )}
          </select>
          <small id="worktree-cleanup-policy-help">
            Manual cleanup is the only option right now. Automatic cleanup after a merge or after a
            set time is not offered yet — Forgeboard will only automate deletion when it can show
            exactly what would be removed.
          </small>
        </label>
        {draft.worktreeCleanupPolicy !== 'manual' && (
          <p className="recovery-guidance warning" role="status">
            This cleanup policy came from an older version and never runs automatically. Choose
            Manual before saving.
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Commit identity"
        description="Set the name and email Forgeboard puts on its commits. Leave both fields blank to use the Git settings from this repository."
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
          Fill in both fields or leave both empty. Forgeboard shows the exact name and email again
          for you to confirm before every commit.
        </small>
        <GitIdentityCheck
          name={draft.gitIdentityName}
          email={draft.gitIdentityEmail}
          activeProject={activeProject}
          busy={busy}
          perform={perform}
        />
      </SettingsSection>
      <SettingsSection
        title="Git remote"
        description="Set the default remote for Git and pull request steps. Every push, GitHub check, and pull request still needs your review before it runs."
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
          Before anything is pushed, Forgeboard checks this name against the selected agent's
          worktree and shows you the exact remote, branch, commits, and files. GitHub sign-in stays
          with the optional gh tool on your computer; Forgeboard stores no token.
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
        description="Set the command that starts your app in a preview. It is stored as a program plus its arguments, never as shell text. Leave it blank to pick a package script from the project for each preview."
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
