import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { CheckExecutionView, CheckPlanView } from '../../../../shared/check-contracts.js';
import { unwrap } from '../../lib/ipc.js';

interface UseProjectChecksInput {
  projectId: string;
  setEvents: Dispatch<SetStateAction<string[]>>;
  onError: (message: string) => void;
}

export function useProjectChecks({ projectId, setEvents, onError }: UseProjectChecksInput) {
  const [executions, setExecutions] = useState<CheckExecutionView[]>([]);
  const [plan, setPlan] = useState<CheckPlanView | null>(null);
  const [busyCheckId, setBusyCheckId] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const projectIdRef = useRef<string | null>(projectId);
  const planRef = useRef<CheckPlanView | null>(null);
  const operationRef = useRef(false);
  const operationVersionRef = useRef(0);
  const approvingRef = useRef(false);
  const onErrorRef = useRef(onError);
  projectIdRef.current = projectId;
  onErrorRef.current = onError;

  useEffect(() => {
    let current = true;
    setExecutions([]);
    setBusyCheckId(null);
    setPlan((currentPlan) => (currentPlan?.projectId === projectId ? currentPlan : null));
    const unsubscribe = window.forgeboard.checks.onEvent((event) => {
      if (!current || event.projectId !== projectId) return;
      setExecutions((items) => upsertExecution(items, event.execution));
    });
    void window.forgeboard.checks
      .list({ projectId })
      .then((result) => {
        if (!current) return;
        const persisted = unwrap(result);
        setExecutions((items) =>
          persisted.reduce((next, execution) => upsertExecution(next, execution), items),
        );
      })
      .catch((cause: unknown) => {
        if (current) {
          onErrorRef.current(
            cause instanceof Error ? cause.message : 'Could not load project checks.',
          );
        }
      });
    return () => {
      current = false;
      unsubscribe();
      operationRef.current = false;
      operationVersionRef.current += 1;
      const pending = planRef.current;
      if (pending?.projectId === projectId && !approvingRef.current) {
        planRef.current = null;
        void discardPreparedPlan(pending.planId, false);
      }
      if (projectIdRef.current === projectId) projectIdRef.current = null;
    };
  }, [projectId]);

  const projectExecutions = useMemo(
    () => executions.filter((execution) => execution.projectId === projectId),
    [executions, projectId],
  );

  const latestByCheckId = useMemo(() => {
    const latest = new Map<string, CheckExecutionView>();
    for (const execution of projectExecutions) {
      const existing = latest.get(execution.checkId);
      if (!existing || Date.parse(execution.updatedAt) > Date.parse(existing.updatedAt)) {
        latest.set(execution.checkId, execution);
      }
    }
    return latest;
  }, [projectExecutions]);

  async function prepare(checkId: string) {
    if (
      operationRef.current ||
      (planRef.current !== null && planRef.current.projectId === projectId)
    ) {
      return;
    }
    operationRef.current = true;
    const operationVersion = ++operationVersionRef.current;
    setBusyCheckId(checkId);
    try {
      const prepared = unwrap(await window.forgeboard.checks.prepare({ projectId, checkId }));
      if (projectIdRef.current !== prepared.projectId) {
        await discardPreparedPlan(prepared.planId, false);
        return;
      }
      planRef.current = prepared;
      setPlan(prepared);
      setEvents((items) =>
        [`Prepared ${prepared.label}; no check process has started.`, ...items].slice(0, 80),
      );
    } catch (cause) {
      if (projectIdRef.current === projectId) {
        onErrorRef.current(
          cause instanceof Error ? cause.message : 'Could not prepare this project check.',
        );
      }
    } finally {
      if (operationVersionRef.current === operationVersion) {
        operationRef.current = false;
        setBusyCheckId(null);
      }
    }
  }

  async function confirm() {
    const pending = planRef.current;
    if (!pending || approvingRef.current) return;
    approvingRef.current = true;
    setApproving(true);
    setBusyCheckId(pending.checkId);
    try {
      const execution = unwrap(
        await window.forgeboard.checks.confirm({ planId: pending.planId, confirmed: true }),
      );
      if (execution && execution.projectId === projectIdRef.current) {
        setExecutions((items) => upsertExecution(items, execution));
        setEvents((items) =>
          [`Started ${execution.label} in ${execution.cwd}.`, ...items].slice(0, 80),
        );
      } else if (!execution && pending.projectId === projectIdRef.current) {
        setEvents((items) => ['Cancelled the native check approval.', ...items].slice(0, 80));
      }
    } catch (cause) {
      onErrorRef.current(
        cause instanceof Error ? cause.message : 'The approved check could not start.',
      );
    } finally {
      if (planRef.current?.planId === pending.planId) planRef.current = null;
      setPlan((current) => (current?.planId === pending.planId ? null : current));
      approvingRef.current = false;
      setApproving(false);
      setBusyCheckId(null);
    }
  }

  async function cancel(executionId: string) {
    if (operationRef.current) return;
    operationRef.current = true;
    const operationVersion = ++operationVersionRef.current;
    const execution = projectExecutions.find((candidate) => candidate.id === executionId);
    setBusyCheckId(execution?.checkId ?? executionId);
    try {
      const cancelled = unwrap(await window.forgeboard.checks.cancel({ executionId }));
      if (cancelled.projectId === projectIdRef.current) {
        setExecutions((items) => upsertExecution(items, cancelled));
        setEvents((items) => [`Cancelled ${cancelled.label}.`, ...items].slice(0, 80));
      }
    } catch (cause) {
      if (projectIdRef.current === projectId) {
        onErrorRef.current(
          cause instanceof Error ? cause.message : 'Could not cancel this project check.',
        );
      }
    } finally {
      if (operationVersionRef.current === operationVersion) {
        operationRef.current = false;
        setBusyCheckId(null);
      }
    }
  }

  function dismissPlan() {
    const pending = planRef.current;
    if (!pending || approvingRef.current) return;
    planRef.current = null;
    setPlan(null);
    void discardPreparedPlan(pending.planId, true);
  }

  async function discardPreparedPlan(planId: string, reportFailure: boolean) {
    try {
      unwrap(await window.forgeboard.checks.confirm({ planId, confirmed: false }));
      if (reportFailure) {
        setEvents((items) =>
          ['Cancelled the check approval before launch.', ...items].slice(0, 80),
        );
      }
    } catch (cause) {
      if (reportFailure) {
        onErrorRef.current(
          cause instanceof Error ? cause.message : 'Could not cancel this check approval.',
        );
      }
    }
  }

  return {
    executions: projectExecutions,
    latestByCheckId,
    plan: plan?.projectId === projectId ? plan : null,
    busyCheckId,
    approving,
    prepare,
    confirm,
    dismissPlan,
    cancel,
  };
}

function upsertExecution(
  executions: CheckExecutionView[],
  execution: CheckExecutionView,
): CheckExecutionView[] {
  const existing = executions.find((candidate) => candidate.id === execution.id);
  if (existing && Date.parse(existing.updatedAt) > Date.parse(execution.updatedAt)) {
    return executions;
  }
  return [execution, ...executions.filter((candidate) => candidate.id !== execution.id)].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}
