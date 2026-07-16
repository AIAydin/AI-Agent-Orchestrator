import { Sparkles } from 'lucide-react';

import type { CommandConfiguration, Project } from '../../../../shared/application/contracts.js';

type PackageManager = Exclude<Project['health']['packageManager'], 'unknown'>;

export function ProjectCommandSuggestions({
  projects,
  selectedProjectId,
  busy,
  onSelectProject,
  onUseDevelopment,
  onUseTest,
}: {
  readonly projects: readonly Project[];
  readonly selectedProjectId: string | null;
  readonly busy: boolean;
  readonly onSelectProject: (projectId: string | null) => void;
  readonly onUseDevelopment: (command: CommandConfiguration) => void;
  readonly onUseTest: (command: CommandConfiguration) => void;
}) {
  const candidates = projects.filter(commandSuggestionProject).slice(0, 50);
  const selected = candidates.find((project) => project.id === selectedProjectId) ?? null;
  const development = selected ? suggestedDevelopmentCommand(selected) : null;
  const test = selected ? suggestedTestCommand(selected) : null;
  const detectedScripts = selected
    ? Object.keys(selected.health.scripts)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 12)
    : [];

  if (candidates.length === 0) {
    return (
      <section className="setup-command-suggestions" aria-label="Project command suggestions">
        <strong>No repository command context yet</strong>
        <p>
          Leave commands blank and open a repository after setup, or use Browse to choose an exact
          executable now. Forgeboard will offer detected package scripts in the project UI.
        </p>
      </section>
    );
  }

  return (
    <section className="setup-command-suggestions" aria-label="Project command suggestions">
      <label>
        Validate and suggest commands from
        <select
          name="setup-command-project"
          aria-label="Project for command suggestions"
          value={selected?.id ?? ''}
          disabled={busy}
          onChange={(event) => onSelectProject(event.target.value || null)}
        >
          <option value="">No project selected</option>
          {candidates.map((project) => (
            <option value={project.id} key={project.id}>
              {project.name} · {project.health.packageManager}
            </option>
          ))}
        </select>
      </label>
      {selected ? (
        <>
          <p>
            Detected scripts: <code>{detectedScripts.join(', ')}</code>
            {Object.keys(selected.health.scripts).length > detectedScripts.length ? ' …' : ''}
          </p>
          <div className="setup-command-suggestion-actions">
            {development ? (
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => onUseDevelopment(development.command)}
              >
                <Sparkles size={14} aria-hidden="true" /> Use “{development.script}” for preview
              </button>
            ) : (
              <span>No likely development script detected.</span>
            )}
            {test ? (
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => onUseTest(test.command)}
              >
                <Sparkles size={14} aria-hidden="true" /> Use “{test.script}” for tests
              </button>
            ) : (
              <span>No likely test script detected.</span>
            )}
          </div>
        </>
      ) : (
        <p>Select a known repository to adopt and validate its detected scripts.</p>
      )}
      <small>
        Suggestions come from the repository health scan. Readiness rechecks the current executable
        and package.json without running repository code.
      </small>
    </section>
  );
}

export function initialCommandSuggestionProjectId(projects: readonly Project[]): string | null {
  return projects.find(commandSuggestionProject)?.id ?? null;
}

function commandSuggestionProject(project: Project): boolean {
  return (
    !project.missing &&
    project.health.packageManager !== 'unknown' &&
    Object.keys(project.health.scripts).length > 0
  );
}

function suggestedDevelopmentCommand(project: Project): SuggestedCommand | null {
  return suggestedCommand(project, ['dev', 'start', 'serve', 'preview']);
}

function suggestedTestCommand(project: Project): SuggestedCommand | null {
  return suggestedCommand(project, ['test', 'test:unit', 'check', 'verify']);
}

interface SuggestedCommand {
  readonly script: string;
  readonly command: CommandConfiguration;
}

function suggestedCommand(
  project: Project,
  priorities: readonly string[],
): SuggestedCommand | null {
  if (project.health.packageManager === 'unknown') return null;
  const available = new Set(Object.keys(project.health.scripts));
  const script = priorities.find((candidate) => available.has(candidate));
  return script
    ? {
        script,
        command: packageScriptCommand(project.health.packageManager, script),
      }
    : null;
}

function packageScriptCommand(manager: PackageManager, script: string): CommandConfiguration {
  return { executable: manager, arguments: ['run', script] };
}
