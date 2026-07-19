import { useEffect, useState } from 'react';

import type { Project } from '../../../../../../shared/application/contracts.js';
import { unwrap } from '../../../../lib/ipc.js';

interface ProjectStatusSnapshot {
  readonly project: Project;
  readonly available: boolean;
}

/** Refreshes display-only project health without allowing stale or prior-project responses to win. */
export function useProjectStatus(project: Project): ProjectStatusSnapshot {
  const [snapshot, setSnapshot] = useState<ProjectStatusSnapshot>({ project, available: true });

  useEffect(() => {
    let disposed = false;
    let pending = false;
    setSnapshot({ project, available: true });
    const refresh = async () => {
      const projectsApi = window.forgeboard?.projects;
      if (pending || document.hidden || typeof projectsApi?.refresh !== 'function') {
        return;
      }
      pending = true;
      try {
        const refreshed = unwrap(await projectsApi.refresh(project.id));
        if (!disposed) setSnapshot({ project: refreshed, available: true });
      } catch {
        if (!disposed) setSnapshot((current) => ({ ...current, available: false }));
      } finally {
        pending = false;
      }
    };
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void refresh(), 5_000);
    void refresh();
    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [project]);

  return snapshot;
}
