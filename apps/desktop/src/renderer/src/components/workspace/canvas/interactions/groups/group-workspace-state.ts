import { applyNodeChanges, type NodeChange } from '@xyflow/react';

import type { WorkshopNode } from '../../CanvasNode.js';
import { lockedCanvasNodeIds } from '../lock-protection.js';
import {
  assignDraggedNodeToContainingFrame,
  descendantIds,
  fitGroupFrameToMembers,
  reconcileGroupMembership,
  removeNodePreservingGroupHierarchy,
  resolvedGroupParents,
} from './group-containment.js';

export interface FinalizedDraggedGroupMembership {
  readonly nodes: WorkshopNode[];
  readonly changedFrameIds: string[];
}

export interface UpdatedGroupFrameData {
  readonly nodes: WorkshopNode[];
  readonly blockedChildIds: string[];
}

/**
 * Applies React Flow changes while keeping flat-coordinate group frames coherent. Frame movement
 * carries each resolved, effectively unlocked member unless React Flow supplied that member's own
 * position change in the same batch.
 */
export function applyGroupAwareNodeChanges(
  nodes: readonly WorkshopNode[],
  changes: readonly NodeChange<WorkshopNode>[],
): WorkshopNode[] {
  const appliedChanges = changes.filter(
    (change) =>
      !(
        change.type === 'dimensions' &&
        nodeById(nodes, change.id)?.data.kind === 'group-frame' &&
        nodeById(nodes, change.id)?.data.autoFit === true &&
        (change.resizing === true || Boolean(change.setAttributes))
      ),
  );
  const explicitlyPositionedIds = new Set(
    appliedChanges.filter((change) => change.type === 'position').map((change) => change.id),
  );
  const movedFrameIds = uniqueSorted(
    appliedChanges
      .filter((change) => change.type === 'position')
      .map((change) => change.id)
      .filter((id) => nodeById(nodes, id)?.data.kind === 'group-frame'),
  );
  const changedFrameGeometryIds = uniqueSorted([
    ...movedFrameIds,
    ...appliedChanges
      .filter((change) => change.type === 'dimensions' || change.type === 'replace')
      .map((change) => change.id)
      .filter(
        (id) =>
          nodeById(nodes, id)?.data.kind === 'group-frame' ||
          nodeByIdAfterReplacement(appliedChanges, id)?.data.kind === 'group-frame',
      ),
  ]);
  const removedFrameParentIds = frameIdsClaimingMembers(
    nodes,
    appliedChanges
      .filter((change) => change.type === 'remove')
      .map((change) => change.id)
      .filter((id) => nodeById(nodes, id)?.data.kind === 'group-frame'),
  );
  const effectivelyLockedIds = lockedCanvasNodeIds(nodes);
  let structuralBase = nodes.slice();
  for (const change of appliedChanges) {
    if (change.type === 'remove') {
      structuralBase = removeNodePreservingGroupHierarchy(structuralBase, change.id);
    }
  }
  let next = applyNodeChanges(
    appliedChanges.filter((change) => change.type !== 'remove'),
    structuralBase,
  );
  const positionUpdates = new Map<string, WorkshopNode>();
  const movedFrameSet = new Set(movedFrameIds);
  const parents = resolvedGroupParents(nodes);
  const deltaByFrame = new Map<string, { x: number; y: number }>();
  for (const frameId of movedFrameIds) {
    const before = nodeById(nodes, frameId);
    const after = nodeById(next, frameId);
    if (before?.data.kind !== 'group-frame' || after?.data.kind !== 'group-frame') continue;
    deltaByFrame.set(frameId, {
      x: after.position.x - before.position.x,
      y: after.position.y - before.position.y,
    });
  }
  for (const node of nodes) {
    if (explicitlyPositionedIds.has(node.id) || effectivelyLockedIds.has(node.id)) continue;
    let owner = parents.get(node.id);
    while (owner !== undefined && !movedFrameSet.has(owner)) owner = parents.get(owner);
    if (owner === undefined) continue;
    const delta = deltaByFrame.get(owner);
    if (delta === undefined || (delta.x === 0 && delta.y === 0)) continue;
    const member = nodeById(next, node.id);
    if (member === undefined) continue;
    positionUpdates.set(member.id, {
      ...member,
      position: { x: member.position.x + delta.x, y: member.position.y + delta.y },
    });
  }
  next = nodesWithUpdates(next, positionUpdates);

  const membershipCanBeStale = appliedChanges.some(
    (change) => change.type === 'remove' || change.type === 'replace',
  );
  if (membershipCanBeStale) next = reconcileGroupMembership(next).nodes;

  const autoFitMemberIds = memberIdsAffectedByGeometryOrRemoval(nodes, next, appliedChanges);
  const autoFitFrameIds = uniqueSorted([
    ...changedFrameGeometryIds,
    ...removedFrameParentIds,
    ...frameIdsClaimingMembers(nodes, autoFitMemberIds),
    ...frameIdsClaimingMembers(next, autoFitMemberIds),
  ]);
  return autoFitFrameIds.length === 0 ? next : fitAutomaticGroupFrames(next, autoFitFrameIds);
}

/** Returns every frame whose direct persisted membership differs between two graph states. */
export function frameIdsWithChangedMembership(
  before: readonly WorkshopNode[],
  after: readonly WorkshopNode[],
): string[] {
  const beforeFrames = new Map(
    before
      .filter((node) => node.data.kind === 'group-frame')
      .map((node) => [node.id, uniqueSorted(childIds(node))] as const),
  );
  const afterFrames = new Map(
    after
      .filter((node) => node.data.kind === 'group-frame')
      .map((node) => [node.id, uniqueSorted(childIds(node))] as const),
  );
  return uniqueSorted([...beforeFrames.keys(), ...afterFrames.keys()]).filter(
    (id) => !sameStrings(beforeFrames.get(id) ?? [], afterFrames.get(id) ?? []),
  );
}

/**
 * Uses final drag coordinates to resolve ordinary-node membership. Effective locks are checked
 * before overlaying positions, so stale drag payloads cannot move a locked node around the guard.
 */
export function finalizeDraggedGroupMembership(
  nodes: readonly WorkshopNode[],
  draggedNodes: readonly WorkshopNode[],
): FinalizedDraggedGroupMembership {
  const effectivelyLockedIds = lockedCanvasNodeIds(nodes);
  const draggedById = new Map(draggedNodes.map((node) => [node.id, node] as const));
  const positionUpdates = new Map<string, WorkshopNode>();
  for (const node of nodes) {
    const dragged = draggedById.get(node.id);
    if (
      dragged === undefined ||
      effectivelyLockedIds.has(node.id) ||
      !finitePosition(dragged.position) ||
      samePosition(node.position, dragged.position)
    ) {
      continue;
    }
    positionUpdates.set(node.id, { ...node, position: { ...dragged.position } });
  }
  let next = nodesWithUpdates(nodes, positionUpdates);
  const draggedFrameIds = uniqueSorted(
    draggedNodes
      .map(({ id }) => id)
      .filter((id) => {
        const node = nodeById(next, id);
        return (
          node?.data.kind === 'group-frame' &&
          node.data.autoFit === true &&
          !effectivelyLockedIds.has(id)
        );
      }),
  );
  const eligibleMemberIds = uniqueSorted(
    draggedNodes
      .map(({ id }) => id)
      .filter((id) => {
        const node = nodeById(next, id);
        return node !== undefined && !effectivelyLockedIds.has(id);
      }),
  );
  const changedFrameIds = new Set<string>();
  const affectedFrameIds = new Set(draggedFrameIds);
  if (eligibleMemberIds.length > 0) {
    for (const frameId of frameIdsClaimingMembers(nodes, eligibleMemberIds)) {
      affectedFrameIds.add(frameId);
    }
    for (const memberId of eligibleMemberIds) {
      const assignment = assignDraggedNodeToContainingFrame(next, memberId);
      next = assignment.nodes;
      for (const frameId of assignment.changedFrameIds) changedFrameIds.add(frameId);
    }

    const reconciliation = reconcileGroupMembership(next);
    next = reconciliation.nodes;
    for (const frameId of reconciliation.changedFrameIds) changedFrameIds.add(frameId);
    for (const frameId of frameIdsClaimingMembers(next, eligibleMemberIds)) {
      affectedFrameIds.add(frameId);
    }
  }
  const stableAffectedFrameIds = uniqueSorted(affectedFrameIds);
  const beforeFit = next;
  next = fitAutomaticGroupFrames(next, stableAffectedFrameIds);
  for (const frameId of changedFramesBetween(beforeFit, next, stableAffectedFrameIds)) {
    changedFrameIds.add(frameId);
  }
  return { nodes: next, changedFrameIds: uniqueSorted(changedFrameIds) };
}

/**
 * Updates a frame without changing individually locked membership or taking children from locked
 * frames. Invalid IDs and cycle-producing frame claims are discarded; requested movable IDs are
 * exclusive across unlocked frames before deterministic reconciliation.
 */
export function updateGroupFrameData(
  nodes: readonly WorkshopNode[],
  frameId: string,
  data: Partial<WorkshopNode['data']>,
): UpdatedGroupFrameData {
  const frame = nodeById(nodes, frameId);
  if (frame?.data.kind !== 'group-frame') {
    return { nodes: nodes.slice(), blockedChildIds: [] };
  }

  const hasExplicitChildren = Object.hasOwn(data, 'childNodeIds');
  const requestedChildIds = hasExplicitChildren
    ? validMemberNodeIds(nodes, frameId, data.childNodeIds)
    : [];
  const unlockOnly =
    frame.data.locked &&
    Object.keys(data).length === 1 &&
    Object.hasOwn(data, 'locked') &&
    data.locked === false;
  const frameEffectivelyLocked = lockedCanvasNodeIds(nodes).has(frameId);
  if (frameEffectivelyLocked && !(frame.data.locked && unlockOnly)) {
    const currentChildIds = validMemberNodeIds(nodes, frameId, childIds(frame));
    const current = new Set(currentChildIds);
    const requested = new Set(requestedChildIds);
    return {
      nodes: nodes.slice(),
      blockedChildIds: hasExplicitChildren
        ? uniqueSorted([
            ...currentChildIds.filter((id) => !requested.has(id)),
            ...requestedChildIds.filter((id) => !current.has(id)),
          ])
        : [],
    };
  }

  const protectedBaseline = reconcileGroupMembership(
    removeLockedClaimsFromUnlockedFrames(nodes),
  ).nodes;
  const baselineFrame = nodeById(protectedBaseline, frameId);
  if (baselineFrame?.data.kind !== 'group-frame') {
    return { nodes: protectedBaseline, blockedChildIds: [] };
  }
  if (!hasExplicitChildren) {
    const updatedFrame: WorkshopNode = {
      ...baselineFrame,
      data: { ...baselineFrame.data, ...data, kind: 'group-frame' },
    };
    return {
      nodes: nodesWithUpdates(protectedBaseline, new Map([[frameId, updatedFrame]])),
      blockedChildIds: [],
    };
  }

  const lockedClaimedIds = new Set(
    protectedBaseline
      .filter((node) => node.data.kind === 'group-frame' && node.data.locked)
      .flatMap((node) => descendantIds(protectedBaseline, node.id)),
  );
  const currentChildIds = childIds(baselineFrame);
  const current = new Set(currentChildIds);
  const requested = new Set(requestedChildIds);
  const desiredChildIds = new Set<string>();
  const blockedChildIds: string[] = [];
  for (const id of uniqueSorted([...currentChildIds, ...requestedChildIds])) {
    const individuallyLocked = nodeById(protectedBaseline, id)?.data.locked === true;
    const claimedByLockedFrame = lockedClaimedIds.has(id);
    if (claimedByLockedFrame) {
      if (requested.has(id)) blockedChildIds.push(id);
      continue;
    }
    if (individuallyLocked) {
      if (current.has(id)) desiredChildIds.add(id);
      if (requested.has(id) !== current.has(id)) blockedChildIds.push(id);
      continue;
    }
    if (requested.has(id)) desiredChildIds.add(id);
  }
  const desired = uniqueSorted(desiredChildIds);
  const targetClaims = new Set(desired);
  const updates = new Map<string, WorkshopNode>();

  for (const candidate of protectedBaseline) {
    if (candidate.id === frameId) {
      updates.set(candidate.id, {
        ...candidate,
        data: {
          ...candidate.data,
          ...data,
          kind: 'group-frame',
          childNodeIds: desired,
        },
      });
      continue;
    }
    if (
      candidate.data.kind !== 'group-frame' ||
      lockedCanvasNodeIds(protectedBaseline).has(candidate.id)
    ) {
      continue;
    }
    const existing = childIds(candidate);
    const retained = existing.filter((id) => !targetClaims.has(id));
    if (!sameStrings(existing, retained)) {
      updates.set(candidate.id, withChildIds(candidate, retained));
    }
  }

  return {
    nodes: reconcileGroupMembership(nodesWithUpdates(protectedBaseline, updates)).nodes,
    blockedChildIds,
  };
}

/** Returns stable frame IDs whose raw child lists claim at least one requested member. */
export function frameIdsClaimingMembers(
  nodes: readonly WorkshopNode[],
  memberIds: readonly string[],
): string[] {
  const requested = new Set(memberIds);
  if (requested.size === 0) return [];
  return nodes
    .filter(
      (node) => node.data.kind === 'group-frame' && childIds(node).some((id) => requested.has(id)),
    )
    .map((node) => node.id)
    .sort(compareIds);
}

/** Fits only the requested, unlocked frames that have automatic fitting enabled. */
export function fitAutomaticGroupFrames(
  nodes: readonly WorkshopNode[],
  frameIds: readonly string[],
): WorkshopNode[] {
  let next = nodes.slice();
  const parents = resolvedGroupParents(next);
  const requested = new Set(frameIds);
  for (const frameId of frameIds) {
    let parent = parents.get(frameId);
    while (parent !== undefined) {
      requested.add(parent);
      parent = parents.get(parent);
    }
  }
  const depth = (id: string) => {
    let value = 0;
    let parent = parents.get(id);
    while (parent !== undefined) {
      value += 1;
      parent = parents.get(parent);
    }
    return value;
  };
  for (const frameId of uniqueSorted(requested).sort(
    (a, b) => depth(b) - depth(a) || a.localeCompare(b),
  )) {
    const frame = nodeById(next, frameId);
    if (frame?.data.kind !== 'group-frame' || frame.data.autoFit !== true || frame.data.locked) {
      continue;
    }
    const result = fitGroupFrameToMembers(next, frameId);
    if (result.disposition === 'fitted') next = result.nodes;
  }
  return next;
}

function memberIdsAffectedByGeometryOrRemoval(
  before: readonly WorkshopNode[],
  after: readonly WorkshopNode[],
  changes: readonly NodeChange<WorkshopNode>[],
): string[] {
  const affected = new Set<string>();
  for (const change of changes) {
    if (!('id' in change)) continue;
    const oldNode = nodeById(before, change.id);
    const nextNode = nodeById(after, change.id);
    if (change.type === 'dimensions') {
      if (isOrdinary(oldNode) || isOrdinary(nextNode)) affected.add(change.id);
      continue;
    }
    if (change.type === 'remove') {
      if (isOrdinary(oldNode)) affected.add(change.id);
      continue;
    }
    if (change.type === 'replace' && (isOrdinary(oldNode) || isOrdinary(nextNode))) {
      affected.add(change.id);
    }
  }
  return uniqueSorted(affected);
}

function validMemberNodeIds(
  nodes: readonly WorkshopNode[],
  frameId: string,
  requested: readonly string[] | undefined,
): string[] {
  const requestedValues: readonly unknown[] = Array.isArray(requested) ? requested : [];
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  return uniqueSorted(
    requestedValues.filter((id): id is string => {
      if (typeof id !== 'string') return false;
      const node = byId.get(id);
      return node !== undefined && id !== frameId && !descendantIds(nodes, id).includes(frameId);
    }),
  );
}

function removeLockedClaimsFromUnlockedFrames(nodes: readonly WorkshopNode[]): WorkshopNode[] {
  const lockedClaimedIds = new Set(
    nodes
      .filter((node) => node.data.kind === 'group-frame' && node.data.locked)
      .flatMap((node) => descendantIds(nodes, node.id)),
  );
  const lockedFrames = lockedCanvasNodeIds(nodes);
  if (lockedClaimedIds.size === 0) return nodes.slice();
  return nodes.map((node) => {
    if (node.data.kind !== 'group-frame' || lockedFrames.has(node.id)) return node;
    const current = childIds(node);
    const retained = current.filter((id) => !lockedClaimedIds.has(id));
    return sameStrings(current, retained) ? node : withChildIds(node, retained);
  });
}

function changedFramesBetween(
  before: readonly WorkshopNode[],
  after: readonly WorkshopNode[],
  candidateIds: readonly string[],
): string[] {
  const beforeById = new Map(before.map((node) => [node.id, node] as const));
  const afterById = new Map(after.map((node) => [node.id, node] as const));
  return uniqueSorted(candidateIds.filter((id) => beforeById.get(id) !== afterById.get(id)));
}

function nodesWithUpdates(
  nodes: readonly WorkshopNode[],
  updates: ReadonlyMap<string, WorkshopNode>,
): WorkshopNode[] {
  if (updates.size === 0) return nodes.slice();
  return nodes.map((node) => updates.get(node.id) ?? node);
}

function nodeById(nodes: readonly WorkshopNode[], id: string): WorkshopNode | undefined {
  return nodes.find((node) => node.id === id);
}

function nodeByIdAfterReplacement(
  changes: readonly NodeChange<WorkshopNode>[],
  id: string,
): WorkshopNode | undefined {
  const replacement = changes.find((change) => change.type === 'replace' && change.id === id);
  return replacement?.type === 'replace' ? replacement.item : undefined;
}

function childIds(frame: WorkshopNode): string[] {
  return Array.isArray(frame.data.childNodeIds)
    ? frame.data.childNodeIds.filter((id): id is string => typeof id === 'string')
    : [];
}

function withChildIds(frame: WorkshopNode, childNodeIds: readonly string[]): WorkshopNode {
  return { ...frame, data: { ...frame.data, childNodeIds: [...childNodeIds] } };
}

function isOrdinary(node: WorkshopNode | undefined): node is WorkshopNode {
  return node !== undefined && node.data.kind !== 'group-frame';
}

function finitePosition(position: { readonly x: number; readonly y: number }): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y);
}

function samePosition(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): boolean {
  return left.x === right.x && left.y === right.y;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareIds);
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right);
}
