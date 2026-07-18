import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type {
  CollaborationAwarenessEntry,
  CollaborationConnection,
  CollaborationInviteCreateInput,
  CollaborationInviteSafeView,
} from '../../../../../shared/collaboration/index.js';
import { SettingsSection } from '../shared.js';
import { CollaborationStatus } from './CollaborationStatus.js';
import { ConnectionFields } from './ConnectionFields.js';
import { DirectJoinControls } from './DirectJoinControls.js';
import { InviteJoinControls } from './InviteJoinControls.js';
import { InviteManagementControls } from './InviteManagementControls.js';
import { RoomAccessControls } from './room/RoomAccessControls.js';
import { RoomAdministrationControls } from './room/RoomAdministrationControls.js';
import { useOwnerRoomAccess } from './room/useOwnerRoomAccess.js';

interface CollaborationSettingsProps {
  readonly settings: AppSettings;
  readonly setSettings: Dispatch<SetStateAction<AppSettings>>;
  readonly busy: boolean;
}

export function CollaborationSettings({ settings, setSettings, busy }: CollaborationSettingsProps) {
  const [accessToken, setAccessToken] = useState('');
  const [connection, setConnection] = useState<CollaborationConnection | null>(null);
  const [collaborators, setCollaborators] = useState<CollaborationAwarenessEntry[]>([]);
  const [sessionInvites, setSessionInvites] = useState<CollaborationInviteSafeView[]>([]);
  const [operationBusy, setOperationBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inviteClearSignal, setInviteClearSignal] = useState(0);
  const operationLock = useRef(false);
  const ownerAccess = useOwnerRoomAccess({
    beginOperation,
    endOperation,
    setConnection,
    setMessage,
    onConnected: () => setInviteClearSignal((current) => current + 1),
  });

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return;
    let active = true;
    let eventObserved = false;
    void collaboration
      .get()
      .then((result) => {
        if (!active || eventObserved) return;
        if (result.ok) setConnection(result.value);
        else setMessage(result.error.message);
      })
      .catch(() => {
        if (active && !eventObserved) setMessage(validationFailure());
      });
    const unsubscribe = collaboration.onEvent((event) => {
      if (!active) return;
      eventObserved = true;
      if (event.type === 'status-changed') {
        setConnection(event.connection);
        if (event.connection.status === 'connected') {
          setMessage(`Connected to room ${event.connection.roomId}.`);
        } else if (event.connection.status === 'offline') {
          clearSession(setCollaborators, setSessionInvites);
          setInviteClearSignal((current) => current + 1);
          setMessage('Collaboration is offline.');
          ownerAccess.clearExpiry();
        }
      } else if (event.type === 'awareness-changed') {
        setCollaborators(event.states);
      } else if (event.type === 'connection-error') {
        setMessage(event.error.message);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const collaboration = window.forgeboard.collaboration;
    if (connection?.status === 'connected') {
      setInviteClearSignal((current) => current + 1);
    }
    if (
      connection?.status !== 'connected' ||
      connection.role !== 'owner' ||
      connection.managementBaseUrl === undefined
    ) {
      setSessionInvites([]);
      return;
    }
    let active = true;
    void collaboration
      ?.listSessionInvites()
      .then((result) => {
        if (!active) return;
        if (result.ok) setSessionInvites(result.value);
        else setMessage(result.error.message);
      })
      .catch(() => {
        if (active) setMessage('Forgeboard could not load session invites.');
      });
    return () => {
      active = false;
    };
  }, [
    connection?.connectionId,
    connection?.managementBaseUrl,
    connection?.role,
    connection?.status,
  ]);

  const connectionActive =
    connection !== null && connection.status !== 'offline' && connection.status !== 'error';
  const controlsBusy = busy || operationBusy;
  const inputDisabled = controlsBusy || connectionActive;
  const canConnect =
    settings.collaborationEnabled &&
    settings.collaborationUrl.trim() !== '' &&
    settings.collaborationRoom.trim() !== '' &&
    settings.collaborationDisplayName.trim() !== '' &&
    settings.collaborationSubject.trim() !== '' &&
    accessToken.trim() !== '' &&
    !inputDisabled;

  async function join(): Promise<void> {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return unavailable(setMessage);
    if (!beginOperation()) return;
    setMessage(null);
    try {
      const result = await collaboration.join({
        serverUrl: settings.collaborationUrl,
        managementBaseUrl: settings.collaborationManagementUrl || undefined,
        roomId: settings.collaborationRoom,
        subject: settings.collaborationSubject,
        displayName: settings.collaborationDisplayName,
        color: settings.collaborationColor,
        accessToken,
        reconnect: settings.collaborationReconnect,
      });
      applyJoinResult(result, setConnection, setMessage);
      if (result.ok) setInviteClearSignal((current) => current + 1);
    } catch {
      setMessage(validationFailure());
    } finally {
      setAccessToken('');
      endOperation();
    }
  }

  async function joinInvite(inviteLink: string): Promise<void> {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return unavailable(setMessage);
    if (!beginOperation()) return;
    setMessage(null);
    try {
      const result = await collaboration.joinInvite({
        serverUrl: settings.collaborationUrl,
        managementBaseUrl: settings.collaborationManagementUrl,
        inviteLink,
        subject: settings.collaborationSubject,
        displayName: settings.collaborationDisplayName,
        color: settings.collaborationColor,
        reconnect: settings.collaborationReconnect,
      });
      applyJoinResult(result, setConnection, setMessage);
    } catch {
      setMessage(validationFailure());
    } finally {
      endOperation();
    }
  }

  async function leave(): Promise<boolean> {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined) return false;
    if (!beginOperation()) return false;
    setMessage(null);
    try {
      const result = await collaboration.leave();
      if (!result.ok) {
        setMessage(result.error.message);
        return false;
      }
      setConnection(null);
      clearSession(setCollaborators, setSessionInvites);
      setAccessToken('');
      setInviteClearSignal((current) => current + 1);
      setMessage('Left the collaboration room.');
      ownerAccess.clearExpiry();
      return true;
    } catch {
      setMessage(validationFailure());
      return false;
    } finally {
      endOperation();
    }
  }

  async function setCollaborationEnabled(enabled: boolean): Promise<void> {
    if (!enabled && connectionActive && !(await leave())) return;
    setSettings((current) => ({ ...current, collaborationEnabled: enabled }));
  }

  async function createInvite(input: CollaborationInviteCreateInput): Promise<void> {
    await manageInvite(async (collaboration) => {
      const result = await collaboration.createInvite(input);
      if (!result.ok) return setMessage(result.error.message);
      if (result.value === null) return setMessage('Invite creation was cancelled.');
      const invite = result.value;
      setSessionInvites((current) => [
        ...current.filter((currentInvite) => currentInvite.id !== invite.id),
        invite,
      ]);
      setMessage('Invite created. Use Copy to share it securely.');
    });
  }

  async function copyInvite(inviteId: string): Promise<void> {
    await manageInvite(async (collaboration) => {
      const result = await collaboration.copyInviteLink({ inviteId });
      setMessage(
        result.ok && result.value
          ? 'Invite link copied.'
          : result.ok
            ? 'Copy cancelled.'
            : result.error.message,
      );
    });
  }

  async function revokeInvite(inviteId: string): Promise<void> {
    await manageInvite(async (collaboration) => {
      const result = await collaboration.revokeInvite({ inviteId });
      if (!result.ok) return setMessage(result.error.message);
      if (!result.value) return setMessage('Invite revocation was cancelled.');
      setSessionInvites((current) => current.filter((invite) => invite.id !== inviteId));
      setMessage('Invite revoked.');
    });
  }

  async function manageInvite(
    action: (collaboration: NonNullable<typeof window.forgeboard.collaboration>) => Promise<void>,
  ): Promise<void> {
    const collaboration = window.forgeboard.collaboration;
    if (collaboration === undefined || !beginOperation()) return;
    setMessage(null);
    try {
      await action(collaboration);
    } catch {
      setMessage(validationFailure());
    } finally {
      endOperation();
    }
  }

  function beginOperation(): boolean {
    if (operationLock.current) return false;
    operationLock.current = true;
    setOperationBusy(true);
    return true;
  }

  function endOperation(): void {
    operationLock.current = false;
    setOperationBusy(false);
  }

  return (
    <SettingsSection
      title="Self-hosted collaboration"
      description="Work with others in real time through a server your team runs. Join a room only when you choose to; access tokens and invite links are never saved."
    >
      <label className="switch-row">
        <span>
          <strong>Enable collaboration</strong>
          <small>A connection starts only when you choose a join action and approve it.</small>
        </span>
        <input
          type="checkbox"
          name="collaboration-enabled"
          checked={settings.collaborationEnabled}
          disabled={controlsBusy}
          onChange={(event) => void setCollaborationEnabled(event.target.checked)}
        />
      </label>
      <ConnectionFields settings={settings} setSettings={setSettings} disabled={inputDisabled} />
      <InviteJoinControls
        settings={settings}
        disabled={inputDisabled}
        clearSignal={inviteClearSignal}
        onJoin={joinInvite}
      />
      <DirectJoinControls
        accessToken={accessToken}
        setAccessToken={setAccessToken}
        disabled={inputDisabled}
        canConnect={canConnect}
        connecting={operationBusy && !connectionActive}
        onJoin={join}
      />
      {!connectionActive && (
        <RoomAccessControls
          settings={settings}
          busy={controlsBusy}
          onBootstrap={ownerAccess.bootstrapRoom}
          onRecover={ownerAccess.recoverOwner}
        />
      )}
      <div className="button-row">
        <button
          className="button"
          type="button"
          disabled={controlsBusy || !connectionActive}
          onClick={() => void leave()}
        >
          Leave room
        </button>
      </div>
      <CollaborationStatus
        connection={connection}
        message={message}
        collaborators={collaborators}
      />
      {connection?.status === 'connected' &&
        connection.role === 'owner' &&
        connection.managementBaseUrl !== undefined && (
          <>
            <InviteManagementControls
              invites={sessionInvites}
              busy={controlsBusy}
              onCreate={createInvite}
              onCopy={copyInvite}
              onRevoke={revokeInvite}
            />
            <RoomAdministrationControls
              ownerSubject={connection.subject}
              expiresAt={ownerAccess.expiresAt}
              disabled={controlsBusy}
              onRenew={ownerAccess.refreshOwner}
            />
          </>
        )}
    </SettingsSection>
  );
}

function applyJoinResult(
  result: Awaited<ReturnType<NonNullable<typeof window.forgeboard.collaboration>['join']>>,
  setConnection: Dispatch<SetStateAction<CollaborationConnection | null>>,
  setMessage: Dispatch<SetStateAction<string | null>>,
): void {
  if (result.ok) {
    setConnection(result.connection);
    setMessage(`Connected to room ${result.connection.roomId}.`);
  } else setMessage(result.error.message);
}

function clearSession(
  setCollaborators: Dispatch<SetStateAction<CollaborationAwarenessEntry[]>>,
  setInvites: Dispatch<SetStateAction<CollaborationInviteSafeView[]>>,
): void {
  setCollaborators([]);
  setInvites([]);
}

function unavailable(setMessage: Dispatch<SetStateAction<string | null>>): void {
  setMessage('Collaboration is not available in this build of Forgeboard.');
}

function validationFailure(): string {
  return "Forgeboard could not understand the collaboration server's response. Try again.";
}
