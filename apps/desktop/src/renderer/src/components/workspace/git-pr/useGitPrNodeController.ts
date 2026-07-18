import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { IpcResult } from '../../../../../shared/application/contracts.js';
import {
  GitRemoteBranchSchema,
  GitRemoteDeliveryTargetInputSchema,
  GitRemoteNameSchema,
  type GitHubCiResultView,
  type GitHubPullRequestPlanView,
  type GitHubStatusResultView,
  type GitRemoteDescriptorView,
  type GitRemoteInspectView,
  type GitRemotePushPlanView,
} from '../../../../../shared/git/remote/index.js';
import type { RunHistorySummary } from '../../../../../shared/runs/contracts.js';
import type { GitRemoteDeliveryApi } from '../../../../../preload/git/remote/index.js';
import { unwrap } from '../../../lib/ipc.js';
import type {
  GitPrAgentRunOption,
  GitPrGitHubStatusView,
  GitPrInspectionView,
  GitPrNodeConfiguration,
  GitPrNodeController,
  GitPrOperation,
  GitPrPendingPlan,
} from './types.js';

interface NodeLabelSource {
  readonly id: string;
  readonly data: { readonly title: string };
}

interface AgentLabelSource {
  readonly id: string;
  readonly label: string;
}

type RunListOperation = (input: {
  readonly projectId: string;
  readonly limit: number;
}) => Promise<IpcResult<RunHistorySummary[]>>;

export interface UseGitPrNodeControllerOptions {
  readonly projectId: string;
  readonly configuration: GitPrNodeConfiguration;
  readonly nodes: readonly NodeLabelSource[];
  readonly agents: readonly AgentLabelSource[];
  readonly onError: (message: string) => void;
  readonly onPullRequestCreated: (url: string) => void;
  readonly operations?: GitRemoteDeliveryApi | undefined;
  readonly listRuns?: RunListOperation | undefined;
}

interface HistoryState {
  readonly loaded: boolean;
  readonly records: readonly RunHistorySummary[];
  readonly error: string | null;
}

interface KeyedState<T> {
  readonly key: string;
  readonly value: T;
}

type PendingPlanState = KeyedState<GitPrPendingPlan>;
const GITHUB_STATUS_TTL_MS = 5 * 60_000;

export function useGitPrNodeController({
  projectId,
  configuration,
  nodes,
  agents,
  onError,
  onPullRequestCreated,
  operations: injectedOperations,
  listRuns: injectedListRuns,
}: UseGitPrNodeControllerOptions): GitPrNodeController {
  const operations =
    injectedOperations ??
    (
      window.forgeboard.git as typeof window.forgeboard.git & {
        readonly remote: GitRemoteDeliveryApi;
      }
    ).remote;
  const defaultListRuns = useCallback<RunListOperation>(
    async (input) => await window.forgeboard.runs.list(input),
    [],
  );
  const listRuns: RunListOperation = injectedListRuns ?? defaultListRuns;
  const [history, setHistory] = useState<HistoryState>({
    loaded: false,
    records: [],
    error: null,
  });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [inspection, setInspection] = useState<GitPrInspectionView | null>(null);
  const [remoteOptionsState, setRemoteOptionsState] = useState<KeyedState<
    readonly string[]
  > | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [githubState, setGitHubState] = useState<KeyedState<GitPrGitHubStatusView> | null>(null);
  const [githubError, setGitHubError] = useState<string | null>(null);
  const [ciState, setCiState] = useState<KeyedState<GitPrNodeController['ciStatus']> | null>(null);
  const [ciError, setCiError] = useState<string | null>(null);
  const [pendingState, setPendingState] = useState<PendingPlanState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<GitPrOperation | null>(null);
  const [, setFreshnessRevision] = useState(0);
  const busyRef = useRef<GitPrOperation | null>(null);
  const historyRequestRef = useRef(0);
  const onErrorRef = useRef(onError);
  const onPullRequestCreatedRef = useRef(onPullRequestCreated);
  const mountedRef = useRef(true);
  const pendingPlanIdRef = useRef<string | null>(null);
  onErrorRef.current = onError;
  onPullRequestCreatedRef.current = onPullRequestCreated;

  const takePendingPlanId = useCallback((expected?: string): string | null => {
    const planId = pendingPlanIdRef.current;
    if (planId === null || (expected !== undefined && planId !== expected)) return null;
    pendingPlanIdRef.current = null;
    return planId;
  }, []);

  const releasePreparedPlan = useCallback(
    async (planId: string): Promise<void> => {
      unwrap(await operations.cancelPlan({ planId }));
    },
    [operations],
  );
  const releasePreparedPlanSilently = useCallback(
    (planId: string): void => {
      void releasePreparedPlan(planId).catch(() => undefined);
    },
    [releasePreparedPlan],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const planId = takePendingPlanId();
      if (planId !== null) releasePreparedPlanSilently(planId);
    };
  }, [releasePreparedPlanSilently, takePendingPlanId]);

  const target = useMemo(() => {
    if (configuration.targetRunId === undefined) return null;
    const parsed = GitRemoteDeliveryTargetInputSchema.safeParse({
      kind: 'agent-worktree',
      projectId,
      runId: configuration.targetRunId,
    });
    return parsed.success ? parsed.data : null;
  }, [configuration.targetRunId, projectId]);
  const targetKey = useMemo(
    () => JSON.stringify([projectId, configuration.targetRunId ?? null]),
    [configuration.targetRunId, projectId],
  );
  const deliveryKey = useMemo(
    () =>
      JSON.stringify([
        projectId,
        configuration.targetRunId ?? null,
        configuration.remote,
        configuration.destinationBranch,
        configuration.baseBranch,
      ]),
    [
      configuration.baseBranch,
      configuration.destinationBranch,
      configuration.remote,
      configuration.targetRunId,
      projectId,
    ],
  );
  const pullRequestKey = useMemo(
    () =>
      JSON.stringify([
        deliveryKey,
        configuration.pullRequestTitle,
        configuration.pullRequestBody,
        configuration.pullRequestDraft,
      ]),
    [
      configuration.pullRequestBody,
      configuration.pullRequestDraft,
      configuration.pullRequestTitle,
      deliveryKey,
    ],
  );
  const deliveryKeyRef = useRef(deliveryKey);
  const pullRequestKeyRef = useRef(pullRequestKey);
  const previousDeliveryKeyRef = useRef(deliveryKey);
  const previousPullRequestKeyRef = useRef(pullRequestKey);
  const previousTargetKeyRef = useRef(targetKey);
  deliveryKeyRef.current = deliveryKey;
  pullRequestKeyRef.current = pullRequestKey;

  useEffect(() => {
    if (githubState === null || githubState.key !== deliveryKey) return;
    const expiresAt = Date.parse(githubState.value.checkedAt) + GITHUB_STATUS_TTL_MS;
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(
      () => setFreshnessRevision((current) => current + 1),
      Math.min(remaining, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [deliveryKey, githubState]);

  useEffect(() => {
    if (previousTargetKeyRef.current === targetKey) return;
    previousTargetKeyRef.current = targetKey;
    setRemoteOptionsState(null);
  }, [targetKey]);

  useEffect(() => {
    if (previousDeliveryKeyRef.current === deliveryKey) return;
    previousDeliveryKeyRef.current = deliveryKey;
    setInspection(null);
    setInspectionError(null);
    setGitHubState(null);
    setGitHubError(null);
    setCiState(null);
    setCiError(null);
    const planId = takePendingPlanId();
    if (planId !== null) releasePreparedPlanSilently(planId);
    setPendingState(null);
    setActionError(null);
    setNotice(null);
  }, [deliveryKey, releasePreparedPlanSilently, takePendingPlanId]);

  useEffect(() => {
    if (previousPullRequestKeyRef.current === pullRequestKey) return;
    previousPullRequestKeyRef.current = pullRequestKey;
    const planId = takePendingPlanId();
    if (planId !== null) releasePreparedPlanSilently(planId);
    setPendingState(null);
    setActionError(null);
    setNotice(null);
  }, [pullRequestKey, releasePreparedPlanSilently, takePendingPlanId]);

  useEffect(() => {
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    let active = true;
    setHistory((current) => ({ ...current, loaded: false, error: null }));
    void listRuns({ projectId, limit: 200 })
      .then((result) => {
        if (!active || historyRequestRef.current !== request) return;
        setHistory({ loaded: true, records: unwrap(result), error: null });
      })
      .catch((cause: unknown) => {
        if (!active || historyRequestRef.current !== request) return;
        const message = errorMessage(
          cause,
          'Could not load the list of past agent runs. Try again.',
        );
        setHistory({ loaded: true, records: [], error: message });
        onErrorRef.current(message);
      });
    return () => {
      active = false;
      if (historyRequestRef.current === request) historyRequestRef.current += 1;
    };
  }, [historyRevision, listRuns, projectId]);

  const agentRuns = useMemo(
    () => runOptions(history.records, nodes, agents),
    [agents, history.records, nodes],
  );
  const currentInspection =
    inspection !== null &&
    target !== null &&
    inspection.targetRunId === target.runId &&
    inspection.remote === configuration.remote &&
    inspection.destinationBranch === configuration.destinationBranch &&
    inspection.requestedBaseBranch === configuration.baseBranch
      ? inspection
      : null;

  const perform = useCallback(
    async <T>(
      operation: GitPrOperation,
      setError: (message: string | null) => void,
      task: () => Promise<T>,
      isCurrent: () => boolean = () => true,
    ): Promise<T | undefined> => {
      if (busyRef.current !== null) return undefined;
      busyRef.current = operation;
      setBusy(operation);
      setError(null);
      setNotice(null);
      try {
        return await task();
      } catch (cause) {
        if (!isCurrent()) return undefined;
        const message = errorMessage(cause, operationFallback(operation));
        setError(message);
        onErrorRef.current(message);
        return undefined;
      } finally {
        if (busyRef.current === operation) busyRef.current = null;
        setBusy((current) => (current === operation ? null : current));
      }
    },
    [],
  );

  const inspect = useCallback(() => {
    if (target === null) {
      const message = 'Choose a finished agent run before checking its changes.';
      setInspectionError(message);
      return;
    }
    const key = deliveryKey;
    setRemoteOptionsState(null);
    setInspection(null);
    setGitHubState(null);
    setGitHubError(null);
    setCiState(null);
    setCiError(null);
    const planId = takePendingPlanId();
    if (planId !== null) releasePreparedPlanSilently(planId);
    setPendingState(null);
    setActionError(null);
    void perform(
      'inspect',
      setInspectionError,
      async () => {
        const view = unwrap(await operations.inspect({ target }));
        if (deliveryKeyRef.current !== key) return;
        setRemoteOptionsState({
          key: targetKey,
          value: [...new Set(view.remotes.map((remote) => remote.name))].sort(),
        });
        setInspection(mapInspection(view, configuration));
        setGitHubState(null);
        setGitHubError(null);
        setCiState(null);
        setCiError(null);
        setPendingState(null);
        setActionError(null);
      },
      () => deliveryKeyRef.current === key,
    );
  }, [
    configuration,
    deliveryKey,
    operations,
    perform,
    releasePreparedPlanSilently,
    takePendingPlanId,
    target,
    targetKey,
  ]);

  const preparePush = useCallback(() => {
    if (target === null) {
      setActionError('Choose a finished agent run before preparing a push.');
      return;
    }
    if (currentInspection?.ready !== true) {
      setActionError(
        "Check the run's changes and finish the required checks and approval before preparing a push.",
      );
      return;
    }
    const key = deliveryKey;
    void perform(
      'prepare-push',
      setActionError,
      async () => {
        const plan = unwrap(
          await operations.preparePush({
            target,
            remote: configuration.remote,
            destinationBranch: configuration.destinationBranch,
          }),
        );
        if (!mountedRef.current || deliveryKeyRef.current !== key) {
          await releasePreparedPlan(plan.planId);
          return;
        }
        const supersededPlanId = takePendingPlanId();
        if (supersededPlanId !== null) releasePreparedPlanSilently(supersededPlanId);
        const nextPending = {
          key,
          value: {
            kind: 'push',
            planId: plan.planId,
            expiresAt: plan.expiresAt,
            inspection: inspectionFromPushPlan(plan, configuration, currentInspection),
          },
        } satisfies PendingPlanState;
        pendingPlanIdRef.current = plan.planId;
        setPendingState(nextPending);
      },
      () => deliveryKeyRef.current === key,
    );
  }, [
    configuration,
    currentInspection,
    deliveryKey,
    operations,
    perform,
    releasePreparedPlan,
    releasePreparedPlanSilently,
    takePendingPlanId,
    target,
  ]);

  const checkGitHub = useCallback(() => {
    if (target === null) {
      setGitHubError('Choose a finished agent run before checking GitHub.');
      return;
    }
    if (currentInspection === null) {
      setGitHubError("Check the run's changes before contacting GitHub.");
      return;
    }
    const key = deliveryKey;
    setGitHubState(null);
    setCiState(null);
    setCiError(null);
    void perform(
      'github-status',
      setGitHubError,
      async () => {
        const plan = unwrap(
          await operations.prepareGitHubStatus({
            target,
            remote: configuration.remote,
            destinationBranch: configuration.destinationBranch,
            baseBranch: configuration.baseBranch,
          }),
        );
        if (!mountedRef.current || deliveryKeyRef.current !== key) {
          await releasePreparedPlan(plan.planId);
          return;
        }
        const result = unwrap(await operations.confirmGitHubStatus({ planId: plan.planId }));
        if (deliveryKeyRef.current !== key) return;
        if (result === null) {
          setNotice('The GitHub check was cancelled. Nothing was sent.');
          return;
        }
        setGitHubState({ key, value: mapGitHubStatus(result) });
        setCiState(null);
      },
      () => deliveryKeyRef.current === key,
    );
  }, [
    configuration,
    currentInspection,
    deliveryKey,
    operations,
    perform,
    releasePreparedPlan,
    target,
  ]);

  const preparePullRequest = useCallback(() => {
    if (target === null) {
      setActionError('Choose a finished agent run before preparing a pull request.');
      return;
    }
    if (currentInspection?.ready !== true) {
      setActionError(
        "Check the run's changes and finish the required checks and approval before preparing a pull request.",
      );
      return;
    }
    const currentGitHub =
      githubState?.key === deliveryKey &&
      githubState.value.sourceOid === currentInspection.sourceOid
        ? githubState.value
        : null;
    if (
      currentGitHub?.authenticated !== true ||
      currentGitHub.headMatchesSource !== true ||
      !githubStatusIsFresh(currentGitHub.checkedAt)
    ) {
      setActionError('Check GitHub again right before preparing a pull request.');
      return;
    }
    const key = pullRequestKey;
    void perform(
      'prepare-pull-request',
      setActionError,
      async () => {
        const plan = unwrap(
          await operations.preparePullRequest({
            target,
            remote: configuration.remote,
            destinationBranch: configuration.destinationBranch,
            baseBranch: configuration.baseBranch,
            title: configuration.pullRequestTitle,
            body: configuration.pullRequestBody,
            draft: configuration.pullRequestDraft,
          }),
        );
        if (!mountedRef.current || pullRequestKeyRef.current !== key) {
          await releasePreparedPlan(plan.planId);
          return;
        }
        const supersededPlanId = takePendingPlanId();
        if (supersededPlanId !== null) releasePreparedPlanSilently(supersededPlanId);
        const nextPending = {
          key,
          value: {
            kind: 'pull-request',
            planId: plan.planId,
            expiresAt: plan.expiresAt,
            inspection: inspectionFromPullRequestPlan(plan, currentInspection),
            ownerRepository: plan.ownerRepository,
            title: plan.title,
            body: configuration.pullRequestBody,
            draft: plan.draft,
          },
        } satisfies PendingPlanState;
        pendingPlanIdRef.current = plan.planId;
        setPendingState(nextPending);
      },
      () => pullRequestKeyRef.current === key,
    );
  }, [
    configuration,
    currentInspection,
    deliveryKey,
    githubState,
    operations,
    perform,
    pullRequestKey,
    releasePreparedPlan,
    releasePreparedPlanSilently,
    takePendingPlanId,
    target,
  ]);

  const checkCi = useCallback(() => {
    if (target === null) {
      setCiError('Choose a finished agent run before checking CI results.');
      return;
    }
    if (currentInspection === null) {
      setCiError("Check the run's changes before asking GitHub for CI results.");
      return;
    }
    const currentGitHub =
      githubState?.key === deliveryKey &&
      githubState.value.sourceOid === currentInspection.sourceOid
        ? githubState.value
        : null;
    if (
      currentGitHub?.authenticated !== true ||
      currentGitHub.headMatchesSource !== true ||
      !githubStatusIsFresh(currentGitHub.checkedAt)
    ) {
      setCiError('Check GitHub again right before reading CI results.');
      return;
    }
    const key = deliveryKey;
    void perform(
      'ci-status',
      setCiError,
      async () => {
        const plan = unwrap(
          await operations.prepareCi({
            target,
            remote: configuration.remote,
            destinationBranch: configuration.destinationBranch,
            baseBranch: configuration.baseBranch,
          }),
        );
        if (!mountedRef.current || deliveryKeyRef.current !== key) {
          await releasePreparedPlan(plan.planId);
          return;
        }
        const result = unwrap(await operations.confirmCi({ planId: plan.planId }));
        if (deliveryKeyRef.current !== key) return;
        if (result === null) {
          setNotice('The CI check was cancelled. Nothing was sent.');
          return;
        }
        setCiState({ key, value: mapCiStatus(result) });
      },
      () => deliveryKeyRef.current === key,
    );
  }, [
    configuration,
    currentInspection,
    deliveryKey,
    githubState,
    operations,
    perform,
    releasePreparedPlan,
    target,
  ]);

  const visiblePending =
    pendingState !== null &&
    pendingState.key === (pendingState.value.kind === 'pull-request' ? pullRequestKey : deliveryKey)
      ? pendingState.value
      : null;

  const cancelPlan = useCallback(() => {
    const planId = takePendingPlanId(pendingState?.value.planId);
    setPendingState(null);
    if (planId === null) {
      setNotice('This prepared action is no longer available. Nothing changed online.');
      return;
    }
    setNotice('Cancelling the prepared action…');
    void releasePreparedPlan(planId).then(
      () => setNotice('Cancelled. Nothing changed online.'),
      (cause: unknown) => {
        const message = errorMessage(
          cause,
          "The action was closed here, but Forgeboard couldn't release its saved approval. Nothing was sent.",
        );
        setNotice(null);
        setActionError(message);
        onErrorRef.current(message);
      },
    );
  }, [pendingState, releasePreparedPlan, takePendingPlanId]);

  const confirmPlan = useCallback(() => {
    if (visiblePending === null) {
      setActionError(
        'This prepared action is out of date. Prepare it again with the current settings.',
      );
      const planId = takePendingPlanId();
      if (planId !== null) releasePreparedPlanSilently(planId);
      setPendingState(null);
      return;
    }
    const key = visiblePending.kind === 'pull-request' ? pullRequestKey : deliveryKey;
    const isCurrent = () =>
      visiblePending.kind === 'pull-request'
        ? pullRequestKeyRef.current === key
        : deliveryKeyRef.current === key;
    if (takePendingPlanId(visiblePending.planId) === null) {
      setActionError('This prepared action is already being cancelled. Prepare it again.');
      setPendingState(null);
      return;
    }
    setPendingState((current) =>
      current?.value.planId === visiblePending.planId ? null : current,
    );
    if (visiblePending.kind === 'push') {
      void perform(
        'confirm-push',
        setActionError,
        async () => {
          const result = unwrap(await operations.confirmPush({ planId: visiblePending.planId }));
          if (!isCurrent()) return;
          if (result === null) {
            setNotice('Push cancelled at the final confirmation. Nothing changed online.');
            return;
          }
          setGitHubState(null);
          setCiState(null);
          setNotice(
            `Pushed commit ${result.sourceOid} to ${result.remote}/${result.destinationBranch}.`,
          );
        },
        isCurrent,
      );
      return;
    }
    void perform(
      'confirm-pull-request',
      setActionError,
      async () => {
        const result = unwrap(
          await operations.confirmPullRequest({ planId: visiblePending.planId }),
        );
        if (!isCurrent()) return;
        if (result === null) {
          setNotice('Pull request cancelled at the final confirmation. Nothing was created.');
          return;
        }
        onPullRequestCreatedRef.current(result.url);
        setNotice(
          `Pull request created after Forgeboard rechecked the reviewed commit ${result.sourceOid}. The remote branch can still change afterwards.`,
        );
      },
      isCurrent,
    );
  }, [
    deliveryKey,
    operations,
    pendingState,
    perform,
    pullRequestKey,
    releasePreparedPlanSilently,
    takePendingPlanId,
    visiblePending,
  ]);

  const currentGitHubStatus =
    githubState?.key === deliveryKey &&
    currentInspection !== null &&
    githubState.value.sourceOid === currentInspection.sourceOid
      ? githubState.value
      : null;
  const githubStatus =
    currentGitHubStatus === null
      ? null
      : {
          ...currentGitHubStatus,
          fresh: githubStatusIsFresh(currentGitHubStatus.checkedAt),
        };
  const ciStatus =
    ciState?.key === deliveryKey &&
    currentInspection !== null &&
    ciState.value?.sourceOid === currentInspection.sourceOid
      ? ciState.value
      : null;
  return {
    agentRuns,
    agentRunsLoaded: history.loaded,
    agentRunsError: history.error,
    availableRemotes: remoteOptionsState?.key === targetKey ? remoteOptionsState.value : null,
    inspection,
    inspectionError,
    githubStatus,
    githubError,
    ciStatus,
    ciError,
    actionError,
    pendingPlan: visiblePending,
    busy,
    notice,
    refreshAgentRuns: () => setHistoryRevision((current) => current + 1),
    inspect,
    preparePush,
    checkGitHub,
    preparePullRequest,
    checkCi,
    cancelPlan,
    confirmPlan,
  };
}

function runOptions(
  records: readonly RunHistorySummary[],
  nodes: readonly NodeLabelSource[],
  agents: readonly AgentLabelSource[],
): GitPrAgentRunOption[] {
  const nodeLabels = new Map(nodes.map((node) => [node.id, node.data.title] as const));
  const agentLabels = new Map(agents.map((agent) => [agent.id, agent.label] as const));
  const seen = new Set<string>();
  return records.flatMap((record) => {
    if (seen.has(record.id) || record.worktreeState === 'cleaned') return [];
    if (!record.worktreeAvailable && record.worktreeState !== 'cleanup-pending') return [];
    seen.add(record.id);
    return [
      {
        runId: record.id,
        nodeLabel: nodeLabels.get(record.nodeId) ?? `Run from ${record.nodeId}`,
        agentLabel: agentLabels.get(record.adapterId) ?? record.adapterId,
        status: record.status,
        branch: record.branch,
        worktreeState: record.worktreeState === 'cleanup-pending' ? 'cleanup-pending' : 'active',
        endedAt: record.endedAt,
      },
    ];
  });
}

function mapInspection(
  view: GitRemoteInspectView,
  configuration: GitPrNodeConfiguration,
): GitPrInspectionView {
  const selectedRemote = view.remotes.find((remote) => remote.name === configuration.remote);
  const readiness = inspectionReadiness(view, configuration, selectedRemote);
  return {
    targetRunId: view.target.runId,
    sourceBranch: view.sourceBranch,
    sourceOid: view.sourceHead,
    remote: configuration.remote,
    remoteDisclosure: remoteDisclosure(selectedRemote, configuration.remote),
    destinationBranch: configuration.destinationBranch,
    requestedBaseBranch: configuration.baseBranch,
    requestedBaseOid: null,
    runBaseRef: view.baseRef,
    runBaseOid: view.baseCommit,
    divergenceBaseOid: view.divergenceBaseCommit,
    commitCount: view.commitCount,
    commits: view.commits,
    commitsTruncated: view.commitsTruncated,
    fileCount: view.fileCount,
    files: view.files,
    filesTruncated: view.filesTruncated,
    additions: view.additions,
    deletions: view.deletions,
    ahead: view.ahead,
    behind: view.behind,
    ready: readiness.length === 0,
    readiness,
    inspectedAt: view.refreshedAt,
  };
}

function inspectionFromPushPlan(
  plan: GitRemotePushPlanView,
  configuration: GitPrNodeConfiguration,
  prior: GitPrInspectionView | null,
): GitPrInspectionView {
  return exactPlanInspection({
    targetRunId: plan.target.runId,
    sourceBranch: plan.sourceBranch,
    sourceOid: plan.sourceHead,
    remote: plan.remote,
    destinationBranch: plan.destinationBranch,
    requestedBaseBranch: configuration.baseBranch,
    requestedBaseOid: null,
    runBaseRef: prior?.sourceOid === plan.sourceHead ? prior.runBaseRef : configuration.baseBranch,
    runBaseOid: plan.baseCommit,
    divergenceBaseOid:
      prior?.sourceOid === plan.sourceHead ? prior.divergenceBaseOid : plan.baseCommit,
    commits: plan.commits,
    files: plan.files,
    additions: plan.additions,
    deletions: plan.deletions,
    ahead: prior?.sourceOid === plan.sourceHead ? prior.ahead : 0,
    behind: prior?.sourceOid === plan.sourceHead ? prior.behind : 0,
    inspectedAt: plan.readiness.updatedAt,
  });
}

function inspectionFromPullRequestPlan(
  plan: GitHubPullRequestPlanView,
  prior: GitPrInspectionView,
): GitPrInspectionView {
  return exactPlanInspection({
    targetRunId: plan.target.runId,
    sourceBranch: prior.sourceBranch,
    sourceOid: plan.sourceHead,
    remote: plan.remote,
    destinationBranch: plan.headBranch,
    requestedBaseBranch: plan.baseBranch,
    requestedBaseOid: plan.baseOid,
    runBaseRef: prior.runBaseRef,
    runBaseOid: prior.runBaseOid,
    divergenceBaseOid: prior.divergenceBaseOid,
    commits: plan.commits,
    files: plan.files,
    additions: plan.additions,
    deletions: plan.deletions,
    ahead: prior.ahead,
    behind: prior.behind,
    inspectedAt: plan.readiness.updatedAt,
  });
}

function exactPlanInspection(input: {
  readonly targetRunId: string;
  readonly sourceBranch: string;
  readonly sourceOid: string;
  readonly remote: GitRemoteDescriptorView;
  readonly destinationBranch: string;
  readonly requestedBaseBranch: string;
  readonly requestedBaseOid?: string | null;
  readonly runBaseRef: string;
  readonly runBaseOid: string;
  readonly divergenceBaseOid: string;
  readonly commits: readonly string[];
  readonly files: GitPrInspectionView['files'];
  readonly additions: number;
  readonly deletions: number;
  readonly ahead: number;
  readonly behind: number;
  readonly inspectedAt: string;
}): GitPrInspectionView {
  return {
    targetRunId: input.targetRunId,
    sourceBranch: input.sourceBranch,
    sourceOid: input.sourceOid,
    remote: input.remote.name,
    remoteDisclosure: remoteDisclosure(input.remote, input.remote.name),
    destinationBranch: input.destinationBranch,
    requestedBaseBranch: input.requestedBaseBranch,
    requestedBaseOid: input.requestedBaseOid ?? null,
    runBaseRef: input.runBaseRef,
    runBaseOid: input.runBaseOid,
    divergenceBaseOid: input.divergenceBaseOid,
    commitCount: input.commits.length,
    commits: input.commits,
    commitsTruncated: false,
    fileCount: input.files.length,
    files: input.files,
    filesTruncated: false,
    additions: input.additions,
    deletions: input.deletions,
    ahead: input.ahead,
    behind: input.behind,
    ready: true,
    readiness: [],
    inspectedAt: input.inspectedAt,
  };
}

function mapGitHubStatus(result: GitHubStatusResultView): GitPrGitHubStatusView {
  return {
    installed: result.installed,
    version: result.version,
    hostname: result.hostname,
    authenticated: result.authenticated,
    ownerRepository: result.ownerRepository,
    repositoryUrl: result.repositoryUrl,
    defaultBranch: result.defaultBranch,
    sourceOid: result.sourceHead,
    headMatchesSource: result.headMatchesSource,
    checkedAt: result.checkedAt,
    fresh: githubStatusIsFresh(result.checkedAt),
  };
}

function githubStatusIsFresh(checkedAt: string): boolean {
  const checkedAtMs = Date.parse(checkedAt);
  return Number.isFinite(checkedAtMs) && checkedAtMs + GITHUB_STATUS_TTL_MS > Date.now();
}

function mapCiStatus(result: GitHubCiResultView): NonNullable<GitPrNodeController['ciStatus']> {
  return { sourceOid: result.sourceHead, checkedAt: result.checkedAt, runs: result.runs };
}

function inspectionReadiness(
  view: GitRemoteInspectView,
  configuration: GitPrNodeConfiguration,
  remote: GitRemoteDescriptorView | undefined,
): string[] {
  const reasons: string[] = [];
  if (!GitRemoteNameSchema.safeParse(configuration.remote).success) {
    reasons.push('Enter a valid remote name.');
  } else if (remote === undefined) {
    reasons.push(`No remote named ${configuration.remote} exists in this run's project copy.`);
  }
  if (!GitRemoteBranchSchema.safeParse(configuration.destinationBranch).success) {
    reasons.push('Enter a valid destination branch.');
  }
  if (!GitRemoteBranchSchema.safeParse(configuration.baseBranch).success) {
    reasons.push('Enter a valid branch for the pull request to merge into.');
  }
  if (view.dirty) reasons.push("Commit or undo all of the run's changes before publishing.");
  if (view.commitCount === 0) reasons.push('There are no committed changes to publish.');
  if (view.commitsTruncated || view.filesTruncated) {
    reasons.push(
      "This run has too many changes to verify fully, so a publish plan can't be shown.",
    );
  }
  if (view.readiness.staleReason !== null) reasons.push(view.readiness.staleReason);
  const readiness = view.readiness.readiness;
  if (readiness === null) {
    reasons.push("The required checks and a person's approval haven't been completed yet.");
  } else {
    reasons.push(...readiness.evaluation.blockers.map(readinessBlockerLabel));
  }
  return [...new Set(reasons)];
}

function readinessBlockerLabel(blocker: {
  readonly code: string;
  readonly label?: string | undefined;
}): string {
  if (blocker.code === 'human-approval-missing')
    return 'A person still needs to approve these changes.';
  if (blocker.code === 'human-approval-stale')
    return 'The approval is out of date. Ask for approval again.';
  const state = blocker.code.replace('required-check-', '');
  return `${blocker.label ?? 'A required check'} is ${state}.`;
}

function remoteDisclosure(remote: GitRemoteDescriptorView | undefined, name: string): string {
  if (remote === undefined) return `${name} · unavailable`;
  if (remote.kind === 'local-filesystem') return `${remote.name} · Local Git repository`;
  return `${remote.transport}://${remote.endpoint}/${remote.resource}`;
}

function operationFallback(operation: GitPrOperation): string {
  switch (operation) {
    case 'inspect':
      return "Could not check the run's changes. Try again.";
    case 'prepare-push':
      return 'Could not prepare the push. Try again.';
    case 'confirm-push':
      return 'The push did not complete. Try again.';
    case 'github-status':
      return 'The GitHub sign-in and repository check failed. Try again.';
    case 'prepare-pull-request':
      return 'Could not prepare the pull request. Try again.';
    case 'confirm-pull-request':
      return 'The pull request was not created. Try again.';
    case 'ci-status':
      return 'The CI check failed. Try again.';
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() !== '' ? cause.message : fallback;
}
