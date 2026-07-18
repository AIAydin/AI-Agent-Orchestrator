import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type {
  AppSettings,
  CommandConfiguration,
  CustomCheckConfiguration,
  Project,
} from '../../../../shared/application/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import type { CommandReadinessStatus } from '../configuration/useCommandReadiness.js';
import { CommandEditor, SettingsSection, type AsyncSettingsProps } from './shared.js';

import './CheckSettings.css';

type StandardCheckKey = 'lintCommand' | 'typecheckCommand' | 'testCommand' | 'buildCommand';
type PackageManager = Exclude<Project['health']['packageManager'], 'unknown'>;

interface CheckSettingsProps extends AsyncSettingsProps {
  activeProject: Project | null;
  readiness: Readonly<Record<string, CommandReadinessStatus>>;
}

const STANDARD_CHECKS: ReadonlyArray<{
  id: 'lint' | 'typecheck' | 'test' | 'build';
  label: string;
  description: string;
  settingsKey: StandardCheckKey;
}> = [
  {
    id: 'lint',
    label: 'Lint',
    description: 'Catches style and quality problems in your code.',
    settingsKey: 'lintCommand',
  },
  {
    id: 'typecheck',
    label: 'Typecheck',
    description: 'Checks types for mistakes without changing any files.',
    settingsKey: 'typecheckCommand',
  },
  {
    id: 'test',
    label: 'Tests',
    description: "Runs the project's tests using its package script.",
    settingsKey: 'testCommand',
  },
  {
    id: 'build',
    label: 'Build',
    description: 'Checks that the project builds without errors.',
    settingsKey: 'buildCommand',
  },
];

export function CheckSettings({
  activeProject,
  draft,
  setDraft,
  busy,
  perform,
  readiness,
}: CheckSettingsProps) {
  const customChecks = readCustomChecks(draft);
  const addCustomCheckButton = useRef<HTMLButtonElement>(null);
  const pendingCustomCheckFocus = useRef<string | null>(null);
  const detectedCount = STANDARD_CHECKS.filter(
    (check) => detectedScriptCommand(activeProject, check.id) !== null,
  ).length;

  useEffect(() => {
    const pendingId = pendingCustomCheckFocus.current;
    if (!pendingId) return;
    const input = document.getElementById(`custom-check-${pendingId}-label`);
    if (!(input instanceof HTMLInputElement)) return;
    pendingCustomCheckFocus.current = null;
    input.focus();
    input.select();
  }, [customChecks]);

  async function chooseExecutable(onSelected: (path: string) => void) {
    await perform(async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected) onSelected(selected);
    });
  }

  function updateStandardCheck(settingsKey: StandardCheckKey, command: CommandConfiguration) {
    setDraft((current) => ({ ...current, [settingsKey]: command }));
  }

  function adoptDetectedChecks() {
    setDraft((current) =>
      STANDARD_CHECKS.reduce<AppSettings>((next, check) => {
        const command = detectedScriptCommand(activeProject, check.id);
        return command ? { ...next, [check.settingsKey]: command } : next;
      }, current),
    );
  }

  function updateCustomChecks(
    update: (checks: CustomCheckConfiguration[]) => CustomCheckConfiguration[],
  ) {
    setDraft((current) => withCustomChecks(current, update(readCustomChecks(current))));
  }

  function updateCustomCheck(
    id: string,
    update: (check: CustomCheckConfiguration) => CustomCheckConfiguration,
  ) {
    updateCustomChecks((checks) =>
      checks.map((check) => (check.id === id ? update(check) : check)),
    );
  }

  function addCustomCheck() {
    const id = crypto.randomUUID();
    pendingCustomCheckFocus.current = id;
    updateCustomChecks((checks) => {
      const number = nextCustomCheckNumber(checks);
      return [
        ...checks,
        {
          id,
          label: `Custom check ${number}`,
          command: { executable: '', arguments: [] },
        },
      ];
    });
  }

  return (
    <div className="check-settings">
      <SettingsSection
        title="Project checks"
        description="Choose the commands Forgeboard runs to check your project. Each command is stored as a program plus its own arguments, never as a shell line. Package scripts may still run other project code and hooks."
      >
        <ProjectScriptSummary
          activeProject={activeProject}
          detectedCount={detectedCount}
          busy={busy}
          onAdoptAll={adoptDetectedChecks}
        />

        <div className="check-settings-command-list">
          {STANDARD_CHECKS.map((check) => {
            const detected = detectedScriptCommand(activeProject, check.id);
            return (
              <article className="check-settings-command" key={check.id}>
                <div className="check-settings-detected-row">
                  <div>
                    <strong>{check.label}</strong>
                    <span>{check.description}</span>
                  </div>
                  {detected ? (
                    <button
                      className="button ghost check-settings-adopt"
                      type="button"
                      disabled={busy}
                      aria-label={`Use detected ${check.label} script`}
                      onClick={() => updateStandardCheck(check.settingsKey, detected)}
                    >
                      <Sparkles size={14} aria-hidden="true" /> Use detected script
                    </button>
                  ) : (
                    <span className="check-settings-detection-note">
                      {detectionNote(activeProject, check.id)}
                    </span>
                  )}
                </div>
                <CommandEditor
                  label={`${check.label} command`}
                  name={`project-check-${check.id}`}
                  value={draft[check.settingsKey]}
                  onChange={(command) => updateStandardCheck(check.settingsKey, command)}
                  onBrowse={() =>
                    void chooseExecutable((executable) =>
                      setDraft((current) => ({
                        ...current,
                        [check.settingsKey]: {
                          ...current[check.settingsKey],
                          executable,
                        },
                      })),
                    )
                  }
                  readiness={readiness[`check-${check.id}`]}
                />
              </article>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Custom checks"
        description="Add your own checks here — no config files to edit. Custom checks use the same program-plus-arguments format as the checks above."
      >
        <div className="check-settings-custom-toolbar">
          <p aria-live="polite">
            {customChecks.length >= 32
              ? 'You have reached the maximum of 32 custom checks.'
              : customChecks.length === 0
                ? 'No custom checks configured.'
                : `${customChecks.length} custom check${customChecks.length === 1 ? '' : 's'} configured.`}
          </p>
          <button
            ref={addCustomCheckButton}
            className="button"
            type="button"
            disabled={busy || customChecks.length >= 32}
            onClick={addCustomCheck}
          >
            <Plus size={15} aria-hidden="true" /> Add custom check
          </button>
        </div>

        {customChecks.length === 0 ? (
          <p className="check-settings-empty">
            Add a check, then give it a name and the exact program to run.
          </p>
        ) : (
          <div className="check-settings-custom-list">
            {customChecks.map((check, index) => {
              const accessibleName = check.label.trim() || `Custom check ${index + 1}`;
              return (
                <article
                  className="check-settings-custom-card"
                  key={check.id}
                  aria-label={accessibleName}
                >
                  <header>
                    <label>
                      Check name
                      <input
                        id={`custom-check-${check.id}-label`}
                        name={`custom-check-${index}-label`}
                        aria-label={`Custom check ${index + 1} name`}
                        maxLength={128}
                        required
                        value={check.label}
                        onChange={(event) =>
                          updateCustomCheck(check.id, (current) => ({
                            ...current,
                            label: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      className="button ghost check-settings-remove"
                      type="button"
                      disabled={busy}
                      aria-label={`Remove ${accessibleName}`}
                      onClick={() => {
                        updateCustomChecks((checks) =>
                          checks.filter((candidate) => candidate.id !== check.id),
                        );
                        addCustomCheckButton.current?.focus();
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" /> Remove
                    </button>
                  </header>
                  <CommandEditor
                    label={`${accessibleName} command`}
                    name={`custom-check-${index}`}
                    value={check.command}
                    onChange={(command) =>
                      updateCustomCheck(check.id, (current) => ({
                        ...current,
                        command,
                      }))
                    }
                    onBrowse={() =>
                      void chooseExecutable((executable) =>
                        updateCustomCheck(check.id, (current) => ({
                          ...current,
                          command: { ...current.command, executable },
                        })),
                      )
                    }
                    readiness={readiness[`check-custom-${check.id}`]}
                  />
                </article>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

function ProjectScriptSummary({
  activeProject,
  detectedCount,
  busy,
  onAdoptAll,
}: {
  activeProject: Project | null;
  detectedCount: number;
  busy: boolean;
  onAdoptAll: () => void;
}) {
  if (!activeProject) {
    return (
      <div className="check-settings-project-summary" role="status">
        <strong>No project is open</strong>
        <p>
          Open a project and Forgeboard will find its check scripts for you. You can always set up
          commands manually below.
        </p>
      </div>
    );
  }

  const manager = activeProject.health.packageManager;
  return (
    <div className="check-settings-project-summary">
      <div className="check-settings-project-heading">
        <div>
          <strong>{activeProject.name}</strong>
          <span>
            {manager === 'unknown' ? 'Package manager not detected' : `${manager} project`}
          </span>
        </div>
        {detectedCount > 0 && (
          <button className="button" type="button" disabled={busy} onClick={onAdoptAll}>
            <Sparkles size={14} aria-hidden="true" /> Use all {detectedCount} detected scripts
          </button>
        )}
      </div>
      <p>
        {detectedCount > 0
          ? 'Using a found script stores your package manager as the program, with “run” and the script name as its arguments. The package manager may still run other scripts and hooks from the project.'
          : manager === 'unknown'
            ? 'Choose commands manually, or reopen the project after installing its package manager.'
            : 'No lint, typecheck, test, or build scripts were found. Set up the commands manually below.'}
      </p>
    </div>
  );
}

function detectedScriptCommand(
  project: Project | null,
  scriptName: 'lint' | 'typecheck' | 'test' | 'build',
): CommandConfiguration | null {
  if (!project || project.health.packageManager === 'unknown') return null;
  if (!Object.prototype.hasOwnProperty.call(project.health.scripts, scriptName)) return null;
  return packageScriptCommand(project.health.packageManager, scriptName);
}

function packageScriptCommand(manager: PackageManager, scriptName: string): CommandConfiguration {
  return { executable: manager, arguments: ['run', scriptName] };
}

function detectionNote(
  project: Project | null,
  scriptName: 'lint' | 'typecheck' | 'test' | 'build',
): string {
  if (!project) return 'Can be set up manually';
  if (project.health.packageManager === 'unknown') return 'Package manager not detected';
  return `No ${scriptName} script found`;
}

function readCustomChecks(settings: AppSettings): CustomCheckConfiguration[] {
  return settings.customChecks ?? [];
}

function withCustomChecks(
  settings: AppSettings,
  customChecks: CustomCheckConfiguration[],
): AppSettings {
  return { ...settings, customChecks };
}

function nextCustomCheckNumber(checks: CustomCheckConfiguration[]): number {
  let number = 1;
  const labels = new Set(checks.map((check) => check.label));
  while (labels.has(`Custom check ${number}`)) number += 1;
  return number;
}
