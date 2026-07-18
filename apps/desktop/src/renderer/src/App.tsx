import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { LoaderCircle } from 'lucide-react';

import type {
  AgentDetection,
  AppInfo,
  AppSettings,
  ExtensionDiscoveryView,
  Project,
} from '../../shared/application/contracts.js';
import type { SettingsRepairSummary } from '../../shared/settings/repair/contracts.js';
import { SettingsPanel, type SettingsTab } from './components/settings/shell/SettingsPanel.js';
import { StartupRepairNotice } from './components/settings/repair/StartupRepairNotice.js';
import { SetupWizard } from './components/onboarding/SetupWizard.js';
import { Welcome } from './components/onboarding/Welcome.js';
import { Workspace } from './components/workspace/shell/Workspace.js';
import type { WorkspaceHandle } from './components/workspace/model/types.js';
import { unwrap } from './lib/ipc.js';

interface BootstrapState {
  info: AppInfo;
  settings: AppSettings;
  agents: AgentDetection[];
  extensions: ExtensionDiscoveryView;
  recent: Project[];
  settingsRepairs: SettingsRepairSummary[];
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('appearance');
  const [dismissedRepairId, setDismissedRepairId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspaceRef = useRef<WorkspaceHandle>(null);

  useEffect(
    () =>
      window.forgeboard.app.onCloseRequested(
        async () => (await workspaceRef.current?.flushCanvas()) ?? true,
      ),
    [],
  );

  const loadBootstrap = useCallback(async () => {
    const [info, settings, agents, extensions, recent, settingsRepairs] = await Promise.all([
      window.forgeboard.app.getInfo(),
      window.forgeboard.settings.get(),
      window.forgeboard.agents.detect(),
      window.forgeboard.extensions.list(),
      window.forgeboard.projects.recent(),
      window.forgeboard.settings.listRepairs(),
    ]);
    setBootstrap({
      info: unwrap(info),
      settings: unwrap(settings),
      agents: unwrap(agents),
      extensions: unwrap(extensions),
      recent: unwrap(recent),
      settingsRepairs: unwrap(settingsRepairs),
    });
  }, []);

  useEffect(() => {
    void loadBootstrap().catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : "Forgeboard couldn't start. Try closing and reopening the app.",
      );
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
        setError(
          cause instanceof Error ? cause.message : "The project action didn't work. Try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [loadBootstrap],
  );

  const openSettings = useCallback((initialTab: SettingsTab = 'appearance') => {
    setSettingsInitialTab(initialTab);
    setShowSettings(true);
  }, []);

  if (!bootstrap) {
    return (
      <main className="loading-screen" aria-live="polite">
        <div className="brand-mark large">F</div>
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>{error ?? 'Opening Forgeboard…'}</p>
      </main>
    );
  }

  return (
    <>
      {!bootstrap.settings.onboardingCompleted ? (
        <SetupWizard
          settings={bootstrap.settings}
          agents={bootstrap.agents}
          projects={bootstrap.recent}
          checkAgentReadiness={async (input) =>
            unwrap(await window.forgeboard.agents.checkReadiness(input))
          }
          checkCommandReadiness={async (input) =>
            unwrap(await window.forgeboard.commands.checkReadiness(input))
          }
          onComplete={async (settings) => {
            unwrap(
              await window.forgeboard.settings.update({
                ...settings,
                onboardingCompleted: true,
              }),
            );
            await loadBootstrap();
          }}
          onSkip={async () => {
            unwrap(
              await window.forgeboard.settings.update({
                ...bootstrap.settings,
                onboardingCompleted: true,
              }),
            );
            await loadBootstrap();
          }}
          onError={setError}
        />
      ) : activeProject ? (
        <Workspace
          ref={workspaceRef}
          project={activeProject}
          settings={bootstrap.settings}
          agents={bootstrap.agents}
          extensionDiscovery={bootstrap.extensions}
          onClose={() => setActiveProject(null)}
          onProjectUpdated={async (project) => {
            setActiveProject(project);
            await loadBootstrap();
          }}
          onOpenSettings={() => openSettings()}
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
          onLocateMoved={async (projectId) =>
            unwrap(await window.forgeboard.projects.locateMoved({ projectId }))
          }
          onConfirmMoved={async (input) => {
            setBusy(true);
            setError(null);
            try {
              const project = unwrap(await window.forgeboard.projects.confirmMoved(input));
              setActiveProject(project);
              await loadBootstrap();
            } finally {
              setBusy(false);
            }
          }}
          onError={setError}
          onCreate={(input) =>
            void run(async () => unwrap(await window.forgeboard.projects.create(input)))
          }
          onClone={(input) =>
            void run(async () => unwrap(await window.forgeboard.projects.clone(input)))
          }
          onDemo={() => void run(async () => unwrap(await window.forgeboard.projects.demo()))}
          onOpenSettings={() => openSettings()}
        />
      )}

      {showSettings && (
        <SettingsPanel
          initialTab={settingsInitialTab}
          info={bootstrap.info}
          settings={bootstrap.settings}
          agents={bootstrap.agents}
          projects={bootstrap.recent}
          activeProject={activeProject}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            await loadBootstrap();
            setShowSettings(false);
          }}
          onError={setError}
          onFlushActiveCanvas={async () => (await workspaceRef.current?.flushCanvas()) ?? true}
          onRecoveryApplied={async () => {
            await loadBootstrap();
            setShowSettings(false);
          }}
          onExtensionsChanged={loadBootstrap}
          onDeleteAll={async (confirmation) => {
            const deleted = unwrap(await window.forgeboard.privacy.deleteAll(confirmation));
            if (!deleted) return;
            flushSync(() => {
              setActiveProject(null);
              setShowSettings(false);
              setError(null);
            });
            await loadBootstrap();
          }}
        />
      )}

      {bootstrap.settingsRepairs[0] !== undefined &&
        bootstrap.settingsRepairs[0].id !== dismissedRepairId &&
        !showSettings && (
          <StartupRepairNotice
            repair={bootstrap.settingsRepairs[0]}
            onReview={() => openSettings('privacy')}
            onDismiss={() => setDismissedRepairId(bootstrap.settingsRepairs[0]?.id ?? null)}
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
