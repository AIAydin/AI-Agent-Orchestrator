import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type {
  CollaborationAwarenessEntry,
  CollaborationConnection,
  CollaborationInviteCreateInput,
  CollaborationInviteHistoryPage,
} from '../../../../../shared/collaboration/index.js';
import { SettingsSection } from '../shared.js';
import { CollaborationStatus } from './CollaborationStatus.js';
import {
  CollaborationProfileFields,
  CollaborationRoomField,
  ConnectionFields,
} from './ConnectionFields.js';
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
  const [invitePage, setInvitePage] = useState<CollaborationInviteHistoryPage | null>(null);
  const [inviteCursors, setInviteCursors] = useState<(string | null)[]>([null]);
  const [invitePageIndex, setInvitePageIndex] = useState(0);
  const [operationBusy, setOperationBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [inviteClearSignal, setInviteClearSignal] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(
    settings.collaborationUrl.trim() === '' || settings.collaborationManagementUrl.trim() === '',
  );
  const operationLock = useRef(false);
  const connectionIdRef = useRef(connection?.connectionId ?? null);
  connectionIdRef.current = connection?.connectionId ?? null;
  const ownerAccess = useOwnerRoomAccess({
    beginOperation,
    endOperation,
    setConnection,
    setMessage,
    onConnected: () => {
      enableCollaboration();
      setInviteClearSignal((current) => current + 1);
    },
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
          clearSession(setCollaborators, setInvitePage);
          setInviteClearSignal((current) => current + 1);
          setMessage('Collaboration is offline.');
          ownerAccess.clearExpiry();
        } else {
          // Do not let a completed management action mask live connecting/reconnecting/error state.
          setMessage(null);
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
    if (connection?.status === 'connected') {
      setInviteClearSignal((current) => current + 1);
    }
    setInvitePage(null);
    setInviteCursors([null]);
    setInvitePageIndex(0);
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
      if (result.ok) {
        enableCollaboration();
        setInviteClearSignal((current) => current + 1);
      }
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
      if (result.ok) enableCollaboration();
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
      clearSession(setCollaborators, setInvitePage);
      setInviteCursors([null]);
      setInvitePageIndex(0);
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

  function enableCollaboration(): void {
    setSettings((current) =>
      current.collaborationEnabled ? current : { ...current, collaborationEnabled: true },
    );
  }

  async function createInvite(input: CollaborationInviteCreateInput): Promise<void> {
    await manageInvite(async (collaboration) => {
      const result = await collaboration.createInvite(input);
      if (!result.ok) return setMessage(result.error.message);
      if (result.value === null) return setMessage('Invite creation was cancelled.');
      setMessage('Invite created. Refresh invite history to review and copy it.');
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
      if (result.value === null) return setMessage('Invite revocation was cancelled.');
      setInvitePage((current) =>
        current === null
          ? null
          : {
              ...current,
              invites: current.invites.map((invite) =>
                invite.id === inviteId ? result.value! : invite,
              ),
            },
      );
      setMessage('Invite revoked.');
    });
  }

  async function loadInvitePage(
    after: string | null,
  ): Promise<CollaborationInviteHistoryPage | null> {
    const expectedConnectionId = connectionIdRef.current;
    let page: CollaborationInviteHistoryPage | null = null;
    await manageInvite(async (collaboration) => {
      const result = await collaboration.listInvites({
        ...(after === null ? {} : { after }),
        limit: 50,
      });
      if (connectionIdRef.current !== expectedConnectionId) return;
      if (!result.ok) return setMessage(result.error.message);
      page = result.value;
      setInvitePage(result.value);
      setMessage('Invite history loaded.');
    });
    return page;
  }

  async function refreshInvites(): Promise<void> {
    if ((await loadInvitePage(null)) === null) return;
    setInviteCursors([null]);
    setInvitePageIndex(0);
  }

  async function nextInvites(): Promise<void> {
    const cursor = invitePage?.nextCursor;
    if (cursor === null || cursor === undefined || (await loadInvitePage(cursor)) === null) return;
    setInviteCursors((current) => [...current.slice(0, invitePageIndex + 1), cursor]);
    setInvitePageIndex((current) => current + 1);
  }

  async function previousInvites(): Promise<void> {
    if (invitePageIndex === 0) return;
    const previousIndex = invitePageIndex - 1;
    const cursor = inviteCursors[previousIndex] ?? null;
    if ((await loadInvitePage(cursor)) === null) return;
    setInvitePageIndex(previousIndex);
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
      title="Collaboration"
      description="Work together on the same canvas through a server your team controls."
    >
      <CollaborationStatus
        connection={connection}
        message={message}
        collaborators={collaborators}
      />
      {!connectionActive && (
        <>
          <CollaborationProfileFields
            settings={settings}
            setSettings={setSettings}
            disabled={inputDisabled}
          />
          <div className="collaboration-setup-grid">
            <section className="collaboration-setup-card primary" aria-labelledby="join-room-title">
              <span className="collaboration-card-kicker">Recommended</span>
              <h4 id="join-room-title">Join with an invite</h4>
              <p>
                Paste the link you received. New Forgeboard invites configure the server for you.
              </p>
              <InviteJoinControls
                settings={settings}
                setSettings={setSettings}
                disabled={inputDisabled}
                clearSignal={inviteClearSignal}
                onJoin={joinInvite}
              />
            </section>
            <section className="collaboration-setup-card" aria-labelledby="host-room-title">
              <h4 id="host-room-title">Create or recover a room</h4>
              <p>For room owners using a server their team already runs.</p>
              <CollaborationRoomField
                settings={settings}
                setSettings={setSettings}
                disabled={inputDisabled}
              />
              <RoomAccessControls
                settings={settings}
                busy={controlsBusy}
                onBootstrap={ownerAccess.bootstrapRoom}
                onRecover={ownerAccess.recoverOwner}
              />
            </section>
          </div>
          <details
            className="collaboration-advanced"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary>
              <span>
                <strong>Server and advanced options</strong>
                <small>Only needed for older invites, custom servers, or direct tokens.</small>
              </span>
            </summary>
            <div className="collaboration-advanced-fields">
              <label className="switch-row">
                <span>
                  <strong>Enable collaboration</strong>
                  <small>Joining a room turns this on automatically.</small>
                </span>
                <input
                  type="checkbox"
                  name="collaboration-enabled"
                  checked={settings.collaborationEnabled}
                  disabled={controlsBusy}
                  onChange={(event) => void setCollaborationEnabled(event.target.checked)}
                />
              </label>
              <ConnectionFields
                settings={settings}
                setSettings={setSettings}
                disabled={inputDisabled}
              />
              <DirectJoinControls
                accessToken={accessToken}
                setAccessToken={setAccessToken}
                disabled={inputDisabled}
                canConnect={canConnect}
                connecting={operationBusy && !connectionActive}
                onJoin={join}
              />
            </div>
          </details>
        </>
      )}
      {connectionActive && (
        <div className="button-row">
          <button
            className="button danger"
            type="button"
            disabled={controlsBusy}
            onClick={() => void leave()}
          >
            Leave room
          </button>
        </div>
      )}
      {connection?.status === 'connected' &&
        connection.role === 'owner' &&
        connection.managementBaseUrl !== undefined && (
          <>
            <InviteManagementControls
              page={invitePage}
              busy={controlsBusy}
              onCreate={createInvite}
              onCopy={copyInvite}
              onRevoke={revokeInvite}
              onRefresh={refreshInvites}
              onPrevious={previousInvites}
              onNext={nextInvites}
              canPrevious={invitePageIndex > 0}
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
  setInvites: Dispatch<SetStateAction<CollaborationInviteHistoryPage | null>>,
): void {
  setCollaborators([]);
  setInvites(null);
}

function unavailable(setMessage: Dispatch<SetStateAction<string | null>>): void {
  setMessage('Collaboration is not available in this build of Forgeboard.');
}

function validationFailure(): string {
  return "Forgeboard could not understand the collaboration server's response. Try again.";
}
