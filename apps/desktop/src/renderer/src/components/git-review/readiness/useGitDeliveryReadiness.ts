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
  readonly selectedCheckIds: readonly CheckId[];
  readonly ready: boolean;
  readonly loading: boolean;
  readonly busy: GitDeliveryReadinessBusy | null;
  readonly error: string | null;
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
  const selectedCheckIds = stateIsCurrent ? state.selectedCheckIds : EMPTY_CHECK_IDS;
  const loading = stateIsCurrent ? state.loading : managedTarget !== null;
  const busy = stateIsCurrent ? state.busy : null;
  const error = stateIsCurrent ? state.error : null;
  const ready = preparedReadiness(view, selectedCheckIds)?.evaluation.ready === true;

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
        setState((current) =>
          current.activation === expected
            ? {
                ...current,
                view: next,
                selectedCheckIds: initialCheckSelection(next),
              }
            : current,
        );
        return true;
      } catch (cause) {
        if (isCurrent(expected) && requestVersionRef.current === requestVersion) {
          const message = readinessErrorMessage(
            cause,
            'Forgeboard could not load delivery readiness for this managed worktree.',
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
      if (!validSelection(view, checkIds)) {
        setCurrentError(
          activation,
          new Error(
            `Select between 1 and ${String(GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS)} unique, configured checks before saving delivery requirements.`,
          ),
          'Select at least one configured check before saving delivery requirements.',
        );
        return false;
      }
      const token = beginOperation(activation, { kind: 'prepare-requirements' });
      if (token === null) return false;
      try {
        unwrap(
          await window.forgeboard.git.readiness.prepare({
            target: managedTarget,
            requiredCheckIds: [...checkIds],
          }),
        );
        if (!isCurrent(activation)) return false;
        return await refreshFor(activation, managedTarget, false);
      } catch (cause) {
        setCurrentError(
          activation,
          cause,
          'Forgeboard could not save the required delivery checks.',
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
      setCurrentError,
      view,
    ],
  );

  const runCheck = useCallback(
    async (checkId: CheckId): Promise<GitDeliveryReadinessNotice | undefined> => {
      const readiness = preparedReadiness(view, selectedCheckIds);
      if (managedTarget === null || readiness === null) {
        setCurrentError(
          activation,
          new Error('Save the current required-check selection before running delivery checks.'),
          'Delivery readiness is not prepared for this managed worktree.',
        );
        return undefined;
      }
      if (!readiness.requiredChecks.some((check) => check.checkId === checkId)) {
        setCurrentError(
          activation,
          new Error('The selected check is not required by the current delivery binding.'),
          'The selected delivery check cannot run.',
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
          new Error('Wait for the active delivery check to finish before running another check.'),
          'A delivery check is already active.',
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
            throw new Error('The delivery-check response omitted the requested check evidence.');
          }
          notice = { kind: 'check-run-result', checkId, state: resultCheck.state };
        }
        await refreshFor(activation, managedTarget, false);
        return isCurrent(activation) ? notice : undefined;
      } catch (cause) {
        setCurrentError(activation, cause, 'Forgeboard could not run this delivery check.');
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
      setCurrentError,
      view,
    ],
  );

  const approveQuality = useCallback(async (): Promise<GitDeliveryReadinessNotice | undefined> => {
    const readiness = preparedReadiness(view, selectedCheckIds);
    if (managedTarget === null || readiness === null) {
      setCurrentError(
        activation,
        new Error('Save the current required-check selection before approving quality.'),
        'Delivery readiness is not prepared for this managed worktree.',
      );
      return undefined;
    }
    if (!readiness.requiredChecks.every((check) => check.state === 'passed')) {
      setCurrentError(
        activation,
        new Error('Every required check must pass before human quality approval can be recorded.'),
        'Required delivery checks have not passed.',
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
      setCurrentError(activation, cause, 'Forgeboard could not record human quality approval.');
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
    setCurrentError,
    view,
  ]);

  return {
    view,
    selectedCheckIds,
    ready,
    loading,
    busy,
    error,
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
    selectedCheckIds: EMPTY_CHECK_IDS,
    loading,
    busy: null,
    error: null,
  };
}

function initialCheckSelection(view: GitDeliveryReadinessGetView): readonly CheckId[] {
  return view.readiness === null
    ? view.availableChecks
        .filter((check) => check.availability === 'configured')
        .map((check) => check.checkId)
    : view.readiness.requiredChecks.map((check) => check.checkId);
}

function validSelection(view: GitDeliveryReadinessGetView, checkIds: readonly CheckId[]): boolean {
  return (
    checkIds.length > 0 &&
    checkIds.length <= GIT_DELIVERY_READINESS_MAX_REQUIRED_CHECKS &&
    new Set(checkIds).size === checkIds.length &&
    checkIds.every((checkId) =>
      view.availableChecks.some(
        (check) => check.checkId === checkId && check.availability === 'configured',
      ),
    )
  );
}

function preparedReadiness(
  view: GitDeliveryReadinessGetView | null,
  selectedCheckIds: readonly CheckId[],
): NonNullable<GitDeliveryReadinessGetView['readiness']> | null {
  if (view?.readiness === null || view === null) return null;
  const requiredCheckIds = view.readiness.requiredChecks.map((check) => check.checkId);
  return sameCheckIds(selectedCheckIds, requiredCheckIds) ? view.readiness : null;
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
