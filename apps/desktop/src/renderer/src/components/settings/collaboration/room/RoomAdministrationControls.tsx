import { useRef, useState } from 'react';
import type {
  CollaborationAuditEvent,
  CollaborationManagementMemberRole,
} from '@forgeboard/core/collaboration-management';

import type {
  CollaborationRoomMemberPage,
  CollaborationRoomMemberView,
} from '../../../../../../shared/collaboration/index.js';
import { RoomAuditControls } from './RoomAuditControls.js';
import { RoomMemberControls } from './RoomMemberControls.js';

interface RoomAdministrationControlsProps {
  readonly ownerSubject: string;
  readonly expiresAt: string | null;
  readonly disabled: boolean;
  readonly onRenew: () => Promise<void>;
}

export function RoomAdministrationControls({
  ownerSubject,
  expiresAt,
  disabled,
  onRenew,
}: RoomAdministrationControlsProps) {
  const [members, setMembers] = useState<CollaborationRoomMemberView[]>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [memberHasMore, setMemberHasMore] = useState(false);
  const [memberMessage, setMemberMessage] = useState<string | null>(null);
  const [memberResetSignal, setMemberResetSignal] = useState(0);
  const [auditEvents, setAuditEvents] = useState<CollaborationAuditEvent[]>([]);
  const [auditAfter, setAuditAfter] = useState<number | null>(null);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditMessage, setAuditMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationLock = useRef(false);
  const controlsBusy = disabled || busy;

  async function operation(action: () => Promise<void>): Promise<void> {
    if (operationLock.current || disabled) return;
    operationLock.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }

  async function loadMembers(replace: boolean): Promise<boolean> {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return false;
    const result = await collaboration.listRoomMembers({
      ...(replace || memberCursor === null ? {} : { after: memberCursor }),
      limit: 100,
    });
    if (!result.ok) {
      setMemberMessage(result.error.message);
      return false;
    }
    applyMemberPage(result.value, replace);
    setMemberMessage(
      result.value.members.length === 0
        ? replace
          ? 'No room members were returned.'
          : 'No additional room members were returned.'
        : `${replace ? 'Loaded' : 'Added'} ${String(result.value.members.length)} room members.`,
    );
    return true;
  }

  function applyMemberPage(page: CollaborationRoomMemberPage, replace: boolean): void {
    setMembers((current) => mergeMembers(replace ? [] : current, page.members));
    setMemberCursor(page.nextCursor);
    setMemberHasMore(page.hasMore);
  }

  async function refreshMembers(): Promise<void> {
    await operation(async () => {
      setMemberMessage('Loading room members…');
      await loadMembers(true);
    });
  }

  async function loadMoreMembers(): Promise<void> {
    await operation(async () => {
      setMemberMessage('Loading more room members…');
      await loadMembers(false);
    });
  }

  async function updateMember(
    member: CollaborationRoomMemberView,
    role: CollaborationManagementMemberRole,
  ): Promise<boolean> {
    let changed = false;
    await operation(async () => {
      const collaboration = window.forgeboard.collaboration;
      if (collaboration === undefined) return;
      setMemberMessage(null);
      const result = await collaboration.updateRoomMember({
        subject: member.subject,
        role,
        expectedTokenVersion: member.tokenVersion,
      });
      if (!result.ok) {
        if (isMembershipConflict(result.error.code)) {
          await loadMembers(true);
          setMemberResetSignal((current) => current + 1);
          setMemberMessage(
            'This member changed on the server. Review the current role and try again.',
          );
        } else setMemberMessage(result.error.message);
        return;
      }
      if (result.value === null) {
        setMemberMessage('Member role change was cancelled.');
        return;
      }
      setMembers((current) => mergeMembers(current, [result.value!.membership]));
      changed = result.value.changed;
      setMemberMessage(
        result.value.changed
          ? `Updated ${result.value.membership.displayName} to ${result.value.membership.role}.`
          : `${result.value.membership.displayName} already has that role.`,
      );
    });
    return changed;
  }

  async function revokeMember(member: CollaborationRoomMemberView): Promise<boolean> {
    let revoked = false;
    await operation(async () => {
      const collaboration = window.forgeboard.collaboration;
      if (collaboration === undefined) return;
      setMemberMessage(null);
      const result = await collaboration.revokeRoomMember({
        subject: member.subject,
        expectedTokenVersion: member.tokenVersion,
      });
      if (!result.ok) {
        if (isMembershipConflict(result.error.code)) {
          await loadMembers(true);
          setMemberResetSignal((current) => current + 1);
          setMemberMessage(
            'This member changed on the server. Review the current role and try again.',
          );
        } else setMemberMessage(result.error.message);
        return;
      }
      if (!result.value) {
        setMemberMessage('Member revocation was cancelled.');
        return;
      }
      setMembers((current) => current.filter((candidate) => candidate.subject !== member.subject));
      setMemberMessage(`Revoked ${member.displayName}.`);
      revoked = true;
    });
    return revoked;
  }

  async function loadAudit(replace: boolean): Promise<void> {
    await operation(async () => {
      const collaboration = window.forgeboard.collaboration;
      if (collaboration === undefined) return;
      setAuditMessage(replace ? 'Loading room audit…' : 'Loading more audit events…');
      const result = await collaboration.listRoomAudit({
        after: replace || auditAfter === null ? 0 : auditAfter,
        limit: 100,
      });
      if (!result.ok) {
        setAuditMessage(result.error.message);
        return;
      }
      setAuditEvents((current) => mergeAudit(replace ? [] : current, result.value.events));
      setAuditAfter(result.value.nextAfter);
      setAuditHasMore(result.value.hasMore);
      setAuditMessage(
        result.value.events.length === 0
          ? replace
            ? 'No room audit events were returned.'
            : 'No additional audit events were returned.'
          : `${replace ? 'Loaded' : 'Added'} ${String(result.value.events.length)} audit events.`,
      );
    });
  }

  return (
    <section aria-labelledby="collaboration-room-administration-heading">
      <h4 id="collaboration-room-administration-heading">Room administration</h4>
      <p>
        Owner session expires:{' '}
        {expiresAt === null ? 'unavailable for this connection' : formatTimestamp(expiresAt)}.
      </p>
      <button
        className="button"
        type="button"
        disabled={controlsBusy}
        onClick={() => void operation(onRenew)}
      >
        Renew owner session
      </button>
      <RoomMemberControls
        ownerSubject={ownerSubject}
        members={members}
        hasMore={memberHasMore}
        busy={controlsBusy}
        message={memberMessage}
        resetSignal={memberResetSignal}
        onRefresh={refreshMembers}
        onLoadMore={loadMoreMembers}
        onUpdate={updateMember}
        onRevoke={revokeMember}
      />
      <RoomAuditControls
        events={auditEvents}
        hasMore={auditHasMore}
        busy={controlsBusy}
        message={auditMessage}
        onRefresh={() => loadAudit(true)}
        onLoadMore={() => loadAudit(false)}
      />
    </section>
  );
}

function mergeMembers(
  current: CollaborationRoomMemberView[],
  incoming: CollaborationRoomMemberView[],
): CollaborationRoomMemberView[] {
  const members = new Map(current.map((member) => [member.subject, member]));
  for (const member of incoming) members.set(member.subject, member);
  return [...members.values()].sort((left, right) => left.subject.localeCompare(right.subject));
}

function mergeAudit(
  current: CollaborationAuditEvent[],
  incoming: CollaborationAuditEvent[],
): CollaborationAuditEvent[] {
  const events = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) events.set(event.sequence, event);
  return [...events.values()].sort((left, right) => left.sequence - right.sequence);
}

function isMembershipConflict(code: string): boolean {
  return code === 'membership_conflict' || code === 'membership_version_conflict';
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
