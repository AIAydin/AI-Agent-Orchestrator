import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  TERMINAL_MAX_REPLAY_BYTES,
  TERMINAL_MAX_REPLAY_CHUNKS,
  TerminalPrepareLaunchInputSchema,
  type TerminalEvent,
  type TerminalDimensions,
  type TerminalLaunchPlanView,
  type TerminalOutputChunk,
  type TerminalSessionStatus,
  type TerminalSessionView,
} from '../../../../../shared/terminal/index.js';
import { unwrap } from '../../../lib/ipc.js';
import type {
  TerminalBusyOperation,
  TerminalNodeConfiguration,
  TerminalOperations,
} from './types.js';

const DEFAULT_DIMENSIONS: TerminalDimensions = { columns: 80, rows: 24 };

interface UseTerminalNodeControllerOptions {
  readonly projectId: string;
  readonly nodeId: string;
  readonly configuration: TerminalNodeConfiguration;
  readonly onError: (message: string) => void;
  readonly onSessionChange?: ((session: TerminalSessionView | null) => void) | undefined;
  readonly operations: TerminalOperations;
}

export interface TerminalNodeController {
  readonly session: TerminalSessionView | null;
  readonly sessions: readonly TerminalSessionView[];
  readonly output: readonly TerminalOutputChunk[];
  readonly pendingPlan: TerminalLaunchPlanView | null;
  readonly busy: TerminalBusyOperation | null;
  readonly error: string | null;
  readonly notice: string | null;
  readonly active: boolean;
  readonly replayWindowLimited: boolean;
  chooseExecutable(): Promise<string | null>;
  prepareLaunch(): Promise<void>;
  confirmLaunch(): Promise<void>;
  cancelLaunch(): Promise<void>;
  refresh(): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  sendInput(data: string): void;
  resize(columns: number, rows: number): void;
  interrupt(): Promise<void>;
  terminate(): Promise<void>;
}

export function useTerminalNodeController({
  projectId,
  nodeId,
  configuration,
  onError,
  onSessionChange,
  operations,
}: UseTerminalNodeControllerOptions): TerminalNodeController {
  const [session, setSessionState] = useState<TerminalSessionView | null>(null);
  const [sessions, setSessions] = useState<readonly TerminalSessionView[]>([]);
  const [output, setOutputState] = useState<readonly TerminalOutputChunk[]>([]);
  const [pendingPlan, setPendingPlanState] = useState<TerminalLaunchPlanView | null>(null);
  const [busy, setBusy] = useState<TerminalBusyOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replayWindowLimited, setReplayWindowLimited] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const sessionRef = useRef<TerminalSessionView | null>(null);
  const outputRef = useRef<readonly TerminalOutputChunk[]>([]);
  const planIdRef = useRef<string | null>(null);
  const dimensionsRef = useRef<TerminalDimensions>(DEFAULT_DIMENSIONS);
  const resizeTimerRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<TerminalDimensions>(DEFAULT_DIMENSIONS);
  const inputQueueRef = useRef(Promise.resolve());
  const eventBacklogRef = useRef(new Map<string, readonly TerminalOutputChunk[]>());
  const onErrorRef = useRef(onError);
  const onSessionChangeRef = useRef(onSessionChange);
  onErrorRef.current = onError;
  onSessionChangeRef.current = onSessionChange;

  const clearBusy = useCallback((expected: TerminalBusyOperation): void => {
    if (!mountedRef.current) return;
    setBusy((current) => (current === expected ? null : current));
  }, []);

  const configurationKey = useMemo(
    () =>
      JSON.stringify([
        projectId,
        nodeId,
        configuration.executable,
        configuration.arguments,
        configuration.cwdRelative,
        configuration.environmentVariableNames,
      ]),
    [configuration, nodeId, projectId],
  );

  const reportError = useCallback((cause: unknown, fallback: string): void => {
    const message = cause instanceof Error ? cause.message : fallback;
    if (!mountedRef.current) return;
    setError(message);
    onErrorRef.current(message);
  }, []);

  const setSession = useCallback((next: TerminalSessionView | null): void => {
    sessionRef.current = next;
    if (mountedRef.current) setSessionState(next);
  }, []);

  const setOutput = useCallback((next: readonly TerminalOutputChunk[]): void => {
    const bounded = boundOutput(next);
    outputRef.current = bounded;
    if (mountedRef.current) setOutputState(bounded);
  }, []);

  const mergeSession = useCallback(
    (next: TerminalSessionView): TerminalSessionView => {
      const selected = sessionRef.current;
      const accepted = selected?.id === next.id ? preferSession(selected, next) : next;
      if (mountedRef.current) {
        setSessions((current) => {
          const existing = current.find((item) => item.id === next.id);
          const retained = existing === undefined ? accepted : preferSession(existing, accepted);
          return sortedSessions([retained, ...current.filter((item) => item.id !== next.id)]);
        });
      }
      if (selected?.id === next.id) setSession(accepted);
      return accepted;
    },
    [setSession],
  );

  const loadReplay = useCallback(
    async (target: TerminalSessionView, generation = generationRef.current): Promise<void> => {
      const afterSequence = Math.max(0, target.nextSequence - TERMINAL_MAX_REPLAY_CHUNKS - 1);
      const replay = unwrap(
        await operations.replay({
          sessionId: target.id,
          afterSequence,
          limit: TERMINAL_MAX_REPLAY_CHUNKS,
        }),
      );
      if (replay === null) {
        if (sessionRef.current?.id === target.id) {
          setSession(null);
          setOutput([]);
          setReplayWindowLimited(false);
          if (mountedRef.current) {
            setSessions((current) => current.filter((candidate) => candidate.id !== target.id));
          }
        }
        throw new Error('This terminal session is no longer saved on this computer.');
      }
      if (
        !mountedRef.current ||
        generation !== generationRef.current ||
        sessionRef.current?.id !== target.id
      ) {
        return;
      }
      const backlog = eventBacklogRef.current.get(target.id) ?? [];
      eventBacklogRef.current.delete(target.id);
      const acceptedSession = mergeSession(replay.session);
      setSession(acceptedSession);
      setOutput(mergeOutput(replay.chunks, outputRef.current, backlog));
      setReplayWindowLimited(
        replay.hasMore ||
          replay.session.outputTruncated ||
          replay.session.earliestSequence > 1 ||
          afterSequence >= replay.session.earliestSequence,
      );
    },
    [mergeSession, operations, setOutput, setSession],
  );

  const chooseAndLoadSession = useCallback(
    async (target: TerminalSessionView, generation = generationRef.current): Promise<void> => {
      setSession(target);
      setOutput([]);
      setReplayWindowLimited(false);
      await loadReplay(target, generation);
    },
    [loadReplay, setOutput, setSession],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    if (mountedRef.current) {
      setBusy('loading');
      setError(null);
    }
    try {
      const listed = mergeListedSessions(
        unwrap(await operations.listSessions({ projectId, nodeId })),
        sessionRef.current,
      );
      if (!mountedRef.current || generation !== generationRef.current) return;
      setSessions(listed);
      const active = listed.find((candidate) => isActiveStatus(candidate.status));
      const existing = listed.find((candidate) => candidate.id === sessionRef.current?.id);
      const selected = active ?? existing ?? listed[0] ?? null;
      if (selected === null) {
        setSession(null);
        setOutput([]);
        setReplayWindowLimited(false);
      } else {
        await chooseAndLoadSession(selected, generation);
      }
    } catch (cause) {
      if (generation === generationRef.current) {
        reportError(cause, 'Could not load the terminal sessions.');
      }
    } finally {
      if (generation === generationRef.current) clearBusy('loading');
    }
  }, [
    chooseAndLoadSession,
    nodeId,
    operations,
    projectId,
    reportError,
    setOutput,
    setSession,
    clearBusy,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const removeListener = operations.onEvent((event) => {
      if (event.projectId !== projectId || event.nodeId !== nodeId) return;
      applyTerminalEvent({
        event,
        selectedSessionId: sessionRef.current?.id ?? null,
        eventBacklog: eventBacklogRef.current,
        onOutput: (chunks) => setOutput(mergeOutput(outputRef.current, chunks)),
        onSession: (next) => {
          const previousSessionId = sessionRef.current?.id ?? null;
          const acceptedSession = mergeSession(next);
          if (sessionRef.current === null || isActiveStatus(acceptedSession.status)) {
            setSession(acceptedSession);
            const backlog = eventBacklogRef.current.get(acceptedSession.id);
            if (previousSessionId !== acceptedSession.id) {
              eventBacklogRef.current.delete(acceptedSession.id);
              setOutput(backlog ?? []);
            } else if (backlog !== undefined) {
              eventBacklogRef.current.delete(acceptedSession.id);
              setOutput(mergeOutput(outputRef.current, backlog));
            }
          }
        },
      });
    });
    void refresh();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      removeListener();
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      const planId = planIdRef.current;
      planIdRef.current = null;
      if (planId !== null) void operations.cancelLaunch({ planId }).catch(() => undefined);
    };
  }, [mergeSession, nodeId, operations, projectId, refresh, setOutput, setSession]);

  useEffect(() => {
    onSessionChangeRef.current?.(session);
  }, [session]);

  useEffect(() => {
    const planId = planIdRef.current;
    if (planId === null) return;
    generationRef.current += 1;
    planIdRef.current = null;
    setPendingPlanState(null);
    void operations.cancelLaunch({ planId }).catch(() => undefined);
  }, [configurationKey, operations]);

  const chooseExecutable = useCallback(async (): Promise<string | null> => {
    setBusy('choosing-executable');
    setError(null);
    try {
      const selection = unwrap(await operations.chooseExecutable({ projectId, nodeId }));
      return selection?.executable ?? null;
    } catch (cause) {
      reportError(cause, 'Could not choose a program.');
      return null;
    } finally {
      clearBusy('choosing-executable');
    }
  }, [clearBusy, nodeId, operations, projectId, reportError]);

  const prepareLaunch = useCallback(async (): Promise<void> => {
    if (sessions.some((candidate) => isActiveStatus(candidate.status))) {
      reportError(new Error('Stop the running terminal session before starting another.'), '');
      return;
    }
    const generation = ++generationRef.current;
    setBusy('preparing');
    setError(null);
    setNotice(null);
    try {
      const input = TerminalPrepareLaunchInputSchema.parse({
        projectId,
        nodeId,
        executable: configuration.executable,
        arguments: configuration.arguments,
        cwdRelative: configuration.cwdRelative,
        environmentVariableNames: configuration.environmentVariableNames,
        ...dimensionsRef.current,
        ...(configuration.peerProvisionId
          ? { peerProvisionId: configuration.peerProvisionId }
          : {}),
      });
      const plan = unwrap(await operations.prepareLaunch(input));
      if (!mountedRef.current || generation !== generationRef.current) {
        void operations.cancelLaunch({ planId: plan.planId }).catch(() => undefined);
        return;
      }
      planIdRef.current = plan.planId;
      setPendingPlanState(plan);
    } catch (cause) {
      reportError(cause, 'Could not prepare the terminal.');
    } finally {
      if (generation === generationRef.current) clearBusy('preparing');
    }
  }, [clearBusy, configuration, nodeId, operations, projectId, reportError, sessions]);

  const cancelLaunch = useCallback(async (): Promise<void> => {
    const planId = planIdRef.current;
    if (planId === null) return;
    planIdRef.current = null;
    setBusy('cancelling-plan');
    try {
      unwrap(await operations.cancelLaunch({ planId }));
      if (mountedRef.current) {
        setPendingPlanState(null);
        setNotice('Cancelled. Nothing was started.');
      }
    } catch (cause) {
      setPendingPlanState(null);
      reportError(cause, 'Could not cancel the launch.');
    } finally {
      clearBusy('cancelling-plan');
    }
  }, [clearBusy, operations, reportError]);

  const confirmLaunch = useCallback(async (): Promise<void> => {
    const planId = planIdRef.current;
    if (planId === null) return;
    planIdRef.current = null;
    setBusy('confirming');
    setError(null);
    try {
      const launched = unwrap(await operations.confirmLaunch({ planId }));
      setPendingPlanState(null);
      if (!mountedRef.current) return;
      if (launched === null) {
        setNotice('Cancelled at the confirmation step. Nothing was started.');
        await refresh();
        return;
      }
      const acceptedSession = mergeSession(launched);
      setSession(acceptedSession);
      const backlog = eventBacklogRef.current.get(launched.id) ?? [];
      eventBacklogRef.current.delete(launched.id);
      setOutput(backlog);
      setNotice('Terminal started after both review steps.');
      await loadReplay(acceptedSession);
    } catch (cause) {
      setPendingPlanState(null);
      reportError(
        cause,
        'Could not confirm whether the terminal started. Refreshing the session list.',
      );
      await refresh();
    } finally {
      clearBusy('confirming');
    }
  }, [
    clearBusy,
    loadReplay,
    mergeSession,
    operations,
    refresh,
    reportError,
    setOutput,
    setSession,
  ]);

  const selectSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const active = sessions.find((candidate) => isActiveStatus(candidate.status));
      const target = sessions.find((candidate) => candidate.id === sessionId);
      if (target === undefined || (active !== undefined && active.id !== target.id)) return;
      const generation = ++generationRef.current;
      setBusy('loading');
      setError(null);
      try {
        const current = unwrap(await operations.getSession({ sessionId }));
        if (current === null) throw new Error('This terminal session is no longer available.');
        if (!mountedRef.current || generation !== generationRef.current) return;
        await chooseAndLoadSession(current, generation);
      } catch (cause) {
        reportError(cause, 'Could not load this terminal session.');
      } finally {
        if (generation === generationRef.current) clearBusy('loading');
      }
    },
    [chooseAndLoadSession, clearBusy, operations, reportError, sessions],
  );

  const sendInput = useCallback(
    (data: string): void => {
      const target = sessionRef.current;
      if (target === null || !isActiveStatus(target.status) || data.length === 0) return;
      inputQueueRef.current = inputQueueRef.current
        .then(async () => {
          const current = sessionRef.current;
          if (current?.id !== target.id || !isActiveStatus(current.status)) return;
          const next = unwrap(await operations.sendInput({ sessionId: target.id, data }));
          mergeSession(next);
        })
        .catch((cause: unknown) => reportError(cause, 'Could not send input to the terminal.'));
    },
    [mergeSession, operations, reportError],
  );

  const resize = useCallback(
    (columns: number, rows: number): void => {
      dimensionsRef.current = { columns, rows };
      pendingResizeRef.current = { columns, rows };
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        resizeTimerRef.current = null;
        const target = sessionRef.current;
        if (target === null || !isActiveStatus(target.status)) return;
        const dimensions = pendingResizeRef.current;
        void operations
          .resize({ sessionId: target.id, ...dimensions })
          .then((result) => mergeSession(unwrap(result)))
          .catch((cause: unknown) => reportError(cause, 'Could not resize the terminal.'));
      }, 80);
    },
    [mergeSession, operations, reportError],
  );

  const interrupt = useCallback(async (): Promise<void> => {
    const target = sessionRef.current;
    if (target === null || !isActiveStatus(target.status)) return;
    setBusy('interrupting');
    try {
      mergeSession(unwrap(await operations.interrupt({ sessionId: target.id })));
    } catch (cause) {
      reportError(cause, 'Could not interrupt the process.');
    } finally {
      clearBusy('interrupting');
    }
  }, [clearBusy, mergeSession, operations, reportError]);

  const terminate = useCallback(async (): Promise<void> => {
    const target = sessionRef.current;
    if (target === null || !isActiveStatus(target.status)) return;
    setBusy('terminating');
    try {
      mergeSession(unwrap(await operations.terminate({ sessionId: target.id })));
    } catch (cause) {
      reportError(cause, 'Could not stop the process.');
    } finally {
      clearBusy('terminating');
    }
  }, [clearBusy, mergeSession, operations, reportError]);

  return {
    session,
    sessions,
    output,
    pendingPlan,
    busy,
    error,
    notice,
    active: session !== null && isActiveStatus(session.status),
    replayWindowLimited,
    chooseExecutable,
    prepareLaunch,
    confirmLaunch,
    cancelLaunch,
    refresh,
    selectSession,
    sendInput,
    resize,
    interrupt,
    terminate,
  };
}

export function isActiveStatus(status: TerminalSessionStatus): boolean {
  return status === 'starting' || status === 'running';
}

function sortedSessions(sessions: readonly TerminalSessionView[]): TerminalSessionView[] {
  const unique = new Map<string, TerminalSessionView>();
  for (const session of sessions) unique.set(session.id, session);
  return [...unique.values()].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

function mergeListedSessions(
  listed: readonly TerminalSessionView[],
  selected: TerminalSessionView | null,
): TerminalSessionView[] {
  if (selected === null) return sortedSessions(listed);
  return sortedSessions(
    listed.map((candidate) =>
      candidate.id === selected.id ? preferSession(candidate, selected) : candidate,
    ),
  );
}

function preferSession(
  current: TerminalSessionView,
  candidate: TerminalSessionView,
): TerminalSessionView {
  if (current.id !== candidate.id) return candidate;
  const currentTerminal = isTerminalStatus(current.status);
  const candidateTerminal = isTerminalStatus(candidate.status);
  if (currentTerminal && !candidateTerminal) return current;
  if (!currentTerminal && candidateTerminal) return candidate;
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const candidateUpdatedAt = Date.parse(candidate.updatedAt);
  if (candidateUpdatedAt < currentUpdatedAt) return current;
  if (candidateUpdatedAt === currentUpdatedAt && candidate.nextSequence < current.nextSequence) {
    return current;
  }
  return candidate;
}

function isTerminalStatus(status: TerminalSessionStatus): boolean {
  return !isActiveStatus(status);
}

function mergeOutput(
  ...groups: readonly (readonly TerminalOutputChunk[])[]
): TerminalOutputChunk[] {
  const bySequence = new Map<number, TerminalOutputChunk>();
  for (const group of groups) {
    for (const chunk of group) bySequence.set(chunk.sequence, chunk);
  }
  return boundOutput(
    [...bySequence.values()].sort((left, right) => left.sequence - right.sequence),
  );
}

function boundOutput(chunks: readonly TerminalOutputChunk[]): TerminalOutputChunk[] {
  const retained = chunks.slice(-TERMINAL_MAX_REPLAY_CHUNKS);
  let bytes = retained.reduce((sum, chunk) => sum + utf8Bytes(chunk.data), 0);
  while (bytes > TERMINAL_MAX_REPLAY_BYTES && retained.length > 1) {
    bytes -= utf8Bytes(retained.shift()?.data ?? '');
  }
  return retained;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function applyTerminalEvent({
  event,
  selectedSessionId,
  eventBacklog,
  onOutput,
  onSession,
}: {
  readonly event: TerminalEvent;
  readonly selectedSessionId: string | null;
  readonly eventBacklog: Map<string, readonly TerminalOutputChunk[]>;
  readonly onOutput: (chunks: readonly TerminalOutputChunk[]) => void;
  readonly onSession: (session: TerminalSessionView) => void;
}): void {
  if (event.kind === 'session') {
    onSession(event.session);
    return;
  }
  if (event.sessionId === selectedSessionId) {
    onOutput([event.chunk]);
    return;
  }
  eventBacklog.set(
    event.sessionId,
    boundOutput([...(eventBacklog.get(event.sessionId) ?? []), event.chunk]),
  );
  if (eventBacklog.size > 4) {
    const oldest = eventBacklog.keys().next().value;
    if (oldest !== undefined) eventBacklog.delete(oldest);
  }
}
