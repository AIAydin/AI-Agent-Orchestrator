import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({ isPackaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronMock.isPackaged;
    },
  },
}));

import { shimEntryPath, writeProviderPeerMaterial } from './provider-config.js';

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
// apps/desktop/src/main/agent-peers -> repo root is 5 levels up.
const REPO_ROOT = resolve(TEST_FILE_DIR, '../../../../..');
const APPS_DESKTOP_DIR = resolve(TEST_FILE_DIR, '../../..');

const ENVIRONMENT = Object.freeze({
  FORGEBOARD_PEER_URL: 'http://127.0.0.1:54999',
  FORGEBOARD_PEER_TOKEN: 'test-secret-token-do-not-leak',
});

async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('shimEntryPath', () => {
  afterEach(() => {
    electronMock.isPackaged = false;
    delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  });

  it('resolves under process.resourcesPath when packaged', () => {
    electronMock.isPackaged = true;
    (process as unknown as { resourcesPath: string }).resourcesPath = '/fake/resources';
    expect(shimEntryPath()).toBe(join('/fake/resources', 'peer-mcp', 'main.js'));
  });

  it('resolves the dev dist path relative to cwd when not packaged', () => {
    electronMock.isPackaged = false;
    expect(shimEntryPath()).toBe(resolve(process.cwd(), '../../packages/peer-mcp/dist/main.js'));
  });

  it('the dev target exists on disk once packages/peer-mcp has been built (Task 3)', async () => {
    // cwd-independent check: confirms the real build artifact this repo's dev-mode
    // shimEntryPath() would resolve to (when invoked with cwd = apps/desktop, as the real
    // app always is) genuinely exists.
    const devTarget = resolve(APPS_DESKTOP_DIR, '../../packages/peer-mcp/dist/main.js');
    expect(devTarget).toBe(join(REPO_ROOT, 'packages/peer-mcp/dist/main.js'));
    await expect(stat(devTarget)).resolves.toBeDefined();
  });
});

describe('writeProviderPeerMaterial', () => {
  let provisionDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    provisionDir = await makeTempDir('forgeboard-peer-provision-');
    projectRoot = await makeTempDir('forgeboard-peer-project-');
  });

  afterEach(async () => {
    await rm(provisionDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe('claude', () => {
    it('writes a 0600 mcp.json into the provision scratch dir and points --mcp-config at it', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'claude',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      expect(material.available).toBe(true);
      expect(material.hint).toBeNull();

      const configPath = join(provisionDir, 'mcp.json');
      expect(material.extraArguments).toEqual(['--mcp-config', configPath]);

      const parsed = await readJson(configPath);
      expect(parsed).toEqual({
        mcpServers: {
          forgeboard: {
            command: process.execPath,
            args: [shimEntryPath()],
            env: { ELECTRON_RUN_AS_NODE: '1', ...ENVIRONMENT },
          },
        },
      });

      const info = await stat(configPath);
      expect(info.mode & 0o777).toBe(0o600);

      await material.cleanup();
      await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('cleanup does not throw when the file was already removed', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'claude',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });
      await rm(join(provisionDir, 'mcp.json'));
      await expect(material.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('codex', () => {
    let codexHome: string;
    const originalCodexHome = process.env['CODEX_HOME'];

    beforeEach(async () => {
      codexHome = await makeTempDir('forgeboard-codex-home-');
      process.env['CODEX_HOME'] = codexHome;
    });

    afterEach(async () => {
      if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = originalCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    });

    it('never puts the token/url in argv; writes them to a 0600 profile TOML under CODEX_HOME instead', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'codex',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      expect(material.available).toBe(true);
      expect(material.hint).toBeNull();

      // Security: argv is world-readable via `ps`. Neither the token nor the url may appear
      // in any argument -- codex does not inherit the parent env into its MCP server child
      // (verified empirically; see task-8-report.md), so this must be a file-based handoff.
      for (const arg of material.extraArguments) {
        expect(arg).not.toContain(ENVIRONMENT.FORGEBOARD_PEER_TOKEN);
        expect(arg).not.toContain(ENVIRONMENT.FORGEBOARD_PEER_URL);
      }
      expect(material.extraArguments[0]).toBe('--profile');
      const profileName = material.extraArguments[1];
      expect(profileName).toMatch(/^forgeboard-/);

      const profilePath = join(codexHome, `${profileName}.config.toml`);
      const toml = await readFile(profilePath, 'utf8');
      expect(toml).toContain('[mcp_servers.forgeboard]');
      expect(toml).toContain(`command = "${process.execPath}"`);
      expect(toml).toContain(shimEntryPath());
      expect(toml).toContain('[mcp_servers.forgeboard.env]');
      expect(toml).toContain('ELECTRON_RUN_AS_NODE');
      expect(toml).toContain(ENVIRONMENT.FORGEBOARD_PEER_URL);
      expect(toml).toContain(ENVIRONMENT.FORGEBOARD_PEER_TOKEN);

      const info = await stat(profilePath);
      expect(info.mode & 0o777).toBe(0o600);

      await material.cleanup();
      await expect(stat(profilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('scopes the profile file name to the provision (basename of provisionDir)', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'codex',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });
      const provisionId = provisionDir.split('/').pop();
      expect(material.extraArguments).toEqual(['--profile', `forgeboard-${provisionId}`]);
      await material.cleanup();
    });

    it('cleanup does not throw when the profile file was already removed', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'codex',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });
      const profileName = material.extraArguments[1];
      await rm(join(codexHome, `${profileName}.config.toml`));
      await expect(material.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('gemini', () => {
    it('merges mcpServers.forgeboard into .gemini/settings.json without writing the token/url', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'gemini',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      expect(material.available).toBe(true);
      expect(material.extraArguments).toEqual([]);

      const settingsPath = join(projectRoot, '.gemini', 'settings.json');
      const parsed = (await readJson(settingsPath)) as {
        mcpServers: {
          forgeboard: { command: string; args: string[]; env: Record<string, string> };
        };
      };
      expect(parsed.mcpServers.forgeboard).toEqual({
        command: process.execPath,
        args: [shimEntryPath()],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });

      const raw = await readFile(settingsPath, 'utf8');
      expect(raw).not.toContain(ENVIRONMENT.FORGEBOARD_PEER_TOKEN);
      expect(raw).not.toContain(ENVIRONMENT.FORGEBOARD_PEER_URL);

      await material.cleanup();
      await expect(stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(projectRoot, '.gemini'))).resolves.toBeDefined();
    });

    it('preserves unrelated existing keys and only removes our own entry on cleanup', async () => {
      await mkdir(join(projectRoot, '.gemini'), { recursive: true });
      const settingsPath = join(projectRoot, '.gemini', 'settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'foo' } } }, null, 2),
      );

      const material = await writeProviderPeerMaterial({
        adapterId: 'gemini',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      const afterWrite = (await readJson(settingsPath)) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(afterWrite.theme).toBe('dark');
      expect(afterWrite.mcpServers['other']).toEqual({ command: 'foo' });
      expect(afterWrite.mcpServers['forgeboard']).toBeDefined();

      await material.cleanup();

      const afterCleanup = (await readJson(settingsPath)) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(afterCleanup).toEqual({ theme: 'dark', mcpServers: { other: { command: 'foo' } } });
    });

    it('tolerates a missing existing file (treats it as {})', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'gemini',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });
      const settingsPath = join(projectRoot, '.gemini', 'settings.json');
      const parsed = (await readJson(settingsPath)) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers)).toEqual(['forgeboard']);
      await material.cleanup();
    });

    it('tolerates an invalid existing file (treats it as {}) and never deletes it on cleanup', async () => {
      await mkdir(join(projectRoot, '.gemini'), { recursive: true });
      const settingsPath = join(projectRoot, '.gemini', 'settings.json');
      await writeFile(settingsPath, '{ not valid json');

      const material = await writeProviderPeerMaterial({
        adapterId: 'gemini',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });
      const parsed = (await readJson(settingsPath)) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers)).toEqual(['forgeboard']);

      await material.cleanup();
      // The file pre-existed (even though it was invalid) -- cleanup must never delete it.
      const info = await stat(settingsPath);
      expect(info).toBeDefined();
      const afterCleanup = (await readJson(settingsPath)) as { mcpServers?: unknown };
      expect(afterCleanup.mcpServers).toBeUndefined();
    });
  });

  describe('opencode', () => {
    it('merges mcp.forgeboard into opencode.json without writing the token/url', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'opencode',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      expect(material.available).toBe(true);
      expect(material.extraArguments).toEqual([]);

      const configPath = join(projectRoot, 'opencode.json');
      const parsed = (await readJson(configPath)) as {
        mcp: {
          forgeboard: { type: string; command: string[]; environment: Record<string, string> };
        };
      };
      expect(parsed.mcp.forgeboard).toEqual({
        type: 'local',
        command: [process.execPath, shimEntryPath()],
        environment: { ELECTRON_RUN_AS_NODE: '1' },
      });

      const raw = await readFile(configPath, 'utf8');
      expect(raw).not.toContain(ENVIRONMENT.FORGEBOARD_PEER_TOKEN);
      expect(raw).not.toContain(ENVIRONMENT.FORGEBOARD_PEER_URL);

      await material.cleanup();
      await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserves unrelated existing keys in opencode.json and only removes our own entry on cleanup', async () => {
      const configPath = join(projectRoot, 'opencode.json');
      await writeFile(
        configPath,
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: { other: { type: 'local', command: ['x'] } },
          },
          null,
          2,
        ),
      );

      const material = await writeProviderPeerMaterial({
        adapterId: 'opencode',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      await material.cleanup();

      const afterCleanup = (await readJson(configPath)) as Record<string, unknown>;
      expect(afterCleanup).toEqual({
        $schema: 'https://opencode.ai/config.json',
        mcp: { other: { type: 'local', command: ['x'] } },
      });
    });
  });

  describe('unknown adapter', () => {
    it('reports unavailable with a hint and performs no filesystem writes', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'some-future-cli',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      expect(material.available).toBe(false);
      expect(material.hint).toBe('Peer tools unavailable for this agent.');
      expect(material.extraArguments).toEqual([]);

      const { readdir } = await import('node:fs/promises');
      expect(await readdir(provisionDir)).toEqual([]);
      expect(await readdir(projectRoot)).toEqual([]);

      await expect(material.cleanup()).resolves.toBeUndefined();
    });
  });
});
