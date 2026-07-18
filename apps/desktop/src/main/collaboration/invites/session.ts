import {
  CollaborationInviteIdSchema,
  CollaborationInviteSchema,
  CollaborationInviteRedeemResponseSchema,
  CollaborationInviteSessionBindingSchema,
  CollaborationManagementUrlSchema,
  CollaborationServerUrlSchema,
  type CollaborationInvite,
  type CollaborationInviteRedeemResponse,
  type CollaborationInviteSafeView,
  type CollaborationInviteSessionBinding,
} from '../../../shared/collaboration/index.js';

export interface CollaborationInviteSessionLease {
  readonly generation: number;
  readonly binding: CollaborationInviteSessionBinding;
}

/** Volatile authority for invite operations. It never persists or renders access credentials. */
export class CollaborationInviteSessionAuthority {
  #binding: CollaborationInviteSessionBinding | null = null;
  #generation = 0;
  readonly #createdInvites = new Map<string, CollaborationInvite>();
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
    if (!this.#createdInvites.has(inviteId)) {
      throw new Error('This invite was not created by the current Forgeboard room session.');
    }
    return binding;
  }

  public recordRevokedInvite(lease: CollaborationInviteSessionLease, rawInviteId: string): void {
    this.assertCurrent(lease);
    this.#createdInvites.delete(CollaborationInviteIdSchema.parse(rawInviteId));
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
    this.assertCurrent(lease);
    const inviteId = CollaborationInviteIdSchema.parse(rawInviteId);
    const invite = this.#createdInvites.get(inviteId);
    if (invite === undefined) {
      throw new Error('This invite was not created by the current Forgeboard room session.');
    }
    return invite.url;
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
