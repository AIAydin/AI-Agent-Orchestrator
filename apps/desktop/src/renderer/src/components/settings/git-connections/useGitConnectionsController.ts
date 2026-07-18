import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '../../../../../shared/application/contracts.js';
import type {
  GitConnectionsView,
  GitHubCliStatusView,
} from '../../../../../shared/git/connections/index.js';
import { unwrap } from '../../../lib/ipc.js';
import type { GitConnectionsNotice, GitConnectionsPendingPlan } from './types.js';

interface UseGitConnectionsControllerInput {
  readonly projects: readonly Project[];
  readonly activeProject: Project | null;
  readonly onError: (message: string) => void;
}

type RefreshResult = 'applied' | 'failed' | 'superseded';

export function useGitConnectionsController({
  projects,
  activeProject,
  onError,
}: UseGitConnectionsControllerInput) {
  const availableProjects = useMemo(
    () => gitConnectionProjects(projects, activeProject),
    [activeProject, projects],
  );
  const [projectId, setProjectId] = useState(() => availableProjects[0]?.id ?? '');
  const [connections, setConnections] = useState<GitConnectionsView | null>(null);
  const [cliStatus, setCliStatus] = useState<GitHubCliStatusView | null>(null);
  const [pendingPlan, setPendingPlan] = useState<GitConnectionsPendingPlan | null>(null);
  const [notice, setNotice] = useState<GitConnectionsNotice | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(false);
  const [cliLoading, setCliLoading] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const onErrorRef = useRef(onError);
  const pendingPlanRef = useRef(pendingPlan);
  const mounted = useRef(true);
  const planRequest = useRef(0);
  const connectionRequest = useRef(0);
  const cliRequest = useRef(0);
  onErrorRef.current = onError;
  pendingPlanRef.current = pendingPlan;

  const reportError = useCallback((cause: unknown, fallback: string): void => {
    if (!mounted.current) return;
    const message = cause instanceof Error ? cause.message : fallback;
    setNotice({ tone: 'warning', message });
    onErrorRef.current(message);
  }, []);

  const loadConnections = useCallback(
    async (
      selectedProjectId: string,
      announce: boolean,
      reportFailure = true,
    ): Promise<RefreshResult> => {
      const requestId = connectionRequest.current + 1;
      connectionRequest.current = requestId;
      if (selectedProjectId === '') {
        setConnections(null);
        setConnectionsLoading(false);
        return 'applied';
      }
      setConnectionsLoading(true);
      try {
        const next = unwrap(
          await window.forgeboard.git.connections.list({ projectId: selectedProjectId }),
        );
        if (connectionRequest.current !== requestId) return 'superseded';
        setConnections(next);
        if (announce) {
          setNotice({
            tone: 'neutral',
            message: `Remotes updated for ${next.projectName}.`,
          });
        }
        return 'applied';
      } catch (cause) {
        if (connectionRequest.current !== requestId) return 'superseded';
        setConnections(null);
        if (reportFailure) {
          reportError(cause, "The selected project's remotes could not be loaded.");
        }
        return 'failed';
      } finally {
        if (connectionRequest.current === requestId) setConnectionsLoading(false);
      }
    },
    [reportError],
  );

  const readCliStatus = useCallback(
    async (refresh: boolean, announce = refresh, reportFailure = true): Promise<RefreshResult> => {
      const requestId = cliRequest.current + 1;
      cliRequest.current = requestId;
      setCliLoading(true);
      try {
        const next = unwrap(
          refresh
            ? await window.forgeboard.git.connections.refresh()
            : await window.forgeboard.git.connections.status(),
        );
        if (cliRequest.current !== requestId) return 'superseded';
        setCliStatus(next);
        if (announce) {
          setNotice({ tone: 'neutral', message: 'GitHub CLI status updated.' });
        }
        return 'applied';
      } catch (cause) {
        if (cliRequest.current !== requestId) return 'superseded';
        setCliStatus(null);
        if (reportFailure) reportError(cause, 'GitHub CLI status could not be loaded.');
        return 'failed';
      } finally {
        if (cliRequest.current === requestId) setCliLoading(false);
      }
    },
    [reportError],
  );

  useEffect(() => {
    if (availableProjects.some((project) => project.id === projectId)) return;
    setProjectId(availableProjects[0]?.id ?? '');
  }, [availableProjects, projectId]);

  useEffect(() => {
    planRequest.current += 1;
    setNotice(null);
    setConnections(null);
    void loadConnections(projectId, false);
  }, [loadConnections, projectId]);

  useEffect(() => {
    void readCliStatus(false);
  }, [readCliStatus]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      planRequest.current += 1;
      const plan = pendingPlanRef.current;
      if (plan === null) return;
      void window.forgeboard.git.connections
        .cancelPlan({ planId: plan.planId })
        .catch(() => undefined);
    };
  }, []);

  function currentSnapshot(): GitConnectionsView | null {
    return connections?.projectId === projectId ? connections : null;
  }

  async function prepareNetwork(
    operation: 'add' | 'replace',
    remoteName: string,
    url: string,
  ): Promise<boolean> {
    const snapshot = currentSnapshot();
    if (snapshot === null) return false;
    return await performMutation(async () => {
      const requestId = beginPlanRequest();
      const plan = unwrap(
        await window.forgeboard.git.connections.prepareNetwork({
          projectId,
          expectedRevision: snapshot.configurationRevision,
          operation,
          remoteName,
          url,
        }),
      );
      await acceptPreparedPlan(plan, requestId);
    }, 'The remote change could not be prepared. Try again.');
  }

  async function prepareLocal(operation: 'add' | 'replace', remoteName: string): Promise<void> {
    const snapshot = currentSnapshot();
    if (snapshot === null) return;
    await performMutation(async () => {
      const requestId = beginPlanRequest();
      const plan = unwrap(
        await window.forgeboard.git.connections.prepareLocal({
          projectId,
          expectedRevision: snapshot.configurationRevision,
          operation,
          remoteName,
        }),
      );
      if (plan === null) {
        if (!planRequestIsCurrent(requestId)) return;
        setNotice({ tone: 'neutral', message: 'Folder selection cancelled. Nothing changed.' });
        return;
      }
      await acceptPreparedPlan(plan, requestId);
    }, 'The folder selection could not be prepared. Try again.');
  }

  async function prepareRemove(remoteName: string): Promise<void> {
    const snapshot = currentSnapshot();
    if (snapshot === null) return;
    await performMutation(async () => {
      const requestId = beginPlanRequest();
      const plan = unwrap(
        await window.forgeboard.git.connections.prepareRemove({
          projectId,
          expectedRevision: snapshot.configurationRevision,
          operation: 'remove',
          remoteName,
        }),
      );
      await acceptPreparedPlan(plan, requestId);
    }, 'The remote removal could not be prepared. Try again.');
  }

  async function chooseGitHubCli(): Promise<void> {
    await performMutation(async () => {
      const requestId = beginPlanRequest();
      const plan = unwrap(await window.forgeboard.git.connections.chooseGitHubCli());
      if (plan === null) {
        if (!planRequestIsCurrent(requestId)) return;
        setNotice({ tone: 'neutral', message: 'GitHub CLI selection cancelled. Nothing changed.' });
        return;
      }
      await acceptPreparedPlan(plan, requestId);
    }, 'The GitHub CLI selection could not be prepared. Try again.');
  }

  async function useAutomaticGitHubCli(): Promise<void> {
    await performMutation(async () => {
      const requestId = beginPlanRequest();
      const plan = unwrap(await window.forgeboard.git.connections.useAutomaticGitHubCli());
      await acceptPreparedPlan(plan, requestId);
    }, 'Automatic GitHub CLI detection could not be prepared. Try again.');
  }

  function beginPlanRequest(): number {
    planRequest.current += 1;
    return planRequest.current;
  }

  function planRequestIsCurrent(requestId: number): boolean {
    return mounted.current && planRequest.current === requestId;
  }

  async function acceptPreparedPlan(
    plan: GitConnectionsPendingPlan,
    requestId: number,
  ): Promise<void> {
    if (planRequestIsCurrent(requestId)) {
      pendingPlanRef.current = plan;
      setPendingPlan(plan);
      return;
    }
    await window.forgeboard.git.connections
      .cancelPlan({ planId: plan.planId })
      .catch(() => undefined);
  }

  async function cancelPendingPlan(): Promise<void> {
    const plan = pendingPlan;
    if (plan === null) return;
    pendingPlanRef.current = null;
    setPendingPlan(null);
    await performMutation(async () => {
      unwrap(await window.forgeboard.git.connections.cancelPlan({ planId: plan.planId }));
      setNotice({ tone: 'neutral', message: 'Review cancelled. Nothing changed.' });
    }, 'The review could not be cancelled cleanly. Try again.');
  }

  async function confirmPendingPlan(): Promise<void> {
    const plan = pendingPlan;
    if (plan === null) return;
    pendingPlanRef.current = null;
    setPendingPlan(null);
    await performMutation(async () => {
      if (plan.kind === 'git-remote-mutation') {
        supersedeConnectionRead();
        let next: GitConnectionsView | null;
        try {
          next = unwrap(await window.forgeboard.git.connections.confirm({ planId: plan.planId }));
        } catch (cause) {
          const refreshResult = await loadConnections(projectId, false, false);
          reportUncertainRemoteOutcome(cause, refreshResult);
          return;
        }
        if (next === null) {
          setNotice({
            tone: 'neutral',
            message: 'Confirmation cancelled. No Git settings were changed.',
          });
          return;
        }
        setConnections(next);
        setNotice({
          tone: 'success',
          message: `${remoteOperationPastTense(plan.operation)} remote ${plan.remoteName}.`,
        });
        return;
      }
      supersedeCliRead();
      let next: GitHubCliStatusView | null;
      try {
        next = unwrap(
          await window.forgeboard.git.connections.confirmGitHubCli({ planId: plan.planId }),
        );
      } catch (cause) {
        const refreshResult = await readCliStatus(true, false, false);
        reportUncertainCliOutcome(cause, refreshResult);
        return;
      }
      if (next === null) {
        setNotice({
          tone: 'neutral',
          message: 'Confirmation cancelled. GitHub CLI setup was not changed.',
        });
        return;
      }
      setCliStatus(next);
      setNotice({ tone: 'success', message: 'GitHub CLI selection saved.' });
    }, 'The reviewed change could not be applied. Try again.');
  }

  function reportUncertainRemoteOutcome(cause: unknown, refreshResult: RefreshResult): void {
    const refreshMessage = recoveryRefreshMessage(refreshResult, "the selected project's remotes");
    reportError(
      new Error(
        `Something went wrong while changing the remote, so the outcome is uncertain — settings on this computer may already have changed. ${refreshMessage}${errorDetail(cause)}`,
      ),
      'The remote change failed and its outcome is uncertain.',
    );
  }

  function supersedeConnectionRead(): void {
    connectionRequest.current += 1;
    setConnectionsLoading(false);
  }

  function supersedeCliRead(): void {
    cliRequest.current += 1;
    setCliLoading(false);
  }

  function reportUncertainCliOutcome(cause: unknown, refreshResult: RefreshResult): void {
    const refreshMessage = recoveryRefreshMessage(refreshResult, 'the current GitHub CLI status');
    reportError(
      new Error(
        `Something went wrong while changing the GitHub CLI selection, so the outcome is uncertain — the selection saved on this computer may already have changed. ${refreshMessage}${errorDetail(cause)}`,
      ),
      'The GitHub CLI change failed and its outcome is uncertain.',
    );
  }

  async function performMutation(
    operation: () => Promise<void>,
    fallback: string,
  ): Promise<boolean> {
    setMutationBusy(true);
    setNotice(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      reportError(cause, fallback);
      return false;
    } finally {
      if (mounted.current) setMutationBusy(false);
    }
  }

  return {
    availableProjects,
    projectId,
    setProjectId,
    connections: currentSnapshot(),
    cliStatus,
    pendingPlan,
    notice,
    connectionsLoading,
    cliLoading,
    mutationBusy,
    refreshConnections: async () => {
      await loadConnections(projectId, true);
    },
    refreshCliStatus: async () => {
      await readCliStatus(true);
    },
    prepareNetwork,
    prepareLocal,
    prepareRemove,
    chooseGitHubCli,
    useAutomaticGitHubCli,
    cancelPendingPlan,
    confirmPendingPlan,
  };
}

export function gitConnectionProjects(
  projects: readonly Project[],
  activeProject: Project | null,
): Project[] {
  const ordered = activeProject === null ? [...projects] : [activeProject, ...projects];
  const seen = new Set<string>();
  return ordered.filter((project) => {
    if (seen.has(project.id) || project.missing || !project.health.isGitRepository) return false;
    seen.add(project.id);
    return true;
  });
}

function remoteOperationPastTense(operation: 'add' | 'replace' | 'remove'): string {
  if (operation === 'add') return 'Added';
  if (operation === 'replace') return 'Replaced';
  return 'Removed';
}

function recoveryRefreshMessage(result: RefreshResult, subject: string): string {
  if (result === 'applied') {
    return `Forgeboard refreshed ${subject}; review what is shown before making another change.`;
  }
  if (result === 'failed') {
    return `Forgeboard could not refresh ${subject}; refresh it yourself before making another change.`;
  }
  return `A newer update replaced the recovery refresh of ${subject}; review the current state before making another change.`;
}

function errorDetail(cause: unknown): string {
  if (!(cause instanceof Error) || cause.message.trim() === '') return '';
  return ` Details: ${cause.message}`;
}
