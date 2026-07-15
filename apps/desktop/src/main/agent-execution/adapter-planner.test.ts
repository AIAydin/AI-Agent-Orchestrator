import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppSettings } from '../../shared/contracts.js';
import { createDefaultAgentAdapterPlanner } from './adapter-planner.js';
import type { AgentExecutionRequest } from './contracts.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('default agent adapter planner launch binding', () => {
  it('rejects replacement of the bundled test-agent script after review', async () => {
    const repositoryPath = await temporaryDirectory();
    const cliPath = path.join(repositoryPath, 'test-agent-cli.js');
    await writeFile(cliPath, 'process.exit(0);\n');
    const planner = createDefaultAgentAdapterPlanner({
      getTrustedAdapter: () => Promise.resolve(undefined),
      resolveTestAgentCliPath: () => Promise.resolve(cliPath),
    });

    const planned = await planner(
      request(),
      repositoryPath,
      { envAllowlist: [] } as unknown as AppSettings,
      '123fae6e-e213-4a10-a0db-0f85b791f7e9',
    );
    await expect(planned.revalidateBeforeLaunch?.()).resolves.toBeUndefined();

    await writeFile(cliPath, 'process.exit(7);\n');
    await expect(planned.revalidateBeforeLaunch?.()).rejects.toThrow(/launch file changed/iu);
  });

  it('rejects a Docker client that replaces itself while rechecking the image tag', async () => {
    if (process.platform === 'win32') return;
    const repositoryPath = await temporaryDirectory();
    const dockerExecutable = path.join(repositoryPath, 'docker');
    const replacement = path.join(repositoryPath, 'replacement-docker');
    const replaceMarker = path.join(repositoryPath, 'replace-now');
    const logPath = path.join(repositoryPath, 'docker-argv.log');
    await writeFile(dockerExecutable, dockerClientScript(true));
    await writeFile(replacement, dockerClientScript(false));
    await Promise.all([chmod(dockerExecutable, 0o700), chmod(replacement, 0o700)]);
    const planner = createDefaultAgentAdapterPlanner({
      getTrustedAdapter: () => Promise.resolve(undefined),
      resolveTestAgentCliPath: () => Promise.reject(new Error('not used')),
    });

    const planned = await planner(
      { ...request(), adapterId: 'codex', permissionProfile: 'docker-isolated' },
      repositoryPath,
      dockerSettings(dockerExecutable),
      '123fae6e-e213-4a10-a0db-0f85b791f7e9',
    );
    const preparationInvocations = await readFile(logPath, 'utf8');
    expect(preparationInvocations).toContain('version --format {{.Server.Version}}');
    expect(preparationInvocations).toContain('image inspect local/test:1');
    expect(preparationInvocations).not.toMatch(/(^|\n)run(?:\s|$)/u);

    await writeFile(replaceMarker, 'replace on the next version probe\n');
    await expect(planned.revalidateBeforeLaunch?.()).rejects.toThrow(/launch file changed/iu);
  });
});

function request(): AgentExecutionRequest {
  return {
    projectId: '123fae6e-e213-4a10-a0db-0f85b791f7e9',
    nodeId: 'agent-node',
    adapterId: 'test-agent',
    prompt: 'Inspect this repository.',
    permissionProfile: 'plan-read-only',
    context: { attachments: [], manifestId: 'context-v1', manifestDigest: 'a'.repeat(64) },
  };
}

function dockerSettings(dockerExecutable: string): AppSettings {
  return {
    envAllowlist: [],
    agentDefaultModels: {},
    dockerEnabled: true,
    dockerExecutable,
    dockerImage: 'local/test:1',
    dockerContainerExecutable: '/usr/local/bin/codex',
    dockerNetwork: 'disabled',
    dockerCpuLimit: 2,
    dockerMemoryMb: 4_096,
    dockerMountHostCredentials: false,
  } as unknown as AppSettings;
}

function dockerClientScript(replaceItself: boolean): string {
  const imageId = `sha256:${'a'.repeat(64)}`;
  return [
    '#!/bin/sh',
    'directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'printf \'%s\\n\' "$*" >> "$directory/docker-argv.log"',
    'if [ "$1" = "version" ]; then',
    ...(replaceItself
      ? [
          '  if [ -f "$directory/replace-now" ]; then',
          '    cp "$directory/replacement-docker" "$0"',
          '    chmod 700 "$0"',
          '  fi',
        ]
      : []),
    "  printf '27.1.0'",
    '  exit 0',
    'fi',
    'if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$3" = "local/test:1" ]; then',
    `  printf '[{"Id":"${imageId}","Os":"linux","Architecture":"amd64","Config":{"Volumes":null}}]'`,
    '  exit 0',
    'fi',
    'exit 19',
    '',
  ].join('\n');
}

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'forgeboard-adapter-planner-')),
  );
  temporaryDirectories.push(directory);
  return directory;
}
