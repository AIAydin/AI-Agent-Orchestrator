import {
  CollaborationAuditListQuerySchema,
  CollaborationAuditListResponseSchema,
  CollaborationManagementAccessTokenSchema,
  CollaborationManagementErrorResponseSchema,
  CollaborationManagementIdempotencyKeySchema,
  CollaborationManagementRoomIdSchema,
  CollaborationManagementSubjectIdSchema,
  CollaborationManagementTokenVersionSchema,
  CollaborationMemberListQuerySchema,
  CollaborationMemberListResponseSchema,
  CollaborationMemberMutationResponseSchema,
  CollaborationMemberUpdateRequestSchema,
  CollaborationOwnerRecoverRequestSchema,
  CollaborationOwnerRecoverResponseSchema,
  CollaborationOwnerRefreshResponseSchema,
  CollaborationRoomBootstrapRequestSchema,
  CollaborationRoomBootstrapResponseSchema,
  type CollaborationAuditListResponse,
  type CollaborationManagementOwnerAccessResponse,
  type CollaborationMemberListResponse,
  type CollaborationMemberMutationResponse,
  type CollaborationMemberUpdateRequest,
  type CollaborationOwnerRecoverRequest,
  type CollaborationRoomBootstrapRequest,
} from '@forgeboard/core/collaboration-management';
import { z, type ZodType } from 'zod';

import { CollaborationManagementUrlSchema } from '../../../shared/collaboration/index.js';
import {
  assertOutboundExecutionPermit,
  type OutboundExecutionPermit,
} from '../../outbound/outbound-action-gate.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

const AdminTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\0\r\n]/u.test(value));

const OwnerAuthoritySchema = z
  .object({
    managementBaseUrl: CollaborationManagementUrlSchema,
    roomId: CollaborationManagementRoomIdSchema,
    accessToken: CollaborationManagementAccessTokenSchema.refine(
      (value) => !/[\0\r\n]/u.test(value),
    ),
  })
  .strict();

export interface CollaborationOwnerManagementAuthority {
  readonly managementBaseUrl: string;
  readonly roomId: string;
  readonly accessToken: string;
}

export interface CollaborationManagementHttpClientOptions {
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export type CollaborationManagementHttpErrorCode =
  | 'invalid-request'
  | 'invalid-response'
  | 'network-failed'
  | 'request-rejected'
  | 'response-too-large'
  | 'timed-out';

export class CollaborationManagementHttpError extends Error {
  public constructor(
    readonly code: CollaborationManagementHttpErrorCode,
    message: string,
    readonly status?: number,
    readonly serverCode?: string,
  ) {
    super(message);
    this.name = 'CollaborationManagementHttpError';
  }
}

/** Hardened main-process transport for the collaboration management control plane. */
export class CollaborationManagementHttpClient {
  readonly #request: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  public constructor(options: CollaborationManagementHttpClientOptions = {}) {
    this.#request = options.request ?? fetch;
    this.#timeoutMs = positiveSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeout');
    this.#maxResponseBytes = positiveSafeInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'response byte limit',
    );
  }

  public bootstrapRoom(
    permit: OutboundExecutionPermit,
    rawManagementBaseUrl: string,
    rawIdempotencyKey: string,
    rawInput: CollaborationRoomBootstrapRequest,
    rawAdminToken?: string,
  ): Promise<CollaborationManagementOwnerAccessResponse> {
    assertOutboundExecutionPermit(permit);
    const managementBaseUrl = parseInput(CollaborationManagementUrlSchema, rawManagementBaseUrl);
    const adminToken = parseOptionalAdminToken(rawAdminToken);
    const idempotencyKey = parseInput(
      CollaborationManagementIdempotencyKeySchema,
      rawIdempotencyKey,
    );
    const input = parseInput(CollaborationRoomBootstrapRequestSchema, rawInput);
    return this.#jsonRequest(
      managementUrl(managementBaseUrl, 'v1/rooms'),
      {
        method: 'POST',
        ...(adminToken === undefined ? {} : { accessToken: adminToken }),
        idempotencyKey,
        body: input,
      },
      201,
      CollaborationRoomBootstrapResponseSchema,
      'room bootstrap',
    );
  }

  public recoverOwner(
    permit: OutboundExecutionPermit,
    rawManagementBaseUrl: string,
    rawRoomId: string,
    rawIdempotencyKey: string,
    rawInput: CollaborationOwnerRecoverRequest,
    rawAdminToken?: string,
  ): Promise<CollaborationManagementOwnerAccessResponse> {
    assertOutboundExecutionPermit(permit);
    const managementBaseUrl = parseInput(CollaborationManagementUrlSchema, rawManagementBaseUrl);
    const roomId = parseInput(CollaborationManagementRoomIdSchema, rawRoomId);
    const adminToken = parseOptionalAdminToken(rawAdminToken);
    const idempotencyKey = parseInput(
      CollaborationManagementIdempotencyKeySchema,
      rawIdempotencyKey,
    );
    const input = parseInput(CollaborationOwnerRecoverRequestSchema, rawInput);
    return this.#jsonRequest(
      managementUrl(
        managementBaseUrl,
        `v1/rooms/${encodeURIComponent(roomId)}/owner-tokens/recover`,
      ),
      {
        method: 'POST',
        ...(adminToken === undefined ? {} : { accessToken: adminToken }),
        idempotencyKey,
        body: input,
      },
      200,
      CollaborationOwnerRecoverResponseSchema,
      'owner recovery',
    );
  }

  public refreshOwner(
    permit: OutboundExecutionPermit,
    rawAuthority: CollaborationOwnerManagementAuthority,
    rawIdempotencyKey: string,
  ): Promise<CollaborationManagementOwnerAccessResponse> {
    assertOutboundExecutionPermit(permit);
    const authority = parseOwnerAuthority(rawAuthority);
    const idempotencyKey = parseInput(
      CollaborationManagementIdempotencyKeySchema,
      rawIdempotencyKey,
    );
    return this.#jsonRequest(
      managementUrl(
        authority.managementBaseUrl,
        `v1/rooms/${encodeURIComponent(authority.roomId)}/owner-tokens/refresh`,
      ),
      { method: 'POST', accessToken: authority.accessToken, idempotencyKey },
      200,
      CollaborationOwnerRefreshResponseSchema,
      'owner renewal',
    );
  }

  public listMembers(
    permit: OutboundExecutionPermit,
    rawAuthority: CollaborationOwnerManagementAuthority,
    rawQuery: { readonly after?: string; readonly limit?: number } = {},
  ): Promise<CollaborationMemberListResponse> {
    assertOutboundExecutionPermit(permit);
    const authority = parseOwnerAuthority(rawAuthority);
    const query = parseInput(CollaborationMemberListQuerySchema, {
      ...(rawQuery.after === undefined ? {} : { after: rawQuery.after }),
      ...(rawQuery.limit === undefined ? {} : { limit: String(rawQuery.limit) }),
    });
    const url = managementUrl(
      authority.managementBaseUrl,
      `v1/rooms/${encodeURIComponent(authority.roomId)}/members`,
    );
    if (query.after !== undefined) url.searchParams.set('after', query.after);
    url.searchParams.set('limit', String(query.limit));
    return this.#jsonRequest(
      url,
      { method: 'GET', accessToken: authority.accessToken },
      200,
      CollaborationMemberListResponseSchema,
      'member list',
    );
  }

  public updateMember(
    permit: OutboundExecutionPermit,
    rawAuthority: CollaborationOwnerManagementAuthority,
    rawIdempotencyKey: string,
    rawSubject: string,
    rawInput: CollaborationMemberUpdateRequest,
  ): Promise<CollaborationMemberMutationResponse> {
    assertOutboundExecutionPermit(permit);
    const authority = parseOwnerAuthority(rawAuthority);
    const subject = parseInput(CollaborationManagementSubjectIdSchema, rawSubject);
    const idempotencyKey = parseInput(
      CollaborationManagementIdempotencyKeySchema,
      rawIdempotencyKey,
    );
    const input = parseInput(CollaborationMemberUpdateRequestSchema, rawInput);
    return this.#jsonRequest(
      managementUrl(
        authority.managementBaseUrl,
        `v1/rooms/${encodeURIComponent(authority.roomId)}/members/${encodeURIComponent(subject)}`,
      ),
      {
        method: 'PATCH',
        accessToken: authority.accessToken,
        idempotencyKey,
        body: input,
      },
      200,
      CollaborationMemberMutationResponseSchema,
      'member update',
    );
  }

  public async revokeMember(
    permit: OutboundExecutionPermit,
    rawAuthority: CollaborationOwnerManagementAuthority,
    rawIdempotencyKey: string,
    rawSubject: string,
    rawExpectedTokenVersion: number,
  ): Promise<void> {
    assertOutboundExecutionPermit(permit);
    const authority = parseOwnerAuthority(rawAuthority);
    const subject = parseInput(CollaborationManagementSubjectIdSchema, rawSubject);
    const idempotencyKey = parseInput(
      CollaborationManagementIdempotencyKeySchema,
      rawIdempotencyKey,
    );
    const expectedTokenVersion = parseInput(
      CollaborationManagementTokenVersionSchema,
      rawExpectedTokenVersion,
    );
    await this.#emptyRequest(
      managementUrl(
        authority.managementBaseUrl,
        `v1/rooms/${encodeURIComponent(authority.roomId)}/members/${encodeURIComponent(subject)}`,
      ),
      {
        method: 'DELETE',
        accessToken: authority.accessToken,
        idempotencyKey,
        expectedTokenVersion,
      },
      'member revocation',
    );
  }

  public listAudit(
    permit: OutboundExecutionPermit,
    rawAuthority: CollaborationOwnerManagementAuthority,
    rawQuery: { readonly after?: number; readonly limit?: number } = {},
  ): Promise<CollaborationAuditListResponse> {
    assertOutboundExecutionPermit(permit);
    const authority = parseOwnerAuthority(rawAuthority);
    const query = parseInput(CollaborationAuditListQuerySchema, {
      ...(rawQuery.after === undefined ? {} : { after: String(rawQuery.after) }),
      ...(rawQuery.limit === undefined ? {} : { limit: String(rawQuery.limit) }),
    });
    const url = managementUrl(
      authority.managementBaseUrl,
      `v1/rooms/${encodeURIComponent(authority.roomId)}/audit`,
    );
    url.searchParams.set('after', String(query.after));
    url.searchParams.set('limit', String(query.limit));
    return this.#jsonRequest(
      url,
      { method: 'GET', accessToken: authority.accessToken },
      200,
      CollaborationAuditListResponseSchema,
      'audit list',
    );
  }

  async #jsonRequest<Output>(
    url: URL,
    input: RequestOptions,
    expectedStatus: number,
    schema: ZodType<Output, z.ZodTypeDef, unknown>,
    operation: string,
  ): Promise<Output> {
    const response = await this.#send(url, input, operation);
    if (!response.ok) throw await this.#rejection(response);
    if (response.status !== expectedStatus) throw invalidResponse(operation);
    assertIdentityEncoding(response, operation);
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
      throw invalidResponse(operation);
    }
    const bytes = await readBoundedBody(response, this.#maxResponseBytes);
    try {
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) throw invalidResponse(operation);
      return parsed.data;
    } catch (error) {
      if (error instanceof CollaborationManagementHttpError) throw error;
      throw invalidResponse(operation);
    }
  }

  async #emptyRequest(url: URL, input: RequestOptions, operation: string): Promise<void> {
    const response = await this.#send(url, input, operation);
    if (!response.ok) throw await this.#rejection(response);
    if (response.status !== 204) throw invalidResponse(operation);
    assertIdentityEncoding(response, operation);
    const bytes = await readBoundedBody(response, this.#maxResponseBytes);
    if (bytes.byteLength !== 0) throw invalidResponse(operation);
  }

  async #send(url: URL, input: RequestOptions, operation: string): Promise<Response> {
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
          ...(input.idempotencyKey === undefined
            ? {}
            : { 'Idempotency-Key': input.idempotencyKey }),
          ...(input.expectedTokenVersion === undefined
            ? {}
            : { 'If-Match': `"${input.expectedTokenVersion}"` }),
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
        throw new CollaborationManagementHttpError(
          'timed-out',
          `The collaboration ${operation} request timed out.`,
        );
      }
      throw new CollaborationManagementHttpError(
        'network-failed',
        `Artemis could not reach the collaboration server for the ${operation} request.`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async #rejection(response: Response): Promise<CollaborationManagementHttpError> {
    let serverCode: string | undefined;
    try {
      const bytes = await readBoundedBody(response, this.#maxResponseBytes);
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const parsed = CollaborationManagementErrorResponseSchema.safeParse(decoded);
      if (parsed.success) serverCode = parsed.data.error.code;
    } catch (error) {
      if (
        error instanceof CollaborationManagementHttpError &&
        error.code === 'response-too-large'
      ) {
        throw error;
      }
      // Hostile and malformed error bodies are deliberately reduced to bounded metadata.
    }
    return new CollaborationManagementHttpError(
      'request-rejected',
      managementRejectionMessage(response.status, serverCode),
      response.status,
      serverCode,
    );
  }
}

interface RequestOptions {
  readonly method: 'DELETE' | 'GET' | 'PATCH' | 'POST';
  readonly accessToken?: string;
  readonly idempotencyKey?: string;
  readonly expectedTokenVersion?: number;
  readonly body?: unknown;
}

function parseInput<Output>(
  schema: ZodType<Output, z.ZodTypeDef, unknown>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new CollaborationManagementHttpError(
      'invalid-request',
      'The collaboration management request is invalid.',
    );
  }
  return parsed.data;
}

function parseOptionalAdminToken(input: string | undefined): string | undefined {
  return input === undefined || input.trim() === ''
    ? undefined
    : parseInput(AdminTokenSchema, input);
}

function parseOwnerAuthority(
  input: CollaborationOwnerManagementAuthority,
): CollaborationOwnerManagementAuthority {
  return parseInput(OwnerAuthoritySchema, {
    managementBaseUrl: input.managementBaseUrl,
    roomId: input.roomId,
    accessToken: input.accessToken,
  });
}

function managementUrl(managementBaseUrl: string, pathname: string): URL {
  return new URL(pathname, CollaborationManagementUrlSchema.parse(managementBaseUrl));
}

function assertIdentityEncoding(response: Response, operation: string): void {
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
    throw new CollaborationManagementHttpError(
      'invalid-response',
      `The collaboration server returned an unsupported ${operation} response encoding.`,
    );
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw responseTooLarge();
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
        throw responseTooLarge();
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

function invalidResponse(operation: string): CollaborationManagementHttpError {
  return new CollaborationManagementHttpError(
    'invalid-response',
    `The collaboration server returned an invalid ${operation} response.`,
  );
}

function responseTooLarge(): CollaborationManagementHttpError {
  return new CollaborationManagementHttpError(
    'response-too-large',
    'The collaboration management response exceeded the safe size limit.',
  );
}

function managementRejectionMessage(status: number, code: string | undefined): string {
  if (status === 401 || code === 'invalid_token' || code === 'unauthorized') {
    return 'The collaboration management credential is invalid or expired.';
  }
  if (status === 403) return 'This collaboration identity cannot perform that management action.';
  if (status === 404) return 'The requested collaboration room or member was not found.';
  if (status === 409) return 'The collaboration data changed. Refresh it before trying again.';
  if (status === 429) return 'The collaboration server rate limit was reached. Try again later.';
  return 'The collaboration server rejected the management request.';
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The collaboration management ${label} must be a positive safe integer.`);
  }
  return value;
}
