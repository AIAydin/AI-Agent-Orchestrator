import { useCallback, useEffect, useRef, useState } from 'react';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import { canonicalCanvasFromLegacy } from '../../../../../shared/canvas/adapter.js';
import {
  collaborationMetadataSnapshotFromCanvas,
  serializeCollaborationMetadataSnapshot,
  type CollaborationAwarenessEntry,
  type CollaborationConnection,
  type CollaborationMetadataSnapshot,
  type CollaborationRole,
} from '../../../../../shared/collaboration/index.js';
import { preserveRemoteCollaborationMetadata } from './outgoing-snapshot.js';

const CURSOR_INTERVAL_MS = 50;
const MAX_RENDERED_COLLABORATORS = 64;
const MAX_RENDERED_SELECTIONS = 16;

interface UseCollaborationCanvasOptions {
  readonly enabled: boolean;
  readonly document: CanvasDocument | null;
  readonly selectedNodeId: string | null;
  readonly onSnapshot: (
    snapshot: CollaborationMetadataSnapshot,
    context: { readonly initial: boolean },
  ) => boolean;
  readonly onError: (message: string) => void;
  readonly debounceMs?: number;
  readonly cursorIntervalMs?: number;
}

export interface CollaborationCanvasBinding {
  readonly awareness: readonly CollaborationAwarenessEntry[];
  readonly graphReadOnly: boolean;
  readonly updateCursor: (position: { readonly x: number; readonly y: number }) => void;
  readonly clearCursor: () => void;
}

/** Publishes only the strict privacy projection and applies only authenticated room events. */
export function useCollaborationCanvas({
  enabled,
  document,
  selectedNodeId,
  onSnapshot,
  onError,
  debounceMs = 200,
  cursorIntervalMs = CURSOR_INTERVAL_MS,
}: UseCollaborationCanvasOptions): CollaborationCanvasBinding {
  const [connection, setConnection] = useState<CollaborationConnection | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [awareness, setAwareness] = useState<readonly CollaborationAwarenessEntry[]>([]);
  const [graphAuthorityRole, setGraphAuthorityRole] = useState<CollaborationRole | null>(null);
  const connectionRef = useRef<CollaborationConnection | null>(null);
  const sessionReadyRef = useRef(false);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const documentRef = useRef(document);
  const cursorRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const cursorTimerRef = useRef<number | null>(null);
  const initialSnapshotRef = useRef(true);
  const lastPublishedSnapshotRef = useRef<string | null>(null);
  const lastAppliedSnapshotRef = useRef<string | null>(null);
  const lastRemoteSnapshotRef = useRef<CollaborationMetadataSnapshot | null>(null);
  const pendingRemoteSnapshotRef = useRef<CollaborationMetadataSnapshot | null>(null);
  const sessionConnectionIdRef = useRef<string | null>(null);
  const reconnectingActivationRef = useRef(false);
  const lastSuccessfulPublishRef = useRef<string | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  const onSnapshotRef = useRef(onSnapshot);
  onErrorRef.current = onError;
  onSnapshotRef.current = onSnapshot;
  selectedNodeIdRef.current = selectedNodeId;
  documentRef.current = document;

  const tryApplySnapshot = useCallback((snapshot: CollaborationMetadataSnapshot): boolean => {
    const fingerprint = serializeCollaborationMetadataSnapshot(snapshot);
    const previousRemote = lastRemoteSnapshotRef.current;
    if (fingerprint === lastPublishedSnapshotRef.current) {
      lastRemoteSnapshotRef.current = snapshot;
      lastAppliedSnapshotRef.current = fingerprint;
      lastSuccessfulPublishRef.current = fingerprint;
      lastPublishedSnapshotRef.current = null;
      initialSnapshotRef.current = false;
      pendingRemoteSnapshotRef.current = null;
      reconnectingActivationRef.current = false;
      return true;
    }
    if (
      reconnectingActivationRef.current &&
      previousRemote !== null &&
      fingerprint !== serializeCollaborationMetadataSnapshot(previousRemote)
    ) {
      pendingRemoteSnapshotRef.current = snapshot;
      sessionReadyRef.current = false;
      reportOnce(
        lastErrorRef,
        onErrorRef.current,
        'Collaboration paused because the room changed while disconnected and has no delivery acknowledgement to resolve it safely.',
      );
      return false;
    }
    if (
      previousRemote !== null &&
      fingerprint !== serializeCollaborationMetadataSnapshot(previousRemote)
    ) {
      const baselineFingerprint =
        lastSuccessfulPublishRef.current ?? serializeCollaborationMetadataSnapshot(previousRemote);
      const currentFingerprint = collaborationDocumentFingerprint(
        documentRef.current,
        previousRemote,
      );
      if (currentFingerprint !== null && currentFingerprint !== baselineFingerprint) {
        pendingRemoteSnapshotRef.current = snapshot;
        sessionReadyRef.current = false;
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Collaboration paused because local and room metadata both changed since the last synchronized state.',
        );
        return false;
      }
    }
    lastRemoteSnapshotRef.current = snapshot;
    if (fingerprint === lastAppliedSnapshotRef.current) {
      if (
        reconnectingActivationRef.current &&
        !collaborationRoleCanEditGraph(connectionRef.current?.role) &&
        !onSnapshotRef.current(snapshot, { initial: false })
      ) {
        pendingRemoteSnapshotRef.current = snapshot;
        return false;
      }
      lastAppliedSnapshotRef.current = fingerprint;
      lastSuccessfulPublishRef.current = fingerprint;
      initialSnapshotRef.current = false;
      pendingRemoteSnapshotRef.current = null;
      reconnectingActivationRef.current = false;
      return true;
    }
    if (
      !onSnapshotRef.current(snapshot, {
        initial:
          initialSnapshotRef.current && collaborationRoleCanEditGraph(connectionRef.current?.role),
      })
    ) {
      pendingRemoteSnapshotRef.current = snapshot;
      return false;
    }
    lastAppliedSnapshotRef.current = fingerprint;
    lastSuccessfulPublishRef.current = fingerprint;
    initialSnapshotRef.current = false;
    pendingRemoteSnapshotRef.current = null;
    reconnectingActivationRef.current = false;
    return true;
  }, []);

  const publishAwareness = useCallback(() => {
    const collaboration = window.forgeboard.collaboration;
    if (!enabled || !sessionReadyRef.current || collaboration === undefined) return;
    const selected = selectedNodeIdRef.current;
    void collaboration
      .updateAwareness({
        awareness: {
          ...(cursorRef.current === null ? {} : { cursor: cursorRef.current }),
          selection: { nodeIds: selected === null ? [] : [selected] },
          activity:
            selected === null ? { status: 'idle' } : { nodeId: selected, status: 'editing' },
        },
      })
      .then((result) => {
        if (result.ok && result.value) lastErrorRef.current = null;
        else if (!result.ok) reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
      })
      .catch(() =>
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Forgeboard could not update collaboration presence.',
        ),
      );
  }, [enabled]);

  const updateCursor = useCallback(
    (position: { readonly x: number; readonly y: number }) => {
      cursorRef.current = position;
      if (!enabled || !sessionReadyRef.current || cursorTimerRef.current !== null) return;
      cursorTimerRef.current = window.setTimeout(() => {
        cursorTimerRef.current = null;
        publishAwareness();
      }, cursorIntervalMs);
    },
    [cursorIntervalMs, enabled, publishAwareness],
  );

  const clearCursor = useCallback(() => {
    cursorRef.current = null;
    if (cursorTimerRef.current !== null) {
      window.clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
    publishAwareness();
  }, [publishAwareness]);

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (!enabled || collaboration === undefined) {
      sessionConnectionIdRef.current = null;
      setGraphAuthorityRole(null);
      deactivateSession(
        connectionRef,
        sessionReadyRef,
        cursorTimerRef,
        cursorRef,
        initialSnapshotRef,
        setConnection,
        setSessionReady,
        setAwareness,
      );
      return;
    }
    let mounted = true;
    let statusEventObserved = false;
    let activationGeneration = 0;

    const activate = async (next: CollaborationConnection): Promise<void> => {
      const generation = ++activationGeneration;
      const reconnecting = sessionConnectionIdRef.current === next.connectionId;
      sessionConnectionIdRef.current = next.connectionId;
      reconnectingActivationRef.current = reconnecting;
      connectionRef.current = next;
      setGraphAuthorityRole(next.role ?? 'viewer');
      sessionReadyRef.current = false;
      initialSnapshotRef.current = !reconnecting;
      if (!reconnecting) {
        lastAppliedSnapshotRef.current = null;
        lastPublishedSnapshotRef.current = null;
        lastRemoteSnapshotRef.current = null;
        lastSuccessfulPublishRef.current = null;
      }
      pendingRemoteSnapshotRef.current = null;
      setConnection(next);
      setSessionReady(false);
      setAwareness([]);
      try {
        const result = await collaboration.snapshot();
        if (
          !mounted ||
          generation !== activationGeneration ||
          connectionRef.current?.connectionId !== next.connectionId
        ) {
          return;
        }
        if (!result.ok) {
          reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
          return;
        }
        const missingReconnectBaseline =
          result.value === null &&
          reconnectingActivationRef.current &&
          lastRemoteSnapshotRef.current !== null;
        if (missingReconnectBaseline) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Collaboration paused because the reconnected room has no valid canvas snapshot.',
          );
        }
        const ready =
          !missingReconnectBaseline && (result.value === null || tryApplySnapshot(result.value));
        sessionReadyRef.current = ready;
        setSessionReady(ready);
      } catch {
        if (mounted && generation === activationGeneration) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Forgeboard could not read the authenticated collaboration snapshot.',
          );
        }
      }
    };

    const unsubscribe = collaboration.onEvent((event) => {
      if (!mounted) return;
      if (event.type === 'status-changed') {
        statusEventObserved = true;
        if (event.connection.status === 'connected') {
          void activate(event.connection);
        } else {
          const sameJoinedSession = sessionConnectionIdRef.current === event.connectionId;
          activationGeneration += 1;
          deactivateSession(
            connectionRef,
            sessionReadyRef,
            cursorTimerRef,
            cursorRef,
            initialSnapshotRef,
            setConnection,
            setSessionReady,
            setAwareness,
          );
          if (!sameJoinedSession) {
            setGraphAuthorityRole(null);
          } else if (
            event.connection.status === 'offline' ||
            event.connection.status === 'disconnecting' ||
            event.connection.status === 'error'
          ) {
            const suspendedGeneration = activationGeneration;
            void collaboration
              .get()
              .then((result) => {
                if (
                  !mounted ||
                  suspendedGeneration !== activationGeneration ||
                  !result.ok ||
                  (result.value !== null && result.value.connectionId === event.connectionId)
                ) {
                  return;
                }
                sessionConnectionIdRef.current = null;
                setGraphAuthorityRole(null);
              })
              .catch(() => {
                // Retain the last authenticated read-only role when leave state cannot be proven.
              });
          }
        }
        return;
      }
      const active = connectionRef.current;
      if (active === null || active.connectionId !== event.connectionId) return;
      if (event.type === 'metadata-snapshot') {
        const ready = tryApplySnapshot(event.snapshot);
        sessionReadyRef.current = ready;
        setSessionReady(ready);
        return;
      }
      if (event.type === 'awareness-changed') {
        setAwareness(renderableAwareness(event.states, active.subject));
      }
    });

    void collaboration
      .get()
      .then((result) => {
        if (!mounted || statusEventObserved) return;
        if (result.ok && result.value?.status === 'connected') {
          void activate(result.value);
        } else if (!result.ok) {
          reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
        }
      })
      .catch(() => {
        if (mounted && !statusEventObserved) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Forgeboard could not read collaboration status.',
          );
        }
      });

    return () => {
      mounted = false;
      activationGeneration += 1;
      unsubscribe();
      deactivateSession(
        connectionRef,
        sessionReadyRef,
        cursorTimerRef,
        cursorRef,
        initialSnapshotRef,
        setConnection,
        setSessionReady,
        setAwareness,
      );
    };
  }, [enabled, tryApplySnapshot]);

  useEffect(() => {
    const pending = pendingRemoteSnapshotRef.current;
    if (!enabled || connection === null || document === null || pending === null) return;
    const ready = tryApplySnapshot(pending);
    sessionReadyRef.current = ready;
    setSessionReady(ready);
  }, [connection, document, enabled, tryApplySnapshot]);

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (
      !enabled ||
      connection === null ||
      !collaborationRoleCanEditGraph(connection.role) ||
      !sessionReady ||
      document === null ||
      collaboration === undefined
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        const migrated = canonicalCanvasFromLegacy(document);
        if (!migrated.ok) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Collaboration paused because this canvas cannot be represented by the safe metadata contract.',
          );
          return;
        }
        const snapshot = preserveRemoteCollaborationMetadata(
          collaborationMetadataSnapshotFromCanvas(migrated.canvas),
          lastRemoteSnapshotRef.current,
        );
        const fingerprint = serializeCollaborationMetadataSnapshot(snapshot);
        if (
          fingerprint === lastPublishedSnapshotRef.current ||
          fingerprint === lastSuccessfulPublishRef.current
        ) {
          return;
        }
        lastPublishedSnapshotRef.current = fingerprint;
        void collaboration
          .publish({ snapshot })
          .then((result) => {
            if (result.ok && result.value) {
              lastSuccessfulPublishRef.current = fingerprint;
              if (lastPublishedSnapshotRef.current === fingerprint) {
                lastPublishedSnapshotRef.current = null;
              }
              lastErrorRef.current = null;
            } else {
              if (lastPublishedSnapshotRef.current === fingerprint) {
                lastPublishedSnapshotRef.current = null;
              }
              if (!result.ok) reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
            }
          })
          .catch(() => {
            if (lastPublishedSnapshotRef.current === fingerprint) {
              lastPublishedSnapshotRef.current = null;
            }
            reportOnce(
              lastErrorRef,
              onErrorRef.current,
              'Forgeboard could not publish collaboration metadata.',
            );
          });
      } catch {
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Collaboration paused because the canvas metadata failed privacy validation.',
        );
      }
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [connection, debounceMs, document, enabled, sessionReady]);

  useEffect(() => {
    if (enabled && sessionReady) publishAwareness();
  }, [enabled, publishAwareness, selectedNodeId, sessionReady]);

  return {
    awareness,
    graphReadOnly:
      graphAuthorityRole !== null && !collaborationRoleCanEditGraph(graphAuthorityRole),
    updateCursor,
    clearCursor,
  };
}

function collaborationDocumentFingerprint(
  document: CanvasDocument | null,
  remote: CollaborationMetadataSnapshot | null,
): string | null {
  if (document === null) return null;
  const migrated = canonicalCanvasFromLegacy(document);
  if (!migrated.ok) return null;
  try {
    return serializeCollaborationMetadataSnapshot(
      preserveRemoteCollaborationMetadata(
        collaborationMetadataSnapshotFromCanvas(migrated.canvas),
        remote,
      ),
    );
  } catch {
    return null;
  }
}

function collaborationRoleCanEditGraph(role: CollaborationRole | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

function renderableAwareness(
  entries: readonly CollaborationAwarenessEntry[],
  localSubject: string,
): CollaborationAwarenessEntry[] {
  return entries
    .filter((entry) => entry.state.user.id !== localSubject)
    .slice(0, MAX_RENDERED_COLLABORATORS)
    .map((entry) => ({
      ...entry,
      state: {
        ...entry.state,
        ...(entry.state.selection === undefined
          ? {}
          : {
              selection: {
                nodeIds: entry.state.selection.nodeIds.slice(0, MAX_RENDERED_SELECTIONS),
              },
            }),
      },
    }));
}

function deactivateSession(
  connection: { current: CollaborationConnection | null },
  ready: { current: boolean },
  cursorTimer: { current: number | null },
  cursor: { current: { readonly x: number; readonly y: number } | null },
  initialSnapshot: { current: boolean },
  setConnection: (value: CollaborationConnection | null) => void,
  setReady: (value: boolean) => void,
  setAwareness: (value: readonly CollaborationAwarenessEntry[]) => void,
): void {
  connection.current = null;
  ready.current = false;
  cursor.current = null;
  initialSnapshot.current = true;
  if (cursorTimer.current !== null) window.clearTimeout(cursorTimer.current);
  cursorTimer.current = null;
  setConnection(null);
  setReady(false);
  setAwareness([]);
}

function reportOnce(
  lastError: { current: string | null },
  report: (message: string) => void,
  message: string,
): void {
  if (lastError.current === message) return;
  lastError.current = message;
  report(message);
}
