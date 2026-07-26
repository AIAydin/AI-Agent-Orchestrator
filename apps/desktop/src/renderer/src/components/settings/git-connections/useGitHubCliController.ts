import { useCallback, useEffect, useRef, useState } from 'react';

import type { GitHubCliStatusView } from '../../../../../shared/git/connections/index.js';
import { unwrap } from '../../../lib/ipc.js';
import type { GitConnectionsNotice, GitHubCliPendingPlan } from './types.js';

type RefreshResult = 'applied' | 'failed' | 'superseded';

/** Drives the GitHub CLI status card: read status, review a selection plan, confirm it. */
export function useGitHubCliController({ onError }: { readonly onError: (m: string) => void }) {
  const [cliStatus, setCliStatus] = useState<GitHubCliStatusView | null>(null);
  const [pendingPlan, setPendingPlan] = useState<GitHubCliPendingPlan | null>(null);
  const [notice, setNotice] = useState<GitConnectionsNotice | null>(null);
  const [cliLoading, setCliLoading] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const onErrorRef = useRef(onError);
  const pendingPlanRef = useRef(pendingPlan);
  const mounted = useRef(true);
  const planRequest = useRef(0);
  const cliRequest = useRef(0);
  onErrorRef.current = onError;
  pendingPlanRef.current = pendingPlan;

  const reportError = useCallback((cause: unknown, fallback: string): void => {
    if (!mounted.current) return;
    const message = cause instanceof Error ? cause.message : fallback;
    setNotice({ tone: 'warning', message });
    onErrorRef.current(message);
  }, []);

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

  async function acceptPreparedPlan(plan: GitHubCliPendingPlan, requestId: number): Promise<void> {
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

  function supersedeCliRead(): void {
    cliRequest.current += 1;
    setCliLoading(false);
  }

  function reportUncertainCliOutcome(cause: unknown, refreshResult: RefreshResult): void {
    const refreshMessage = recoveryRefreshMessage(refreshResult);
    reportError(
      new Error(
        `Something went wrong while changing the GitHub CLI selection, so the outcome is uncertain — the selection saved on this computer may already have changed. ${refreshMessage}${errorDetail(cause)}`,
      ),
      'The GitHub CLI change failed and its outcome is uncertain.',
    );
  }

  async function performMutation(operation: () => Promise<void>, fallback: string): Promise<void> {
    setMutationBusy(true);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      reportError(cause, fallback);
    } finally {
      if (mounted.current) setMutationBusy(false);
    }
  }

  return {
    cliStatus,
    pendingPlan,
    notice,
    cliLoading,
    mutationBusy,
    refreshCliStatus: async () => {
      await readCliStatus(true);
    },
    chooseGitHubCli,
    useAutomaticGitHubCli,
    cancelPendingPlan,
    confirmPendingPlan,
  };
}

function recoveryRefreshMessage(result: RefreshResult): string {
  const subject = 'the current GitHub CLI status';
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
