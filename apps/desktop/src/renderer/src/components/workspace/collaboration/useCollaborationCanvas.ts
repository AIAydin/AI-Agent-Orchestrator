import { useCallback, useEffect, useRef, useState } from 'react';

import type { CanvasDocument } from '../../../../../shared/application/contracts.js';
import { canonicalCanvasFromLegacy } from '../../../../../shared/canvas/adapter.js';
import {
  analyzeCollaborationCommentRecovery,
  collaborationRecoveryCanCheckpoint,
  collaborationRecoveryHasNoLocalIntent,
  collaborationMetadataSnapshotFromCanvas,
  CollaborationMetadataSnapshotSchema,
  effectiveCollaborationSyncPending,
  serializeCollaborationMetadataSnapshot,
  type CollaborationAwarenessEntry,
  type CollaborationCommentMetadata,
  type CollaborationConnection,
  type CollaborationEvent,
  type CollaborationMetadataSnapshot,
  type CollaborationRejectedCommentEntry,
  type CollaborationRole,
  type CollaborationSyncRecovery,
} from '../../../../../shared/collaboration/index.js';
import { preserveRemoteCollaborationMetadata } from './outgoing-snapshot.js';
import {
  collaborationIntentSurvives,
  jsonValuesEqual,
  mergeCollaborationIntent,
} from './sync/three-way.js';
import { rejectedCommentsAfterAcknowledgement } from './sync/rejected-comments.js';

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
  readonly snapshotDigest: string;
  readonly candidateComments: Readonly<Record<string, CollaborationCommentMetadata>>;
  readonly comments?: readonly CollaborationCommentMetadata[];
  readonly resolveComment?: (comment: CollaborationCommentMetadata | null) => void;
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
  readonly rejectedComments: readonly CollaborationCommentMetadata[];
  readonly rejectedCommentEntries: readonly CollaborationRejectedCommentEntry[];
  readonly graphReadOnly: boolean;
  readonly role: CollaborationRole | null;
  readonly canComment: boolean;
  readonly createComment: (
    nodeId: string,
    body: string,
  ) => Promise<CollaborationCommentMetadata | null>;
  readonly discardRejectedComment: (entry: CollaborationRejectedCommentEntry) => Promise<boolean>;
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
  const [rejectedComments, setRejectedComments] = useState<readonly CollaborationCommentMetadata[]>(
    [],
  );
  const [rejectedCommentEntries, setRejectedCommentEntries] = useState<
    readonly CollaborationRejectedCommentEntry[]
  >([]);
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
  const pendingDeliveryReservationsRef = useRef(0);
  const earlyDeliveryEventsRef = useRef(new Map<string, CollaborationDeliveryEvent>());
  const pendingCommentOperationsRef = useRef(new Set<() => void>());
  const deliveryLifecycleGenerationRef = useRef(0);
  const heldCommentSnapshotRef = useRef<CollaborationMetadataSnapshot | null>(null);
  const rejectedCommentIdsRef = useRef(new Set<string>());
  const rejectedCommentsRef = useRef(new Map<string, CollaborationCommentMetadata>());
  const rejectedCommentEntriesRef = useRef(new Map<string, CollaborationRejectedCommentEntry>());
  const lastErrorRef = useRef<string | null>(null);
  const durableRecoveryRef = useRef<CollaborationSyncRecovery | null>(null);
  const retainedUnauthorizedRecoveryRef = useRef(false);
  const recoveryLoadedConnectionIdRef = useRef<string | null>(null);
  const recoveryLoadingConnectionIdRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  const onSnapshotRef = useRef(onSnapshot);
  onErrorRef.current = onError;
  onSnapshotRef.current = onSnapshot;
  selectedNodeIdRef.current = selectedNodeId;
  documentRef.current = document;

  const resetDeliveryTracking = useCallback((): void => {
    deliveryLifecycleGenerationRef.current += 1;
    for (const cancel of [...pendingCommentOperationsRef.current]) cancel();
    pendingCommentOperationsRef.current.clear();
    discardPendingDeliveries(pendingDeliveryFingerprintsRef.current);
    pendingDeliveryReservationsRef.current = 0;
    earlyDeliveryEventsRef.current.clear();
    heldCommentSnapshotRef.current = null;
    rejectedCommentIdsRef.current.clear();
    rejectedCommentsRef.current.clear();
    rejectedCommentEntriesRef.current.clear();
    setRejectedComments([]);
    setRejectedCommentEntries([]);
  }, []);

  const checkpointSnapshot = useCallback((snapshot: CollaborationMetadataSnapshot): void => {
    const collaboration = window.forgeboard.collaboration;
    const current = documentRef.current;
    if (
      collaboration === undefined ||
      current === null ||
      retainedUnauthorizedRecoveryRef.current ||
      pendingDeliveryFingerprintsRef.current.size > 0 ||
      pendingDeliveryReservationsRef.current > 0 ||
      rejectedCommentIdsRef.current.size > 0
    ) {
      return;
    }
    lastSynchronizedMetadataRef.current = snapshot;
    lastSynchronizedSnapshotRef.current = serializeCollaborationMetadataSnapshot(snapshot);
    void collaboration
      .checkpoint({
        projectId: current.projectId,
        canvasId: current.id,
        snapshot,
      })
      .then((result) => {
        if (!result.ok) reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
      })
      .catch(() =>
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Forgeboard could not save a recovery copy of the shared canvas.',
        ),
      );
  }, []);

  const checkpointCurrentRoom = useCallback((): void => {
    const collaboration = window.forgeboard.collaboration;
    if (
      collaboration === undefined ||
      connectionRef.current === null ||
      !sessionReadyRef.current ||
      pendingDeliveryFingerprintsRef.current.size > 0 ||
      pendingDeliveryReservationsRef.current > 0 ||
      rejectedCommentIdsRef.current.size > 0 ||
      retainedUnauthorizedRecoveryRef.current
    ) {
      return;
    }
    void collaboration
      .snapshot()
      .then((result) => {
        if (result.ok && result.value !== null) checkpointSnapshot(result.value);
        else if (!result.ok) reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
      })
      .catch(() =>
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Forgeboard could not read the shared canvas to save a recovery copy.',
        ),
      );
  }, [checkpointSnapshot]);

  const tryApplySnapshot = useCallback(
    (snapshot: CollaborationMetadataSnapshot): boolean => {
      const authenticatedRoomSnapshot = snapshot;
      let restoredLocalIntent = false;
      let retainUnauthorizedRecovery = false;
      const recovery = durableRecoveryRef.current;
      if (recovery !== null) {
        const effectivePending = effectiveCollaborationSyncPending(recovery);
        if (collaborationRoleCanEditGraph(connectionRef.current?.role)) {
          const merged = mergeCollaborationIntent(recovery.baseline, effectivePending, snapshot);
          if (!merged.ok) {
            pendingRemoteSnapshotRef.current = snapshot;
            sessionReadyRef.current = false;
            reportOnce(
              lastErrorRef,
              onErrorRef.current,
              'Sharing paused because changes made on this device while Forgeboard was closed clash with changes made by others in the shared canvas.',
            );
            return false;
          }
          snapshot = merged.snapshot;
          restoredLocalIntent = !jsonValuesEqual(snapshot, authenticatedRoomSnapshot);
        } else {
          const subject = connectionRef.current?.subject;
          const commentRecovery =
            subject === undefined
              ? null
              : analyzeCollaborationCommentRecovery(
                  recovery.baseline,
                  effectivePending,
                  snapshot,
                  subject,
                );
          if (
            commentRecovery?.satisfied !== true &&
            !collaborationRecoveryCanCheckpoint(recovery, snapshot) &&
            !collaborationRecoveryHasNoLocalIntent(recovery)
          ) {
            retainUnauthorizedRecovery = true;
            retainedUnauthorizedRecoveryRef.current = true;
            reportOnce(
              lastErrorRef,
              onErrorRef.current,
              commentRecovery !== null && commentRecovery.additions.length > 0
                ? 'Comments and canvas changes made while offline are saved on this device, but your current role cannot share them.'
                : 'Canvas changes made while offline are saved on this device, but your current role cannot share them.',
            );
          }
        }
        durableRecoveryRef.current = null;
        if (!retainUnauthorizedRecovery) retainedUnauthorizedRecoveryRef.current = false;
      }
      const remoteFingerprint = serializeCollaborationMetadataSnapshot(snapshot);
      const previousRemote = lastRemoteSnapshotRef.current;
      if (previousRemote !== null && !restoredLocalIntent) {
        const remoteChanged =
          remoteFingerprint !== serializeCollaborationMetadataSnapshot(previousRemote);
        const baseline = lastSynchronizedMetadataRef.current ?? previousRemote;
        const baselineFingerprint = serializeCollaborationMetadataSnapshot(baseline);
        const currentSnapshot = collaborationDocumentSnapshot(documentRef.current, previousRemote);
        const currentFingerprint =
          currentSnapshot === null ? null : serializeCollaborationMetadataSnapshot(currentSnapshot);
        const localIntentSurvived =
          currentSnapshot !== null &&
          collaborationIntentSurvives(baseline, currentSnapshot, snapshot);
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
                ? 'Sharing paused because the shared canvas did not confirm your offline changes after reconnecting.'
                : 'Sharing paused because an offline change clashed with shared canvas changes while reconnecting.'
              : 'Sharing paused because this device and the shared canvas both changed since they were last in sync.',
          );
          return false;
        }
      }
      lastRemoteSnapshotRef.current = authenticatedRoomSnapshot;
      const pendingCommentIds = pendingCollaborationCommentIds(
        pendingDeliveryFingerprintsRef.current,
      );
      const unidentifiedLocalCommentIds = pendingUnidentifiedLocalCommentIds(
        snapshot,
        lastSynchronizedMetadataRef.current,
        connectionRef.current?.subject,
        pendingCommentOperationsRef.current.size > 0,
      );
      const heldCommentIds = new Set([...pendingCommentIds, ...unidentifiedLocalCommentIds]);
      const excludedCommentIds = new Set([...heldCommentIds, ...rejectedCommentIdsRef.current]);
      if (snapshotContainsAnyComment(snapshot, heldCommentIds)) {
        heldCommentSnapshotRef.current = snapshot;
      } else {
        heldCommentSnapshotRef.current = null;
      }
      if (snapshotContainsAnyComment(snapshot, excludedCommentIds)) {
        snapshot = snapshotWithoutComments(snapshot, excludedCommentIds);
      }
      const fingerprint = serializeCollaborationMetadataSnapshot(snapshot);
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
        if (
          !restoredLocalIntent &&
          pendingDeliveryFingerprintsRef.current.size === 0 &&
          pendingDeliveryReservationsRef.current === 0
        ) {
          lastSynchronizedSnapshotRef.current = fingerprint;
          lastSynchronizedMetadataRef.current = snapshot;
        }
        initialSnapshotRef.current = false;
        pendingRemoteSnapshotRef.current = null;
        reconnectingActivationRef.current = false;
        if (!retainUnauthorizedRecovery && jsonValuesEqual(snapshot, authenticatedRoomSnapshot)) {
          checkpointSnapshot(snapshot);
        }
        return true;
      }
      if (
        !onSnapshotRef.current(snapshot, {
          initial:
            !restoredLocalIntent &&
            initialSnapshotRef.current &&
            collaborationRoleCanEditGraph(connectionRef.current?.role),
        })
      ) {
        pendingRemoteSnapshotRef.current = snapshot;
        return false;
      }
      lastAppliedSnapshotRef.current = fingerprint;
      if (
        !restoredLocalIntent &&
        pendingDeliveryFingerprintsRef.current.size === 0 &&
        pendingDeliveryReservationsRef.current === 0
      ) {
        lastSynchronizedSnapshotRef.current = fingerprint;
        lastSynchronizedMetadataRef.current = snapshot;
      }
      initialSnapshotRef.current = false;
      pendingRemoteSnapshotRef.current = null;
      reconnectingActivationRef.current = false;
      if (!retainUnauthorizedRecovery && jsonValuesEqual(snapshot, authenticatedRoomSnapshot)) {
        checkpointSnapshot(snapshot);
      }
      return true;
    },
    [checkpointSnapshot],
  );

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
        const retained = rejectedCommentsAfterAcknowledgement(
          [...rejectedCommentsRef.current.values()],
          pending.candidateComments,
        );
        const retainedIds = new Set(retained.map((comment) => comment.id));
        for (const commentId of rejectedCommentsRef.current.keys()) {
          if (retainedIds.has(commentId)) continue;
          rejectedCommentIdsRef.current.delete(commentId);
          rejectedCommentsRef.current.delete(commentId);
          rejectedCommentEntriesRef.current.delete(commentId);
        }
        setRejectedComments([...rejectedCommentsRef.current.values()]);
        setRejectedCommentEntries([...rejectedCommentEntriesRef.current.values()]);
        pending.resolveComment?.(pending.comments?.[0] ?? null);
        lastErrorRef.current = null;
        const pendingRemote = pendingRemoteSnapshotRef.current ?? heldCommentSnapshotRef.current;
        if (connectionRef.current !== null && pendingRemote !== null) {
          const ready = tryApplySnapshot(pendingRemote);
          sessionReadyRef.current = ready;
          setSessionReady(ready);
        } else {
          checkpointCurrentRoom();
        }
        return;
      }
      pending.resolveComment?.(null);
      const held = heldCommentSnapshotRef.current;
      const rejectedCommentIds = new Set((pending.comments ?? []).map((comment) => comment.id));
      for (const comment of pending.comments ?? []) {
        rejectedCommentIdsRef.current.add(comment.id);
        rejectedCommentsRef.current.set(comment.id, comment);
        rejectedCommentEntriesRef.current.set(comment.id, {
          comment,
          rejectedDeliveryId: response.deliveryId,
        });
      }
      setRejectedComments([...rejectedCommentsRef.current.values()]);
      setRejectedCommentEntries([...rejectedCommentEntriesRef.current.values()]);
      if (held !== null && rejectedCommentIds.size > 0) {
        heldCommentSnapshotRef.current = null;
        const ready = tryApplySnapshot(held);
        sessionReadyRef.current = ready;
        setSessionReady(ready);
      }
      if (event.duringReconnect) reconnectDeliveryRejectedRef.current = true;
      reportOnce(
        lastErrorRef,
        onErrorRef.current,
        deliveryRejectionMessage(event.rejection.reason, event.duringReconnect),
      );
    },
    [checkpointCurrentRoom, tryApplySnapshot],
  );

  const trackReplayedReceipt = useCallback(
    (recovery: CollaborationSyncRecovery | null): boolean => {
      const subject = connectionRef.current?.subject;
      const effectivePending =
        recovery === null ? null : effectiveCollaborationSyncPending(recovery);
      const comments =
        subject === undefined || recovery === null || effectivePending === null
          ? []
          : analyzeCollaborationCommentRecovery(
              recovery.baseline,
              effectivePending,
              recovery.baseline ?? effectivePending,
              subject,
            ).additions;
      for (const [commentId, authoritative] of Object.entries(recovery?.baseline?.comments ?? {})) {
        const rejected = rejectedCommentsRef.current.get(commentId);
        if (rejected !== undefined && jsonValuesEqual(authoritative, rejected)) {
          rejectedCommentIdsRef.current.delete(commentId);
          rejectedCommentsRef.current.delete(commentId);
          rejectedCommentEntriesRef.current.delete(commentId);
        }
      }
      for (const commentId of recovery?.rejectedCommentIds ?? []) {
        rejectedCommentIdsRef.current.add(commentId);
      }
      for (const comment of recovery?.rejectedComments ?? []) {
        rejectedCommentIdsRef.current.add(comment.id);
        rejectedCommentsRef.current.set(comment.id, comment);
      }
      for (const entry of recovery?.rejectedCommentEntries ?? []) {
        rejectedCommentIdsRef.current.add(entry.comment.id);
        rejectedCommentsRef.current.set(entry.comment.id, entry.comment);
        rejectedCommentEntriesRef.current.set(entry.comment.id, entry);
      }
      setRejectedComments([...rejectedCommentsRef.current.values()]);
      setRejectedCommentEntries([...rejectedCommentEntriesRef.current.values()]);
      const receipt = recovery?.replayedReceipt;
      if (receipt === undefined) return true;
      const existing = pendingDeliveryFingerprintsRef.current.get(receipt.deliveryId);
      if (existing !== undefined && existing.snapshotDigest !== receipt.snapshotDigest) {
        sessionReadyRef.current = false;
        setSessionReady(false);
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Sharing paused because a saved delivery record did not match while restoring offline changes.',
        );
        return false;
      }
      if (existing === undefined) {
        pendingDeliveryFingerprintsRef.current.set(receipt.deliveryId, {
          fingerprint:
            comments.length === 0 && recovery !== null
              ? serializeCollaborationMetadataSnapshot(recovery.pending)
              : receipt.snapshotDigest,
          snapshotDigest: receipt.snapshotDigest,
          candidateComments: recovery?.pending.comments ?? {},
          ...(comments.length === 0 ? {} : { comments }),
        });
      }
      const tracked = pendingDeliveryFingerprintsRef.current.get(receipt.deliveryId);
      if (tracked === undefined) return false;
      if (tracked.comments === undefined && comments.length > 0) {
        pendingDeliveryFingerprintsRef.current.set(receipt.deliveryId, {
          ...tracked,
          comments,
        });
      }
      const early = earlyDeliveryEventsRef.current.get(receipt.deliveryId);
      if (early !== undefined) {
        earlyDeliveryEventsRef.current.delete(receipt.deliveryId);
        settleDeliveryEvent(early);
      }
      return true;
    },
    [settleDeliveryEvent],
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
          'Forgeboard could not show your cursor and selection to others.',
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
      durableRecoveryRef.current = null;
      retainedUnauthorizedRecoveryRef.current = false;
      recoveryLoadedConnectionIdRef.current = null;
      recoveryLoadingConnectionIdRef.current = null;
      reconnectDeliveryRejectedRef.current = false;
      resetDeliveryTracking();
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
        durableRecoveryRef.current = null;
        retainedUnauthorizedRecoveryRef.current = false;
        recoveryLoadedConnectionIdRef.current = null;
        recoveryLoadingConnectionIdRef.current = null;
        reconnectDeliveryRejectedRef.current = false;
        resetDeliveryTracking();
      }
      pendingRemoteSnapshotRef.current = null;
      setConnection(next);
      setSessionReady(false);
      setAwareness([]);
      try {
        const localDocument = documentRef.current;
        if (localDocument !== null) {
          const recovered = await collaboration.recover({
            projectId: localDocument.projectId,
            canvasId: localDocument.id,
          });
          if (
            !mounted ||
            generation !== activationGeneration ||
            connectionRef.current?.connectionId !== next.connectionId
          ) {
            return;
          }
          if (!recovered.ok) {
            reportOnce(lastErrorRef, onErrorRef.current, recovered.error.message);
            return;
          }
          durableRecoveryRef.current = recovered.value;
          if (!trackReplayedReceipt(recovered.value)) return;
          recoveryLoadedConnectionIdRef.current = next.connectionId;
          if (recovered.value !== null) {
            lastSynchronizedMetadataRef.current = recovered.value.baseline;
            lastSynchronizedSnapshotRef.current =
              recovered.value.baseline === null
                ? null
                : serializeCollaborationMetadataSnapshot(recovered.value.baseline);
          }
        }
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
            'Sharing paused because the reconnected shared canvas has no usable saved data.',
          );
        }
        let ready = false;
        if (!missingReconnectBaseline && result.value === null) {
          const recovery = durableRecoveryRef.current;
          if (recovery !== null && collaborationRoleCanEditGraph(next.role)) {
            ready = onSnapshotRef.current(effectiveCollaborationSyncPending(recovery), {
              initial: false,
            });
            if (ready) durableRecoveryRef.current = null;
          } else {
            ready = true;
          }
        } else if (!missingReconnectBaseline && result.value !== null) {
          ready = tryApplySnapshot(result.value);
        }
        sessionReadyRef.current = ready;
        setSessionReady(ready);
      } catch {
        if (mounted && generation === activationGeneration) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Forgeboard could not read the shared canvas data.',
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
          } else {
            resetDeliveryTracking();
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
        if (
          documentRef.current !== null &&
          recoveryLoadedConnectionIdRef.current !== active.connectionId
        ) {
          pendingRemoteSnapshotRef.current = event.snapshot;
          return;
        }
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
            'Forgeboard could not check whether sharing is connected.',
          );
        }
      });

    return () => {
      mounted = false;
      activationGeneration += 1;
      unsubscribe();
      resetDeliveryTracking();
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
  }, [enabled, resetDeliveryTracking, settleDeliveryEvent, trackReplayedReceipt, tryApplySnapshot]);

  useEffect(() => {
    const pending = pendingRemoteSnapshotRef.current;
    if (!enabled || connection === null || document === null || pending === null) return;
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return;
    if (recoveryLoadedConnectionIdRef.current === connection.connectionId) {
      const ready = tryApplySnapshot(pending);
      sessionReadyRef.current = ready;
      setSessionReady(ready);
      return;
    }
    if (recoveryLoadingConnectionIdRef.current === connection.connectionId) return;
    recoveryLoadingConnectionIdRef.current = connection.connectionId;
    let cancelled = false;
    void collaboration
      .recover({ projectId: document.projectId, canvasId: document.id })
      .then(async (result) => {
        if (cancelled || connectionRef.current?.connectionId !== connection.connectionId) return;
        if (!result.ok) {
          reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
          return;
        }
        const synchronized = result.value?.disposition === 'synchronized';
        durableRecoveryRef.current = synchronized ? null : result.value;
        if (synchronized && result.value !== null) {
          retainedUnauthorizedRecoveryRef.current = false;
          const synchronizedSnapshot = result.value.baseline ?? result.value.pending;
          lastSynchronizedMetadataRef.current = synchronizedSnapshot;
          lastSynchronizedSnapshotRef.current =
            serializeCollaborationMetadataSnapshot(synchronizedSnapshot);
        }
        if (!trackReplayedReceipt(result.value)) return;
        recoveryLoadedConnectionIdRef.current = connection.connectionId;
        if (result.value !== null) {
          lastSynchronizedMetadataRef.current = result.value.baseline;
          lastSynchronizedSnapshotRef.current =
            result.value.baseline === null
              ? null
              : serializeCollaborationMetadataSnapshot(result.value.baseline);
        }
        const refreshed = await collaboration.snapshot();
        if (cancelled || connectionRef.current?.connectionId !== connection.connectionId) return;
        if (!refreshed.ok) {
          reportOnce(lastErrorRef, onErrorRef.current, refreshed.error.message);
          return;
        }
        const ready = tryApplySnapshot(refreshed.value ?? pending);
        sessionReadyRef.current = ready;
        setSessionReady(ready);
      })
      .catch(() => {
        if (!cancelled) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Forgeboard could not restore your offline shared changes.',
          );
        }
      })
      .finally(() => {
        if (recoveryLoadingConnectionIdRef.current === connection.connectionId) {
          recoveryLoadingConnectionIdRef.current = null;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection, document, enabled, trackReplayedReceipt, tryApplySnapshot]);

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
            'Sharing paused because this canvas could not be converted into the safe sharing format.',
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
        if (
          pendingDeliveryFingerprintsRef.current.size + pendingDeliveryReservationsRef.current >=
          MAX_PENDING_DELIVERY_RECEIPTS
        ) {
          reportOnce(
            lastErrorRef,
            onErrorRef.current,
            'Too many shared changes are still waiting to be confirmed. Reconnect before making more changes.',
          );
          return;
        }
        lastPublishedSnapshotRef.current = fingerprint;
        const deliveryLifecycleGeneration = deliveryLifecycleGenerationRef.current;
        pendingDeliveryReservationsRef.current += 1;
        let reservationHeld = true;
        const releaseReservation = (): void => {
          if (!reservationHeld) return;
          reservationHeld = false;
          pendingDeliveryReservationsRef.current = Math.max(
            0,
            pendingDeliveryReservationsRef.current - 1,
          );
        };
        void Promise.resolve()
          .then(() =>
            collaboration.publish({
              projectId: document.projectId,
              canvasId: document.id,
              baseline: lastSynchronizedMetadataRef.current,
              snapshot,
            }),
          )
          .then((result) => {
            releaseReservation();
            if (deliveryLifecycleGeneration !== deliveryLifecycleGenerationRef.current) return;
            if (result.ok && result.value) {
              pendingDeliveryFingerprintsRef.current.set(result.value.deliveryId, {
                fingerprint,
                snapshotDigest: result.value.snapshotDigest,
                candidateComments: snapshot.comments,
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
                  ? 'Forgeboard could not send your canvas changes to the shared canvas.'
                  : result.error.message,
              );
            }
          })
          .catch(() => {
            releaseReservation();
            if (deliveryLifecycleGeneration !== deliveryLifecycleGenerationRef.current) return;
            if (lastPublishedSnapshotRef.current === fingerprint) {
              lastPublishedSnapshotRef.current = null;
            }
            reportOnce(
              lastErrorRef,
              onErrorRef.current,
              'Forgeboard could not share your canvas changes.',
            );
          });
      } catch {
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Sharing paused because this canvas could not pass the privacy check.',
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

  const createComment = useCallback(
    (nodeId: string, body: string): Promise<CollaborationCommentMetadata | null> => {
      const collaboration = window.forgeboard.collaboration;
      const current = documentRef.current;
      const active = connectionRef.current;
      if (
        collaboration === undefined ||
        current === null ||
        active === null ||
        !sessionReadyRef.current ||
        !collaborationRoleCanComment(active.role)
      ) {
        return Promise.resolve(null);
      }
      if (
        pendingDeliveryFingerprintsRef.current.size + pendingDeliveryReservationsRef.current >=
        MAX_PENDING_DELIVERY_RECEIPTS
      ) {
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Too many shared changes are still waiting to be confirmed. Reconnect before sharing another comment.',
        );
        return Promise.resolve(null);
      }
      pendingDeliveryReservationsRef.current += 1;
      let reservationHeld = true;
      return new Promise<CollaborationCommentMetadata | null>((resolve) => {
        let settled = false;
        const finish = (value: CollaborationCommentMetadata | null): void => {
          if (settled) return;
          settled = true;
          pendingCommentOperationsRef.current.delete(cancel);
          if (reservationHeld) {
            reservationHeld = false;
            pendingDeliveryReservationsRef.current = Math.max(
              0,
              pendingDeliveryReservationsRef.current - 1,
            );
          }
          resolve(value);
        };
        const cancel = (): void => finish(null);
        pendingCommentOperationsRef.current.add(cancel);
        void collaboration
          .createComment({
            projectId: current.projectId,
            canvasId: current.id,
            nodeId,
            body,
          })
          .then((result) => {
            if (settled) return;
            if (!result.ok) {
              reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
              finish(null);
              return;
            }
            if (result.value === null) {
              reportOnce(
                lastErrorRef,
                onErrorRef.current,
                'Forgeboard could not send your comment to the shared canvas.',
              );
              finish(null);
              return;
            }
            const { receipt, comment } = result.value;
            reservationHeld = false;
            pendingDeliveryReservationsRef.current = Math.max(
              0,
              pendingDeliveryReservationsRef.current - 1,
            );
            pendingDeliveryFingerprintsRef.current.set(receipt.deliveryId, {
              fingerprint: receipt.snapshotDigest,
              snapshotDigest: receipt.snapshotDigest,
              candidateComments: { [comment.id]: comment },
              comments: [comment],
              resolveComment: finish,
            });
            const early = earlyDeliveryEventsRef.current.get(receipt.deliveryId);
            if (early !== undefined) {
              earlyDeliveryEventsRef.current.delete(receipt.deliveryId);
              settleDeliveryEvent(early);
            }
          })
          .catch(() => {
            if (settled) return;
            reportOnce(
              lastErrorRef,
              onErrorRef.current,
              'Forgeboard could not create your shared comment.',
            );
            finish(null);
          });
      });
    },
    [settleDeliveryEvent],
  );

  const discardRejectedComment = useCallback(
    async (requestedEntry: CollaborationRejectedCommentEntry): Promise<boolean> => {
      const collaboration = window.forgeboard.collaboration;
      const current = documentRef.current;
      const comment = requestedEntry.comment;
      const retained = rejectedCommentsRef.current.get(comment.id);
      const entry = rejectedCommentEntriesRef.current.get(comment.id);
      if (
        collaboration === undefined ||
        current === null ||
        retained === undefined ||
        entry === undefined ||
        !jsonValuesEqual(retained, comment) ||
        !jsonValuesEqual(entry, requestedEntry)
      ) {
        return false;
      }
      try {
        const result = await collaboration.discardRejectedComment({
          projectId: current.projectId,
          canvasId: current.id,
          comment,
          rejectedDeliveryId: requestedEntry.rejectedDeliveryId,
        });
        if (!result.ok) {
          reportOnce(lastErrorRef, onErrorRef.current, result.error.message);
          return false;
        }
        const synchronized = result.value?.disposition === 'synchronized';
        durableRecoveryRef.current = synchronized ? null : result.value;
        if (synchronized && result.value !== null) {
          retainedUnauthorizedRecoveryRef.current = false;
          const synchronizedSnapshot = result.value.baseline ?? result.value.pending;
          lastSynchronizedMetadataRef.current = synchronizedSnapshot;
          lastSynchronizedSnapshotRef.current =
            serializeCollaborationMetadataSnapshot(synchronizedSnapshot);
        }
        rejectedCommentIdsRef.current.clear();
        rejectedCommentsRef.current.clear();
        rejectedCommentEntriesRef.current.clear();
        for (const commentId of result.value?.rejectedCommentIds ?? []) {
          rejectedCommentIdsRef.current.add(commentId);
        }
        for (const rejected of result.value?.rejectedComments ?? []) {
          rejectedCommentIdsRef.current.add(rejected.id);
          rejectedCommentsRef.current.set(rejected.id, rejected);
        }
        for (const rejectedEntry of result.value?.rejectedCommentEntries ?? []) {
          rejectedCommentIdsRef.current.add(rejectedEntry.comment.id);
          rejectedCommentsRef.current.set(rejectedEntry.comment.id, rejectedEntry.comment);
          rejectedCommentEntriesRef.current.set(rejectedEntry.comment.id, rejectedEntry);
        }
        setRejectedComments([...rejectedCommentsRef.current.values()]);
        setRejectedCommentEntries([...rejectedCommentEntriesRef.current.values()]);
        lastErrorRef.current = null;
        return !jsonValuesEqual(rejectedCommentsRef.current.get(comment.id), comment);
      } catch {
        reportOnce(
          lastErrorRef,
          onErrorRef.current,
          'Forgeboard could not delete the saved comment.',
        );
        return false;
      }
    },
    [],
  );

  return {
    awareness,
    rejectedComments,
    rejectedCommentEntries,
    graphReadOnly:
      graphAuthorityRole !== null && !collaborationRoleCanEditGraph(graphAuthorityRole),
    role: graphAuthorityRole,
    canComment:
      sessionReady &&
      graphAuthorityRole !== null &&
      collaborationRoleCanComment(graphAuthorityRole),
    createComment,
    discardRejectedComment,
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

function collaborationRoleCanEditGraph(role: CollaborationRole | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

function collaborationRoleCanComment(role: CollaborationRole | undefined): boolean {
  return role === 'owner' || role === 'editor' || role === 'reviewer';
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

function discardPendingDeliveries(pending: Map<string, PendingDeliveryFingerprint>): void {
  for (const delivery of pending.values()) delivery.resolveComment?.(null);
  pending.clear();
}

function pendingCollaborationCommentIds(
  pending: ReadonlyMap<string, PendingDeliveryFingerprint>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const delivery of pending.values()) {
    for (const comment of delivery.comments ?? []) ids.add(comment.id);
  }
  return ids;
}

/**
 * The server echo can beat the main-process IPC result that reveals a new comment's id. During
 * that narrow window, hold newly observed comments from the authenticated local subject. The last
 * synchronized snapshot is not advanced while the comment reservation is outstanding, so existing
 * acknowledged comments from that subject remain visible.
 */
function pendingUnidentifiedLocalCommentIds(
  snapshot: CollaborationMetadataSnapshot,
  synchronized: CollaborationMetadataSnapshot | null,
  localSubject: string | undefined,
  hasPendingCommentOperation: boolean,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!hasPendingCommentOperation || localSubject === undefined) return ids;
  for (const [commentId, comment] of Object.entries(snapshot.comments)) {
    if (comment.authorId === localSubject && synchronized?.comments[commentId] === undefined) {
      ids.add(commentId);
    }
  }
  return ids;
}

function snapshotContainsAnyComment(
  snapshot: CollaborationMetadataSnapshot,
  commentIds: ReadonlySet<string>,
): boolean {
  for (const commentId of commentIds) {
    if (snapshot.comments[commentId] !== undefined) return true;
  }
  return false;
}

/** Holds receipt-bound comments out of renderer state while retaining unrelated room changes. */
function snapshotWithoutComments(
  snapshot: CollaborationMetadataSnapshot,
  excludedCommentIds: ReadonlySet<string>,
): CollaborationMetadataSnapshot {
  const excluded = new Set(excludedCommentIds);
  const repliesByParent = new Map<string, string[]>();
  for (const comment of Object.values(snapshot.comments)) {
    if (comment.replyToId === undefined) continue;
    const replies = repliesByParent.get(comment.replyToId) ?? [];
    replies.push(comment.id);
    repliesByParent.set(comment.replyToId, replies);
  }
  const queue = [...excluded];
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    if (parentId === undefined) break;
    for (const replyId of repliesByParent.get(parentId) ?? []) {
      if (excluded.has(replyId)) continue;
      excluded.add(replyId);
      queue.push(replyId);
    }
  }
  const comments = Object.fromEntries(
    Object.entries(snapshot.comments).filter(([commentId]) => !excluded.has(commentId)),
  );
  const reviews = Object.fromEntries(
    Object.entries(snapshot.reviews).map(([reviewId, review]) => [
      reviewId,
      review.commentIds === undefined
        ? review
        : {
            ...review,
            commentIds: review.commentIds.filter((commentId) => !excluded.has(commentId)),
          },
    ]),
  );
  return CollaborationMetadataSnapshotSchema.parse({
    ...snapshot,
    comments,
    reviews,
  });
}

function deliveryRejectionMessage(
  reason: 'invalid-request' | 'not-authorized' | 'state-not-applied' | 'document-too-large',
  duringReconnect: boolean,
): string {
  if (reason === 'not-authorized') {
    return 'The shared canvas refused your changes because your role cannot share them.';
  }
  if (reason === 'document-too-large') {
    return 'Your changes are too large for the shared canvas size limit and were not applied.';
  }
  if (duringReconnect) {
    return 'Sharing paused because the shared canvas did not confirm your offline changes after reconnecting.';
  }
  return 'The shared canvas did not confirm your latest changes.';
}

function renderableAwareness(
  entries: readonly CollaborationAwarenessEntry[],
  localSubject: string,
): CollaborationAwarenessEntry[] {
  const bySubject = new Map<string, CollaborationAwarenessEntry>();
  for (const entry of entries) {
    if (entry.state.user.id === localSubject) continue;
    const current = bySubject.get(entry.state.user.id);
    if (current === undefined || awarenessPriority(entry) > awarenessPriority(current)) {
      bySubject.set(entry.state.user.id, entry);
    }
  }
  return [...bySubject.values()]
    .sort((left, right) => left.clientId - right.clientId)
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

function awarenessPriority(entry: CollaborationAwarenessEntry): number {
  const status = entry.state.activity?.status ?? 'idle';
  const activity =
    status === 'editing' ? 4 : status === 'reviewing' ? 3 : status === 'idle' ? 2 : 1;
  return (
    activity +
    (entry.state.cursor === undefined ? 0 : 4) +
    (entry.state.selection?.nodeIds.length ? 4 : 0)
  );
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
