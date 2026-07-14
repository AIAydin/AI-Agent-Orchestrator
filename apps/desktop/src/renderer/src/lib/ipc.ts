import type { IpcResult } from '../../../shared/contracts.js';

export function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
