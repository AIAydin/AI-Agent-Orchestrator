import {
  CANVAS_NODE_MINIMUM_DIMENSIONS,
  DEFAULT_CANVAS_NODE_DIMENSIONS,
} from '../../../../../../../shared/canvas/node-dimensions.js';
import type { WorkshopNode } from '../../CanvasNode.js';
import { GROUP_FRAME_MINIMUM } from './group-dimensions.js';

export const DEFAULT_CANVAS_NODE_WIDTH = DEFAULT_CANVAS_NODE_DIMENSIONS.width;
export const DEFAULT_CANVAS_NODE_HEIGHT = DEFAULT_CANVAS_NODE_DIMENSIONS.height;

export interface CanvasNodeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type GroupLayout = 'freeform' | 'horizontal' | 'vertical' | 'grid';

export type GroupMembershipIssueCode =
  | 'duplicate-child-id'
  | 'stale-child-id'
  | 'nested-group-frame'
  | 'multiple-frame-membership';

export interface GroupMembershipIssue {
  readonly code: GroupMembershipIssueCode;
  readonly childId: string;
  readonly frameIds: readonly string[];
}

export interface ResolvedGroupMembership {
  readonly childId: string;
  readonly frameId: string;
}

export interface GroupMembershipValidation {
  readonly valid: boolean;
  readonly issues: readonly GroupMembershipIssue[];
  readonly memberships: readonly ResolvedGroupMembership[];
}

export interface GroupMembershipChange {
  readonly childId: string;
  readonly fromFrameIds: readonly string[];
  readonly toFrameId: string | null;
}

export interface GroupMembershipReconciliation extends GroupMembershipValidation {
  readonly nodes: WorkshopNode[];
  readonly changedFrameIds: readonly string[];
  readonly changedNodeIds: readonly string[];
  readonly membershipChanges: readonly GroupMembershipChange[];
}

export type GroupAssignmentDisposition =
  | 'assigned'
  | 'reassigned'
  | 'unassigned'
  | 'reconciled'
  | 'unchanged'
  | 'rejected';

export interface GroupAssignmentResult {
  readonly nodes: WorkshopNode[];
  readonly nodeId: string;
  readonly disposition: GroupAssignmentDisposition;
  readonly reason: string;
  readonly previousFrameIds: readonly string[];
  readonly candidateFrameIds: readonly string[];
  readonly assignedFrameId: string | null;
  readonly changedFrameIds: readonly string[];
  readonly changedNodeIds: readonly string[];
}

export type MoveGroupFrameDisposition = 'moved' | 'unchanged' | 'rejected';

export interface MoveGroupFrameResult {
  readonly nodes: WorkshopNode[];
  readonly frameId: string;
  readonly disposition: MoveGroupFrameDisposition;
  readonly reason: string;
  readonly delta: { readonly x: number; readonly y: number };
  readonly memberIds: readonly string[];
  readonly movedMemberIds: readonly string[];
  readonly preservedLockedMemberIds: readonly string[];
  readonly changedNodeIds: readonly string[];
}

export interface FitGroupFrameOptions {
  readonly padding?: number;
}

export type FitGroupFrameDisposition = 'fitted' | 'unchanged' | 'rejected';

export interface FitGroupFrameResult {
  readonly nodes: WorkshopNode[];
  readonly frameId: string;
  readonly disposition: FitGroupFrameDisposition;
  readonly reason: string;
  readonly memberIds: readonly string[];
  readonly fittedBounds: CanvasNodeBounds | null;
  readonly changedNodeIds: readonly string[];
}

export interface ArrangeGroupMembersOptions {
  readonly padding?: number;
  readonly gap?: number;
  readonly gridColumns?: number;
}

export interface GroupMemberPlacement {
  readonly nodeId: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly target: { readonly x: number; readonly y: number };
  readonly applied: boolean;
  readonly locked: boolean;
}

export type ArrangeGroupMembersDisposition = 'arranged' | 'unchanged' | 'rejected';

export interface ArrangeGroupMembersResult {
  readonly nodes: WorkshopNode[];
  readonly frameId: string;
  readonly layout: GroupLayout;
  readonly disposition: ArrangeGroupMembersDisposition;
  readonly reason: string;
  readonly memberIds: readonly string[];
  readonly movedMemberIds: readonly string[];
  readonly preservedLockedMemberIds: readonly string[];
  readonly placements: readonly GroupMemberPlacement[];
  readonly changedNodeIds: readonly string[];
}

interface MembershipAnalysis extends GroupMembershipValidation {
  readonly ownerByChild: ReadonlyMap<string, string>;
  readonly rawClaims: ReadonlyMap<string, readonly string[]>;
  readonly rawClaimCounts: ReadonlyMap<string, number>;
}

const DEFAULT_FRAME_PADDING = 24;
const DEFAULT_LAYOUT_GAP = 16;
const MAX_GEOMETRY_OPTION = 100_000;

/** Returns flat absolute canvas bounds without relying on React Flow parent coordinates. */
export function canvasNodeBounds(node: WorkshopNode): CanvasNodeBounds {
  const minimum = isGroupFrame(node) ? GROUP_FRAME_MINIMUM : CANVAS_NODE_MINIMUM_DIMENSIONS;
  return {
    x: node.position.x,
    y: node.position.y,
    width: Math.max(
      minimum.width,
      resolvedDimension(node.width, node.measured?.width, DEFAULT_CANVAS_NODE_WIDTH),
    ),
    height: Math.max(
      minimum.height,
      resolvedDimension(node.height, node.measured?.height, DEFAULT_CANVAS_NODE_HEIGHT),
    ),
  };
}

/** Reports invalid or ambiguous memberships and the deterministic owner reconciliation would use. */
export function validateGroupMembership(nodes: readonly WorkshopNode[]): GroupMembershipValidation {
  const analysis = analyzeMembership(nodes);
  return {
    valid: analysis.valid,
    issues: analysis.issues,
    memberships: analysis.memberships,
  };
}

/**
 * Removes stale, duplicate, nested-frame, and losing cross-frame claims. A child can have one frame
 * owner. When legacy frames disagree, a containing frame wins over a non-containing frame, then the
 * smallest frame wins, with the frame ID as the final stable tie-breaker.
 */
export function reconcileGroupMembership(
  nodes: readonly WorkshopNode[],
): GroupMembershipReconciliation {
  const analysis = analyzeMembership(nodes);
  const childrenByFrame = new Map<string, string[]>();
  for (const { childId, frameId } of analysis.memberships) {
    const children = childrenByFrame.get(frameId) ?? [];
    children.push(childId);
    childrenByFrame.set(frameId, children);
  }

  const updates = new Map<string, WorkshopNode>();
  for (const frame of groupFrames(nodes)) {
    const current = childIds(frame);
    const next = childrenByFrame.get(frame.id) ?? [];
    if (!sameStrings(current, next)) {
      updates.set(frame.id, withChildIds(frame, next));
    }
  }

  const changedFrameIds = sorted(updates.keys());
  const membershipChanges = sorted(analysis.rawClaims.keys()).flatMap((childId) => {
    const fromFrameIds = uniqueSorted(analysis.rawClaims.get(childId) ?? []);
    const toFrameId = analysis.ownerByChild.get(childId) ?? null;
    const exactSingleClaim =
      toFrameId !== null &&
      fromFrameIds.length === 1 &&
      fromFrameIds[0] === toFrameId &&
      analysis.rawClaimCounts.get(childId) === 1;
    if (exactSingleClaim) return [];
    return [{ childId, fromFrameIds, toFrameId }];
  });

  return {
    valid: analysis.valid,
    issues: analysis.issues,
    memberships: analysis.memberships,
    nodes: nodesWithUpdates(nodes, updates),
    changedFrameIds,
    changedNodeIds: changedFrameIds,
    membershipChanges,
  };
}

/** Moves an unlocked frame and every unlocked member by the same absolute-canvas delta. */
export function moveGroupFrameWithMembers(
  nodes: readonly WorkshopNode[],
  frameId: string,
  nextPosition: { readonly x: number; readonly y: number },
): MoveGroupFrameResult {
  const frame = findFrame(nodes, frameId);
  const memberIds = frame === undefined ? [] : ownedMemberIds(nodes, frameId);
  const base = {
    nodes: nodes.slice(),
    frameId,
    delta: { x: 0, y: 0 },
    memberIds,
    movedMemberIds: [] as readonly string[],
    preservedLockedMemberIds: lockedIds(nodes, memberIds),
    changedNodeIds: [] as readonly string[],
  };
  if (frame === undefined) {
    return {
      ...base,
      disposition: 'rejected',
      reason: 'group-frame-not-found',
    };
  }
  if (frame.data.locked) {
    return { ...base, disposition: 'rejected', reason: 'group-frame-locked' };
  }
  if (!finitePoint(nextPosition)) {
    return {
      ...base,
      disposition: 'rejected',
      reason: 'invalid-frame-position',
    };
  }

  const delta = {
    x: nextPosition.x - frame.position.x,
    y: nextPosition.y - frame.position.y,
  };
  if (delta.x === 0 && delta.y === 0) {
    return {
      ...base,
      delta,
      disposition: 'unchanged',
      reason: 'frame-position-unchanged',
    };
  }

  const membersById = nodeIndex(nodes);
  const updates = new Map<string, WorkshopNode>([
    [frame.id, { ...frame, position: { ...nextPosition } }],
  ]);
  const movedMemberIds: string[] = [];
  const preservedLockedMemberIds: string[] = [];
  for (const memberId of memberIds) {
    const member = membersById.get(memberId);
    if (member === undefined || isGroupFrame(member)) continue;
    if (member.data.locked) {
      preservedLockedMemberIds.push(member.id);
      continue;
    }
    updates.set(member.id, {
      ...member,
      position: {
        x: member.position.x + delta.x,
        y: member.position.y + delta.y,
      },
    });
    movedMemberIds.push(member.id);
  }
  const changedNodeIds = sorted(updates.keys());
  return {
    nodes: nodesWithUpdates(nodes, updates),
    frameId,
    delta,
    memberIds,
    movedMemberIds: sorted(movedMemberIds),
    preservedLockedMemberIds: sorted(preservedLockedMemberIds),
    changedNodeIds,
    disposition: 'moved',
    reason: 'frame-and-unlocked-members-moved',
  };
}

/**
 * Reassigns a dragged ordinary node from its final absolute bounds. Locked and collapsed frames do
 * not receive nodes. If visible frames overlap, the smallest fully containing unlocked frame wins
 * deterministically.
 */
export function assignDraggedNodeToContainingFrame(
  nodes: readonly WorkshopNode[],
  nodeId: string,
): GroupAssignmentResult {
  const node = nodeIndex(nodes).get(nodeId);
  const previousFrameIds = groupFrames(nodes)
    .filter((frame) => childIds(frame).includes(nodeId))
    .map((frame) => frame.id)
    .sort(compareIds);
  const rejected = (reason: string): GroupAssignmentResult => ({
    nodes: nodes.slice(),
    nodeId,
    disposition: 'rejected',
    reason,
    previousFrameIds,
    candidateFrameIds: [],
    assignedFrameId: previousFrameIds.length === 1 ? (previousFrameIds[0] ?? null) : null,
    changedFrameIds: [],
    changedNodeIds: [],
  });
  if (node === undefined) return rejected('dragged-node-not-found');
  if (isGroupFrame(node)) return rejected('nested-group-frames-are-not-supported');
  if (node.data.locked) return rejected('dragged-node-locked');

  const candidateFrames = groupFrames(nodes)
    .filter((frame) => !frame.data.locked && !frame.data.collapsed && containsNode(frame, node))
    .sort(compareFramePriority);
  const assignedFrameId = candidateFrames[0]?.id ?? null;
  const updates = new Map<string, WorkshopNode>();
  for (const frame of groupFrames(nodes)) {
    const current = childIds(frame);
    const next = membershipForDraggedNode(current, nodeId, frame.id === assignedFrameId);
    if (!sameStrings(current, next)) updates.set(frame.id, withChildIds(frame, next));
  }
  const changedFrameIds = sorted(updates.keys());
  if (changedFrameIds.length === 0) {
    return {
      nodes: nodes.slice(),
      nodeId,
      disposition: 'unchanged',
      reason: assignedFrameId === null ? 'node-remains-ungrouped' : 'membership-unchanged',
      previousFrameIds,
      candidateFrameIds: candidateFrames.map((frame) => frame.id),
      assignedFrameId,
      changedFrameIds,
      changedNodeIds: changedFrameIds,
    };
  }

  const alreadyOnlyOwner = previousFrameIds.length === 1 && previousFrameIds[0] === assignedFrameId;
  const disposition: GroupAssignmentDisposition =
    assignedFrameId === null
      ? 'unassigned'
      : previousFrameIds.length === 0
        ? 'assigned'
        : alreadyOnlyOwner
          ? 'reconciled'
          : 'reassigned';
  return {
    nodes: nodesWithUpdates(nodes, updates),
    nodeId,
    disposition,
    reason:
      assignedFrameId === null
        ? 'node-left-all-unlocked-frames'
        : 'smallest-containing-unlocked-frame-selected',
    previousFrameIds,
    candidateFrameIds: candidateFrames.map((frame) => frame.id),
    assignedFrameId,
    changedFrameIds,
    changedNodeIds: changedFrameIds,
  };
}

/** Fits an unlocked frame to the absolute union of all resolved members, including locked members. */
export function fitGroupFrameToMembers(
  nodes: readonly WorkshopNode[],
  frameId: string,
  options: FitGroupFrameOptions = {},
): FitGroupFrameResult {
  const frame = findFrame(nodes, frameId);
  const memberIds = frame === undefined ? [] : ownedMemberIds(nodes, frameId);
  const base = {
    nodes: nodes.slice(),
    frameId,
    memberIds,
    fittedBounds: null,
    changedNodeIds: [] as readonly string[],
  };
  if (frame === undefined) {
    return {
      ...base,
      disposition: 'rejected',
      reason: 'group-frame-not-found',
    };
  }
  if (frame.data.locked) {
    return { ...base, disposition: 'rejected', reason: 'group-frame-locked' };
  }
  const members = nodesForIds(nodes, memberIds);
  if (members.length === 0) {
    return {
      ...base,
      disposition: 'unchanged',
      reason: 'group-frame-has-no-members',
    };
  }

  const padding = geometryOption(options.padding, DEFAULT_FRAME_PADDING);
  const union = unionBounds(members.map(canvasNodeBounds));
  const paddedBounds = {
    x: union.x - padding,
    y: union.y - padding,
    width: union.width + padding * 2,
    height: union.height + padding * 2,
  };
  const width = Math.max(GROUP_FRAME_MINIMUM.width, paddedBounds.width);
  const height = Math.max(GROUP_FRAME_MINIMUM.height, paddedBounds.height);
  const fittedBounds = {
    x: paddedBounds.x - (width - paddedBounds.width) / 2,
    y: paddedBounds.y - (height - paddedBounds.height) / 2,
    width,
    height,
  };
  const current = canvasNodeBounds(frame);
  if (sameBounds(current, fittedBounds)) {
    return {
      ...base,
      fittedBounds,
      disposition: 'unchanged',
      reason: 'group-frame-already-fitted',
    };
  }

  const updated: WorkshopNode = {
    ...frame,
    position: { x: fittedBounds.x, y: fittedBounds.y },
    width: fittedBounds.width,
    height: fittedBounds.height,
  };
  return {
    nodes: nodesWithUpdates(nodes, new Map([[frame.id, updated]])),
    frameId,
    memberIds,
    fittedBounds,
    changedNodeIds: [frame.id],
    disposition: 'fitted',
    reason: 'group-frame-fitted-to-member-bounds',
  };
}

/** Arranges resolved members in stable ID order while leaving every locked member byte-for-byte. */
export function arrangeGroupMembers(
  nodes: readonly WorkshopNode[],
  frameId: string,
  layout: GroupLayout,
  options: ArrangeGroupMembersOptions = {},
): ArrangeGroupMembersResult {
  const frame = findFrame(nodes, frameId);
  const memberIds = frame === undefined ? [] : ownedMemberIds(nodes, frameId);
  const emptyBase = {
    nodes: nodes.slice(),
    frameId,
    layout,
    memberIds,
    movedMemberIds: [] as readonly string[],
    preservedLockedMemberIds: [] as readonly string[],
    placements: [] as readonly GroupMemberPlacement[],
    changedNodeIds: [] as readonly string[],
  };
  if (frame === undefined) {
    return {
      ...emptyBase,
      disposition: 'rejected',
      reason: 'group-frame-not-found',
    };
  }
  if (frame.data.locked) {
    return {
      ...emptyBase,
      disposition: 'rejected',
      reason: 'group-frame-locked',
    };
  }
  const members = nodesForIds(nodes, memberIds);
  if (members.length === 0) {
    return {
      ...emptyBase,
      disposition: 'unchanged',
      reason: 'group-frame-has-no-members',
    };
  }
  if (layout === 'freeform') {
    return {
      ...emptyBase,
      preservedLockedMemberIds: lockedIds(nodes, memberIds),
      disposition: 'unchanged',
      reason: 'freeform-layout-preserved',
    };
  }

  const padding = geometryOption(options.padding, DEFAULT_FRAME_PADDING);
  const gap = geometryOption(options.gap, DEFAULT_LAYOUT_GAP);
  const targets = layoutTargets(frame, members, layout, padding, gap, options.gridColumns);
  const updates = new Map<string, WorkshopNode>();
  const placements: GroupMemberPlacement[] = [];
  const movedMemberIds: string[] = [];
  const preservedLockedMemberIds: string[] = [];
  for (const member of members) {
    const target = targets.get(member.id) ?? member.position;
    const locked = member.data.locked;
    const changed = member.position.x !== target.x || member.position.y !== target.y;
    const applied = !locked && changed;
    placements.push({
      nodeId: member.id,
      from: { ...member.position },
      target: { ...target },
      applied,
      locked,
    });
    if (locked) {
      preservedLockedMemberIds.push(member.id);
    } else if (changed) {
      updates.set(member.id, { ...member, position: { ...target } });
      movedMemberIds.push(member.id);
    }
  }
  const changedNodeIds = sorted(updates.keys());
  return {
    nodes: nodesWithUpdates(nodes, updates),
    frameId,
    layout,
    memberIds,
    movedMemberIds: sorted(movedMemberIds),
    preservedLockedMemberIds: sorted(preservedLockedMemberIds),
    placements,
    changedNodeIds,
    disposition: changedNodeIds.length > 0 ? 'arranged' : 'unchanged',
    reason:
      changedNodeIds.length > 0
        ? `${layout}-layout-applied`
        : preservedLockedMemberIds.length === members.length
          ? 'all-members-locked'
          : 'member-positions-already-arranged',
  };
}

function analyzeMembership(nodes: readonly WorkshopNode[]): MembershipAnalysis {
  const byId = nodeIndex(nodes);
  const frames = groupFrames(nodes);
  const issues: GroupMembershipIssue[] = [];
  const validClaims = new Map<string, WorkshopNode[]>();
  const rawClaims = new Map<string, string[]>();
  const rawClaimCounts = new Map<string, number>();

  for (const frame of frames) {
    const seen = new Set<string>();
    for (const childId of childIds(frame)) {
      const raw = rawClaims.get(childId) ?? [];
      raw.push(frame.id);
      rawClaims.set(childId, raw);
      rawClaimCounts.set(childId, (rawClaimCounts.get(childId) ?? 0) + 1);
      if (seen.has(childId)) {
        issues.push({
          code: 'duplicate-child-id',
          childId,
          frameIds: [frame.id],
        });
        continue;
      }
      seen.add(childId);
      const child = byId.get(childId);
      if (child === undefined) {
        issues.push({ code: 'stale-child-id', childId, frameIds: [frame.id] });
        continue;
      }
      if (isGroupFrame(child)) {
        issues.push({
          code: 'nested-group-frame',
          childId,
          frameIds: [frame.id],
        });
        continue;
      }
      const claims = validClaims.get(childId) ?? [];
      claims.push(frame);
      validClaims.set(childId, claims);
    }
  }

  const ownerByChild = new Map<string, string>();
  for (const childId of sorted(validClaims.keys())) {
    const child = byId.get(childId);
    if (child === undefined) continue;
    const claims = [...(validClaims.get(childId) ?? [])].sort((left, right) =>
      compareExistingClaim(left, right, child),
    );
    const winner = claims[0];
    if (winner === undefined) continue;
    ownerByChild.set(childId, winner.id);
    if (claims.length > 1) {
      issues.push({
        code: 'multiple-frame-membership',
        childId,
        frameIds: claims.map((frame) => frame.id).sort(compareIds),
      });
    }
  }

  const memberships = sorted(ownerByChild.keys()).map((childId) => ({
    childId,
    frameId: ownerByChild.get(childId)!,
  }));
  issues.sort(compareIssues);
  return {
    valid: issues.length === 0,
    issues,
    memberships,
    ownerByChild,
    rawClaims,
    rawClaimCounts,
  };
}

function layoutTargets(
  frame: WorkshopNode,
  members: readonly WorkshopNode[],
  layout: Exclude<GroupLayout, 'freeform'>,
  padding: number,
  gap: number,
  requestedColumns: number | undefined,
): ReadonlyMap<string, { readonly x: number; readonly y: number }> {
  const origin = {
    x: frame.position.x + padding,
    y: frame.position.y + padding,
  };
  const targets = new Map<string, { x: number; y: number }>();
  if (layout === 'horizontal') {
    let x = origin.x;
    for (const member of members) {
      targets.set(member.id, { x, y: origin.y });
      x += canvasNodeBounds(member).width + gap;
    }
    return targets;
  }
  if (layout === 'vertical') {
    let y = origin.y;
    for (const member of members) {
      targets.set(member.id, { x: origin.x, y });
      y += canvasNodeBounds(member).height + gap;
    }
    return targets;
  }

  const columns = boundedColumns(requestedColumns, members.length);
  const cellWidth = Math.max(...members.map((member) => canvasNodeBounds(member).width));
  const cellHeight = Math.max(...members.map((member) => canvasNodeBounds(member).height));
  members.forEach((member, index) => {
    targets.set(member.id, {
      x: origin.x + (index % columns) * (cellWidth + gap),
      y: origin.y + Math.floor(index / columns) * (cellHeight + gap),
    });
  });
  return targets;
}

function compareExistingClaim(
  left: WorkshopNode,
  right: WorkshopNode,
  child: WorkshopNode,
): number {
  const leftContains = containsNode(left, child);
  const rightContains = containsNode(right, child);
  if (leftContains !== rightContains) return leftContains ? -1 : 1;
  return compareFramePriority(left, right);
}

function compareFramePriority(left: WorkshopNode, right: WorkshopNode): number {
  const leftBounds = canvasNodeBounds(left);
  const rightBounds = canvasNodeBounds(right);
  const area = leftBounds.width * leftBounds.height - rightBounds.width * rightBounds.height;
  return area === 0 ? compareIds(left.id, right.id) : area;
}

function compareIssues(left: GroupMembershipIssue, right: GroupMembershipIssue): number {
  return (
    compareIds(left.childId, right.childId) ||
    compareIds(left.code, right.code) ||
    compareIds(left.frameIds.join('\0'), right.frameIds.join('\0'))
  );
}

function containsNode(frame: WorkshopNode, child: WorkshopNode): boolean {
  const outer = canvasNodeBounds(frame);
  const inner = canvasNodeBounds(child);
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function ownedMemberIds(nodes: readonly WorkshopNode[], frameId: string): string[] {
  return analyzeMembership(nodes)
    .memberships.filter((membership) => membership.frameId === frameId)
    .map((membership) => membership.childId)
    .sort(compareIds);
}

function nodesForIds(nodes: readonly WorkshopNode[], ids: readonly string[]): WorkshopNode[] {
  const byId = nodeIndex(nodes);
  return ids
    .map((id) => byId.get(id))
    .filter((node): node is WorkshopNode => node !== undefined && !isGroupFrame(node))
    .sort((left, right) => compareIds(left.id, right.id));
}

function lockedIds(nodes: readonly WorkshopNode[], ids: readonly string[]): string[] {
  return nodesForIds(nodes, ids)
    .filter((node) => node.data.locked)
    .map((node) => node.id)
    .sort(compareIds);
}

function groupFrames(nodes: readonly WorkshopNode[]): WorkshopNode[] {
  return nodes.filter(isGroupFrame).sort((left, right) => compareIds(left.id, right.id));
}

function findFrame(nodes: readonly WorkshopNode[], frameId: string): WorkshopNode | undefined {
  const node = nodeIndex(nodes).get(frameId);
  return node !== undefined && isGroupFrame(node) ? node : undefined;
}

function isGroupFrame(node: WorkshopNode): boolean {
  return node.data.kind === 'group-frame';
}

function childIds(frame: WorkshopNode): string[] {
  const value = frame.data.childNodeIds;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function withChildIds(frame: WorkshopNode, childNodeIds: readonly string[]): WorkshopNode {
  return { ...frame, data: { ...frame.data, childNodeIds: [...childNodeIds] } };
}

function membershipForDraggedNode(
  current: readonly string[],
  nodeId: string,
  shouldContain: boolean,
): string[] {
  let retained = false;
  const next = current.filter((id) => {
    if (id !== nodeId) return true;
    if (!shouldContain || retained) return false;
    retained = true;
    return true;
  });
  if (shouldContain && !retained) next.push(nodeId);
  return next;
}

function nodeIndex(nodes: readonly WorkshopNode[]): ReadonlyMap<string, WorkshopNode> {
  return new Map(nodes.map((node) => [node.id, node] as const));
}

function nodesWithUpdates(
  nodes: readonly WorkshopNode[],
  updates: ReadonlyMap<string, WorkshopNode>,
): WorkshopNode[] {
  return nodes.map((node) => updates.get(node.id) ?? node);
}

function unionBounds(bounds: readonly CanvasNodeBounds[]): CanvasNodeBounds {
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sameBounds(left: CanvasNodeBounds, right: CanvasNodeBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function resolvedDimension(
  explicit: number | null | undefined,
  measured: number | undefined,
  fallback: number,
): number {
  if (positiveFinite(explicit)) return explicit;
  return positiveFinite(measured) ? measured : fallback;
}

function geometryOption(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_GEOMETRY_OPTION, Math.max(0, value));
}

function boundedColumns(value: number | undefined, memberCount: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return Math.max(1, Math.ceil(Math.sqrt(memberCount)));
  }
  return Math.min(memberCount, value);
}

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finitePoint(point: { readonly x: number; readonly y: number }): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareIds);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compareIds);
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right);
}
