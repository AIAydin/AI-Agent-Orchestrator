import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { TerminalSessionStatus } from '../../../../../shared/terminal/index.js';
import type { WorkshopNodeData } from '../canvas/CanvasNode.js';
import type { TerminalNodeConfiguration } from './types.js';

export function terminalNodeConfiguration(
  data: WorkshopNodeData,
  settings: AppSettings,
): TerminalNodeConfiguration {
  const command = data.command;
  return {
    executable: command?.executable ?? settings.terminalShell,
    arguments: command?.arguments ?? [],
    cwdRelative: command?.cwdRelative ?? '.',
    environmentVariableNames: command?.environmentNames ?? settings.envAllowlist,
  };
}

export function terminalCommandConfiguration(
  configuration: TerminalNodeConfiguration,
): NonNullable<WorkshopNodeData['command']> {
  return {
    executable: configuration.executable,
    arguments: [...configuration.arguments],
    cwdRelative: configuration.cwdRelative,
    environmentNames: [...configuration.environmentVariableNames],
  };
}

export function terminalSessionNodeStatus(
  status: TerminalSessionStatus | undefined,
  exitCode: number | null | undefined,
): WorkshopNodeData['status'] {
  if (status === undefined) return 'idle';
  if (status === 'starting') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'interrupted' || status === 'terminated') return 'cancelled';
  if (status === 'exited') return exitCode === 0 ? 'succeeded' : 'failed';
  return 'failed';
}
