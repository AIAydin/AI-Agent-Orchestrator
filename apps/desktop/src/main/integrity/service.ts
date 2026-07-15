import {
  IntegrityCheckInputSchema,
  IntegrityCheckResultSchema,
  SANITIZED_INTEGRITY_MESSAGES,
  type IntegrityCheckResult,
  type SanitizedIntegrityMessage,
} from '../../shared/integrity/contracts.js';
import type { IntegrityReport } from '../storage-schemas.js';

export interface IntegrityStore {
  checkIntegrity(mode: 'quick' | 'full'): IntegrityReport;
}

/** Read-only main-process boundary for renderer-requested local-data verification. */
export class IntegrityService {
  public constructor(
    private readonly store: IntegrityStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public check(input: unknown): IntegrityCheckResult {
    const request = IntegrityCheckInputSchema.parse(input);
    let report: IntegrityReport;
    try {
      report = this.store.checkIntegrity(request.mode);
    } catch {
      return this.#incomplete(request.mode);
    }
    if (report.mode !== request.mode) return this.#incomplete(request.mode);

    const messagesAreArray = Array.isArray(report.messages);
    const sourceMessages = messagesAreArray ? report.messages : [];
    const ok = report.ok === true && messagesAreArray && sourceMessages.length === 0;
    const messages = ok ? [] : sanitizeIntegrityMessages(sourceMessages);
    const result = IntegrityCheckResultSchema.safeParse({
      schemaVersion: 1,
      mode: report.mode,
      checkedAt: report.checkedAt,
      ok,
      messages: ok || messages.length > 0 ? messages : [SANITIZED_INTEGRITY_MESSAGES.incomplete],
    });
    return result.success ? result.data : this.#incomplete(request.mode);
  }

  #incomplete(mode: 'quick' | 'full'): IntegrityCheckResult {
    return IntegrityCheckResultSchema.parse({
      schemaVersion: 1,
      mode,
      checkedAt: this.now().toISOString(),
      ok: false,
      messages: [SANITIZED_INTEGRITY_MESSAGES.incomplete],
    });
  }
}

export function sanitizeIntegrityMessages(
  rawMessages: readonly unknown[],
): SanitizedIntegrityMessage[] {
  const messages = new Set<SanitizedIntegrityMessage>();
  for (const value of rawMessages.slice(0, 10_000)) {
    const raw = typeof value === 'string' ? value.toLowerCase() : '';
    if (raw.includes('audit')) {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.audit);
    } else if (raw.includes('approval')) {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.approvals);
    } else if (raw.includes('workflow')) {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.workflow);
    } else if (raw.includes('schema version') || raw.includes('migration ledger')) {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.schema);
    } else if (raw.includes('foreign-key') || raw.includes('foreign key')) {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.relationships);
    } else if (raw.startsWith('sqlite:')) {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.sqlite);
    } else if (raw.includes('unknown integrity') || raw.includes('integrity-check failure')) {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.incomplete);
    } else {
      messages.add(SANITIZED_INTEGRITY_MESSAGES.structural);
    }
  }
  return [...messages];
}
