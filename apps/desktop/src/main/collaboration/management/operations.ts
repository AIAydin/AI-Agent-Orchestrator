import { createHash, randomUUID } from 'node:crypto';
import type { BrowserWindow, Dialog } from 'electron';

import {
  CollaborationManagementOwnerAccessResponseSchema,
  CollaborationMemberMutationResponseSchema,
  type CollaborationAuditListResponse,
  type CollaborationManagementOwnerAccessResponse,
  type CollaborationMemberListResponse,
  type CollaborationMemberMutationResponse,
} from '@forgeboard/core/collaboration-management';
import {
  CollaborationJoinInputSchema,
  CollaborationOwnerRecoverJoinInputSchema,
  CollaborationOwnerSessionViewSchema,
  CollaborationRoomAuditListInputSchema,
  CollaborationRoomBootstrapJoinInputSchema,
  CollaborationRoomMemberListInputSchema,
  CollaborationRoomMemberRevokeInputSchema,
  CollaborationRoomMemberUpdateInputSchema,
  type CollaborationConnection,
  type CollaborationJoinResult,
  type CollaborationOwnerRecoverJoinInput,
  type CollaborationOwnerSessionView,
  type CollaborationRoomAuditListInput,
  type CollaborationRoomBootstrapJoinInput,
  type CollaborationRoomMemberListInput,
  type CollaborationRoomMemberRevokeInput,
  type CollaborationRoomMemberUpdateInput,
} from '../../../shared/collaboration/index.js';
import type {
  OutboundActionDisclosure,
  OutboundActionGate,
  OutboundExecutionPermit,
} from '../../outbound/outbound-action-gate.js';
import { createNativeOutboundConfirmation } from '../../outbound/native-confirmation.js';
import { CollaborationInviteSessionAuthority } from '../invites/session.js';
import {
  auditListDisclosure,
  memberRevokeDisclosure,
  memberUpdateDisclosure,
  membersListDisclosure,
  ownerRecoverDisclosure,
  ownerRefreshDisclosure,
  roomBootstrapDisclosure,
} from './disclosures.js';
import { CollaborationManagementHttpClient } from './http-client.js';

export interface CollaborationManagementNativeAuthority {
  readonly ownerId: string;
  readonly parent: BrowserWindow;
  readonly assertCurrent: () => void;
}

export interface CollaborationManagementOperationsOptions {
  readonly http?: Pick<
    CollaborationManagementHttpClient,
    | 'bootstrapRoom'
    | 'recoverOwner'
    | 'refreshOwner'
    | 'listMembers'
    | 'updateMember'
    | 'revokeMember'
    | 'listAudit'
  >;
  readonly session?: CollaborationInviteSessionAuthority;
  readonly createId?: () => string;
}

interface PendingOwnerAccess {
  readonly idempotencyKey: string;
  response?: CollaborationManagementOwnerAccessResponse;
}

/** Main-owned room administration. Access and administrator credentials never render or persist. */
export class CollaborationManagementOperations {
  readonly #http: NonNullable<CollaborationManagementOperationsOptions['http']>;
  readonly #session: CollaborationInviteSessionAuthority;
  readonly #createId: () => string;
  readonly #pendingEffects = new Map<string, string>();
  #pendingOwnerAccess: { key: string; value: PendingOwnerAccess } | null = null;

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly outbound: OutboundActionGate,
    options: CollaborationManagementOperationsOptions = {},
  ) {
    this.#http = options.http ?? new CollaborationManagementHttpClient();
    this.#session = options.session ?? new CollaborationInviteSessionAuthority();
    this.#createId = options.createId ?? randomUUID;
  }

  public clear(): void {
    this.#pendingOwnerAccess = null;
    this.clearPendingEffects();
  }

  /** Drops mutation retry IDs when the owning collaboration session is replaced. */
  public clearPendingEffects(): void {
    this.#pendingEffects.clear();
  }

  public dispose(): void {
    this.clear();
  }

  public async bootstrapAndJoin(
    authority: CollaborationManagementNativeAuthority,
    rawInput: CollaborationRoomBootstrapJoinInput,
    join: (
      input: ReturnType<typeof CollaborationJoinInputSchema.parse>,
    ) => Promise<CollaborationJoinResult>,
  ): Promise<CollaborationOwnerSessionView | null> {
    const input = CollaborationRoomBootstrapJoinInputSchema.parse(rawInput);
    const disclosure = roomBootstrapDisclosure({
      ...input,
      adminAuthorized: Boolean(input.adminToken),
    });
    return await this.#ownerAccessAndJoin(
      authority,
      input,
      disclosure,
      join,
      async (permit, pending) =>
        await this.#http.bootstrapRoom(
          permit,
          input.managementBaseUrl,
          pending.idempotencyKey,
          {
            roomId: input.roomId,
            owner: { id: input.subject, displayName: input.displayName },
          },
          input.adminToken,
        ),
    );
  }

  public async recoverAndJoin(
    authority: CollaborationManagementNativeAuthority,
    rawInput: CollaborationOwnerRecoverJoinInput,
    join: (
      input: ReturnType<typeof CollaborationJoinInputSchema.parse>,
    ) => Promise<CollaborationJoinResult>,
  ): Promise<CollaborationOwnerSessionView | null> {
    const input = CollaborationOwnerRecoverJoinInputSchema.parse(rawInput);
    const disclosure = ownerRecoverDisclosure({
      ...input,
      adminAuthorized: Boolean(input.adminToken),
    });
    return await this.#ownerAccessAndJoin(
      authority,
      input,
      disclosure,
      join,
      async (permit, pending) =>
        await this.#http.recoverOwner(
          permit,
          input.managementBaseUrl,
          input.roomId,
          pending.idempotencyKey,
          { ownerId: input.subject },
          input.adminToken,
        ),
    );
  }

  public async refresh(
    authority: CollaborationManagementNativeAuthority,
    connection: CollaborationConnection,
    replaceCredential: (accessToken: string) => void,
  ): Promise<CollaborationOwnerSessionView | null> {
    const lease = this.#ownerLease(connection);
    const disclosure = ownerRefreshDisclosure(lease);
    const effectKey = effectDigest(
      'refresh',
      lease.binding.managementBaseUrl,
      lease.binding.roomId,
      lease.binding.subject,
    );
    const result = await this.#confirmed(authority, disclosure, async (permit) => {
      authority.assertCurrent();
      const response = await this.#http.refreshOwner(
        permit,
        this.#session.assertCurrent(lease),
        this.#effectId(effectKey),
      );
      authority.assertCurrent();
      CollaborationManagementOwnerAccessResponseSchema.parse(response);
      this.#session.assertOwnerAccessRenewal(lease, response);
      replaceCredential(response.accessToken);
      this.#session.renewOwnerAccess(lease, response);
      this.#pendingEffects.delete(effectKey);
      return ownerSessionView(connection, response);
    });
    return result;
  }

  public async listMembers(
    authority: CollaborationManagementNativeAuthority,
    connection: CollaborationConnection,
    rawInput: CollaborationRoomMemberListInput,
  ): Promise<CollaborationMemberListResponse> {
    const input = CollaborationRoomMemberListInputSchema.parse(rawInput);
    const lease = this.#ownerLease(connection);
    return await this.#requiredConfirmed(
      authority,
      membersListDisclosure(lease, input.after),
      async (permit) =>
        await this.#http.listMembers(permit, this.#session.assertCurrent(lease), {
          ...(input.after === undefined ? {} : { after: input.after }),
          limit: input.limit,
        }),
    );
  }

  public async updateMember(
    authority: CollaborationManagementNativeAuthority,
    connection: CollaborationConnection,
    rawInput: CollaborationRoomMemberUpdateInput,
  ): Promise<CollaborationMemberMutationResponse | null> {
    const input = CollaborationRoomMemberUpdateInputSchema.parse(rawInput);
    const lease = this.#ownerLease(connection);
    const effectKey = effectDigest(
      'update',
      lease.binding.managementBaseUrl,
      lease.binding.roomId,
      input.subject,
      input.role,
      input.expectedTokenVersion,
    );
    return await this.#confirmed(
      authority,
      memberUpdateDisclosure(lease, input),
      async (permit) => {
        const value = await this.#http.updateMember(
          permit,
          this.#session.assertCurrent(lease),
          this.#effectId(effectKey),
          input.subject,
          {
            role: input.role,
            expectedTokenVersion: input.expectedTokenVersion,
          },
        );
        authority.assertCurrent();
        this.#pendingEffects.delete(effectKey);
        return CollaborationMemberMutationResponseSchema.parse(value);
      },
    );
  }

  public async revokeMember(
    authority: CollaborationManagementNativeAuthority,
    connection: CollaborationConnection,
    rawInput: CollaborationRoomMemberRevokeInput,
  ): Promise<boolean> {
    const input = CollaborationRoomMemberRevokeInputSchema.parse(rawInput);
    const lease = this.#ownerLease(connection);
    const effectKey = effectDigest(
      'revoke',
      lease.binding.managementBaseUrl,
      lease.binding.roomId,
      input.subject,
      input.expectedTokenVersion,
    );
    const result = await this.#confirmed(
      authority,
      memberRevokeDisclosure(lease, input),
      async (permit) => {
        await this.#http.revokeMember(
          permit,
          this.#session.assertCurrent(lease),
          this.#effectId(effectKey),
          input.subject,
          input.expectedTokenVersion,
        );
        authority.assertCurrent();
        this.#pendingEffects.delete(effectKey);
        return true;
      },
    );
    return result ?? false;
  }

  public async listAudit(
    authority: CollaborationManagementNativeAuthority,
    connection: CollaborationConnection,
    rawInput: CollaborationRoomAuditListInput,
  ): Promise<CollaborationAuditListResponse> {
    const input = CollaborationRoomAuditListInputSchema.parse(rawInput);
    const lease = this.#ownerLease(connection);
    return await this.#requiredConfirmed(
      authority,
      auditListDisclosure(lease, input.after),
      async (permit) =>
        await this.#http.listAudit(permit, this.#session.assertCurrent(lease), input),
    );
  }

  async #ownerAccessAndJoin(
    authority: CollaborationManagementNativeAuthority,
    input: CollaborationRoomBootstrapJoinInput,
    disclosure: ReturnType<typeof roomBootstrapDisclosure>,
    join: (
      input: ReturnType<typeof CollaborationJoinInputSchema.parse>,
    ) => Promise<CollaborationJoinResult>,
    request: (
      permit: OutboundExecutionPermit,
      pending: PendingOwnerAccess,
    ) => Promise<CollaborationManagementOwnerAccessResponse>,
  ): Promise<CollaborationOwnerSessionView | null> {
    const key = ownerAccessDigest(input, disclosure.action);
    const pending = this.#ownerPending(key);
    return await this.#confirmed(authority, disclosure, async (permit) => {
      authority.assertCurrent();
      pending.response ??= await request(permit, pending);
      authority.assertCurrent();
      const response = CollaborationManagementOwnerAccessResponseSchema.parse(pending.response);
      const joinInput = CollaborationJoinInputSchema.parse({
        serverUrl: input.serverUrl,
        managementBaseUrl: input.managementBaseUrl,
        roomId: response.room.id,
        subject: response.membership.subject,
        displayName: response.membership.displayName,
        color: input.color,
        accessToken: response.accessToken,
        reconnect: input.reconnect,
      });
      const joined = await join(joinInput);
      authority.assertCurrent();
      if (!joined.ok) throw new Error(joined.error.message);
      this.#session.establishOwnerAccess(input.serverUrl, input.managementBaseUrl, response);
      this.#pendingOwnerAccess = null;
      return ownerSessionView(joined.connection, response);
    });
  }

  #ownerPending(key: string): PendingOwnerAccess {
    if (this.#pendingOwnerAccess?.key !== key) {
      this.#pendingOwnerAccess = {
        key,
        value: { idempotencyKey: this.#createId() },
      };
    }
    return this.#pendingOwnerAccess.value;
  }

  #effectId(key: string): string {
    const existing = this.#pendingEffects.get(key);
    if (existing !== undefined) return existing;
    if (this.#pendingEffects.size >= 32)
      this.#pendingEffects.delete(this.#pendingEffects.keys().next().value!);
    const id = this.#createId();
    this.#pendingEffects.set(key, id);
    return id;
  }

  #ownerLease(connection: CollaborationConnection) {
    if (connection.managementBaseUrl === undefined) {
      throw new Error('Reconnect with a collaboration management URL to administer this room.');
    }
    return this.#session.ownerLease(
      connection.serverUrl,
      connection.managementBaseUrl,
      connection.roomId,
    );
  }

  async #requiredConfirmed<Value>(
    authority: CollaborationManagementNativeAuthority,
    disclosure: OutboundActionDisclosure,
    execute: (permit: OutboundExecutionPermit) => Promise<Value>,
  ): Promise<Value> {
    const value = await this.#confirmed(authority, disclosure, execute);
    if (value === null) throw new Error('The collaboration management read was cancelled.');
    return value as Value;
  }

  async #confirmed<Value>(
    authority: CollaborationManagementNativeAuthority,
    disclosure: OutboundActionDisclosure,
    execute: (permit: OutboundExecutionPermit) => Promise<Value>,
  ): Promise<Value | null> {
    const plan = this.outbound.prepare(authority.ownerId, disclosure);
    const result = await this.outbound.confirmAndExecute({
      ownerId: authority.ownerId,
      planId: plan.id,
      confirmation: createNativeOutboundConfirmation({
        assertCurrent: authority.assertCurrent,
        show: async (options) =>
          (await this.dialog.showMessageBox(authority.parent, options)).response,
      }),
      currentDisclosure: () => {
        authority.assertCurrent();
        return disclosure;
      },
      execute,
    });
    return result.outcome === 'denied' ? null : result.value;
  }
}

function ownerSessionView(
  connection: CollaborationConnection,
  response: CollaborationManagementOwnerAccessResponse,
): CollaborationOwnerSessionView {
  return CollaborationOwnerSessionViewSchema.parse({
    connection,
    expiresAt: response.expiresAt,
    tokenVersion: response.membership.tokenVersion,
  });
}

function ownerAccessDigest(input: CollaborationRoomBootstrapJoinInput, action: string): string {
  const hash = createHash('sha256');
  hash.update(action);
  hash.update('\0');
  hash.update(input.serverUrl);
  hash.update('\0');
  hash.update(input.managementBaseUrl);
  hash.update('\0');
  hash.update(input.roomId);
  hash.update('\0');
  hash.update(input.subject);
  hash.update('\0');
  hash.update(input.displayName);
  hash.update('\0');
  hash.update(input.color);
  hash.update('\0');
  hash.update(input.adminToken ?? '');
  hash.update('\0');
  hash.update(input.reconnect ? '1' : '0');
  return hash.digest('hex');
}

function effectDigest(...parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
