import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AgentAdapterManifestSchema,
  createCustomCliAdapter,
  planDockerAgentLaunch,
  type PermissionProfile,
  type PreparedAgentLaunch,
} from '@forgeboard/agent-adapters';
import { TEST_AGENT_MANIFEST } from '@forgeboard/test-agent';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentExecutionContextRequest } from '../contracts.js';
import {
  createImmutableContextSnapshot,
  dockerContextMountArgument,
} from './immutable-snapshot.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('immutable agent context snapshots', () => {
  it('keeps approved bytes after source replacement and removes private paths idempotently', async () => {
    const fixture = await hostFixture('approved bytes\n');
    const plan = hostPlan(fixture, {
      prompt: `Inspect ${fixture.sourcePath}`,
      strategy: 'prompt-references',
      transport: 'argument',
    });
    const snapshot = await createImmutableContextSnapshot(fixture.context, fixture.checkout, {
      runtime: 'host',
    });
    expect(snapshot).not.toBeNull();

    await writeFile(fixture.sourcePath, 'replacement after snapshot\n');
    const rebound = await snapshot!.bind(plan);
    const privatePath = snapshot!.bindings[0]!.snapshotPath;

    expect(await readFile(privatePath, 'utf8')).toBe('approved bytes\n');
    expect(contextLaunchFields(rebound).join('\n')).not.toContain(fixture.sourcePath);
    expect(contextLaunchFields(rebound).join('\n')).toContain(privatePath);
    await snapshot!.cleanup();
    await snapshot!.cleanup();
    await expect(access(snapshot!.rootPath)).rejects.toThrow();
  });

  it('requires the storage lease to revalidate protected files immediately before binding', async () => {
    const fixture = await hostFixture('approved bytes\n');
    const snapshotRoot = await temporaryRoot('forgeboard-context-bind-acl-');
    const protectedFiles: string[] = [];
    let revalidationCalls = 0;
    const snapshot = await createImmutableContextSnapshot(fixture.context, fixture.checkout, {
      runtime: 'host',
      createSnapshotDirectory: () =>
        Promise.resolve({
          rootPath: snapshotRoot,
          protectFile: (filePath) => {
            protectedFiles.push(filePath);
            return Promise.resolve();
          },
          revalidate: (filePaths) => {
            revalidationCalls += 1;
            expect(filePaths).toEqual(protectedFiles);
            return Promise.reject(new Error('injected bind-time ACL failure'));
          },
          cleanup: async () => await chmod(snapshotRoot, 0o700),
        }),
    });
    const plan = hostPlan(fixture, {
      prompt: `Inspect ${fixture.sourcePath}`,
      strategy: 'prompt-references',
      transport: 'argument',
    });

    expect(protectedFiles).toEqual([snapshot!.bindings[0]?.snapshotPath]);
    await expect(snapshot!.bind(plan)).rejects.toThrow('injected bind-time ACL failure');
    expect(revalidationCalls).toBe(1);
    await snapshot!.cleanup();
  });

  it('substitutes prompt references, repeat arguments, and stdin without changing other argv', async () => {
    const fixture = await hostFixture('context\n');
    const promptPlan = hostPlan(fixture, {
      prompt: `Review ${fixture.sourcePath}`,
      strategy: 'prompt-references',
      transport: 'argument',
    });
    const repeatPlan = hostPlan(fixture, {
      prompt: `Review ${fixture.sourcePath}`,
      strategy: 'repeat-arguments',
      transport: 'stdin',
    });
    const snapshot = await createImmutableContextSnapshot(fixture.context, fixture.checkout, {
      runtime: 'host',
    });
    const privatePath = snapshot!.bindings[0]!.snapshotPath;

    const promptRebound = await snapshot!.bind(promptPlan);
    const repeatRebound = await snapshot!.bind(repeatPlan);
    expect(promptRebound.disclosure.executable).toBe(promptPlan.disclosure.executable);
    expect(promptRebound.disclosure.arguments.join('\n')).toContain(privatePath);
    expect(repeatRebound.disclosure.arguments).toContain(privatePath);
    expect(repeatRebound.initialStdin).toContain(privatePath);
    expect(contextLaunchFields(promptRebound).join('\n')).not.toContain(fixture.sourcePath);
    expect(contextLaunchFields(repeatRebound).join('\n')).not.toContain(fixture.sourcePath);
    await snapshot!.cleanup();
  });

  it('rebinds punctuation, local file URLs, and redundant-separator path aliases', async () => {
    const fixture = await hostFixture('context\n');
    const redundantSeparatorAlias = fixture.sourcePath.split(path.sep).join(path.sep.repeat(2));
    const plan = hostPlan(fixture, {
      prompt: `Inspect ${fixture.sourcePath}. Open file://${fixture.sourcePath}. Also file://localhost${fixture.sourcePath}. Alias ${redundantSeparatorAlias}.`,
      strategy: 'prompt-references',
      transport: 'stdin',
    });
    const snapshot = await createImmutableContextSnapshot(fixture.context, fixture.checkout, {
      runtime: 'host',
    });
    const privatePath = snapshot!.bindings[0]!.snapshotPath;

    const rebound = await snapshot!.bind(plan);
    const fields = contextLaunchFields(rebound).join('\n');
    expect(fields).toContain(`Inspect ${privatePath}.`);
    expect(fields).toContain(`file://${privatePath}.`);
    expect(fields).toContain(`file://localhost${privatePath}.`);
    expect(fields).toContain(`Alias ${privatePath}.`);
    expect(fields).not.toContain(redundantSeparatorAlias);
    expect(fields).not.toContain(fixture.sourcePath);
    await snapshot!.cleanup();
  });

  it('rebinds percent-encoded file URLs and independently rejects no residual source alias', async () => {
    const checkout = await temporaryRoot('forgeboard-context-file-url-');
    const sourcePath = path.join(checkout, 'selected file.ts');
    await writeFile(sourcePath, 'context\n');
    const fixture: HostFixture = {
      checkout,
      sourcePath,
      context: contextFor([[sourcePath, sha256('context\n')]]),
    };
    const encodedSourceUrl = pathToFileURL(sourcePath).href;
    const alternateEncoding = encodedSourceUrl.replace('selected', '%73elected');
    const plan = hostPlan(fixture, {
      prompt: `Inspect ${encodedSourceUrl}. Alternate ${alternateEncoding}.`,
      strategy: 'prompt-references',
      transport: 'argument',
    });
    const snapshot = await createImmutableContextSnapshot(fixture.context, checkout, {
      runtime: 'host',
    });
    const encodedSnapshotUrl = pathToFileURL(snapshot!.bindings[0]!.snapshotPath).href;

    const rebound = await snapshot!.bind(plan);
    const fields = contextLaunchFields(rebound).join('\n');
    expect(fields).toContain(`Inspect ${encodedSnapshotUrl}.`);
    expect(fields).toContain(`Alternate ${encodedSnapshotUrl}.`);
    expect(fields).not.toContain(encodedSourceUrl);
    expect(fields).not.toContain(alternateEncoding);
    await snapshot!.cleanup();
  });

  it('does not rewrite a longer unselected path that contains a selected path prefix', async () => {
    const checkout = await temporaryRoot('forgeboard-context-overlap-');
    const selectedPath = path.join(checkout, 'foo.ts');
    const unselectedPath = path.join(checkout, 'foo.tsx');
    await writeFile(selectedPath, 'selected\n');
    await writeFile(unselectedPath, 'not selected\n');
    const fixture: HostFixture = {
      checkout,
      sourcePath: selectedPath,
      context: contextFor([[selectedPath, sha256('selected\n')]]),
    };
    const plan = hostPlan(fixture, {
      prompt: `Selected=${selectedPath}; unselected=${unselectedPath}`,
      strategy: 'prompt-references',
      transport: 'argument',
    });
    const snapshot = await createImmutableContextSnapshot(fixture.context, checkout, {
      runtime: 'host',
    });
    const privatePath = snapshot!.bindings[0]!.snapshotPath;

    const rebound = await snapshot!.bind(plan);
    const fields = contextLaunchFields(rebound).join('\n');
    expect(fields).toContain(`Selected=${privatePath}`);
    expect(fields).toContain(`unselected=${unselectedPath}`);
    expect(fields).not.toContain(`${privatePath}x`);
    await snapshot!.cleanup();
  });

  it('fails closed when an exact selected path remains behind an unrecognized URI scheme', async () => {
    const fixture = await hostFixture('context\n');
    const plan = hostPlan(fixture, {
      prompt: `custom:${fixture.sourcePath}`,
      strategy: 'prompt-references',
      transport: 'argument',
    });
    const snapshot = await createImmutableContextSnapshot(fixture.context, fixture.checkout, {
      runtime: 'host',
    });

    await expect(snapshot!.bind(plan)).rejects.toThrow(/mutable selected-context path remained/iu);
    await snapshot!.cleanup();
  });

  it('maps overlapping selected paths simultaneously without cascading replacements', async () => {
    const checkout = await temporaryRoot('forgeboard-context-simultaneous-');
    const shorterPath = path.join(checkout, 'foo.ts');
    const longerPath = path.join(checkout, 'foo.tsx');
    await writeFile(shorterPath, 'shorter\n');
    await writeFile(longerPath, 'longer\n');
    const context = contextFor([
      [shorterPath, sha256('shorter\n')],
      [longerPath, sha256('longer\n')],
    ]);
    const fixture: HostFixture = { checkout, sourcePath: shorterPath, context };
    const plan = hostPlan(fixture, {
      prompt: `Short=${shorterPath}; long=${longerPath}`,
      strategy: 'prompt-references',
      transport: 'argument',
    });
    const snapshot = await createImmutableContextSnapshot(context, checkout, {
      runtime: 'host',
    });
    const shortSnapshotPath = snapshot!.bindings[0]!.snapshotPath;
    const longSnapshotPath = snapshot!.bindings[1]!.snapshotPath;

    const rebound = await snapshot!.bind(plan);
    const fields = contextLaunchFields(rebound).join('\n');
    expect(fields).toContain(`Short=${shortSnapshotPath}`);
    expect(fields).toContain(`long=${longSnapshotPath}`);
    expect(fields).not.toContain(`${shortSnapshotPath}x`);
    await snapshot!.cleanup();
  });

  it('rejects duplicate paths and equal-digest attachment reordering', async () => {
    const fixture = await hostFixture('same bytes\n');
    await expect(
      createImmutableContextSnapshot(
        {
          ...fixture.context,
          attachments: [fixture.context.attachments[0]!, fixture.context.attachments[0]!],
        },
        fixture.checkout,
        { runtime: 'host' },
      ),
    ).rejects.toThrow(/duplicate selected file paths/iu);

    const secondPath = path.join(fixture.checkout, 'second.ts');
    await writeFile(secondPath, 'same bytes\n');
    const digest = sha256('same bytes\n');
    const context = contextFor([
      [fixture.sourcePath, digest],
      [secondPath, digest],
    ]);
    const snapshot = await createImmutableContextSnapshot(context, fixture.checkout, {
      runtime: 'host',
    });
    const reversedPlan = hostPlan(
      { ...fixture, context },
      {
        prompt: 'Review both.',
        strategy: 'repeat-arguments',
        transport: 'argument',
      },
      [...context.attachments].reverse(),
    );
    await expect(snapshot!.bind(reversedPlan)).rejects.toThrow(/no longer matches/iu);
    await snapshot!.cleanup();
  });

  it('detects snapshot tampering before binding a launch', async () => {
    const fixture = await hostFixture('approved bytes\n');
    const plan = hostPlan(fixture, {
      prompt: 'Review context.',
      strategy: 'repeat-arguments',
      transport: 'argument',
    });
    const snapshot = await createImmutableContextSnapshot(fixture.context, fixture.checkout, {
      runtime: 'host',
    });
    const privatePath = snapshot!.bindings[0]!.snapshotPath;
    await chmod(snapshot!.rootPath, 0o700);
    await chmod(privatePath, 0o600);
    await writeFile(privatePath, 'tampered bytes\n');
    await chmod(privatePath, 0o400);
    await chmod(snapshot!.rootPath, 0o500);

    await expect(snapshot!.bind(plan)).rejects.toThrow(/snapshot file changed/iu);
    await snapshot!.cleanup();
  });

  it('preserves both causes when partial snapshot cleanup fails during construction', async () => {
    const checkout = await temporaryRoot('forgeboard-context-partial-failure-');
    const snapshotRoot = await temporaryRoot('forgeboard-context-failing-lease-');
    const firstPath = path.join(checkout, 'first.ts');
    const secondPath = path.join(checkout, 'second.ts');
    await Promise.all([
      writeFile(firstPath, 'first approved bytes\n'),
      writeFile(secondPath, 'second changed bytes\n'),
    ]);
    const cleanupFailure = new Error('injected snapshot cleanup failure');
    let cleanupCalls = 0;
    const context = contextFor([
      [firstPath, sha256('first approved bytes\n')],
      [secondPath, sha256('second approved bytes\n')],
    ]);

    const creating = createImmutableContextSnapshot(context, checkout, {
      runtime: 'host',
      createSnapshotDirectory: () =>
        Promise.resolve({
          rootPath: snapshotRoot,
          protectFile: () => Promise.resolve(),
          revalidate: () => Promise.resolve(),
          cleanup: () => {
            cleanupCalls += 1;
            return Promise.reject(cleanupFailure);
          },
        }),
    });

    await expect(creating).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.message.includes('private files could not be removed') &&
        error.errors.some(
          (cause: unknown) =>
            cause instanceof Error &&
            cause.message.includes('no longer matches its approved digest'),
        ) &&
        error.errors.includes(cleanupFailure),
    );
    expect(cleanupCalls).toBe(1);
    await expect(readFile(path.join(snapshotRoot, '0000.ts'), 'utf8')).resolves.toBe(
      'first approved bytes\n',
    );
  });

  it('adds one read-only Docker context-root mount with deterministic container paths', async () => {
    const managedRoot = await temporaryRoot('forgeboard-managed-');
    const checkout = path.join(managedRoot, 'project', 'worktree');
    await mkdir(checkout, { recursive: true });
    const sourcePath = path.join(checkout, 'context.ts');
    await writeFile(sourcePath, 'docker context\n');
    const context = contextFor([[sourcePath, sha256('docker context\n')]]);
    const fixture = { checkout, sourcePath, context };
    const providerPlan = hostPlan(fixture, {
      prompt: `Review ${sourcePath}`,
      strategy: 'repeat-arguments',
      transport: 'stdin',
    });
    const dockerPlan = await planDockerAgentLaunch(providerPlan, {
      assignedWorktreePath: checkout,
      worktreeAccess: 'read-write',
      dockerExecutable: process.execPath,
      image: `sha256:${'a'.repeat(64)}`,
      containerExecutable: '/usr/local/bin/agent',
      userId: 1000,
      groupId: 1000,
      cpuLimit: 1,
      memoryLimitMb: 512,
      pidsLimit: 64,
      tmpfsSizeMb: 64,
      network: { mode: 'none' },
      environmentAllowlist: [],
    });
    const snapshot = await createImmutableContextSnapshot(context, checkout, {
      runtime: 'docker',
      managedRoot,
    });
    const logicalPath = dockerPlan.disclosure.contextAttachments[0]?.path;
    if (logicalPath === undefined) throw new Error('Expected one Docker context attachment.');
    const logicalFileUrl = pathToFileURL(logicalPath, { windows: false }).href;
    const dockerPlanWithEncodedUrl: PreparedAgentLaunch = {
      ...dockerPlan,
      disclosure: {
        ...dockerPlan.disclosure,
        arguments: dockerPlan.disclosure.arguments.map((argument) =>
          argument.replaceAll(logicalPath, logicalFileUrl),
        ),
      },
      ...(dockerPlan.initialStdin === undefined
        ? {}
        : {
            initialStdin: dockerPlan.initialStdin.replaceAll(logicalPath, logicalFileUrl),
          }),
    };
    const rebound = await snapshot!.bind(dockerPlanWithEncodedUrl);
    const mounts = rebound.disclosure.arguments.flatMap((argument, index, all) =>
      argument === '--mount' ? [all[index + 1]] : [],
    );

    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toContain(`source=${checkout},target=/workspace`);
    expect(mounts[1]).toBe(
      `type=bind,source=${snapshot!.rootPath},target=/forgeboard-context,readonly`,
    );
    expect(rebound.disclosure.contextAttachments[0]?.path).toBe('/forgeboard-context/0000.ts');
    expect(rebound.disclosure.permissionProfile.readRoots).toContain('/forgeboard-context');
    expect(contextLaunchFields(rebound).join('\n')).toContain('file:///forgeboard-context/0000.ts');
    expect(contextLaunchFields(rebound).join('\n')).not.toContain(logicalFileUrl);
    expect(contextLaunchFields(rebound).join('\n')).not.toContain(sourcePath);
    expect(contextLaunchFields(rebound).join('\n')).not.toContain('/workspace/context.ts');
    await snapshot!.cleanup();
  });

  it('rejects Docker mount sources containing commas, line breaks, or NUL bytes', () => {
    for (const candidate of [
      '/tmp/with,comma',
      '/tmp/with\nnewline',
      '/tmp/with\rreturn',
      '/tmp/x\0y',
    ]) {
      expect(() => dockerContextMountArgument(candidate)).toThrow(/cannot be represented safely/iu);
    }
  });
});

interface HostFixture {
  readonly checkout: string;
  readonly sourcePath: string;
  readonly context: AgentExecutionContextRequest;
}

async function hostFixture(content: string): Promise<HostFixture> {
  const checkout = await temporaryRoot('forgeboard-context-checkout-');
  const sourcePath = path.join(checkout, 'context.ts');
  await writeFile(sourcePath, content);
  return {
    checkout,
    sourcePath,
    context: contextFor([[sourcePath, sha256(content)]]),
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function contextFor(entries: readonly (readonly [string, string])[]): AgentExecutionContextRequest {
  return {
    attachments: entries.map(([attachmentPath, digest]) => ({
      path: attachmentPath,
      kind: 'file',
      explicitlyApproved: true,
      sha256: digest,
    })),
    manifestId: 'snapshot-test',
    manifestDigest: 'a'.repeat(64),
  };
}

function hostPlan(
  fixture: HostFixture,
  options: {
    readonly prompt: string;
    readonly strategy: 'prompt-references' | 'repeat-arguments';
    readonly transport: 'argument' | 'stdin';
  },
  attachments = fixture.context.attachments,
): PreparedAgentLaunch {
  const manifest = AgentAdapterManifestSchema.parse({
    ...TEST_AGENT_MANIFEST,
    id: 'snapshot-test',
    invocation: {
      ...TEST_AGENT_MANIFEST.invocation,
      promptTransport: options.transport,
      launchArguments:
        options.transport === 'argument'
          ? ['{contextArgs}', '--fixed', 'unchanged', '{prompt}', '{extraArgs}']
          : ['{contextArgs}', '--fixed', 'unchanged', '{extraArgs}'],
      context:
        options.strategy === 'prompt-references'
          ? { strategy: 'prompt-references' }
          : {
              strategy: 'repeat-arguments',
              arguments: ['--context', '{contextPath}'],
              supportedKinds: ['file'],
            },
    },
    capabilities: {
      ...TEST_AGENT_MANIFEST.capabilities,
      contextAttachments: true,
    },
  });
  return createCustomCliAdapter(manifest).prepareLaunch({
    prompt: options.prompt,
    cwd: fixture.checkout,
    permissionProfile: permissionProfile(fixture.checkout),
    contextAttachments: attachments,
    executable: process.execPath,
    extraArguments: [],
    environment: { inherit: 'none', variables: {}, unset: [] },
  });
}

function permissionProfile(checkout: string): PermissionProfile {
  return {
    id: 'snapshot-test',
    name: 'Snapshot test',
    mode: 'custom',
    enforcement: 'disclosure-only',
    readRoots: [checkout],
    writeRoots: [],
    network: 'provider-controlled',
    approvalPolicy: 'Test only.',
    disclosure: 'Test only.',
    custom: {
      runtime: 'host',
      filesystem: 'assigned-worktree-read-only',
      ignoredFileRead: 'deny',
      sensitiveFileRead: 'deny',
      launchExecutablePolicy: 'selected-agent-only',
      allowedLaunchExecutables: [process.execPath],
      forgeboardManagedActions: { developmentServers: 'deny', tests: 'deny' },
      requireReviewBeforePrimary: true,
      policyLimitations: ['Test fixture disclosure only.'],
    },
  };
}

function contextLaunchFields(plan: PreparedAgentLaunch): string[] {
  return [
    ...plan.disclosure.arguments,
    ...plan.disclosure.contextAttachments.map(({ path: attachmentPath }) => attachmentPath),
    ...(plan.initialStdin === undefined ? [] : [plan.initialStdin]),
  ];
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
