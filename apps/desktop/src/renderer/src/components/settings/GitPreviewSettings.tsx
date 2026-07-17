import { GitRemoteSettingSchema } from '../../../../shared/application/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import type { CommandReadinessStatus } from '../configuration/useCommandReadiness.js';
import { numericDraftValue } from './fields/numeric-draft.js';
import { FolderReadinessEvidence } from './readiness/FolderReadinessEvidence.js';
import type { FolderReadinessStatus } from './readiness/useSettingsFolderReadiness.js';
import { CommandEditor, SettingsSection, type AsyncSettingsProps } from './shared.js';

interface GitPreviewSettingsProps extends AsyncSettingsProps {
  readonly developmentReadiness?: CommandReadinessStatus | undefined;
  readonly managedWorktreeReadiness?: FolderReadinessStatus | undefined;
}

export function GitPreviewSettings({
  draft,
  setDraft,
  perform,
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
            Forgeboard never cleans a worktree or branch without an impact-specific confirmation.
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
            <option value="manual">Manual · confirmation required</option>
            {draft.worktreeCleanupPolicy !== 'manual' && (
              <option value={draft.worktreeCleanupPolicy} disabled>
                {draft.worktreeCleanupPolicy} · stored but unavailable
              </option>
            )}
          </select>
          <small id="worktree-cleanup-policy-help">
            Manual cleanup is the only implemented policy. Automatic after-merge and retention
            cleanup are not offered until Forgeboard can verify the lifecycle and show exact impact.
          </small>
        </label>
        {draft.worktreeCleanupPolicy !== 'manual' && (
          <p className="recovery-guidance warning" role="status">
            This imported legacy policy is not executed automatically. Select Manual before saving
            to use the supported behavior.
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Commit identity"
        description="Optionally override the author identity used by Forgeboard commits. Leave both fields blank to use this repository's Git configuration."
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
          Provide both fields or neither. The exact effective identity is shown again before every
          commit and bound to the native confirmation.
        </small>
      </SettingsSection>
      <SettingsSection
        title="Remote automation"
        description="Choose the default remote offered by Git / PR nodes. Every push, GitHub lookup, and pull request remains an explicit reviewed action."
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
          A Git / PR node verifies this name against the selected agent worktree and shows the exact
          credential-free remote identity, branch, commits, and files before anything is pushed.
          GitHub authentication remains owned by the optional local gh CLI; Forgeboard stores no
          token.
        </small>
        {!gitRemoteValid ? (
          <p id="git-default-remote-error" className="recovery-guidance warning" role="alert">
            Enter a Git remote name using letters, numbers, dots, underscores, or hyphens. The Git /
            PR node verifies that it exists in the selected agent worktree.
          </p>
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="Development preview"
        description="The preview command is stored as an executable plus literal arguments—never as a shell string. Leave it blank to choose a detected package script per preview node."
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
