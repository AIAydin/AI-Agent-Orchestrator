import {
  AgentReadinessResultSchema,
  type AgentReadinessRequest,
  type AgentReadinessResult,
} from '../../shared/readiness/contracts.js';
import {
  CommandReadinessResultSchema,
  type CommandReadinessRequest,
  type CommandReadinessResult,
} from '../../shared/command-readiness/contracts.js';
import {
  commandNeedsReadiness,
  expectedReadinessSource,
  settingsAgentReadinessRequestChanged,
  settingsAgentReadinessRequests,
  settingsCommandFingerprint,
  settingsCommandReadinessDrafts,
} from '../../shared/settings/readiness-requests.js';
import {
  FolderReadinessResultSchema,
  folderReadinessMatches,
  type FolderReadinessRequest,
  type FolderReadinessResult,
} from '../../shared/settings/folder-readiness.js';
import type { AppSettings } from '../../shared/application/contracts.js';

interface SettingsAgentReadinessVerifier {
  verifySettingsReadiness(input: unknown): Promise<AgentReadinessResult>;
}

interface SettingsFolderReadinessVerifier {
  check(input: unknown): Promise<FolderReadinessResult>;
}

interface SettingsCommandReadinessVerifier {
  verifySettingsReadiness(
    input: Pick<CommandReadinessRequest, 'purpose' | 'command'>,
  ): Promise<CommandReadinessResult>;
}

/** Trusted save-time verification for newly changed executable and folder configuration. */
export class SettingsPersistenceReadinessVerifier {
  public constructor(
    private readonly agents: SettingsAgentReadinessVerifier,
    private readonly folders: SettingsFolderReadinessVerifier,
    private readonly commands: SettingsCommandReadinessVerifier,
  ) {}

  public async verify(current: AppSettings, next: AppSettings): Promise<void> {
    const changedAgents = settingsAgentReadinessRequests(next).filter((request) =>
      settingsAgentReadinessRequestChanged(current, next, request),
    );
    const currentCommands = new Map(
      settingsCommandReadinessDrafts(current).map((draft) => [
        draft.id,
        settingsCommandFingerprint(draft),
      ]),
    );
    const changedCommands = settingsCommandReadinessDrafts(next)
      .filter(
        (draft) =>
          commandNeedsReadiness(draft) &&
          currentCommands.get(draft.id) !== settingsCommandFingerprint(draft),
      )
      .map((draft) => ({
        purpose: draft.purpose,
        command: draft.command,
      }));
    const changedFolders: FolderReadinessRequest[] = [];
    if (current.worktreeRoot !== next.worktreeRoot) {
      changedFolders.push({ purpose: 'managed-worktrees', path: next.worktreeRoot });
    }
    if (
      next.backupsEnabled &&
      (!current.backupsEnabled || current.backupDirectory !== next.backupDirectory)
    ) {
      changedFolders.push({
        purpose: 'backup-destination',
        path: next.backupDirectory,
      });
    }
    await Promise.all([
      ...changedAgents.map(async (request) => await this.#verifyAgent(request)),
      ...changedCommands.map(async (request) => await this.#verifyCommand(request)),
      ...changedFolders.map(async (request) => await this.#verifyFolder(request)),
    ]);
  }

  async #verifyAgent(request: AgentReadinessRequest): Promise<void> {
    const result = AgentReadinessResultSchema.parse(
      await this.agents.verifySettingsReadiness(request),
    );
    if (
      !result.ready ||
      result.agentId !== request.agentId ||
      result.source !== expectedReadinessSource(request)
    ) {
      throw new Error(
        `Refresh readiness for ${request.agentId} from the current Settings draft before saving.`,
      );
    }
  }

  async #verifyFolder(request: FolderReadinessRequest): Promise<void> {
    const result = FolderReadinessResultSchema.parse(await this.folders.check(request));
    if (!folderReadinessMatches(result, request) || !result.ready) {
      throw new Error(
        result.reason ??
          `The ${request.purpose === 'managed-worktrees' ? 'managed worktree folder' : 'backup destination'} is not ready.`,
      );
    }
  }

  async #verifyCommand(
    request: Pick<CommandReadinessRequest, 'purpose' | 'command'>,
  ): Promise<void> {
    const result = CommandReadinessResultSchema.parse(
      await this.commands.verifySettingsReadiness(request),
    );
    if (
      !result.ready ||
      settingsCommandFingerprint(result.request) !== settingsCommandFingerprint(request)
    ) {
      throw new Error(
        result.reason ?? 'Refresh readiness for the current command draft before saving.',
      );
    }
  }
}
