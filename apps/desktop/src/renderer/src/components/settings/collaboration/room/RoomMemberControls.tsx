import { useEffect, useRef, useState } from 'react';
import type { CollaborationManagementMemberRole } from '@forgeboard/core/collaboration-management';

import type { CollaborationRoomMemberView } from '../../../../../../shared/collaboration/index.js';

interface RoomMemberControlsProps {
  readonly ownerSubject: string;
  readonly members: CollaborationRoomMemberView[];
  readonly hasMore: boolean;
  readonly busy: boolean;
  readonly message: string | null;
  readonly resetSignal: number;
  readonly onRefresh: () => Promise<void>;
  readonly onLoadMore: () => Promise<void>;
  readonly onUpdate: (
    member: CollaborationRoomMemberView,
    role: CollaborationManagementMemberRole,
  ) => Promise<boolean>;
  readonly onRevoke: (member: CollaborationRoomMemberView) => Promise<boolean>;
}

export function RoomMemberControls(props: RoomMemberControlsProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section aria-labelledby="collaboration-members-heading">
      <h5 id="collaboration-members-heading" ref={heading} tabIndex={-1}>
        Room members
      </h5>
      <div className="button-row">
        <button
          className="button"
          type="button"
          disabled={props.busy}
          onClick={() => void props.onRefresh()}
        >
          Refresh room members
        </button>
        {props.hasMore && (
          <button
            className="button"
            type="button"
            disabled={props.busy}
            onClick={() => void props.onLoadMore()}
          >
            Load more members
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {props.message ?? 'Member data is loaded only when you request it.'}
      </p>
      {props.members.length > 0 && (
        <ul aria-label="Room members">
          {props.members.map((member) => (
            <MemberRow
              key={`${member.subject}:${String(member.tokenVersion)}:${String(props.resetSignal)}`}
              member={member}
              owner={member.subject === props.ownerSubject || member.role === 'owner'}
              busy={props.busy}
              onUpdate={props.onUpdate}
              onRevoke={async (selected) => {
                const removed = await props.onRevoke(selected);
                if (removed) heading.current?.focus();
                return removed;
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemberRow({
  member,
  owner,
  busy,
  onUpdate,
  onRevoke,
}: {
  readonly member: CollaborationRoomMemberView;
  readonly owner: boolean;
  readonly busy: boolean;
  readonly onUpdate: RoomMemberControlsProps['onUpdate'];
  readonly onRevoke: RoomMemberControlsProps['onRevoke'];
}) {
  const [draftRole, setDraftRole] = useState<CollaborationManagementMemberRole>(
    member.role === 'owner' ? 'editor' : member.role,
  );
  useEffect(() => {
    if (member.role !== 'owner') setDraftRole(member.role);
  }, [member.role, member.tokenVersion]);
  const identity = `${member.displayName} (${member.subject})`;

  return (
    <li>
      <strong>{identity}</strong> · {member.role}
      {owner ? (
        <span> · Current owner</span>
      ) : (
        <div className="two-column">
          <label>
            Role for {identity}
            <select
              name={`collaboration-member-role-${member.subject}`}
              value={draftRole}
              disabled={busy}
              onChange={(event) =>
                setDraftRole(event.target.value as CollaborationManagementMemberRole)
              }
            >
              <option value="editor">Editor</option>
              <option value="reviewer">Reviewer</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <div className="button-row">
            <button
              className="button"
              type="button"
              disabled={busy || draftRole === member.role}
              aria-label={`Review role change for ${identity}`}
              onClick={() => void onUpdate(member, draftRole)}
            >
              Review and apply role
            </button>
            <button
              className="button danger"
              type="button"
              disabled={busy}
              aria-label={`Revoke ${identity}`}
              onClick={() => void onRevoke(member)}
            >
              Revoke member
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
