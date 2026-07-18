export interface AuditedLocalEffect<T> {
  readonly assertCurrent: () => void;
  readonly auditAllowed: () => void;
  readonly effect: () => T | Promise<T>;
  readonly auditFailed: () => void;
}

/** Persists authorization before a local export/backup write and fails closed if it cannot. */
export async function performAuditedLocalEffect<T>(input: AuditedLocalEffect<T>): Promise<T> {
  input.assertCurrent();
  input.auditAllowed();
  try {
    const result = await input.effect();
    input.assertCurrent();
    return result;
  } catch (error) {
    try {
      input.auditFailed();
    } catch {
      // Preserve the effect/authority failure; the allowed audit already persisted before the effect.
    }
    throw error;
  }
}
