import {
  FolderReadinessRequestSchema,
  FolderReadinessResultSchema,
  type FolderReadinessRequest,
  type FolderReadinessResult,
} from '../shared/settings/folder-readiness.js';
import { IPC_CHANNELS, ipcResultSchema, type IpcResult } from '../shared/application/contracts.js';

export type SettingsFolderReadinessInvoker = (
  channel: string,
  ...args: unknown[]
) => Promise<unknown>;

/** Browser-safe preload validation for the narrow passive folder preflight. */
export async function checkSettingsFolderReadiness(
  invoke: SettingsFolderReadinessInvoker,
  input: FolderReadinessRequest,
): Promise<IpcResult<FolderReadinessResult>> {
  const request = FolderReadinessRequestSchema.parse(input);
  const result: unknown = await invoke(IPC_CHANNELS.settingsCheckFolderReadiness, request);
  return ipcResultSchema(FolderReadinessResultSchema).parse(result);
}
