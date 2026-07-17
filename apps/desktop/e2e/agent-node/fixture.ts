import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ADAPTER_ID = 'forgeboard.e2e.offline.agent';
export const EXTENSION_ID = 'forgeboard.e2e.offline';
export const MODEL_ID = 'offline-model-v1';
export const INITIAL_PROMPT = 'Wait for explicit interactive input, then remain active.';
export const RETRY_FAILURE_PROMPT = 'RETRY_FAIL as an eligible retry parent.';
export const RETRY_PROMPT = 'RETRY_COMPLETE through a fresh reviewed attempt.';
export const INPUT_TEXT = 'approved-interactive-input';

export interface PrimarySnapshot {
  readonly head: string;
  readonly readme: string;
  readonly status: string;
}

export async function createRepository(repositoryPath: string): Promise<PrimarySnapshot> {
  await mkdir(repositoryPath, { recursive: true });
  await writeFile(join(repositoryPath, 'README.md'), '# Agent node E2E primary checkout\n');
  await runGit(repositoryPath, ['init', '--initial-branch=main']);
  await runGit(repositoryPath, ['add', '--', 'README.md']);
  await runGit(repositoryPath, [
    '-c',
    'user.name=Forgeboard E2E',
    '-c',
    'user.email=forgeboard-e2e@example.invalid',
    'commit',
    '-m',
    'Initial primary state',
  ]);
  return await primarySnapshot(repositoryPath);
}

export async function primarySnapshot(repositoryPath: string): Promise<PrimarySnapshot> {
  const [head, status, readme] = await Promise.all([
    runGit(repositoryPath, ['rev-parse', 'HEAD']),
    runGit(repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all']),
    readFile(join(repositoryPath, 'README.md'), 'utf8'),
  ]);
  return { head: head.trim(), status, readme };
}

export async function writeOfflineExtension(extensionPath: string): Promise<void> {
  await mkdir(extensionPath, { recursive: true });
  const scriptPath = fileURLToPath(
    new URL('./fixtures/scripts/offline-agent.mjs', import.meta.url),
  );
  const manifest = {
    schemaVersion: 1,
    id: EXTENSION_ID,
    name: 'Forgeboard offline E2E agent',
    version: '1.0.0',
    description: 'A local JSON-lines fixture used only by the Agent-node Electron journey.',
    publisher: 'Forgeboard test suite',
    requestedPermissions: ['agent.adapter.register', 'agent.process.launch'],
    contributes: {
      agentAdapters: [
        {
          schemaVersion: 1,
          id: ADAPTER_ID,
          name: 'Offline resumable agent',
          provider: {
            name: 'Local offline fixture',
            sendsContextOffDevice: false,
            disclosure: 'This deterministic fixture runs locally and performs no network access.',
          },
          executable: {
            command: process.execPath,
            versionArguments: ['--version'],
            versionPattern: 'v(?<version>\\d+(?:\\.\\d+)+)',
            detectionTimeoutMs: 2_000,
          },
          invocation: {
            runtime: 'pipes',
            launchArguments: [
              scriptPath,
              'launch',
              '--no-alt-screen',
              '{permissionArgs}',
              '{modelArgs}',
              '{extraArgs}',
              '{prompt}',
            ],
            resumeArguments: [
              scriptPath,
              'resume',
              '--no-alt-screen',
              '{permissionArgs}',
              '{modelArgs}',
              '{extraArgs}',
              '{sessionId}',
              '{prompt}',
            ],
            promptTransport: 'argument',
            modelArguments: ['--model', '{model}'],
            context: { strategy: 'none' },
            permissionArguments: {
              'plan-read-only': ['--permission', 'read-only'],
              'worktree-write': ['--permission', 'worktree-write'],
            },
            output: 'json-lines',
          },
          capabilities: {
            interactiveInput: true,
            interrupt: true,
            terminate: true,
            pause: false,
            resume: true,
            ansiStreaming: false,
            structuredOutput: true,
            modelSelection: true,
            contextAttachments: false,
            permissionModes: ['plan-read-only', 'worktree-write'],
          },
          suggestedEnvironmentVariables: [],
        },
      ],
      canvasNodeTypes: [],
    },
  };
  await writeFile(
    join(extensionPath, 'forgeboard-extension.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function findFiles(root: string, name: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) results.push(...(await findFiles(candidate, name)));
    else if (entry.isFile() && entry.name === name) results.push(candidate);
  }
  return results;
}

async function runGit(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...arguments_], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout;
}
