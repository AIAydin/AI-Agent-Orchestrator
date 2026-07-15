import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkDockerReadiness, pullDockerImage } from './docker-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('main-owned Docker runtime', () => {
  it('checks the configured agent in a constrained no-mount, no-network container', async () => {
    if (process.platform === 'win32') return;
    const fixture = await dockerFixture('ready');
    const readiness = await checkDockerReadiness({
      dockerExecutable: fixture.executable,
      image: 'local/forgeboard-agent:1',
      containerExecutable: '/usr/local/bin/codex',
    });

    expect(readiness).toMatchObject({
      available: true,
      status: 'ready',
      executableAvailable: true,
      daemonAvailable: true,
      imageAvailable: true,
      imageCompatible: true,
      containerExecutableAvailable: true,
      agentVersion: 'codex 1.2.3',
    });
    const argumentsLog = await readFile(fixture.log, 'utf8');
    expect(argumentsLog).toContain(['run', '--rm', '--pull', 'never', '--name'].join('\n'));
    expect(argumentsLog).toContain('--network\nnone');
    expect(argumentsLog).toContain('--read-only');
    expect(argumentsLog).toContain('--cap-drop\nALL');
    expect(argumentsLog).toContain('--security-opt\nno-new-privileges:true');
    expect(argumentsLog).toContain('--entrypoint\n/usr/local/bin/codex');
    expect(argumentsLog).not.toContain('--mount');
    expect(argumentsLog).not.toContain('/var/run/docker.sock');
  });

  it('reports a missing in-image executable without claiming the profile is ready', async () => {
    if (process.platform === 'win32') return;
    const fixture = await dockerFixture('missing-agent');
    const readiness = await checkDockerReadiness({
      dockerExecutable: fixture.executable,
      image: 'local/forgeboard-agent:1',
      containerExecutable: '/missing/codex',
    });

    expect(readiness).toMatchObject({
      available: false,
      status: 'agent-unavailable',
      imageCompatible: true,
      containerExecutableAvailable: false,
    });
    expect(readiness.reason).toContain('could not start');
    expect(readiness.reason).not.toContain('\n');
    expect(readiness.reason).not.toContain('\u001B');
  });

  it('uses a bounded literal pull argv and rejects hostile image input before launch', async () => {
    if (process.platform === 'win32') return;
    const fixture = await dockerFixture('ready');
    const result = await pullDockerImage({
      dockerExecutable: fixture.executable,
      image: 'registry.example/forgeboard-agent:1',
      containerExecutable: '/usr/local/bin/codex',
    });
    expect(result.image).toBe('registry.example/forgeboard-agent:1');
    expect(result.executable).toMatch(/\/docker$/u);
    expect(await readFile(fixture.log, 'utf8')).toBe(
      'pull\nregistry.example/forgeboard-agent:1\n--END--\n',
    );

    await expect(
      pullDockerImage({
        dockerExecutable: fixture.executable,
        image: 'agent;touch /tmp/escaped',
        containerExecutable: '/usr/local/bin/codex',
      }),
    ).rejects.toThrow('CLI metacharacters');
    expect(await readFile(fixture.log, 'utf8')).toBe(
      'pull\nregistry.example/forgeboard-agent:1\n--END--\n',
    );
  });

  it('times out a readiness process and requests cleanup by generated container name', async () => {
    if (process.platform === 'win32') return;
    const fixture = await dockerFixture('timeout');
    const readiness = await checkDockerReadiness(
      {
        dockerExecutable: fixture.executable,
        image: 'local/forgeboard-agent:1',
        containerExecutable: '/usr/local/bin/codex',
      },
      { checkTimeoutMs: 2_000 },
    );

    expect(readiness).toMatchObject({ available: false, status: 'agent-unavailable' });
    expect(readiness.reason).toContain('timed out');
    const argumentsLog = await readFile(fixture.log, 'utf8');
    expect(argumentsLog).toMatch(/rm\n--force\nforgeboard-readiness-[a-f0-9-]+/u);
  });
});

async function dockerFixture(mode: 'ready' | 'missing-agent' | 'timeout'): Promise<{
  executable: string;
  log: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'forgeboard-docker-runtime-'));
  roots.push(root);
  const executable = path.join(root, 'docker');
  const log = path.join(root, 'arguments.log');
  const runAction =
    mode === 'ready'
      ? "printf 'codex 1.2.3'; exit 0"
      : mode === 'missing-agent'
        ? "printf '\\033[31mexec failed\\n' >&2; exit 127"
        : 'exec sleep 5';
  await writeFile(
    executable,
    `#!/bin/sh
for argument in "$@"; do printf '%s\\n' "$argument" >> ${shellQuote(log)}; done
printf '%s\\n' '--END--' >> ${shellQuote(log)}
if [ "$1" = "version" ]; then
  printf '27.5.1'
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf '[{"Id":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Os":"linux","Architecture":"amd64","Config":{"Volumes":null}}]'
  exit 0
fi
if [ "$1" = "run" ]; then
  ${runAction}
fi
if [ "$1" = "pull" ]; then
  printf 'downloaded'
  exit 0
fi
if [ "$1" = "rm" ]; then
  exit 0
fi
exit 19
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, log };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
