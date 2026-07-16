import { useCallback, useEffect, useRef, useState } from 'react';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import { canonicalCanvasFromLegacy } from '../../../../../shared/canvas/adapter.js';
import {
  collaborationMetadataSnapshotFromCanvas,
  serializeCollaborationMetadataSnapshot,
  type CollaborationAwarenessEntry,
  type CollaborationConnection,
  type CollaborationEvent,
  type CollaborationMetadataSnapshot,
  type CollaborationRole,
} from '../../../../../shared/collaboration/index.js';
import { preserveRemoteCollaborationMetadata } from './outgoing-snapshot.js';

const CURSOR_INTERVAL_MS = 50;
const MAX_RENDERED_COLLABORATORS = 64;
const MAX_RENDERED_SELECTIONS = 16;
const MAX_PENDING_DELIVERY_RECEIPTS = 256;

type CollaborationDeliveryEvent = Extract<
  CollaborationEvent,
  { type: 'delivery-acknowledged' | 'delivery-rejected' }
>;

interface PendingDeliveryFingerprint {
  readonly fingerprint: string;
}

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
  const lastSynchronizedSnapshotRef = useRef<string | null>(null);
  const lastSynchronizedMetadataRef = useRef<CollaborationMetadataSnapshot | null>(null);
  const reconnectDeliveryRejectedRef = useRef(false);
  const pendingDeliveryFingerprintsRef = useRef(new Map<string, PendingDeliveryFingerprint>());
  const earlyDeliveryEventsRef = useRef(new Map<string, CollaborationDeliveryEvent>());
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
    if (previousRemote !== null) {
      const remoteChanged = fingerprint !== serializeCollaborationMetadataSnapshot(previousRemote);
      const baseline = lastSynchronizedMetadataRef.current ?? previousRemote;
      const baselineFingerprint = serializeCollaborationMetadataSnapshot(baseline);
      const currentSnapshot = collaborationDocumentSnapshot(documentRef.current, previousRemote);
      const currentFingerprint =
        currentSnapshot === null ? null : serializeCollaborationMetadataSnapshot(currentSnapshot);
      const localIntentSurvived =
        currentSnapshot !== null && localChangesSurvive(baseline, currentSnapshot, snapshot);
      if (
        collaborationRoleCanEditGraph(connectionRef.current?.role) &&
        currentFingerprint !== null &&
        currentFingerprint !== baselineFingerprint &&
        (remoteChanged || reconnectingActivationRef.current) &&
        (!localIntentSurvived || reconnectDeliveryRejectedRef.current)
      ) {
        pendingRemoteSnapshotRef.current = snapshot;
        sessionReadyRef.current = false;
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          reconnectingActivationRef.current
            ? reconnectDeliveryRejectedRef.current
              ? 'Collaboration paused because offline metadata was not durably acknowledged after reconnect.'
              : 'Collaboration paused because an offline edit conflicted with room changes during reconnect.'
            : 'Collaboration paused because local and room metadata both changed since the last synchronized state.',
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
      lastSynchronizedSnapshotRef.current = fingerprint;
      lastSynchronizedMetadataRef.current = snapshot;
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
    lastSynchronizedSnapshotRef.current = fingerprint;
    lastSynchronizedMetadataRef.current = snapshot;
    initialSnapshotRef.current = false;
    pendingRemoteSnapshotRef.current = null;
    reconnectingActivationRef.current = false;
    return true;
  }, []);

  const settleDeliveryEvent = useCallback(
    (event: CollaborationDeliveryEvent): void => {
      const response =
        event.type === 'delivery-acknowledged' ? event.acknowledgement : event.rejection;
      const pending = pendingDeliveryFingerprintsRef.current.get(response.deliveryId);
      if (pending === undefined) {
        if (earlyDeliveryEventsRef.current.size >= MAX_PENDING_DELIVERY_RECEIPTS) {
          const oldest = earlyDeliveryEventsRef.current.keys().next().value;
          if (oldest !== undefined) earlyDeliveryEventsRef.current.delete(oldest);
        }
        earlyDeliveryEventsRef.current.set(response.deliveryId, event);
        return;
      }
      pendingDeliveryFingerprintsRef.current.delete(response.deliveryId);
      if (
        lastPublishedSnapshotRef.current === pending.fingerprint &&
        !hasPendingFingerprint(pendingDeliveryFingerprintsRef.current, pending.fingerprint)
      ) {
        lastPublishedSnapshotRef.current = null;
      }
      if (event.type === 'delivery-acknowledged') {
        lastErrorRef.current = null;
        const pendingRemote = pendingRemoteSnapshotRef.current;
        if (connectionRef.current !== null && pendingRemote !== null) {
          const ready = tryApplySnapshot(pendingRemote);
          sessionReadyRef.current = ready;
          setSessionReady(ready);
        }
        return;
      }
      if (event.duringReconnect) reconnectDeliveryRejectedRef.current = true;
      reportOnce(
        lastErrorRef,
        onErrorRef.current,
        deliveryRejectionMessage(event.rejection.reason, event.duringReconnect),
      );
    },
    [tryApplySnapshot],
  );

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
      lastPublishedSnapshotRef.current = null;
      lastSynchronizedMetadataRef.current = null;
      reconnectDeliveryRejectedRef.current = false;
      pendingDeliveryFingerprintsRef.current.clear();
      earlyDeliveryEventsRef.current.clear();
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
        lastSynchronizedSnapshotRef.current = null;
        lastSynchronizedMetadataRef.current = null;
        reconnectDeliveryRejectedRef.current = false;
        pendingDeliveryFingerprintsRef.current.clear();
        earlyDeliveryEventsRef.current.clear();
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
          if (sameJoinedSession && event.connection.status === 'reconnecting') {
            reconnectDeliveryRejectedRef.current = false;
          }
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
          if (sameJoinedSession && event.connection.status === 'reconnecting') {
            setConnection(event.connection);
          }
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
      if (
        (event.type === 'delivery-acknowledged' || event.type === 'delivery-rejected') &&
        sessionConnectionIdRef.current === event.connectionId
      ) {
        settleDeliveryEvent(event);
        return;
      }
      const active = connectionRef.current;
      if (active === null || active.connectionId !== event.connectionId) return;
      if (event.type === 'metadata-snapshot') {
        if (event.source === 'local') return;
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
  }, [enabled, settleDeliveryEvent, tryApplySnapshot]);

  useEffect(() => {
    const pending = pendingRemoteSnapshotRef.current;
    if (!enabled || connection === null || document === null || pending === null) return;
    const ready = tryApplySnapshot(pending);
    sessionReadyRef.current = ready;
    setSessionReady(ready);
  }, [connection, document, enabled, tryApplySnapshot]);

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    const canPublishOnline = connection?.status === 'connected' && sessionReady;
    const canQueueOffline =
      connection?.status === 'reconnecting' &&
      sessionConnectionIdRef.current === connection.connectionId;
    if (
      !enabled ||
      connection === null ||
      !collaborationRoleCanEditGraph(connection.role ?? graphAuthorityRole ?? undefined) ||
      (!canPublishOnline && !canQueueOffline) ||
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
          fingerprint === lastSynchronizedSnapshotRef.current ||
          hasPendingFingerprint(pendingDeliveryFingerprintsRef.current, fingerprint)
        ) {
          return;
        }
        if (pendingDeliveryFingerprintsRef.current.size >= MAX_PENDING_DELIVERY_RECEIPTS) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Collaboration is waiting for too many delivery confirmations; reconnect before making more shared edits.',
          );
          return;
        }
        lastPublishedSnapshotRef.current = fingerprint;
        void collaboration
          .publish({ snapshot })
          .then((result) => {
            if (result.ok && result.value) {
              pendingDeliveryFingerprintsRef.current.set(result.value.deliveryId, {
                fingerprint,
              });
              const early = earlyDeliveryEventsRef.current.get(result.value.deliveryId);
              if (early !== undefined) {
                earlyDeliveryEventsRef.current.delete(result.value.deliveryId);
                settleDeliveryEvent(early);
              }
              lastErrorRef.current = null;
            } else {
              if (lastPublishedSnapshotRef.current === fingerprint) {
                lastPublishedSnapshotRef.current = null;
              }
              reportOnce(
                lastErrorRef,
                onErrorRef.current,
                result.ok
                  ? 'Forgeboard could not queue collaboration metadata for delivery.'
                  : result.error.message,
              );
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
  }, [
    connection,
    debounceMs,
    document,
    enabled,
    graphAuthorityRole,
    sessionReady,
    settleDeliveryEvent,
  ]);

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

function collaborationDocumentSnapshot(
  document: CanvasDocument | null,
  remote: CollaborationMetadataSnapshot | null,
): CollaborationMetadataSnapshot | null {
  if (document === null) return null;
  const migrated = canonicalCanvasFromLegacy(document);
  if (!migrated.ok) return null;
  try {
    return preserveRemoteCollaborationMetadata(
      collaborationMetadataSnapshotFromCanvas(migrated.canvas),
      remote,
    );
  } catch {
    return null;
  }
}

/** Accepts remote-only changes but requires every local change since the baseline to survive. */
function localChangesSurvive(baseline: unknown, local: unknown, merged: unknown): boolean {
  if (jsonValuesEqual(baseline, local)) return true;
  if (Array.isArray(baseline) || Array.isArray(local) || Array.isArray(merged)) {
    return jsonValuesEqual(local, merged);
  }
  if (isJsonRecord(baseline) && isJsonRecord(local) && isJsonRecord(merged)) {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(local)]);
    for (const key of keys) {
      const baselineHas = Object.hasOwn(baseline, key);
      const localHas = Object.hasOwn(local, key);
      const mergedHas = Object.hasOwn(merged, key);
      if (baselineHas === localHas && jsonValuesEqual(baseline[key], local[key])) continue;
      if (!localHas) {
        if (mergedHas) return false;
        continue;
      }
      if (!mergedHas) return false;
      if (!baselineHas) {
        if (!jsonValuesEqual(local[key], merged[key])) return false;
        continue;
      }
      if (!localChangesSurvive(baseline[key], local[key], merged[key])) return false;
    }
    return true;
  }
  return jsonValuesEqual(local, merged);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (isJsonRecord(left) && isJsonRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
    );
  }
  return false;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collaborationRoleCanEditGraph(role: CollaborationRole | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

function hasPendingFingerprint(
  pending: ReadonlyMap<string, PendingDeliveryFingerprint>,
  fingerprint: string,
): boolean {
  for (const value of pending.values()) {
    if (value.fingerprint === fingerprint) return true;
  }
  return false;
}

function deliveryRejectionMessage(
  reason: 'invalid-request' | 'not-authorized' | 'state-not-applied' | 'document-too-large',
  duringReconnect: boolean,
): string {
  if (reason === 'not-authorized') {
    return "The collaboration server rejected this role's metadata delivery.";
  }
  if (reason === 'document-too-large') {
    return 'The collaboration server rejected metadata that exceeds the room size limit.';
  }
  if (duringReconnect) {
    return 'Collaboration paused because offline metadata was not durably acknowledged after reconnect.';
  }
  return 'The collaboration server did not durably acknowledge the latest metadata update.';
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
