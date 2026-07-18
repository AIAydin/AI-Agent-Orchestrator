import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS,
  type GitDeliveryReadinessGetView,
  type GitDeliveryRequiredCheckState,
  type GitDeliveryReadinessTarget,
} from '../../../../../shared/git/readiness/index.js';
import { unwrap } from '../../../lib/ipc.js';

type CheckId = GitDeliveryReadinessGetView['availableChecks'][number]['checkId'];

export type GitDeliveryReadinessBusy =
  | { readonly kind: 'prepare-requirements' }
  | { readonly kind: 'run-check'; readonly checkId: CheckId }
  | { readonly kind: 'approve-quality' };

export type GitDeliveryReadinessNotice =
  | {
      readonly kind: 'check-run-result';
      readonly checkId: CheckId;
      readonly state: GitDeliveryRequiredCheckState;
    }
  | { readonly kind: 'check-run-cancelled'; readonly checkId: CheckId }
  | { readonly kind: 'quality-approved' }
  | { readonly kind: 'quality-approval-cancelled' };

export interface GitDeliveryReadinessController {
  readonly view: GitDeliveryReadinessGetView | null;
  readonly selectedWorkflowExecutionId: string | null;
  readonly selectedCheckIds: readonly CheckId[];
  readonly ready: boolean;
  readonly loading: boolean;
  readonly busy: GitDeliveryReadinessBusy | null;
  readonly error: string | null;
  readonly setSelectedWorkflowExecutionId: (executionId: string) => void;
  readonly setSelectedCheckIds: (checkIds: readonly CheckId[]) => void;
  readonly refresh: () => Promise<boolean>;
  readonly prepareRequirements: (checkIds: readonly CheckId[]) => Promise<boolean>;
  readonly runCheck: (checkId: CheckId) => Promise<GitDeliveryReadinessNotice | undefined>;
  readonly approveQuality: () => Promise<GitDeliveryReadinessNotice | undefined>;
}

interface TargetActivation {
  readonly key: string | null;
}

interface OperationToken {
  readonly activation: TargetActivation;
}

interface ReadinessState {
  readonly activation: TargetActivation;
  readonly view: GitDeliveryReadinessGetView | null;
  readonly selectedWorkflowExecutionId: string | null;
  readonly selectedCheckIds: readonly CheckId[];
  readonly loading: boolean;
  readonly busy: GitDeliveryReadinessBusy | null;
  readonly error: string | null;
}

const EMPTY_CHECK_IDS: readonly CheckId[] = [];

export function useGitDeliveryReadiness(
  target: GitDeliveryReadinessTarget | null,
): GitDeliveryReadinessController {
  const projectId = target?.projectId ?? null;
  const runId = target?.runId ?? null;
  const managedTarget = useMemo<GitDeliveryReadinessTarget | null>(
    () =>
      projectId === null || runId === null ? null : { kind: 'agent-worktree', projectId, runId },
    [projectId, runId],
  );
  const activeTargetKey =
    managedTarget === null ? null : `${managedTarget.projectId}:${managedTarget.runId}`;
  const activation = useMemo<TargetActivation>(() => ({ key: activeTargetKey }), [activeTargetKey]);
  const [state, setState] = useState<ReadinessState>(() =>
    emptyState(activation, managedTarget !== null),
  );
  const mountedRef = useRef(true);
  const activeActivationRef = useRef(activation);
  const requestVersionRef = useRef(0);
  const operationRef = useRef<OperationToken | null>(null);
  activeActivationRef.current = activation;

  const stateIsCurrent = state.activation === activation;
  const view = stateIsCurrent ? state.view : null;
  const selectedWorkflowExecutionId = stateIsCurrent ? state.selectedWorkflowExecutionId : null;
  const selectedCheckIds = stateIsCurrent ? state.selectedCheckIds : EMPTY_CHECK_IDS;
  const loading = stateIsCurrent ? state.loading : managedTarget !== null;
  const busy = stateIsCurrent ? state.busy : null;
  const error = stateIsCurrent ? state.error : null;
  const ready =
    preparedReadiness(view, selectedWorkflowExecutionId, selectedCheckIds)?.evaluation.ready ===
    true;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
      operationRef.current = null;
    };
  }, []);

  const isCurrent = useCallback(
    (expected: TargetActivation) => mountedRef.current && activeActivationRef.current === expected,
    [],
  );

  const refreshFor = useCallback(
    async (
      expected: TargetActivation,
      expectedTarget: GitDeliveryReadinessTarget,
      clearError: boolean,
    ): Promise<boolean> => {
      if (!isCurrent(expected)) return false;
      const requestVersion = ++requestVersionRef.current;
      setState((current) => ({
        activation: expected,
        view: null,
        selectedWorkflowExecutionId:
          current.activation === expected ? current.selectedWorkflowExecutionId : null,
        selectedCheckIds:
          current.activation === expected ? current.selectedCheckIds : EMPTY_CHECK_IDS,
        loading: true,
        busy: current.activation === expected ? current.busy : null,
        error: clearError || current.activation !== expected ? null : current.error,
      }));
      try {
        const next = unwrap(await window.forgeboard.git.readiness.get({ target: expectedTarget }));
        if (
          !isCurrent(expected) ||
          requestVersionRef.current !== requestVersion ||
          !sameTarget(next.target, expectedTarget)
        ) {
          return false;
        }
        setState((current) => {
          if (current.activation !== expected) return current;
          const selection = selectionAfterRefresh(
            next,
            current.selectedWorkflowExecutionId,
            current.selectedCheckIds,
          );
          return { ...current, view: next, ...selection };
        });
        return true;
      } catch (cause) {
        if (isCurrent(expected) && requestVersionRef.current === requestVersion) {
          const message = readinessErrorMessage(
            cause,
            "Forgeboard couldn't load the delivery status for this agent's workspace. Try again.",
          );
          setState((current) =>
            current.activation === expected ? { ...current, view: null, error: message } : current,
          );
        }
        return false;
      } finally {
        if (isCurrent(expected) && requestVersionRef.current === requestVersion) {
          setState((current) =>
            current.activation === expected ? { ...current, loading: false } : current,
          );
        }
      }
    },
    [isCurrent],
  );

  useEffect(() => {
    const expected = activation;
    if (managedTarget === null) {
      requestVersionRef.current += 1;
      setState(emptyState(expected, false));
      return () => undefined;
    }
    void refreshFor(expected, managedTarget, true);
    return () => {
      if (operationRef.current?.activation === expected) operationRef.current = null;
    };
  }, [activation, managedTarget, refreshFor]);

  const setSelectedCheckIds = useCallback(
    (checkIds: readonly CheckId[]) => {
      if (!isCurrent(activation)) return;
      setState((current) =>
        current.activation === activation
          ? { ...current, selectedCheckIds: [...checkIds], error: null }
          : current,
      );
    },
    [activation, isCurrent],
  );

  const setSelectedWorkflowExecutionId = useCallback(
    (executionId: string) => {
      if (!isCurrent(activation)) return;
      setState((current) => {
        if (current.activation !== activation || current.view === null) return current;
        const candidate = current.view.compatibleWorkflowExecutions.find(
          (execution) => execution.executionId === executionId,
        );
        if (candidate === undefined) {
          return {
            ...current,
            selectedWorkflowExecutionId: null,
            selectedCheckIds: EMPTY_CHECK_IDS,
            error: 'Refresh delivery readiness before selecting this workflow execution.',
          };
        }
        return {
          ...current,
          selectedWorkflowExecutionId: candidate.executionId,
          selectedCheckIds: EMPTY_CHECK_IDS,
          error: null,
        };
      });
    },
    [activation, isCurrent],
  );

  const refresh = useCallback(async (): Promise<boolean> => {
    if (managedTarget === null || busy !== null) return false;
    return await refreshFor(activation, managedTarget, true);
  }, [activation, busy, managedTarget, refreshFor]);

  const setCurrentError = useCallback(
    (expected: TargetActivation, cause: unknown, fallback: string) => {
      if (!isCurrent(expected)) return;
      const message = readinessErrorMessage(cause, fallback);
      setState((current) =>
        current.activation === expected ? { ...current, error: message } : current,
      );
    },
    [isCurrent],
  );

  const beginOperation = useCallback(
    (expected: TargetActivation, nextBusy: GitDeliveryReadinessBusy): OperationToken | null => {
      if (!isCurrent(expected)) return null;
      if (operationRef.current?.activation === expected) return null;
      const token = { activation: expected };
      operationRef.current = token;
      setState((current) =>
        current.activation === expected ? { ...current, busy: nextBusy, error: null } : current,
      );
      return token;
    },
    [isCurrent],
  );

  const endOperation = useCallback(
    (expected: TargetActivation, token: OperationToken) => {
      if (operationRef.current !== token) return;
      operationRef.current = null;
      if (!isCurrent(expected)) return;
      setState((current) =>
        current.activation === expected ? { ...current, busy: null } : current,
      );
    },
    [isCurrent],
  );

  const prepareRequirements = useCallback(
    async (checkIds: readonly CheckId[]): Promise<boolean> => {
      if (managedTarget === null || view === null) return false;
      const candidate = selectedWorkflowExecution(view, selectedWorkflowExecutionId);
      if (candidate === null || !validSelection(view, candidate, checkIds)) {
        setCurrentError(
          activation,
          new Error(
            `Choose a compatible workflow run and up to ${String(GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS)} different checks that are set up before saving delivery requirements.`,
          ),
          'Choose a compatible workflow run before saving delivery requirements.',
        );
        return false;
      }
      const token = beginOperation(activation, {
        kind: 'prepare-requirements',
      });
      if (token === null) return false;
      try {
        unwrap(
          await window.forgeboard.git.readiness.prepare({
            target: managedTarget,
            workflowExecutionId: candidate.executionId,
            additionalCheckIds: [...checkIds],
          }),
        );
        if (!isCurrent(activation)) return false;
        return await refreshFor(activation, managedTarget, false);
      } catch (cause) {
        setCurrentError(
          activation,
          cause,
          "Forgeboard couldn't save the required checks. Try again.",
        );
        return false;
      } finally {
        endOperation(activation, token);
      }
    },
    [
      activation,
      beginOperation,
      endOperation,
      isCurrent,
      managedTarget,
      refreshFor,
      selectedWorkflowExecutionId,
      setCurrentError,
      view,
    ],
  );

  const runCheck = useCallback(
    async (checkId: CheckId): Promise<GitDeliveryReadinessNotice | undefined> => {
      const readiness = preparedReadiness(view, selectedWorkflowExecutionId, selectedCheckIds);
      if (managedTarget === null || readiness === null) {
        setCurrentError(
          activation,
          new Error('Save the current selection of required checks before running them.'),
          "Delivery checks aren't set up for this agent's workspace yet.",
        );
        return undefined;
      }
      if (!readiness.requiredChecks.some((check) => check.checkId === checkId)) {
        setCurrentError(
          activation,
          new Error("This check isn't part of the current delivery requirements."),
          "This delivery check can't be run.",
        );
        return undefined;
      }
      if (
        readiness.requiredChecks.some(
          (check) => check.state === 'queued' || check.state === 'running',
        )
      ) {
        setCurrentError(
          activation,
          new Error('Wait for the running check to finish before starting another one.'),
          'A delivery check is already running.',
        );
        return undefined;
      }
      const token = beginOperation(activation, { kind: 'run-check', checkId });
      if (token === null) return undefined;
      try {
        const result = unwrap(
          await window.forgeboard.git.readiness.run({
            readinessId: readiness.readinessId,
            checkId,
            expectedSourceFingerprint: readiness.sourceFingerprint.digest,
          }),
        );
        if (!isCurrent(activation)) return undefined;
        let notice: GitDeliveryReadinessNotice;
        if (result === null) {
          notice = { kind: 'check-run-cancelled', checkId };
        } else {
          const resultCheck = result.requiredChecks.find((check) => check.checkId === checkId);
          if (resultCheck === undefined) {
            throw new Error('The check run finished without a result for the requested check.');
          }
          notice = {
            kind: 'check-run-result',
            checkId,
            state: resultCheck.state,
          };
        }
        await refreshFor(activation, managedTarget, false);
        return isCurrent(activation) ? notice : undefined;
      } catch (cause) {
        setCurrentError(activation, cause, "Forgeboard couldn't run this check. Try again.");
        if (isCurrent(activation)) await refreshFor(activation, managedTarget, false);
        return undefined;
      } finally {
        endOperation(activation, token);
      }
    },
    [
      activation,
      beginOperation,
      endOperation,
      isCurrent,
      managedTarget,
      refreshFor,
      selectedCheckIds,
      selectedWorkflowExecutionId,
      setCurrentError,
      view,
    ],
  );

  const approveQuality = useCallback(async (): Promise<GitDeliveryReadinessNotice | undefined> => {
    const readiness = preparedReadiness(view, selectedWorkflowExecutionId, selectedCheckIds);
    if (managedTarget === null || readiness === null) {
      setCurrentError(
        activation,
        new Error('Save the current selection of required checks before approving quality.'),
        "Delivery checks aren't set up for this agent's workspace yet.",
      );
      return undefined;
    }
    if (!readiness.requiredChecks.every((check) => check.state === 'passed')) {
      setCurrentError(
        activation,
        new Error('Every required check must pass before quality can be approved.'),
        "The required checks haven't all passed yet.",
      );
      return undefined;
    }
    if (readiness.evaluation.humanApprovalState === 'approved') return undefined;
    const token = beginOperation(activation, { kind: 'approve-quality' });
    if (token === null) return undefined;
    try {
      const result = unwrap(
        await window.forgeboard.git.readiness.approve({
          readinessId: readiness.readinessId,
          expectedSourceFingerprint: readiness.sourceFingerprint.digest,
          confirmed: true,
        }),
      );
      if (!isCurrent(activation)) return undefined;
      const notice: GitDeliveryReadinessNotice =
        result === null ? { kind: 'quality-approval-cancelled' } : { kind: 'quality-approved' };
      await refreshFor(activation, managedTarget, false);
      return isCurrent(activation) ? notice : undefined;
    } catch (cause) {
      setCurrentError(
        activation,
        cause,
        "Forgeboard couldn't record the quality approval. Try again.",
      );
      return undefined;
    } finally {
      endOperation(activation, token);
    }
  }, [
    activation,
    beginOperation,
    endOperation,
    isCurrent,
    managedTarget,
    refreshFor,
    selectedCheckIds,
    selectedWorkflowExecutionId,
    setCurrentError,
    view,
  ]);

  return {
    view,
    selectedWorkflowExecutionId,
    selectedCheckIds,
    ready,
    loading,
    busy,
    error,
    setSelectedWorkflowExecutionId,
    setSelectedCheckIds,
    refresh,
    prepareRequirements,
    runCheck,
    approveQuality,
  };
}

function emptyState(activation: TargetActivation, loading: boolean): ReadinessState {
  return {
    activation,
    view: null,
    selectedWorkflowExecutionId: null,
    selectedCheckIds: EMPTY_CHECK_IDS,
    loading,
    busy: null,
    error: null,
  };
}

function selectionAfterRefresh(
  view: GitDeliveryReadinessGetView,
  previousExecutionId: string | null,
  previousCheckIds: readonly CheckId[],
): Pick<ReadinessState, 'selectedWorkflowExecutionId' | 'selectedCheckIds'> {
  const executionId = view.readiness?.workflowBinding.executionId;
  const preparedCandidate =
    executionId === undefined
      ? undefined
      : view.compatibleWorkflowExecutions.find(
          (execution) => execution.executionId === executionId,
        );
  if (executionId !== undefined && preparedCandidate === undefined) {
    return {
      selectedWorkflowExecutionId: null,
      selectedCheckIds: EMPTY_CHECK_IDS,
    };
  }
  const previousCandidate =
    previousExecutionId === null
      ? undefined
      : view.compatibleWorkflowExecutions.find(
          (execution) => execution.executionId === previousExecutionId,
        );
  const candidate =
    preparedCandidate ??
    previousCandidate ??
    (previousExecutionId === null && view.compatibleWorkflowExecutions.length === 1
      ? view.compatibleWorkflowExecutions[0]
      : undefined);
  if (candidate === undefined) {
    return {
      selectedWorkflowExecutionId: null,
      selectedCheckIds: EMPTY_CHECK_IDS,
    };
  }
  const mandatory = new Set(candidate.derivedCheckIds);
  const selectedCheckIds =
    view.readiness?.workflowBinding.executionId === candidate.executionId
      ? view.readiness.requiredChecks
          .map((check) => check.checkId)
          .filter((checkId) => !mandatory.has(checkId))
      : previousCandidate === candidate
        ? previousCheckIds
        : EMPTY_CHECK_IDS;
  return {
    selectedWorkflowExecutionId: candidate.executionId,
    selectedCheckIds,
  };
}

function validSelection(
  view: GitDeliveryReadinessGetView,
  candidate: GitDeliveryReadinessGetView['compatibleWorkflowExecutions'][number],
  checkIds: readonly CheckId[],
): boolean {
  const mandatory = new Set(candidate.derivedCheckIds);
  const totalCheckIds = [...candidate.derivedCheckIds, ...checkIds];
  return (
    totalCheckIds.length > 0 &&
    totalCheckIds.length <= GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS &&
    new Set(checkIds).size === checkIds.length &&
    checkIds.every((checkId) => !mandatory.has(checkId)) &&
    totalCheckIds.every((checkId) =>
      view.availableChecks.some(
        (check) => check.checkId === checkId && check.availability === 'configured',
      ),
    )
  );
}

function preparedReadiness(
  view: GitDeliveryReadinessGetView | null,
  selectedWorkflowExecutionId: string | null,
  selectedCheckIds: readonly CheckId[],
): NonNullable<GitDeliveryReadinessGetView['readiness']> | null {
  if (view?.readiness === null || view === null) return null;
  const candidate = selectedWorkflowExecution(view, selectedWorkflowExecutionId);
  if (candidate === null || view.readiness.workflowBinding.executionId !== candidate.executionId) {
    return null;
  }
  const requiredCheckIds = view.readiness.requiredChecks.map((check) => check.checkId);
  const selectedRequiredCheckIds = [...candidate.derivedCheckIds, ...selectedCheckIds];
  return sameCheckIds(selectedRequiredCheckIds, requiredCheckIds) ? view.readiness : null;
}

function selectedWorkflowExecution(
  view: GitDeliveryReadinessGetView,
  executionId: string | null,
): GitDeliveryReadinessGetView['compatibleWorkflowExecutions'][number] | null {
  if (executionId === null) return null;
  return (
    view.compatibleWorkflowExecutions.find((execution) => execution.executionId === executionId) ??
    null
  );
}

function sameCheckIds(left: readonly CheckId[], right: readonly CheckId[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length) return false;
  const rightIds = new Set(right);
  return left.every((checkId) => rightIds.has(checkId));
}

function sameTarget(left: GitDeliveryReadinessTarget, right: GitDeliveryReadinessTarget): boolean {
  return left.projectId === right.projectId && left.runId === right.runId;
}

function readinessErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
