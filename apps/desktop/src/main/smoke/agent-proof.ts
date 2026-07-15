import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  PACKAGED_SMOKE_AGENT_NODE_ID,
  PACKAGED_SMOKE_AGENT_PROMPT,
  type PackagedRendererDemoProbe,
  type PackagedSmokeReport,
} from '../../shared/smoke/contracts.js';
import type { AgentExecutionOperations } from '../agent-execution/contracts.js';
import type { StoredRunRecord } from '../storage.js';

export interface PackagedSmokeRuns {
  executionOperations(): AgentExecutionOperations;
}

export interface PackagedSmokeStore {
  getProject(projectId: string):
    | {
        readonly id: string;
        readonly path: string;
        readonly missing: boolean;
      }
    | undefined;
  getRun(runId: string): StoredRunRecord | undefined;
}

export interface PackagedAgentProofInput {
  readonly profileRoot: string;
  readonly demo: PackagedRendererDemoProbe;
  readonly runs: PackagedSmokeRuns;
  readonly store: PackagedSmokeStore;
  readonly agentExecutablePath: string;
  readonly testAgentResourcePath: string;
  readonly timeoutMs: number;
}

export type PackagedAgentProof = Pick<
  PackagedSmokeReport,
  | 'agentRun'
  | 'durableRun'
  | 'agentRunId'
  | 'agentExecutablePath'
  | 'agentResourcePath'
  | 'agentProcessId'
  | 'agentWorktreePath'
  | 'agentChangedFiles'
  | 'agentOutputPath'
  | 'agentOutputSha256'
  | 'agentOutputDigest'
>;

export async function provePackagedTestAgent(
  input: PackagedAgentProofInput,
): Promise<PackagedAgentProof> {
  if (input.demo.projectId === null || input.demo.projectPath === null) {
    throw new Error('The packaged agent proof requires the renderer-created demo project.');
  }
  const [profileRoot, demoProjectPath, agentExecutablePath, testAgentResourcePath] =
    await Promise.all([
      canonicalDirectory(input.profileRoot),
      canonicalDirectory(input.demo.projectPath),
      canonicalFile(input.agentExecutablePath),
      canonicalFile(input.testAgentResourcePath),
    ]);
  assertContained(profileRoot, demoProjectPath, 'demo project');

  const storedProject = input.store.getProject(input.demo.projectId);
  if (
    storedProject === undefined ||
    storedProject.missing ||
    storedProject.id !== input.demo.projectId ||
    resolve(storedProject.path) !== resolve(demoProjectPath)
  ) {
    throw new Error('The renderer-created demo project was not durably available to agent runs.');
  }

  const operations = input.runs.executionOperations();
  const ownerId = 'packaged-smoke:test-agent';
  const prepared = await operations.prepare(ownerId, {
    projectId: input.demo.projectId,
    nodeId: PACKAGED_SMOKE_AGENT_NODE_ID,
    adapterId: 'test-agent',
    prompt: PACKAGED_SMOKE_AGENT_PROMPT,
    permissionProfile: 'worktree-write',
    context: { attachments: [] },
  });
  const preparedWorktreePath = await canonicalDirectory(prepared.disclosure.cwd);
  assertContained(profileRoot, preparedWorktreePath, 'prepared agent worktree');
  assertPreparedLaunch(
    prepared.disclosure,
    agentExecutablePath,
    testAgentResourcePath,
    preparedWorktreePath,
  );

  let launchChecked = false;
  const handle = await operations.launch(
    ownerId,
    prepared.planId,
    prepared.disclosureFingerprint,
    () => {
      const currentWorktreePath = canonicalDirectorySync(prepared.disclosure.cwd);
      assertContained(profileRoot, currentWorktreePath, 'launch-time agent worktree');
      if (resolve(currentWorktreePath) !== resolve(preparedWorktreePath)) {
        throw new Error('The packaged test-agent worktree changed after preparation.');
      }
      assertPreparedLaunch(
        prepared.disclosure,
        agentExecutablePath,
        testAgentResourcePath,
        currentWorktreePath,
      );
      launchChecked = true;
    },
  );
  if (!launchChecked || handle.process === null || handle.process.pid <= 0) {
    await handle.terminate().catch(() => undefined);
    throw new Error('The bundled deterministic test-agent process did not launch.');
  }

  const completion = await awaitCompletion(handle, input.timeoutMs);
  if (
    completion.runId !== prepared.runId ||
    completion.nodeId !== PACKAGED_SMOKE_AGENT_NODE_ID ||
    completion.status !== 'succeeded' ||
    completion.exitCode !== 0 ||
    completion.worktreePath === null
  ) {
    throw new Error('The bundled deterministic test-agent did not complete successfully.');
  }

  const worktreePath = await canonicalDirectory(completion.worktreePath);
  assertContained(profileRoot, worktreePath, 'managed smoke worktree');
  if (resolve(worktreePath) !== resolve(preparedWorktreePath)) {
    throw new Error('The packaged test-agent completed in an unreviewed worktree.');
  }
  const expectedRelativeOutput = `forgeboard-agent-output-${prepared.runId.slice(0, 8)}.md`;
  if (
    completion.changedFiles.length !== 1 ||
    completion.changedFiles[0] !== expectedRelativeOutput
  ) {
    throw new Error('The deterministic test-agent did not report its exact output file.');
  }
  const outputPath = await canonicalFile(join(worktreePath, expectedRelativeOutput));
  assertContained(worktreePath, outputPath, 'deterministic agent output');
  const output = await readFile(outputPath, 'utf8');
  if (
    !output.includes('# Forgeboard deterministic agent output') ||
    !output.includes(PACKAGED_SMOKE_AGENT_PROMPT)
  ) {
    throw new Error('The deterministic test-agent output did not contain the reviewed request.');
  }

  const durable = input.store.getRun(prepared.runId);
  if (
    durable === undefined ||
    durable.projectId !== input.demo.projectId ||
    durable.nodeId !== PACKAGED_SMOKE_AGENT_NODE_ID ||
    durable.adapterId !== 'test-agent' ||
    durable.status !== 'succeeded' ||
    durable.exitCode !== 0 ||
    durable.endedAt === null ||
    resolve(durable.cwd) !== resolve(worktreePath)
  ) {
    throw new Error('The completed packaged test-agent result was not durably persisted.');
  }

  return {
    agentRun: 'succeeded',
    durableRun: 'verified',
    agentRunId: prepared.runId,
    agentExecutablePath,
    agentResourcePath: testAgentResourcePath,
    agentProcessId: handle.process.pid,
    agentWorktreePath: worktreePath,
    agentChangedFiles: [expectedRelativeOutput],
    agentOutputPath: outputPath,
    agentOutputSha256: createHash('sha256').update(output).digest('hex'),
    agentOutputDigest: completion.outputDigest,
  };
}

function assertPreparedLaunch(
  disclosure: {
    readonly adapterId: string;
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly environmentVariableNames: readonly string[];
    readonly cwd: string;
    readonly runtime: string;
    readonly contextAttachments: readonly unknown[];
    readonly permissionProfile: {
      readonly mode: string;
      readonly enforcement: string;
      readonly readRoots: readonly string[];
      readonly writeRoots: readonly string[];
    };
  },
  agentExecutablePath: string,
  testAgentResourcePath: string,
  worktreePath: string,
): void {
  const environmentNames = new Set(disclosure.environmentVariableNames);
  const allowedEnvironmentNames = new Set([
    'COLORTERM',
    'ELECTRON_RUN_AS_NODE',
    'HOME',
    'LANG',
    'PATH',
    'TERM',
  ]);
  if (
    disclosure.adapterId !== 'test-agent' ||
    resolve(disclosure.executable) !== resolve(agentExecutablePath) ||
    disclosure.arguments.length !== 1 ||
    resolve(disclosure.arguments[0] ?? '') !== resolve(testAgentResourcePath) ||
    disclosure.runtime !== 'pipes' ||
    disclosure.contextAttachments.length !== 0 ||
    environmentNames.size !== disclosure.environmentVariableNames.length ||
    !environmentNames.has('ELECTRON_RUN_AS_NODE') ||
    [...environmentNames].some((name) => !allowedEnvironmentNames.has(name)) ||
    disclosure.permissionProfile.mode !== 'custom' ||
    disclosure.permissionProfile.enforcement !== 'disclosure-only' ||
    disclosure.permissionProfile.readRoots.length !== 1 ||
    resolve(disclosure.permissionProfile.readRoots[0] ?? '') !== resolve(worktreePath) ||
    disclosure.permissionProfile.writeRoots.length !== 1 ||
    resolve(disclosure.permissionProfile.writeRoots[0] ?? '') !== resolve(worktreePath) ||
    resolve(disclosure.cwd) !== resolve(worktreePath)
  ) {
    throw new Error(
      'The packaged test-agent launch did not use its reviewed process and resource paths.',
    );
  }
}

async function awaitCompletion(
  handle: {
    readonly completion: Promise<{
      readonly runId: string;
      readonly nodeId: string;
      readonly status: string;
      readonly exitCode: number | null;
      readonly worktreePath: string | null;
      readonly changedFiles: readonly string[];
      readonly outputDigest: string;
    }>;
    terminate(): Promise<void>;
  },
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('The packaged deterministic test-agent timed out.')),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    await handle.terminate().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Smoke path is not a directory: ${path}`);
  }
  return canonical;
}

async function canonicalFile(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error(`Smoke path is not a file: ${path}`);
  return canonical;
}

function canonicalDirectorySync(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`Smoke path is not a directory: ${path}`);
  }
  return canonical;
}

function assertContained(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`The packaged ${label} escaped its disposable smoke profile.`);
  }
}
