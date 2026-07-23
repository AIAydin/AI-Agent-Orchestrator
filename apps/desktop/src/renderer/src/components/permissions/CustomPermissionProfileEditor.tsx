import { AlertTriangle, CheckCircle2, Container, MonitorCog } from 'lucide-react';

import type { AppSettings, Project } from '../../../../shared/application/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import { ExecutableAllowlistEditor } from './ExecutableAllowlistEditor.js';
import { PermissionRootEditor } from './PermissionRootEditor.js';
import { customPermissionConfigurationIssues } from './permission-profile-ui.js';
import './permissions.css';

interface CustomPermissionProfileEditorProps {
  draft: AppSettings;
  setDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
  activeProject: Project | null;
  busy: boolean;
  compact?: boolean;
  onError: (message: string) => void;
}

export function CustomPermissionProfileEditor({
  draft,
  setDraft,
  activeProject,
  busy,
  compact = false,
  onError,
}: CustomPermissionProfileEditorProps) {
  const profile = draft.customPermissionProfile;
  const dockerRuntime = profile.runtime === 'docker';
  const explicitPaths = profile.filesystem === 'explicit-paths';
  const issues = customPermissionConfigurationIssues(draft);

  const updateProfile = (next: AppSettings['customPermissionProfile']): void =>
    setDraft((current) => ({ ...current, customPermissionProfile: next }));

  const chooseRoot = async (kind: 'read' | 'write'): Promise<void> => {
    if (activeProject === null) return;
    try {
      const selected = unwrap(
        await window.forgeboard.projects.pickReferences({ kind: 'directory', multiple: false }),
      )[0];
      if (selected === undefined) return;
      const relative = projectRelativePath(activeProject.path, selected);
      const key = kind === 'read' ? 'readPaths' : 'writePaths';
      const current = profile[key];
      if (!current.includes(relative)) updateProfile({ ...profile, [key]: [...current, relative] });
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "That folder couldn't be used. Choose a folder inside the active project.",
      );
    }
  };

  const chooseExecutable = async (): Promise<void> => {
    try {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected === null || profile.allowedExecutables.includes(selected)) return;
      updateProfile({
        ...profile,
        allowedExecutables: [...profile.allowedExecutables, selected],
      });
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "That program couldn't be selected. Try again.",
      );
    }
  };

  return (
    <div className={compact ? 'custom-permission-editor compact' : 'custom-permission-editor'}>
      <div className="permission-runtime-grid">
        <label>
          Where the agent runs
          <select
            name="custom-permission-runtime"
            value={profile.runtime}
            disabled={busy}
            onChange={(event) => {
              const runtime = event.target.value as typeof profile.runtime;
              const next = {
                ...profile,
                runtime,
                ...(runtime === 'docker'
                  ? {
                      filesystem:
                        profile.filesystem === 'explicit-paths'
                          ? ('assigned-worktree-read-only' as const)
                          : profile.filesystem,
                      readPaths: ['.'],
                      writePaths: profile.filesystem === 'assigned-worktree-write' ? ['.'] : [],
                    }
                  : {}),
              };
              setDraft((current) => ({
                ...current,
                customPermissionProfile: next,
                ...(runtime === 'docker' ? { dockerEnabled: true } : {}),
              }));
            }}
          >
            <option value="host">On this computer · limits stated, not enforced</option>
            <option value="docker">In a Docker container · enforced, one worktree only</option>
          </select>
        </label>
        <label>
          File access
          <select
            name="custom-permission-filesystem"
            value={profile.filesystem}
            disabled={busy}
            onChange={(event) => {
              const filesystem = event.target.value as typeof profile.filesystem;
              updateProfile({
                ...profile,
                filesystem,
                readPaths: filesystem === 'explicit-paths' ? [] : ['.'],
                writePaths: filesystem === 'assigned-worktree-write' ? ['.'] : [],
              });
            }}
          >
            <option value="assigned-worktree-read-only">Assigned worktree · read-only</option>
            <option value="assigned-worktree-write">Assigned worktree · read and write</option>
            <option value="explicit-paths" disabled={dockerRuntime}>
              Specific folders in the assigned worktree
            </option>
          </select>
        </label>
      </div>

      <BoundaryExplanation docker={dockerRuntime} />

      {explicitPaths && (
        <div className="permission-root-grid">
          <PermissionRootEditor
            kind="read"
            values={profile.readPaths}
            disabled={busy}
            canBrowse={activeProject !== null}
            onChange={(readPaths) => updateProfile({ ...profile, readPaths })}
            onBrowse={() => void chooseRoot('read')}
          />
          <PermissionRootEditor
            kind="write"
            values={profile.writePaths}
            disabled={busy}
            canBrowse={activeProject !== null}
            onChange={(writePaths) => updateProfile({ ...profile, writePaths })}
            onBrowse={() => void chooseRoot('write')}
          />
        </div>
      )}

      <fieldset className="permission-policy-group">
        <legend>What the agent can see in the project</legend>
        <div className="permission-runtime-grid">
          <label>
            Ignored files
            <select
              name="custom-permission-ignored-files"
              value={profile.ignoredFileRead}
              disabled={busy}
              onChange={(event) =>
                updateProfile({
                  ...profile,
                  ignoredFileRead: event.target.value as typeof profile.ignoredFileRead,
                })
              }
            >
              <option value="deny">
                {dockerRuntime ? 'Not allowed · Docker needs the whole worktree' : 'Not allowed'}
              </option>
              <option value="allow">Let the agent read these files in its worktree</option>
            </select>
          </label>
          <label>
            Sensitive files
            <select
              name="custom-permission-sensitive-files"
              value={profile.sensitiveFileRead}
              disabled={busy}
              onChange={(event) =>
                updateProfile({
                  ...profile,
                  sensitiveFileRead: event.target.value as typeof profile.sensitiveFileRead,
                })
              }
            >
              <option value="deny">
                {dockerRuntime ? 'Not allowed · Docker needs the whole worktree' : 'Not allowed'}
              </option>
              <option value="allow">Let the agent read these files in its worktree</option>
            </select>
          </label>
        </div>
        <p className="permission-caution">
          <AlertTriangle size={15} aria-hidden="true" />
          When allowed, the agent can open these files in its worktree on its own. Forgeboard still
          never attaches ignored or sensitive files to a prompt without your per-file approval. On
          this computer these choices are requests to the agent, not blocks enforced by the
          operating system.
        </p>
      </fieldset>

      <fieldset className="permission-policy-group">
        <legend>Starting the agent</legend>
        <label>
          Which programs can start it
          <select
            name="custom-permission-executable-policy"
            value={profile.executablePolicy}
            disabled={busy}
            onChange={(event) => {
              const executablePolicy = event.target.value as typeof profile.executablePolicy;
              updateProfile({
                ...profile,
                executablePolicy,
                ...(executablePolicy === 'selected-agent-only' ? { allowedExecutables: [] } : {}),
              });
            }}
          >
            <option value="selected-agent-only">Only the selected agent's program</option>
            <option value="allowlist">Only the programs I list</option>
          </select>
        </label>
        {profile.executablePolicy === 'allowlist' && (
          <ExecutableAllowlistEditor
            values={profile.allowedExecutables}
            disabled={busy}
            dockerRuntime={dockerRuntime}
            onChange={(allowedExecutables) => updateProfile({ ...profile, allowedExecutables })}
            onBrowse={() => void chooseExecutable()}
          />
        )}
      </fieldset>

      <fieldset className="permission-policy-group">
        <legend>Requests for the agent</legend>
        <label className="switch-row">
          <span>
            <strong>Ask the agent to allow development servers</strong>
            <small>
              Local servers that preview the app. Added to the agent's launch instructions.
            </small>
          </span>
          <input
            type="checkbox"
            name="custom-permission-development-servers"
            checked={profile.forgeboardManagedActions.developmentServers === 'allow'}
            disabled={busy}
            onChange={(event) =>
              updateProfile({
                ...profile,
                forgeboardManagedActions: {
                  ...profile.forgeboardManagedActions,
                  developmentServers: event.target.checked ? 'allow' : 'deny',
                },
              })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>Ask the agent to allow tests</strong>
            <small>Added to the agent's launch instructions.</small>
          </span>
          <input
            type="checkbox"
            name="custom-permission-tests"
            checked={profile.forgeboardManagedActions.tests === 'allow'}
            disabled={busy}
            onChange={(event) =>
              updateProfile({
                ...profile,
                forgeboardManagedActions: {
                  ...profile.forgeboardManagedActions,
                  tests: event.target.checked ? 'allow' : 'deny',
                },
              })
            }
          />
        </label>
        <p>
          Requests, not hard limits — the agent could still start other processes. Preview and Test
          nodes you run yourself aren't affected.
        </p>
      </fieldset>

      {dockerRuntime && (
        <fieldset className="permission-policy-group">
          <legend>Docker limits</legend>
          <div className="permission-runtime-grid three">
            <label>
              Network access
              <select
                name="custom-permission-docker-network"
                value={profile.docker.network}
                disabled={busy}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    docker: {
                      ...profile.docker,
                      network: event.target.value as typeof profile.docker.network,
                    },
                  })
                }
              >
                <option value="disabled">Off</option>
                <option value="enabled">On, after you approve the launch</option>
              </select>
            </label>
            <label>
              CPU limit
              <input
                type="number"
                name="custom-permission-docker-cpu"
                min="0.1"
                max="128"
                step="0.1"
                value={profile.docker.cpuLimit}
                disabled={busy}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    docker: { ...profile.docker, cpuLimit: event.target.valueAsNumber },
                  })
                }
              />
            </label>
            <label>
              Memory limit (MB)
              <input
                type="number"
                name="custom-permission-docker-memory"
                min="128"
                max="1048576"
                value={profile.docker.memoryMb}
                disabled={busy}
                onChange={(event) =>
                  updateProfile({
                    ...profile,
                    docker: { ...profile.docker, memoryMb: event.target.valueAsNumber },
                  })
                }
              />
            </label>
          </div>
          <p>
            The container runs without admin rights, can only see its assigned worktree, and never
            receives your sign-in details from this computer. Set the Docker engine, image, and
            agent path in Agents &amp; runtime.
          </p>
        </fieldset>
      )}

      <div className="permission-locked-rules" aria-label="Always enforced permission rules">
        <div>
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            <strong>Review before the main branch</strong>
            <small>Always required — custom settings can't skip your review.</small>
          </span>
        </div>
        <div>
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            <strong>This computer is not a sandbox</strong>
            <small>
              You'll see and approve the details again before every launch on this computer.
            </small>
          </span>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="permission-validation" role="alert">
          <strong>Finish setting up custom permissions before saving</strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BoundaryExplanation({ docker }: { docker: boolean }) {
  return (
    <div className={docker ? 'permission-boundary docker' : 'permission-boundary host'}>
      {docker ? (
        <Container size={18} aria-hidden="true" />
      ) : (
        <MonitorCog size={18} aria-hidden="true" />
      )}
      <span>
        <strong>
          {docker ? 'Docker enforces these limits' : 'Limits are stated, not enforced'}
        </strong>
        <small>
          {docker
            ? 'Docker keeps the agent inside one worktree and controls its network access, user rights, CPU, and memory.'
            : 'Every run gets its own worktree, even read-only runs. On this computer, folder lists tell the agent your intent — the operating system does not block it.'}
        </small>
      </span>
    </div>
  );
}

function projectRelativePath(projectPath: string, selectedPath: string): string {
  const project = normalizePath(projectPath);
  const selected = normalizePath(selectedPath);
  const caseInsensitive = /^[A-Za-z]:\//u.test(project);
  const comparableProject = caseInsensitive ? project.toLocaleLowerCase() : project;
  const comparableSelected = caseInsensitive ? selected.toLocaleLowerCase() : selected;
  if (comparableSelected === comparableProject) return '.';
  if (!comparableSelected.startsWith(`${comparableProject}/`)) {
    throw new Error(
      "Choose a folder inside the active project. The same location will be used inside each run's worktree.",
    );
  }
  return selected.slice(project.length + 1);
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
}
