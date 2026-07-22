import {
  CollaborationInviteHistoryPageSchema,
  CollaborationInviteIdSchema,
  CollaborationInviteSchema,
  collaborationInviteLinkWithConnection,
  CollaborationInviteRedeemResponseSchema,
  CollaborationInviteSessionBindingSchema,
  CollaborationManagementUrlSchema,
  CollaborationServerUrlSchema,
  type CollaborationInvite,
  type CollaborationInviteHistoryPage,
  type CollaborationInviteRedeemResponse,
  type CollaborationInviteSafeView,
  type CollaborationInviteSessionBinding,
} from '../../../shared/collaboration/index.js';
import {
  CollaborationInviteListResponseSchema,
  CollaborationManagementOwnerAccessResponseSchema,
  type CollaborationInviteListResponse,
  type CollaborationManagementInvite,
  type CollaborationManagementOwnerAccessResponse,
} from '@forgeboard/core/collaboration-management';
import { z } from 'zod';

const RenewedOwnerAccessClaimsSchema = z
  .object({
    iss: z.literal('forgeboard-collab'),
    aud: z.literal('forgeboard-collab-client'),
    typ: z.literal('access'),
    jti: z.string().uuid(),
    roomId: z.string(),
    role: z.literal('owner'),
    sub: z.string(),
    ver: z.number().int().nonnegative().safe(),
    iat: z.number().int().nonnegative().safe(),
    exp: z.number().int().positive().safe(),
  })
  .strict();

export interface CollaborationInviteSessionLease {
  readonly generation: number;
  readonly binding: CollaborationInviteSessionBinding;
}

/** Volatile authority for invite operations. It never persists or renders access credentials. */
export class CollaborationInviteSessionAuthority {
  #binding: CollaborationInviteSessionBinding | null = null;
  #generation = 0;
  readonly #createdInvites = new Map<string, CollaborationInvite>();
  readonly #listedInvites = new Map<string, CollaborationManagementInvite>();
  readonly #now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  public establish(rawBinding: CollaborationInviteSessionBinding): void {
    const binding = CollaborationInviteSessionBindingSchema.parse(rawBinding);
    this.#assertNotExpired(binding);
    this.clear();
    this.#binding = binding;
  }

  public establishRedeemed(
    rawServerUrl: string,
    rawManagementBaseUrl: string,
    rawResponse: CollaborationInviteRedeemResponse,
  ): CollaborationInviteSessionBinding {
    const serverUrl = CollaborationServerUrlSchema.parse(rawServerUrl);
    const managementBaseUrl = CollaborationManagementUrlSchema.parse(rawManagementBaseUrl);
    const response = CollaborationInviteRedeemResponseSchema.parse(rawResponse);
    const binding = CollaborationInviteSessionBindingSchema.parse({
      serverUrl,
      managementBaseUrl,
      roomId: response.room.id,
      subject: response.membership.subject,
      role: response.membership.role,
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
    });
    this.establish(binding);
    return structuredClone(binding);
  }

  public establishOwnerAccess(
    rawServerUrl: string,
    rawManagementBaseUrl: string,
    rawResponse: CollaborationManagementOwnerAccessResponse,
  ): CollaborationInviteSessionBinding {
    const serverUrl = CollaborationServerUrlSchema.parse(rawServerUrl);
    const managementBaseUrl = CollaborationManagementUrlSchema.parse(rawManagementBaseUrl);
    const response = CollaborationManagementOwnerAccessResponseSchema.parse(rawResponse);
    const binding = CollaborationInviteSessionBindingSchema.parse({
      serverUrl,
      managementBaseUrl,
      roomId: response.room.id,
      subject: response.membership.subject,
      role: response.membership.role,
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
    });
    this.establish(binding);
    return structuredClone(binding);
  }

  /** Replaces only the owner credential while retaining current-session invite records. */
  public renewOwnerAccess(
    lease: CollaborationInviteSessionLease,
    rawResponse: CollaborationManagementOwnerAccessResponse,
  ): CollaborationInviteSessionBinding {
    const binding = this.#ownerRenewalBinding(lease, rawResponse);
    this.#binding = binding;
    this.#generation += 1;
    return structuredClone(binding);
  }

  /** Validates a renewal before an external live client swaps to the replacement credential. */
  public assertOwnerAccessRenewal(
    lease: CollaborationInviteSessionLease,
    rawResponse: CollaborationManagementOwnerAccessResponse,
  ): void {
    this.#ownerRenewalBinding(lease, rawResponse);
  }

  #ownerRenewalBinding(
    lease: CollaborationInviteSessionLease,
    rawResponse: CollaborationManagementOwnerAccessResponse,
  ): CollaborationInviteSessionBinding {
    const current = this.assertCurrent(lease);
    const response = CollaborationManagementOwnerAccessResponseSchema.parse(rawResponse);
    const claims = decodeRenewedOwnerAccessClaims(response.accessToken);
    if (
      current.role !== 'owner' ||
      response.membership.role !== 'owner' ||
      response.room.id !== current.roomId ||
      response.membership.subject !== current.subject ||
      claims.roomId !== response.room.id ||
      claims.sub !== response.membership.subject ||
      claims.role !== response.membership.role ||
      claims.ver !== response.membership.tokenVersion ||
      claims.exp * 1_000 !== new Date(response.expiresAt).getTime()
    ) {
      throw new Error('The renewed owner credential does not match the active room session.');
    }
    const binding = CollaborationInviteSessionBindingSchema.parse({
      ...current,
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
    });
    return binding;
  }

  public ownerLease(
    rawServerUrl: string,
    rawManagementBaseUrl: string,
    rawRoomId: string,
  ): CollaborationInviteSessionLease {
    const expected = CollaborationInviteSessionBindingSchema.pick({
      serverUrl: true,
      managementBaseUrl: true,
      roomId: true,
    }).parse({
      serverUrl: rawServerUrl,
      managementBaseUrl: rawManagementBaseUrl,
      roomId: rawRoomId,
    });
    const binding = this.#current();
    if (
      binding.serverUrl !== expected.serverUrl ||
      binding.managementBaseUrl !== expected.managementBaseUrl ||
      binding.roomId !== expected.roomId
    ) {
      throw new Error('The invite action does not match the connected collaboration room.');
    }
    if (binding.role !== 'owner') {
      throw new Error('Only the connected room owner can manage collaboration invites.');
    }
    return { generation: this.#generation, binding: structuredClone(binding) };
  }

  public recordCreatedInvite(
    lease: CollaborationInviteSessionLease,
    rawInvite: CollaborationInvite,
  ): void {
    const binding = this.assertCurrent(lease);
    const invite = CollaborationInviteSchema.parse(rawInvite);
    if (invite.roomId !== binding.roomId) {
      throw new Error('The created invite does not match the connected collaboration room.');
    }
    this.assertCanCreateInvite(lease);
    this.#createdInvites.set(invite.id, invite);
  }

  public assertCanCreateInvite(lease: CollaborationInviteSessionLease): void {
    this.assertCurrent(lease);
    if (this.#createdInvites.size >= 100) {
      throw new Error('This session has reached the collaboration invite management limit.');
    }
  }

  public authorizeRevoke(
    lease: CollaborationInviteSessionLease,
    rawInviteId: string,
  ): CollaborationInviteSessionBinding {
    const binding = this.assertCurrent(lease);
    const inviteId = CollaborationInviteIdSchema.parse(rawInviteId);
    const listed = this.#listedInvites.get(inviteId);
    if (
      (listed !== undefined && listed.status !== 'active') ||
      (listed === undefined && !this.#createdInvites.has(inviteId))
    ) {
      throw new Error('Refresh invite history before revoking this invite.');
    }
    return binding;
  }

  public recordRevokedInvite(lease: CollaborationInviteSessionLease, rawInviteId: string): void {
    this.assertCurrent(lease);
    this.#createdInvites.delete(CollaborationInviteIdSchema.parse(rawInviteId));
    this.#listedInvites.delete(CollaborationInviteIdSchema.parse(rawInviteId));
  }

  public recordListedPage(
    lease: CollaborationInviteSessionLease,
    rawPage: CollaborationInviteListResponse,
  ): CollaborationInviteHistoryPage {
    this.assertCurrent(lease);
    const page = CollaborationInviteListResponseSchema.parse(rawPage);
    this.#listedInvites.clear();
    for (const invite of page.invites) this.#listedInvites.set(invite.id, invite);
    return CollaborationInviteHistoryPageSchema.parse({
      ...page,
      invites: page.invites.map((invite) => ({
        ...invite,
        copyAvailable: invite.status === 'active' && this.#createdInvites.has(invite.id),
      })),
    });
  }

  public createdInviteViews(lease: CollaborationInviteSessionLease): CollaborationInviteSafeView[] {
    this.assertCurrent(lease);
    return [...this.#createdInvites.values()].map((invite) => ({
      id: invite.id,
      roomId: invite.roomId,
      role: invite.role,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
    }));
  }

  /** Main-process-only clipboard handoff. Never return this value through renderer IPC. */
  public inviteLinkForCopy(lease: CollaborationInviteSessionLease, rawInviteId: string): string {
    const binding = this.assertCurrent(lease);
    const inviteId = CollaborationInviteIdSchema.parse(rawInviteId);
    const invite = this.#createdInvites.get(inviteId);
    if (invite === undefined) {
      throw new Error('This invite was not created by the current Forgeboard room session.');
    }
    return collaborationInviteLinkWithConnection(invite.url, {
      serverUrl: binding.serverUrl,
      managementBaseUrl: binding.managementBaseUrl,
    });
  }

  public assertCurrent(lease: CollaborationInviteSessionLease): CollaborationInviteSessionBinding {
    const binding = this.#current();
    if (
      lease.generation !== this.#generation ||
      lease.binding.serverUrl !== binding.serverUrl ||
      lease.binding.managementBaseUrl !== binding.managementBaseUrl ||
      lease.binding.roomId !== binding.roomId ||
      lease.binding.subject !== binding.subject ||
      lease.binding.accessToken !== binding.accessToken
    ) {
      throw new Error('The collaboration room session changed. Review the invite action again.');
    }
    return structuredClone(binding);
  }

  public clear(): void {
    this.#binding = null;
    this.#createdInvites.clear();
    this.#listedInvites.clear();
    this.#generation += 1;
  }

  public clearForLeave(): void {
    this.clear();
  }

  public clearForReset(): void {
    this.clear();
  }

  public dispose(): void {
    this.clear();
  }

  public get createdInviteCount(): number {
    return this.#createdInvites.size;
  }

  #current(): CollaborationInviteSessionBinding {
    if (this.#binding === null) throw new Error('No collaboration room session is active.');
    this.#assertNotExpired(this.#binding);
    return this.#binding;
  }

  #assertNotExpired(binding: CollaborationInviteSessionBinding): void {
    if (
      binding.expiresAt !== undefined &&
      new Date(binding.expiresAt).getTime() <= this.#now().getTime()
    ) {
      throw new Error('The collaboration room credential is expired. Reconnect before continuing.');
    }
  }
}

function decodeRenewedOwnerAccessClaims(
  accessToken: string,
): z.infer<typeof RenewedOwnerAccessClaimsSchema> {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3 || parts[1] === undefined) throw new Error('invalid');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return RenewedOwnerAccessClaimsSchema.parse(payload);
  } catch {
    throw new Error('The renewed owner credential does not match the active room session.');
  }
}
