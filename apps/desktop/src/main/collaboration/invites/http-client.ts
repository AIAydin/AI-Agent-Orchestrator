import { z } from 'zod';

import {
  CollaborationInviteListQuerySchema,
  CollaborationInviteListResponseSchema,
  CollaborationInviteRevokeResponseSchema,
  type CollaborationInviteListResponse,
  type CollaborationManagementInvite,
} from '@forgeboard/core/collaboration-management';

import {
  CollaborationInviteCreateInputSchema,
  CollaborationInviteCreateResponseSchema,
  CollaborationInviteIdSchema,
  CollaborationInviteRedeemInputSchema,
  CollaborationInviteRedeemResponseSchema,
  CollaborationInviteSessionBindingSchema,
  CollaborationManagementUrlSchema,
  type CollaborationInvite,
  type CollaborationInviteCreateInput,
  type CollaborationInviteRedeemInput,
  type CollaborationInviteRedeemResponse,
  type CollaborationInviteSessionBinding,
} from '../../../shared/collaboration/index.js';
import {
  assertOutboundExecutionPermit,
  type OutboundExecutionPermit,
} from '../../outbound/outbound-action-gate.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32_768;

const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().trim().min(1).max(128),
        message: z.string().trim().min(1).max(4_096),
      })
      .strict(),
  })
  .strict();

export type CollaborationInviteHttpErrorCode =
  | 'cancelled'
  | 'invalid-response'
  | 'network-failed'
  | 'request-rejected'
  | 'response-too-large'
  | 'timed-out';

export class CollaborationInviteHttpError extends Error {
  public constructor(
    readonly code: CollaborationInviteHttpErrorCode,
    message: string,
    readonly status?: number,
    readonly serverCode?: string,
  ) {
    super(message);
    this.name = 'CollaborationInviteHttpError';
  }
}

export interface CollaborationInviteHttpClientOptions {
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Bounded, token-redacting client for the collaboration server's existing invite API. */
export class CollaborationInviteHttpClient {
  readonly #request: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  public constructor(options: CollaborationInviteHttpClientOptions = {}) {
    this.#request = options.request ?? fetch;
    this.#timeoutMs = positiveSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeout');
    this.#maxResponseBytes = positiveSafeInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'response byte limit',
    );
  }

  public async createInvite(
    permit: OutboundExecutionPermit,
    rawSession: CollaborationInviteSessionBinding,
    rawInput: CollaborationInviteCreateInput,
  ): Promise<CollaborationInvite> {
    assertOutboundExecutionPermit(permit);
    const session = CollaborationInviteSessionBindingSchema.parse(rawSession);
    const input = CollaborationInviteCreateInputSchema.parse(rawInput);
    if (session.role !== 'owner') {
      throw new CollaborationInviteHttpError(
        'request-rejected',
        'Only the connected room owner can create collaboration invites.',
      );
    }
    const response = await this.#jsonRequest(
      managementUrl(
        session.managementBaseUrl,
        `v1/rooms/${encodeURIComponent(session.roomId)}/invites`,
      ),
      {
        method: 'POST',
        accessToken: session.accessToken,
        body: input,
      },
      201,
    );
    const parsed = CollaborationInviteCreateResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned an invalid invite response.',
      );
    }
    return parsed.data.invite;
  }

  public async listInvites(
    permit: OutboundExecutionPermit,
    rawSession: CollaborationInviteSessionBinding,
    rawQuery: { readonly after?: string; readonly limit?: number } = {},
  ): Promise<CollaborationInviteListResponse> {
    assertOutboundExecutionPermit(permit);
    const session = CollaborationInviteSessionBindingSchema.parse(rawSession);
    if (session.role !== 'owner') {
      throw new CollaborationInviteHttpError(
        'request-rejected',
        'Only the connected room owner can list collaboration invites.',
      );
    }
    const query = CollaborationInviteListQuerySchema.parse({
      ...(rawQuery.after === undefined ? {} : { after: rawQuery.after }),
      ...(rawQuery.limit === undefined ? {} : { limit: String(rawQuery.limit) }),
    });
    const url = managementUrl(
      session.managementBaseUrl,
      `v1/rooms/${encodeURIComponent(session.roomId)}/invites`,
    );
    if (query.after !== undefined) url.searchParams.set('after', query.after);
    url.searchParams.set('limit', String(query.limit));
    const response = await this.#jsonRequest(
      url,
      { method: 'GET', accessToken: session.accessToken },
      200,
    );
    const parsed = CollaborationInviteListResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned an invalid invite history response.',
      );
    }
    return parsed.data;
  }

  public async redeemInvite(
    permit: OutboundExecutionPermit,
    rawManagementBaseUrl: string,
    rawInput: CollaborationInviteRedeemInput,
  ): Promise<CollaborationInviteRedeemResponse> {
    assertOutboundExecutionPermit(permit);
    const managementBaseUrl = CollaborationManagementUrlSchema.parse(rawManagementBaseUrl);
    const input = CollaborationInviteRedeemInputSchema.parse(rawInput);
    const response = await this.#jsonRequest(
      managementUrl(managementBaseUrl, 'v1/invites/redeem'),
      {
        method: 'POST',
        body: input,
      },
      200,
    );
    const parsed = CollaborationInviteRedeemResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned an invalid invite response.',
      );
    }
    const redeemed = parsed.data;
    if (
      redeemed.membership.subject !== input.subject ||
      redeemed.membership.displayName !== input.displayName
    ) {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned an invite membership for a different identity.',
      );
    }
    return redeemed;
  }

  public async revokeInvite(
    permit: OutboundExecutionPermit,
    rawSession: CollaborationInviteSessionBinding,
    rawInviteId: string,
  ): Promise<CollaborationManagementInvite> {
    assertOutboundExecutionPermit(permit);
    const session = CollaborationInviteSessionBindingSchema.parse(rawSession);
    const inviteId = CollaborationInviteIdSchema.parse(rawInviteId);
    if (session.role !== 'owner') {
      throw new CollaborationInviteHttpError(
        'request-rejected',
        'Only the connected room owner can revoke collaboration invites.',
      );
    }
    const response = CollaborationInviteRevokeResponseSchema.parse(
      await this.#jsonRequest(
        managementUrl(
          session.managementBaseUrl,
          `v1/rooms/${encodeURIComponent(session.roomId)}/invites/${encodeURIComponent(inviteId)}`,
        ),
        { method: 'DELETE', accessToken: session.accessToken },
        200,
      ),
    );
    if (
      response.invite.id !== inviteId ||
      response.invite.roomId !== session.roomId ||
      response.invite.status !== 'revoked'
    ) {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned a mismatched revoked invite.',
      );
    }
    return response.invite;
  }

  async #jsonRequest(url: URL, input: RequestOptions, expectedStatus: number): Promise<unknown> {
    const response = await this.#send(url, input);
    if (!response.ok) throw await this.#rejection(response);
    if (response.status !== expectedStatus) {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned an invalid invite response.',
      );
    }
    assertIdentityEncoding(response);
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned an invalid invite response.',
      );
    }
    const bytes = await readBoundedBody(response, this.#maxResponseBytes);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new CollaborationInviteHttpError(
        'invalid-response',
        'The collaboration server returned an invalid invite response.',
      );
    }
  }

  async #send(url: URL, input: RequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#request(url, {
        method: input.method,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(input.accessToken === undefined
            ? {}
            : { Authorization: `Bearer ${input.accessToken}` }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new CollaborationInviteHttpError(
          'timed-out',
          'The collaboration invite request timed out.',
        );
      }
      throw new CollaborationInviteHttpError(
        'network-failed',
        'Forgeboard could not reach the collaboration server for the invite request.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async #rejection(response: Response): Promise<CollaborationInviteHttpError> {
    let serverCode: string | undefined;
    try {
      const bytes = await readBoundedBody(response, this.#maxResponseBytes);
      const parsed = ErrorResponseSchema.safeParse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      if (parsed.success) serverCode = parsed.data.error.code;
    } catch (error) {
      if (error instanceof CollaborationInviteHttpError && error.code === 'response-too-large') {
        throw error;
      }
      // A hostile or malformed error body is intentionally reduced to bounded status metadata.
    }
    return new CollaborationInviteHttpError(
      'request-rejected',
      inviteRejectionMessage(response.status, serverCode),
      response.status,
      serverCode,
    );
  }
}

interface RequestOptions {
  readonly method: 'DELETE' | 'GET' | 'POST';
  readonly accessToken?: string;
  readonly body?: unknown;
}

function managementUrl(managementBaseUrl: string, pathname: string): URL {
  return new URL(pathname, CollaborationManagementUrlSchema.parse(managementBaseUrl));
}

function assertIdentityEncoding(response: Response): void {
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
    throw new CollaborationInviteHttpError(
      'invalid-response',
      'The collaboration server returned an unsupported invite response encoding.',
    );
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new CollaborationInviteHttpError(
      'response-too-large',
      'The collaboration server invite response exceeded the safe size limit.',
    );
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new CollaborationInviteHttpError(
          'response-too-large',
          'The collaboration server invite response exceeded the safe size limit.',
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function inviteRejectionMessage(status: number, code: string | undefined): string {
  if (status === 401 || code === 'invalid_token') {
    return 'The collaboration invite credential is invalid or expired.';
  }
  if (status === 403) return 'This collaboration identity cannot perform that invite action.';
  if (status === 404 || code === 'invite_not_found') {
    return 'The collaboration invite is no longer available.';
  }
  if (status === 410 || code === 'invite_unavailable') {
    return 'The collaboration invite is expired, revoked, or already used.';
  }
  if (status === 429) return 'The collaboration server rate limit was reached. Try again later.';
  return 'The collaboration server rejected the invite request.';
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The collaboration invite ${label} must be a positive safe integer.`);
  }
  return value;
}
