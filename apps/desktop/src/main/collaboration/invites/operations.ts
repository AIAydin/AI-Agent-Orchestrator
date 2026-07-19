import { createHash } from 'node:crypto';
import type { BrowserWindow, Dialog } from 'electron';

import {
  CollaborationInviteCreateInputSchema,
  CollaborationInviteHistoryPageSchema,
  CollaborationInviteHistoryViewSchema,
  CollaborationInviteIdSchema,
  CollaborationInviteListInputSchema,
  CollaborationInviteSafeViewSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinInviteInputSchema,
  collaborationInviteTokenFromLink,
  type CollaborationConnection,
  type CollaborationInviteCreateInput,
  type CollaborationInviteHistoryPage,
  type CollaborationInviteHistoryView,
  type CollaborationInviteListInput,
  type CollaborationInviteRedeemResponse,
  type CollaborationInviteSafeView,
  type CollaborationJoinInput,
  type CollaborationJoinInviteInput,
  type CollaborationJoinResult,
} from '../../../shared/collaboration/index.js';
import type { OutboundActionGate } from '../../outbound/outbound-action-gate.js';
import { createNativeOutboundConfirmation } from '../../outbound/native-confirmation.js';
import {
  inviteCreateDisclosure,
  inviteListDisclosure,
  inviteRedeemDisclosure,
  inviteRevokeDisclosure,
} from './disclosures.js';
import { CollaborationInviteHttpClient } from './http-client.js';
import { confirmInviteLinkCopy } from './native-copy.js';
import { CollaborationInviteSessionAuthority } from './session.js';

export interface CollaborationInviteNativeAuthority {
  readonly ownerId: string;
  readonly parent: BrowserWindow;
  readonly assertCurrent: () => void;
}

export interface CollaborationInviteOperationsOptions {
  readonly http?: Pick<
    CollaborationInviteHttpClient,
    'createInvite' | 'redeemInvite' | 'revokeInvite'
  > &
    Partial<Pick<CollaborationInviteHttpClient, 'listInvites'>>;
  readonly session?: CollaborationInviteSessionAuthority;
  readonly clipboard?: { writeText(value: string): void };
}

/** Main-owned invite orchestration. Access credentials and invite links never leave this boundary. */
export class CollaborationInviteOperations {
  readonly #http: NonNullable<CollaborationInviteOperationsOptions['http']>;
  readonly #session: CollaborationInviteSessionAuthority;
  readonly #clipboard: NonNullable<CollaborationInviteOperationsOptions['clipboard']>;
  readonly #pendingRedemptions = new Map<string, CollaborationInviteRedeemResponse>();

  public constructor(
    private readonly dialog: Pick<Dialog, 'showMessageBox'>,
    private readonly outbound: OutboundActionGate,
    options: CollaborationInviteOperationsOptions = {},
  ) {
    this.#http = options.http ?? new CollaborationInviteHttpClient();
    this.#session = options.session ?? new CollaborationInviteSessionAuthority();
    this.#clipboard = options.clipboard ?? {
      writeText: () => {
        throw new Error('The native clipboard is unavailable.');
      },
    };
  }

  public establishDirect(input: CollaborationJoinInput, connection: CollaborationConnection): void {
    const parsed = CollaborationJoinInputSchema.parse(input);
    if (parsed.managementBaseUrl === undefined || connection.role === undefined) {
      this.#session.clearForLeave();
      return;
    }
    this.#session.establish({
      serverUrl: parsed.serverUrl,
      managementBaseUrl: parsed.managementBaseUrl,
      roomId: connection.roomId,
      subject: connection.subject,
      role: connection.role,
      accessToken: parsed.accessToken,
    });
  }

  public clear(): void {
    this.#pendingRedemptions.clear();
    this.#session.clearForLeave();
  }

  public dispose(): void {
    this.#pendingRedemptions.clear();
    this.#session.dispose();
  }

  public async listHistory(
    authority: CollaborationInviteNativeAuthority,
    connection: CollaborationConnection,
    rawInput: CollaborationInviteListInput,
  ): Promise<CollaborationInviteHistoryPage> {
    const input = CollaborationInviteListInputSchema.parse(rawInput);
    const lease = this.#ownerLease(connection);
    const disclosure = inviteListDisclosure(lease, input);
    const plan = this.outbound.prepare(authority.ownerId, disclosure);
    const result = await this.outbound.confirmAndExecute({
      ownerId: authority.ownerId,
      planId: plan.id,
      confirmation: this.#confirmation(authority),
      currentDisclosure: () => {
        authority.assertCurrent();
        this.#session.assertCurrent(lease);
        return inviteListDisclosure(lease, input);
      },
      execute: async (permit) => {
        authority.assertCurrent();
        if (this.#http.listInvites === undefined) {
          throw new Error('Collaboration invite history is unavailable.');
        }
        const page = await this.#http.listInvites(permit, this.#session.assertCurrent(lease), {
          ...(input.after === undefined ? {} : { after: input.after }),
          limit: input.limit,
        });
        authority.assertCurrent();
        return this.#session.recordListedPage(lease, page);
      },
    });
    if (result.outcome === 'denied') {
      throw new Error('The collaboration invite history request was cancelled.');
    }
    return CollaborationInviteHistoryPageSchema.parse(result.value);
  }

  public async create(
    authority: CollaborationInviteNativeAuthority,
    connection: CollaborationConnection,
    rawInput: CollaborationInviteCreateInput,
  ): Promise<CollaborationInviteSafeView | null> {
    const input = CollaborationInviteCreateInputSchema.parse(rawInput);
    const lease = this.#ownerLease(connection);
    this.#session.assertCanCreateInvite(lease);
    const disclosure = inviteCreateDisclosure(lease, input);
    const plan = this.outbound.prepare(authority.ownerId, disclosure);
    const result = await this.outbound.confirmAndExecute({
      ownerId: authority.ownerId,
      planId: plan.id,
      confirmation: this.#confirmation(authority),
      currentDisclosure: () => {
        authority.assertCurrent();
        this.#session.assertCanCreateInvite(lease);
        return inviteCreateDisclosure(lease, input);
      },
      execute: async (permit) => {
        authority.assertCurrent();
        const invite = await this.#http.createInvite(
          permit,
          this.#session.assertCurrent(lease),
          input,
        );
        try {
          authority.assertCurrent();
          this.#session.recordCreatedInvite(lease, invite);
        } catch (error) {
          try {
            await this.#http.revokeInvite(permit, lease.binding, invite.id);
          } catch {
            // The original authority failure is the actionable result. Revocation is best effort.
          }
          throw error;
        }
        return this.#session
          .createdInviteViews(lease)
          .find((candidate) => candidate.id === invite.id);
      },
    });
    if (result.outcome === 'denied') return null;
    if (result.value === undefined) throw new Error('The created invite could not be retained.');
    return CollaborationInviteSafeViewSchema.parse(result.value);
  }

  public async copy(
    authority: CollaborationInviteNativeAuthority,
    connection: CollaborationConnection,
    rawInviteId: string,
  ): Promise<boolean> {
    const inviteId = CollaborationInviteIdSchema.parse(rawInviteId);
    const lease = this.#ownerLease(connection);
    const invite = this.#session
      .createdInviteViews(lease)
      .find((candidate) => candidate.id === inviteId);
    if (invite === undefined)
      throw new Error('This invite is not available in the current session.');
    const approved = await confirmInviteLinkCopy({
      dialog: this.dialog,
      parent: authority.parent,
      invite,
      assertCurrent: () => {
        authority.assertCurrent();
        this.#session.assertCurrent(lease);
      },
    });
    if (!approved) return false;
    authority.assertCurrent();
    const link = this.#session.inviteLinkForCopy(lease, inviteId);
    this.#clipboard.writeText(link);
    return true;
  }

  public async revoke(
    authority: CollaborationInviteNativeAuthority,
    connection: CollaborationConnection,
    rawInviteId: string,
  ): Promise<CollaborationInviteHistoryView | null> {
    const inviteId = CollaborationInviteIdSchema.parse(rawInviteId);
    const lease = this.#ownerLease(connection);
    this.#session.authorizeRevoke(lease, inviteId);
    const disclosure = inviteRevokeDisclosure(lease, inviteId);
    const plan = this.outbound.prepare(authority.ownerId, disclosure);
    const result = await this.outbound.confirmAndExecute({
      ownerId: authority.ownerId,
      planId: plan.id,
      confirmation: this.#confirmation(authority),
      currentDisclosure: () => {
        authority.assertCurrent();
        this.#session.authorizeRevoke(lease, inviteId);
        return inviteRevokeDisclosure(lease, inviteId);
      },
      execute: async (permit) => {
        authority.assertCurrent();
        const revoked = await this.#http.revokeInvite(
          permit,
          this.#session.authorizeRevoke(lease, inviteId),
          inviteId,
        );
        authority.assertCurrent();
        this.#session.recordRevokedInvite(lease, inviteId);
        return CollaborationInviteHistoryViewSchema.parse({
          ...revoked,
          copyAvailable: false,
        });
      },
    });
    return result.outcome === 'allowed' ? result.value : null;
  }

  public async redeemAndJoin(
    authority: CollaborationInviteNativeAuthority,
    rawInput: CollaborationJoinInviteInput,
    join: (input: CollaborationJoinInput) => Promise<CollaborationJoinResult>,
  ): Promise<CollaborationJoinResult> {
    const input = CollaborationJoinInviteInputSchema.parse(rawInput);
    const redemptionKey = inviteRedemptionKey(input);
    const disclosure = inviteRedeemDisclosure(input);
    const plan = this.outbound.prepare(authority.ownerId, disclosure);
    const result = await this.outbound.confirmAndExecute({
      ownerId: authority.ownerId,
      planId: plan.id,
      confirmation: this.#confirmation(authority),
      currentDisclosure: () => {
        authority.assertCurrent();
        return inviteRedeemDisclosure(input);
      },
      execute: async (permit) => {
        authority.assertCurrent();
        let redeemed = this.#pendingRedemptions.get(redemptionKey);
        if (redeemed === undefined) {
          this.#pendingRedemptions.clear();
          redeemed = await this.#http.redeemInvite(permit, input.managementBaseUrl, {
            token: collaborationInviteTokenFromLink(input.inviteLink),
            subject: input.subject,
            displayName: input.displayName,
          });
          authority.assertCurrent();
          this.#pendingRedemptions.set(redemptionKey, structuredClone(redeemed));
        }
        authority.assertCurrent();
        this.#session.clearForLeave();
        const joinInput = CollaborationJoinInputSchema.parse({
          serverUrl: input.serverUrl,
          managementBaseUrl: input.managementBaseUrl,
          roomId: redeemed.room.id,
          subject: redeemed.membership.subject,
          displayName: redeemed.membership.displayName,
          color: input.color,
          accessToken: redeemed.accessToken,
          reconnect: input.reconnect,
        });
        const joined = await join(joinInput);
        if (!joined.ok) return joined;
        authority.assertCurrent();
        this.#session.establishRedeemed(input.serverUrl, input.managementBaseUrl, redeemed);
        this.#pendingRedemptions.delete(redemptionKey);
        return joined;
      },
    });
    return result.outcome === 'denied'
      ? {
          ok: false,
          error: {
            code: 'cancelled',
            message: 'The collaboration invite redemption was cancelled.',
            retryable: false,
          },
        }
      : result.value;
  }

  #ownerLease(connection: CollaborationConnection) {
    if (connection.managementBaseUrl === undefined) {
      throw new Error('Reconnect with an explicit collaboration management URL to manage invites.');
    }
    return this.#session.ownerLease(
      connection.serverUrl,
      connection.managementBaseUrl,
      connection.roomId,
    );
  }

  #confirmation(authority: CollaborationInviteNativeAuthority) {
    return createNativeOutboundConfirmation({
      assertCurrent: authority.assertCurrent,
      show: async (options) =>
        (await this.dialog.showMessageBox(authority.parent, options)).response,
    });
  }
}

function inviteRedemptionKey(input: CollaborationJoinInviteInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inviteLink: input.inviteLink,
        serverUrl: input.serverUrl,
        managementBaseUrl: input.managementBaseUrl,
        subject: input.subject,
        displayName: input.displayName,
        color: input.color,
        reconnect: input.reconnect,
      }),
    )
    .digest('hex');
}
