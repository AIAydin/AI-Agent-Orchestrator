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
          : 'The selected folder could not be made project-relative.',
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
      onError(cause instanceof Error ? cause.message : 'The executable could not be selected.');
    }
  };

  return (
    <div className={compact ? 'custom-permission-editor compact' : 'custom-permission-editor'}>
      <div className="permission-runtime-grid">
        <label>
          Runtime boundary
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
            <option value="host">Host process · disclosed policy</option>
            <option
              value="docker"
              disabled={
                draft.defaultPermissionProfile === 'custom' && draft.defaultAgent === 'test-agent'
              }
            >
              Docker · technical single-worktree boundary
            </option>
          </select>
        </label>
        <label>
          Filesystem policy
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
              Explicit assigned-worktree-relative paths
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
        <legend>Repository content visibility</legend>
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
                {dockerRuntime
                  ? 'Denied · incompatible with whole-worktree mount'
                  : 'Request denied'}
              </option>
              <option value="allow">Expose matching worktree content to the process</option>
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
                {dockerRuntime
                  ? 'Denied · incompatible with whole-worktree mount'
                  : 'Request denied'}
              </option>
              <option value="allow">Expose matching worktree content to the process</option>
            </select>
          </label>
        </div>
        <p className="permission-caution">
          <AlertTriangle size={15} aria-hidden="true" />
          “Expose” lets the process read matching content already present in its worktree; Docker
          does not require a separate attachment approval for that direct read. Forgeboard still
          never attaches ignored or sensitive files as context without exact per-file approval. On
          the host these choices are disclosed requests, not an operating-system read barrier.
        </p>
      </fieldset>

      <fieldset className="permission-policy-group">
        <legend>Agent launch executable</legend>
        <label>
          Top-level launch policy
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
            <option value="selected-agent-only">Only the selected agent executable</option>
            <option value="allowlist">Exact executable allowlist</option>
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
        <legend>Requested agent actions (advisory)</legend>
        <label className="switch-row">
          <span>
            <strong>Ask the agent to allow development servers</strong>
            <small>Included in the effective agent policy and launch disclosure.</small>
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
            <small>Included in the effective agent policy and launch disclosure.</small>
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
          These are advisory instructions for this agent launch. They do not technically prevent a
          generic agent or its descendants from starting processes, and they do not gate separate
          user-triggered Preview or Test nodes.
        </p>
      </fieldset>

      {dockerRuntime && (
        <fieldset className="permission-policy-group">
          <legend>Custom Docker controls</legend>
          <div className="permission-runtime-grid three">
            <label>
              Container network
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
                <option value="disabled">Disabled</option>
                <option value="enabled">Enabled after launch disclosure</option>
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
            The container runs non-root, mounts only its assigned worktree, and never mounts host
            CLI credentials. Docker engine, image, and in-image agent path stay in Agents & runtime.
          </p>
        </fieldset>
      )}

      <div className="permission-locked-rules" aria-label="Always enforced permission rules">
        <div>
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            <strong>Review before the primary branch</strong>
            <small>Always required; Custom cannot bypass Git review.</small>
          </span>
        </div>
        <div>
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>
            <strong>Host cwd is not a sandbox</strong>
            <small>Always disclosed again before every host launch.</small>
          </span>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="permission-validation" role="alert">
          <strong>Finish the Custom profile before saving</strong>
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
          {docker ? 'Docker-enforced outer boundary' : 'Host policy is disclosure-only'}
        </strong>
        <small>
          {docker
            ? 'Docker enforces the whole-worktree mount mode, network mode, non-root user, CPU, and memory limits.'
            : 'Every run still receives a managed worktree, including declared read-only runs, but cwd and path lists do not restrict the current user at the OS level.'}
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
      'Choose a folder inside the active project. Its relative path will be applied to each assigned worktree.',
    );
  }
  return selected.slice(project.length + 1);
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
}
