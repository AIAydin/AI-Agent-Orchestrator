import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import type { AgentDetection, AppInfo, AppSettings, Project } from '../../shared/contracts.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { Welcome } from './components/Welcome.js';
import { Workspace } from './components/Workspace.js';
import { unwrap } from './lib/ipc.js';

interface BootstrapState {
  info: AppInfo;
  settings: AppSettings;
  agents: AgentDetection[];
  recent: Project[];
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBootstrap = useCallback(async () => {
    const [info, settings, agents, recent] = await Promise.all([
      window.forgeboard.app.getInfo(),
      window.forgeboard.settings.get(),
      window.forgeboard.agents.detect(),
      window.forgeboard.projects.recent(),
    ]);
    setBootstrap({
      info: unwrap(info),
      settings: unwrap(settings),
      agents: unwrap(agents),
      recent: unwrap(recent),
    });
  }, []);

  useEffect(() => {
    void loadBootstrap().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Forgeboard could not start.');
    });
  }, [loadBootstrap]);

  useEffect(() => {
    if (!bootstrap) return;
    const dark =
      bootstrap.settings.theme === 'dark' ||
      (bootstrap.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.density = bootstrap.settings.density;
    document.documentElement.dataset.reducedMotion = String(bootstrap.settings.reducedMotion);
  }, [bootstrap]);

  const run = useCallback(
    async (operation: () => Promise<Project | null>) => {
      setBusy(true);
      setError(null);
      try {
        const project = await operation();
        if (project) {
          setActiveProject(project);
          await loadBootstrap();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The project operation failed.');
      } finally {
        setBusy(false);
      }
    },
    [loadBootstrap],
  );

  if (!bootstrap) {
    return (
      <main className="loading-screen" aria-live="polite">
        <div className="brand-mark large">F</div>
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>{error ?? 'Opening your local workshop…'}</p>
      </main>
    );
  }

  return (
    <>
      {activeProject ? (
        <Workspace
          project={activeProject}
          settings={bootstrap.settings}
          agents={bootstrap.agents}
          onClose={() => setActiveProject(null)}
          onOpenSettings={() => setShowSettings(true)}
          onError={setError}
        />
      ) : (
        <Welcome
          recent={bootstrap.recent}
          agents={bootstrap.agents}
          busy={busy}
          onOpen={() =>
            void run(async () => {
              const result = await window.forgeboard.projects.pick();
              return unwrap(result);
            })
          }
          onOpenRecent={(path) =>
            void run(async () => unwrap(await window.forgeboard.projects.open(path)))
          }
          onCreate={(input) =>
            void run(async () => unwrap(await window.forgeboard.projects.create(input)))
          }
          onClone={(input) =>
            void run(async () => unwrap(await window.forgeboard.projects.clone(input)))
          }
          onDemo={() => void run(async () => unwrap(await window.forgeboard.projects.demo()))}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}

      {showSettings && (
        <SettingsPanel
          info={bootstrap.info}
          settings={bootstrap.settings}
          agents={bootstrap.agents}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            await loadBootstrap();
            setShowSettings(false);
          }}
          onError={setError}
        />
      )}

      {error && (
        <div className="toast error-toast" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
