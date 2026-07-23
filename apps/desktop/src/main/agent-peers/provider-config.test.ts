import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    // `resolveCodexHome` deliberately ignores a `CODEX_HOME` override in the main process's own
    // env and always writes under `join(homedir(), '.codex')` -- the location codex-in-the-PTY
    // resolves, since the PTY env (baseTerminalEnvironment + the agent session's empty
    // environmentVariableNames + peerEnvironment) never carries CODEX_HOME. So these tests mock
    // `HOME` (which `os.homedir()` reads live on every call -- see node:os) to get a
    // deterministic, isolated write location, mirroring the same temp-dir/env-mocking style the
    // old CODEX_HOME-based setup used.
    let homeDir: string;
    const originalHome = process.env['HOME'];
    const originalCodexHome = process.env['CODEX_HOME'];

    beforeEach(async () => {
      homeDir = await makeTempDir('forgeboard-codex-fakehome-');
      process.env['HOME'] = homeDir;
      delete process.env['CODEX_HOME'];
    });

    afterEach(async () => {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = originalCodexHome;
      await rm(homeDir, { recursive: true, force: true });
    });

    function codexHomeDir(): string {
      return join(homeDir, '.codex');
    }

    it('never puts the token/url in argv; writes them to a 0600 profile TOML under join(homedir(), ".codex") instead', async () => {
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

      const profilePath = join(codexHomeDir(), `${profileName}.config.toml`);
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
      await rm(join(codexHomeDir(), `${profileName}.config.toml`));
      await expect(material.cleanup()).resolves.toBeUndefined();
    });

    it('ignores a custom CODEX_HOME set in the main process env, writing under join(homedir(), ".codex") instead -- proving the main-process write location and the PTY-process read location provably agree even when CODEX_HOME diverges (Option A of the whole-branch review finding)', async () => {
      const customCodexHome = await makeTempDir('forgeboard-codex-custom-home-');
      try {
        process.env['CODEX_HOME'] = customCodexHome;

        const material = await writeProviderPeerMaterial({
          adapterId: 'codex',
          provisionDir,
          projectRoot,
          environment: ENVIRONMENT,
        });

        const profileName = material.extraArguments[1];

        // Written where codex-in-the-PTY actually resolves ($HOME/.codex -- the PTY env never
        // carries CODEX_HOME, see baseTerminalEnvironment() in terminal/pty-process.ts).
        const homeProfilePath = join(codexHomeDir(), `${profileName}.config.toml`);
        await expect(stat(homeProfilePath)).resolves.toBeDefined();

        // NOT written under the custom CODEX_HOME -- that would only be visible to the main
        // process, never to codex running inside the PTY.
        const customProfilePath = join(customCodexHome, `${profileName}.config.toml`);
        await expect(stat(customProfilePath)).rejects.toMatchObject({ code: 'ENOENT' });

        await material.cleanup();
        await expect(stat(homeProfilePath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(customCodexHome, { recursive: true, force: true });
      }
    });
  });

  describe('gemini', () => {
    it('merges mcpServers.forgeboard-<provisionId> into .gemini/settings.json without writing the token/url', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'gemini',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      expect(material.available).toBe(true);
      expect(material.extraArguments).toEqual([]);

      const provisionId = provisionDir.split('/').pop();
      const entryKey = `forgeboard-${provisionId}`;
      const settingsPath = join(projectRoot, '.gemini', 'settings.json');
      const parsed = (await readJson(settingsPath)) as {
        mcpServers: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
      };
      expect(parsed.mcpServers[entryKey]).toEqual({
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

      const provisionId = provisionDir.split('/').pop();
      const entryKey = `forgeboard-${provisionId}`;
      const afterWrite = (await readJson(settingsPath)) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(afterWrite.theme).toBe('dark');
      expect(afterWrite.mcpServers['other']).toEqual({ command: 'foo' });
      expect(afterWrite.mcpServers[entryKey]).toBeDefined();

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
      const provisionId = provisionDir.split('/').pop();
      const settingsPath = join(projectRoot, '.gemini', 'settings.json');
      const parsed = (await readJson(settingsPath)) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers)).toEqual([`forgeboard-${provisionId}`]);
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
      const provisionId = provisionDir.split('/').pop();
      const parsed = (await readJson(settingsPath)) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers)).toEqual([`forgeboard-${provisionId}`]);

      await material.cleanup();
      // The file pre-existed (even though it was invalid) -- cleanup must never delete it.
      const info = await stat(settingsPath);
      expect(info).toBeDefined();
      const afterCleanup = (await readJson(settingsPath)) as { mcpServers?: unknown };
      expect(afterCleanup.mcpServers).toBeUndefined();
    });

    it('supports two concurrent gemini provisions on the same project without clobbering each other', async () => {
      const provisionDirA = await makeTempDir('forgeboard-peer-provision-a-');
      const provisionDirB = await makeTempDir('forgeboard-peer-provision-b-');
      try {
        const settingsPath = join(projectRoot, '.gemini', 'settings.json');
        const idA = provisionDirA.split('/').pop();
        const idB = provisionDirB.split('/').pop();
        const keyA = `forgeboard-${idA}`;
        const keyB = `forgeboard-${idB}`;

        const materialA = await writeProviderPeerMaterial({
          adapterId: 'gemini',
          provisionDir: provisionDirA,
          projectRoot,
          environment: ENVIRONMENT,
        });
        const materialB = await writeProviderPeerMaterial({
          adapterId: 'gemini',
          provisionDir: provisionDirB,
          projectRoot,
          environment: ENVIRONMENT,
        });

        const afterBothWrites = (await readJson(settingsPath)) as {
          mcpServers: Record<string, unknown>;
        };
        expect(afterBothWrites.mcpServers[keyA]).toBeDefined();
        expect(afterBothWrites.mcpServers[keyB]).toBeDefined();

        // Cleaning up the FIRST provision must leave the SECOND's key intact and the file present
        // -- the file isn't empty yet (B's entry remains), so it's rewritten, not deleted.
        await materialA.cleanup();
        const afterFirstCleanup = (await readJson(settingsPath)) as {
          mcpServers: Record<string, unknown>;
        };
        expect(afterFirstCleanup.mcpServers[keyA]).toBeUndefined();
        expect(afterFirstCleanup.mcpServers[keyB]).toBeDefined();
        await expect(stat(settingsPath)).resolves.toBeDefined();

        // Cleaning up the SECOND provision removes its key too. It must NOT delete the file:
        // the file already existed (A created it) before B's own write, so B never qualifies as
        // the creator and must never be the one to delete it -- even though it is now empty.
        await materialB.cleanup();
        const afterSecondCleanup = (await readJson(settingsPath)) as {
          mcpServers?: Record<string, unknown>;
        };
        expect(afterSecondCleanup.mcpServers?.[keyA]).toBeUndefined();
        expect(afterSecondCleanup.mcpServers?.[keyB]).toBeUndefined();
        await expect(stat(settingsPath)).resolves.toBeDefined();
      } finally {
        await rm(provisionDirA, { recursive: true, force: true });
        await rm(provisionDirB, { recursive: true, force: true });
      }
    });
  });

  describe('opencode', () => {
    it('merges mcp.forgeboard-<provisionId> into opencode.json without writing the token/url', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'opencode',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });

      expect(material.available).toBe(true);
      expect(material.extraArguments).toEqual([]);

      const provisionId = provisionDir.split('/').pop();
      const entryKey = `forgeboard-${provisionId}`;
      const configPath = join(projectRoot, 'opencode.json');
      const parsed = (await readJson(configPath)) as {
        mcp: Record<
          string,
          { type: string; command: string[]; environment: Record<string, string> }
        >;
      };
      expect(parsed.mcp[entryKey]).toEqual({
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

    it('supports two concurrent opencode provisions on the same project without clobbering each other', async () => {
      const provisionDirA = await makeTempDir('forgeboard-peer-provision-a-');
      const provisionDirB = await makeTempDir('forgeboard-peer-provision-b-');
      try {
        const configPath = join(projectRoot, 'opencode.json');
        const idA = provisionDirA.split('/').pop();
        const idB = provisionDirB.split('/').pop();
        const keyA = `forgeboard-${idA}`;
        const keyB = `forgeboard-${idB}`;

        const materialA = await writeProviderPeerMaterial({
          adapterId: 'opencode',
          provisionDir: provisionDirA,
          projectRoot,
          environment: ENVIRONMENT,
        });
        const materialB = await writeProviderPeerMaterial({
          adapterId: 'opencode',
          provisionDir: provisionDirB,
          projectRoot,
          environment: ENVIRONMENT,
        });

        const afterBothWrites = (await readJson(configPath)) as { mcp: Record<string, unknown> };
        expect(afterBothWrites.mcp[keyA]).toBeDefined();
        expect(afterBothWrites.mcp[keyB]).toBeDefined();

        // Cleaning up the FIRST provision must leave the SECOND's key intact and the file present
        // -- the file isn't empty yet (B's entry remains), so it's rewritten, not deleted.
        await materialA.cleanup();
        const afterFirstCleanup = (await readJson(configPath)) as { mcp: Record<string, unknown> };
        expect(afterFirstCleanup.mcp[keyA]).toBeUndefined();
        expect(afterFirstCleanup.mcp[keyB]).toBeDefined();
        await expect(stat(configPath)).resolves.toBeDefined();

        // Cleaning up the SECOND provision removes its key too. It must NOT delete the file:
        // the file already existed (A created it) before B's own write, so B never qualifies as
        // the creator and must never be the one to delete it -- even though it is now empty.
        await materialB.cleanup();
        const afterSecondCleanup = (await readJson(configPath)) as {
          mcp?: Record<string, unknown>;
        };
        expect(afterSecondCleanup.mcp?.[keyA]).toBeUndefined();
        expect(afterSecondCleanup.mcp?.[keyB]).toBeUndefined();
        await expect(stat(configPath)).resolves.toBeDefined();
      } finally {
        await rm(provisionDirA, { recursive: true, force: true });
        await rm(provisionDirB, { recursive: true, force: true });
      }
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

  describe('provision id validation', () => {
    it.each(['codex', 'gemini', 'opencode'] as const)(
      'rejects a path-hostile provisionDir basename for %s with available:false instead of writing to disk',
      async (adapterId) => {
        // Built with string concatenation, not path.join -- join() would normalize away a `..`
        // segment, defeating the point of this test. The basename must itself be an unsafe
        // token (space, `!`, `$`) that the safe-token pattern rejects.
        const hostileProvisionDir = `${tmpdir()}/evil name!with$pecial`;

        const material = await writeProviderPeerMaterial({
          adapterId,
          provisionDir: hostileProvisionDir,
          projectRoot,
          environment: ENVIRONMENT,
        });

        expect(material.available).toBe(false);
        expect(material.hint).toBeTruthy();
        expect(material.extraArguments).toEqual([]);
        await expect(material.cleanup()).resolves.toBeUndefined();

        // Nothing should have been written to the project root by the rejected gemini/opencode
        // writes (and, for codex, nothing under CODEX_HOME either -- checked by an empty
        // projectRoot here since codex never touches it in the first place).
        const { readdir } = await import('node:fs/promises');
        expect(await readdir(projectRoot)).toEqual([]);
      },
    );

    it('accepts a plain safe provisionDir basename (the normal case)', async () => {
      const material = await writeProviderPeerMaterial({
        adapterId: 'gemini',
        provisionDir,
        projectRoot,
        environment: ENVIRONMENT,
      });
      expect(material.available).toBe(true);
      await material.cleanup();
    });
  });
});
