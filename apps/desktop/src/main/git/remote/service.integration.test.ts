import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ChangeService,
  GitEngineError,
  RepositoryService,
  WorktreeService,
  type GitHubCommandOptions,
  type GitHubCommandResult,
  type GitHubCommandRunner,
} from '@forgeboard/git-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../shared/application/contracts.js';
import {
  evaluateGitDeliveryReadiness,
  type GitDeliveryReadinessGetView,
  type GitDeliveryReadinessTarget,
  type GitDeliveryReadinessView,
} from '../../../shared/git/readiness/index.js';
import type { OutboundApprovalPlan } from '../../outbound/outbound-action-gate.js';
import { OutboundActionGate } from '../../outbound/outbound-action-gate.js';
import { PermitBoundGitRemoteOperations } from '../../outbound/git/executors.js';
import { LocalStore, type StoredRunRecord } from '../../storage.js';
import type { GitHubCliCommandRuntime } from '../github-cli/runtime.js';
import { GitTargetResolver } from '../git-target-resolver.js';
import type {
  GitShippingReadinessAuthority,
  GitShippingReadinessBinding,
} from '../shipping/git-shipping-service.js';
import { GitRemoteDeliveryService } from './service.js';

const PROJECT_ID = '91000000-0000-4000-8000-000000000001';
const RUN_ID = '91000000-0000-4000-8000-000000000002';
const APPROVAL_ID = '91000000-0000-4000-8000-000000000003';
const READINESS_ID = '91000000-0000-4000-8000-000000000004';
const EXECUTION_ID = '91000000-0000-4000-8000-000000000005';
const NOW = '2026-07-17T12:00:00.000Z';
const roots: string[] = [];
const stores = new Set<LocalStore>();
const services = new Set<GitRemoteDeliveryService>();

afterEach(async () => {
  await Promise.allSettled([...services].map(async (service) => await service.dispose()));
  services.clear();
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe('main-owned Git remote delivery', () => {
  it('cancels without a push, rejects source/remote/readiness/dialog drift, then pushes one exact OID without force', async () => {
    const fixture = await createFixture();
    const harness = createHarness(fixture);
    const target = deliveryTarget();
    const deniedPlans: OutboundApprovalPlan[] = [];

    const inspection = await harness.service.inspect({ target });
    expect(inspection.remotes.find((remote) => remote.name === 'origin')).toEqual({
      kind: 'local-filesystem',
      name: 'origin',
      endpoint: 'local-filesystem',
      resource: 'Local Git repository',
      transport: 'local',
      githubCompatible: false,
    });
    expect(JSON.stringify(inspection)).not.toContain(fixture.bareRemote);

    const cancelled = await harness.service.preparePush('window-a', {
      target,
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
    });
    expect(cancelled).toMatchObject({
      sourceBranch: fixture.branch,
      destinationBranch: 'published/reviewed-topic',
      sourceHead: fixture.sourceHead,
      force: false,
    });
    expect(cancelled.fileCount).toBe(1);
    await expect(
      harness.service.confirmPush('window-a', cancelled.planId, {
        confirm: (plan) => {
          deniedPlans.push(plan);
          return Promise.resolve('denied');
        },
      }),
    ).resolves.toBeNull();
    expect(
      await git(
        fixture.bareRemote,
        ['rev-parse', '--verify', 'refs/heads/published/reviewed-topic'],
        true,
      ),
    ).toBe('');
    expect(deniedPlans[0]?.disclosure.destination.resource).toBe(fixture.bareRemote);
    expect(deniedPlans[0]?.disclosure.details).toContainEqual({
      label: 'Force',
      value: 'Disabled',
    });

    const dirtyPlan = await harness.service.preparePush('window-a', {
      target,
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
    });
    await writeFile(path.join(fixture.worktree, 'dirty.txt'), 'unreviewed\n');
    const dirtyConfirm = vi.fn(() => Promise.resolve('approved' as const));
    await expect(
      harness.service.confirmPush('window-a', dirtyPlan.planId, {
        confirm: dirtyConfirm,
      }),
    ).rejects.toThrow(/commit or discard/iu);
    expect(dirtyConfirm).not.toHaveBeenCalled();
    const orphanConfirmation = vi.fn(() => Promise.resolve<'denied'>('denied'));
    await expect(
      harness.outbound.confirmAndExecute({
        ownerId: 'window-a',
        planId: dirtyPlan.planId,
        confirmation: { confirm: orphanConfirmation },
        currentDisclosure: () => {
          throw new Error('An orphaned outbound plan must not reach disclosure validation.');
        },
        execute: () => {
          throw new Error('An orphaned outbound plan must not execute.');
        },
      }),
    ).rejects.toThrow(/missing|already used/iu);
    expect(orphanConfirmation).not.toHaveBeenCalled();
    await rm(path.join(fixture.worktree, 'dirty.txt'));
    await expect(
      harness.service.confirmPush('window-a', dirtyPlan.planId, {
        confirm: dirtyConfirm,
      }),
    ).rejects.toThrow(/unavailable|already used/iu);
    expect(dirtyConfirm).not.toHaveBeenCalled();

    const sourcePlan = await harness.service.preparePush('window-a', {
      target,
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
    });
    await git(fixture.worktree, ['commit', '--allow-empty', '-m', 'Reviewed empty follow-up']);
    fixture.sourceHead = await git(fixture.worktree, ['rev-parse', 'HEAD']);
    const sourceConfirm = vi.fn(() => Promise.resolve('approved' as const));
    await expect(
      harness.service.confirmPush('window-a', sourcePlan.planId, {
        confirm: sourceConfirm,
      }),
    ).rejects.toThrow(/source changed/iu);
    expect(sourceConfirm).not.toHaveBeenCalled();

    const remotePlan = await harness.service.preparePush('window-a', {
      target,
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
    });
    await git(fixture.worktree, ['remote', 'set-url', 'origin', fixture.secondBareRemote]);
    const remoteConfirm = vi.fn(() => Promise.resolve('approved' as const));
    await expect(
      harness.service.confirmPush('window-a', remotePlan.planId, {
        confirm: remoteConfirm,
      }),
    ).rejects.toThrow(/source changed|remote changed/iu);
    expect(remoteConfirm).not.toHaveBeenCalled();
    await git(fixture.worktree, ['remote', 'set-url', 'origin', fixture.bareRemote]);

    const readinessPlan = await harness.service.preparePush('window-a', {
      target,
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
    });
    harness.readiness.failNext = true;
    const readinessConfirm = vi.fn(() => Promise.resolve('approved' as const));
    await expect(
      harness.service.confirmPush('window-a', readinessPlan.planId, {
        confirm: readinessConfirm,
      }),
    ).rejects.toThrow(/readiness changed/iu);
    expect(readinessConfirm).not.toHaveBeenCalled();

    const dialogDriftPlan = await harness.service.preparePush('window-a', {
      target,
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
    });
    await expect(
      harness.service.confirmPush('window-a', dialogDriftPlan.planId, {
        confirm: async () => {
          await git(fixture.worktree, ['remote', 'set-url', 'origin', fixture.secondBareRemote]);
          return 'approved';
        },
      }),
    ).rejects.toThrow(/source changed|remote changed/iu);
    expect(
      await git(
        fixture.secondBareRemote,
        ['rev-parse', '--verify', 'refs/heads/published/reviewed-topic'],
        true,
      ),
    ).toBe('');
    await git(fixture.worktree, ['remote', 'set-url', 'origin', fixture.bareRemote]);

    const approved = await harness.service.preparePush('window-a', {
      target,
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
    });
    const result = await harness.service.confirmPush('window-a', approved.planId, {
      confirm: () => Promise.resolve('approved'),
    });
    expect(result).toEqual({
      remote: 'origin',
      destinationBranch: 'published/reviewed-topic',
      sourceOid: fixture.sourceHead,
    });
    expect(
      await git(fixture.bareRemote, ['rev-parse', 'refs/heads/published/reviewed-topic']),
    ).toBe(fixture.sourceHead);
    expect(harness.readiness.revalidateCalls).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('releases only owner-matching plans and survives repeated prepare/cancel cycles', async () => {
    const fixture = await createFixture();
    const harness = createHarness(fixture);

    const ownerPlan = await prepareFixturePush(harness.service, 'window-owner');
    const otherOwnerConfirmation = vi.fn(() => Promise.resolve<'approved'>('approved'));
    await expect(
      harness.service.confirmPush('window-other', ownerPlan.planId, {
        confirm: otherOwnerConfirmation,
      }),
    ).rejects.toThrow(/another window/iu);
    expect(otherOwnerConfirmation).not.toHaveBeenCalled();
    await expect(harness.service.cancelPlan('window-other', ownerPlan.planId)).resolves.toEqual({
      acknowledged: true,
    });
    const confirmation = vi.fn(() => Promise.resolve<'denied'>('denied'));
    await expect(
      harness.service.confirmPush('window-owner', ownerPlan.planId, { confirm: confirmation }),
    ).resolves.toBeNull();
    expect(confirmation).toHaveBeenCalledTimes(1);

    const cancelled = await prepareFixturePush(harness.service, 'window-owner');
    await expect(harness.service.cancelPlan('window-owner', cancelled.planId)).resolves.toEqual({
      acknowledged: true,
    });
    await expect(
      harness.service.confirmPush('window-owner', cancelled.planId, {
        confirm: () => Promise.resolve('approved'),
      }),
    ).rejects.toThrow(/unavailable|another window/iu);

    for (let index = 0; index < 17; index += 1) {
      const plan = await prepareFixturePush(harness.service, 'window-owner');
      await expect(harness.service.cancelPlan('window-owner', plan.planId)).resolves.toEqual({
        acknowledged: true,
      });
    }
    const afterRepeatedCancellation = await prepareFixturePush(harness.service, 'window-owner');
    await expect(
      harness.service.cancelPlan('window-owner', afterRepeatedCancellation.planId),
    ).resolves.toEqual({ acknowledged: true });
  }, 60_000);

  it('bounds discovery and refuses an exact action whose changed-file impact exceeds the cap', async () => {
    const fixture = await createFixture();
    const many = path.join(fixture.worktree, 'many');
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 257 }, async (_, index) => {
        const name = `file-${String(index).padStart(3, '0')}.txt`;
        await writeFile(path.join(many, name), `${String(index)}\n`);
      }),
    );
    await git(fixture.worktree, ['add', '--', 'many']);
    await git(fixture.worktree, ['commit', '-m', 'Large reviewed impact']);
    fixture.sourceHead = await git(fixture.worktree, ['rev-parse', 'HEAD']);
    const harness = createHarness(fixture);
    const inspection = await harness.service.inspect({
      target: deliveryTarget(),
    });
    expect(inspection.fileCount).toBe(258);
    expect(inspection.files).toHaveLength(256);
    expect(inspection.filesTruncated).toBe(true);
    await expect(
      harness.service.preparePush('window-cap', {
        target: deliveryTarget(),
        remote: 'origin',
        destinationBranch: 'published/too-large',
      }),
    ).rejects.toThrow(/too large or invalid/iu);
  });

  it('inspects an unchanged managed branch honestly and blocks only actionable delivery', async () => {
    const fixture = await createFixture();
    await git(fixture.worktree, ['reset', '--hard', fixture.baseCommit]);
    fixture.sourceHead = fixture.baseCommit;
    const harness = createHarness(fixture);

    const inspection = await harness.service.inspect({
      target: deliveryTarget(),
    });
    expect(inspection).toMatchObject({
      baseCommit: fixture.baseCommit,
      sourceHead: fixture.baseCommit,
      ahead: 0,
      behind: 0,
      commitCount: 0,
      commits: [],
      fileCount: 0,
      files: [],
      additions: 0,
      deletions: 0,
    });
    await expect(
      harness.service.preparePush('window-unchanged', {
        target: deliveryTarget(),
        remote: 'origin',
        destinationBranch: 'published/unchanged',
      }),
    ).rejects.toThrow(/no committed changes/iu);
  });

  it('computes divergence against the current primary base ref rather than the recorded run base', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repository, 'primary-only.txt'), 'advanced primary\n');
    await git(fixture.repository, ['add', '--', 'primary-only.txt']);
    await git(fixture.repository, ['commit', '-m', 'Advance current primary']);
    const currentPrimaryHead = await git(fixture.repository, ['rev-parse', 'HEAD']);
    const harness = createHarness(fixture);

    const inspection = await harness.service.inspect({
      target: deliveryTarget(),
    });
    expect(inspection).toMatchObject({
      baseRef: 'HEAD',
      baseCommit: fixture.baseCommit,
      divergenceBaseCommit: currentPrimaryHead,
      sourceHead: fixture.sourceHead,
      ahead: 1,
      behind: 1,
    });
  });

  it('fails closed when legacy graft configuration could rewrite reviewed history', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repository, '.git', 'info', 'grafts'), '');
    const harness = createHarness(fixture);

    await expect(harness.service.inspect({ target: deliveryTarget() })).rejects.toThrow(
      /legacy grafts file/iu,
    );
  });

  it('rejects a shallow source when preparing an exact push', async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.repository, '.git', 'shallow'), `${fixture.baseCommit}\n`);
    const harness = createHarness(fixture);

    await expect(
      harness.service.preparePush('window-shallow', {
        target: deliveryTarget(),
        remote: 'origin',
        destinationBranch: 'published/shallow',
      }),
    ).rejects.toThrow(/shallow repositories/iu);
  });

  it('omits a remote with an effective helper override before native review', async () => {
    const fixture = await createFixture();
    await git(fixture.worktree, ['config', 'remote.github.vcs', 'file']);
    const harness = createHarness(fixture);

    const inspection = await harness.service.inspect({
      target: deliveryTarget(),
    });
    expect(inspection.remotes.map((remote) => remote.name)).toEqual(['origin']);
    await expect(
      harness.service.prepareGitHubStatus('window-helper', {
        target: deliveryTarget(),
        remote: 'github',
        baseBranch: 'main',
        destinationBranch: fixture.branch,
      }),
    ).rejects.toThrow(/unavailable or no longer safe/iu);
  });

  it('blocks source pre-push hooks and repository-local credential helpers before review', async () => {
    const hookFixture = await createFixture();
    await writeFile(
      path.join(hookFixture.repository, '.git', 'hooks', 'pre-push'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 },
    );
    const hookHarness = createHarness(hookFixture);
    await expect(prepareFixturePush(hookHarness.service, 'window-hook')).rejects.toThrow(
      /pre-push hook/iu,
    );

    const credentialFixture = await createFixture();
    await git(credentialFixture.worktree, [
      'config',
      '--local',
      'credential.helper',
      '!unreviewed-helper',
    ]);
    const credentialHarness = createHarness(credentialFixture);
    await expect(
      prepareFixturePush(credentialHarness.service, 'window-credential'),
    ).rejects.toThrow(/credential.*unsupported/iu);

    const configuredHookFixture = await createFixture();
    await git(configuredHookFixture.worktree, ['config', 'core.hooksPath', 'custom-hooks']);
    const configuredHookHarness = createHarness(configuredHookFixture);
    await expect(
      prepareFixturePush(configuredHookHarness.service, 'window-configured-hook'),
    ).rejects.toThrow(/points hook scripts to a custom folder/iu);

    if (process.platform !== 'win32') {
      const symlinkHookFixture = await createFixture();
      await symlink(
        '/dev/null',
        path.join(symlinkHookFixture.repository, '.git', 'hooks', 'pre-push'),
      );
      const symlinkHookHarness = createHarness(symlinkHookFixture);
      await expect(
        prepareFixturePush(symlinkHookHarness.service, 'window-symlink-hook'),
      ).rejects.toThrow(/pre-push hook/iu);
    }
  });

  it('blocks credential helpers inherited through local includes and worktree config', async () => {
    const includedFixture = await createFixture();
    const includedConfig = path.join(includedFixture.root, 'included-credentials.config');
    await writeFile(includedConfig, '[credential]\n\thelper = !unreviewed-included-helper\n');
    await git(includedFixture.worktree, ['config', '--local', 'include.path', includedConfig]);
    const includedHarness = createHarness(includedFixture);
    await expect(
      prepareFixturePush(includedHarness.service, 'window-included-credential'),
    ).rejects.toThrow(/credential.*unsupported/iu);

    const worktreeFixture = await createFixture();
    await git(worktreeFixture.worktree, ['config', 'extensions.worktreeConfig', 'true']);
    await git(worktreeFixture.worktree, [
      'config',
      '--worktree',
      'credential.helper',
      '!unreviewed-worktree-helper',
    ]);
    const worktreeHarness = createHarness(worktreeFixture);
    await expect(
      prepareFixturePush(worktreeHarness.service, 'window-worktree-credential'),
    ).rejects.toThrow(/credential.*unsupported/iu);
  });

  it('blocks repository-owned HTTP identity and URL rewrite settings without exposing values', async () => {
    const httpFixture = await createFixture();
    const secretHeader = 'Authorization: Bearer should-never-appear';
    await git(httpFixture.worktree, [
      'config',
      '--local',
      'http.https://github.com/.extraHeader',
      secretHeader,
    ]);
    const httpHarness = createHarness(httpFixture);
    let httpFailure: unknown;
    try {
      await prepareFixturePush(httpHarness.service, 'window-http-override');
    } catch (error) {
      httpFailure = error;
    }
    expect(httpFailure).toBeInstanceOf(Error);
    expect((httpFailure as Error).message).toMatch(/credential, HTTP, and URL rewrite/iu);
    expect((httpFailure as Error).message).not.toContain(secretHeader);

    const rewriteFixture = await createFixture();
    await git(rewriteFixture.worktree, ['config', 'extensions.worktreeConfig', 'true']);
    await git(rewriteFixture.worktree, [
      'config',
      '--worktree',
      `url.${rewriteFixture.secondBareRemote}.pushInsteadOf`,
      rewriteFixture.bareRemote,
    ]);
    const rewriteHarness = createHarness(rewriteFixture);
    await expect(prepareFixturePush(rewriteHarness.service, 'window-url-rewrite')).rejects.toThrow(
      /URL rewrite/iu,
    );
  });

  it('blocks Git LFS pointer history that would require an undisclosed object upload', async () => {
    const fixture = await createFixture();
    await writeFile(
      path.join(fixture.worktree, 'large.bin'),
      'version https://git-lfs.github.com/spec/v1\n' +
        `oid sha256:${'a'.repeat(64)}\n` +
        'size 123\n',
    );
    await git(fixture.worktree, ['add', '--', 'large.bin']);
    await git(fixture.worktree, ['commit', '-m', 'Add LFS pointer']);
    await git(fixture.worktree, ['rm', '--', 'large.bin']);
    await git(fixture.worktree, ['commit', '-m', 'Remove LFS pointer from current tree']);
    fixture.sourceHead = await git(fixture.worktree, ['rev-parse', 'HEAD']);
    const harness = createHarness(fixture);

    await expect(
      harness.service.preparePush('window-lfs', {
        target: deliveryTarget(),
        remote: 'origin',
        destinationBranch: 'published/lfs',
      }),
    ).rejects.toThrow(/history uses Git LFS/iu);

    const legacyFixture = await createFixture();
    await writeFile(
      path.join(legacyFixture.worktree, 'legacy.pointer'),
      'version http://git-media.io/v/2\r\n' + `oid sha256:${'b'.repeat(64)}\r\n` + 'size 9\r\n',
    );
    await git(legacyFixture.worktree, ['add', '--', 'legacy.pointer']);
    await git(legacyFixture.worktree, ['commit', '-m', 'Add legacy LFS pointer']);
    legacyFixture.sourceHead = await git(legacyFixture.worktree, ['rev-parse', 'HEAD']);
    const legacyHarness = createHarness(legacyFixture);
    await expect(
      legacyHarness.service.preparePush('window-legacy-lfs', {
        target: deliveryTarget(),
        remote: 'origin',
        destinationBranch: 'published/legacy-lfs',
      }),
    ).rejects.toThrow(/history uses Git LFS/iu);
  });

  it('does not treat a documentation mention of the Git LFS header as an LFS pointer', async () => {
    const fixture = await createFixture();
    await writeFile(
      path.join(fixture.worktree, 'lfs-notes.md'),
      'version https://git-lfs.github.com/spec/v1\n' +
        `oid sha256:${'c'.repeat(64)}\n` +
        'size 123\n' +
        'This complete-looking snippet is documentation, not a pointer.\n',
    );
    await git(fixture.worktree, ['add', '--', 'lfs-notes.md']);
    await git(fixture.worktree, ['commit', '-m', 'Document the LFS header']);
    fixture.sourceHead = await git(fixture.worktree, ['rev-parse', 'HEAD']);
    const harness = createHarness(fixture);

    await expect(
      harness.service.preparePush('window-lfs-docs', {
        target: deliveryTarget(),
        remote: 'origin',
        destinationBranch: 'published/lfs-docs',
      }),
    ).resolves.toMatchObject({ sourceHead: fixture.sourceHead, commitCount: 2 });
  });

  it('blocks zero-change pull-request preparation before any GitHub action', async () => {
    const fixture = await createFixture();
    await git(fixture.worktree, ['reset', '--hard', fixture.baseCommit]);
    fixture.sourceHead = fixture.baseCommit;
    const harness = createHarness(fixture);

    await expect(
      harness.service.preparePullRequest('window-zero-pr', {
        target: deliveryTarget(),
        remote: 'github',
        baseBranch: 'main',
        destinationBranch: fixture.branch,
        title: 'No changes',
        body: '',
        draft: false,
      }),
    ).rejects.toThrow(/no committed changes/iu);
    expect(harness.runner.calls).toHaveLength(0);
  });

  it('names both sides of a rename in the native exact push disclosure', async () => {
    const fixture = await createFixture();
    await git(fixture.worktree, ['mv', 'README.md', 'RENAMED.md']);
    await git(fixture.worktree, ['commit', '-m', 'Rename reviewed file']);
    fixture.sourceHead = await git(fixture.worktree, ['rev-parse', 'HEAD']);
    const harness = createHarness(fixture);
    const plan = await harness.service.preparePush('window-rename', {
      target: deliveryTarget(),
      remote: 'origin',
      destinationBranch: 'published/rename',
    });
    expect(plan.files).toContainEqual({
      oldPath: 'README.md',
      newPath: 'RENAMED.md',
      status: 'renamed',
    });

    let nativePlan: OutboundApprovalPlan | undefined;
    await harness.service.confirmPush('window-rename', plan.planId, {
      confirm: (approval) => {
        nativePlan = approval;
        return Promise.resolve('denied');
      },
    });
    expect(
      nativePlan?.disclosure.details
        .filter((detail) => detail.label.startsWith('Files'))
        .map((detail) => detail.value)
        .join('\n'),
    ).toContain('README.md → RENAMED.md');
  });

  it('uses only a fake GitHub runner, requires an exact cached remote head, sends the exact PR body on stdin, and filters CI by SHA', async () => {
    const fixture = await createFixture();
    const runner = new FakeGitHubRunner();
    runner.branches.set('main', fixture.baseCommit);
    runner.branches.set('remote-topic', fixture.baseCommit);
    const harness = createHarness(fixture, runner);
    const target = deliveryTarget();

    await expect(
      harness.service.preparePullRequest('window-github', {
        target,
        remote: 'github',
        baseBranch: 'main',
        destinationBranch: 'remote-topic',
        title: 'Exact reviewed pull request',
        body: 'body',
        draft: false,
      }),
    ).rejects.toThrow(/check this exact GitHub destination/iu);

    const cancelledStatus = await harness.service.prepareGitHubStatus('window-github', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    await expect(
      harness.service.confirmGitHubStatus('window-github', cancelledStatus.planId, {
        confirm: () => Promise.resolve('denied'),
      }),
    ).resolves.toBeNull();
    expect(runner.calls).toHaveLength(0);

    const staleStatus = await harness.service.prepareGitHubStatus('window-github', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    const stale = await harness.service.confirmGitHubStatus('window-github', staleStatus.planId, {
      confirm: () => Promise.resolve('approved'),
    });
    expect(stale?.headMatchesSource).toBe(false);
    await expect(
      harness.service.preparePullRequest('window-github', {
        target,
        remote: 'github',
        baseBranch: 'main',
        destinationBranch: 'remote-topic',
        title: 'Exact reviewed pull request',
        body: 'body',
        draft: false,
      }),
    ).rejects.toThrow(/Push the reviewed commits to this remote branch/iu);

    runner.branches.set('remote-topic', fixture.sourceHead);
    const currentStatus = await harness.service.prepareGitHubStatus('window-github', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    const current = await harness.service.confirmGitHubStatus(
      'window-github',
      currentStatus.planId,
      { confirm: () => Promise.resolve('approved') },
    );
    expect(current).toMatchObject({
      ownerRepository: 'owner/repository',
      headOid: fixture.sourceHead,
      headMatchesSource: true,
    });
    await expect(
      harness.service.preparePullRequest('another-window', {
        target,
        remote: 'github',
        baseBranch: 'main',
        destinationBranch: 'remote-topic',
        title: 'Must not reuse another window status',
        body: 'body',
        draft: false,
      }),
    ).rejects.toThrow(/check this exact GitHub destination/iu);

    const body = 'Exact body line one\n\n- literal $(no shell)';
    const pr = await harness.service.preparePullRequest('window-github', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
      title: 'Exact reviewed pull request',
      body,
      draft: true,
    });
    let nativePlan: OutboundApprovalPlan | undefined;
    const created = await harness.service.confirmPullRequest('window-github', pr.planId, {
      confirm: (plan) => {
        nativePlan = plan;
        return Promise.resolve('approved');
      },
    });
    expect(created?.url).toBe('https://github.com/owner/repository/pull/42');
    expect(nativePlan?.disclosure.details).toContainEqual({
      label: 'Pull request body',
      value: body,
    });
    const prCall = runner.calls.find((call) => call.args[0] === 'pr');
    expect(prCall?.options.input).toBe(body);
    expect(prCall?.args).toContain('github.com/owner/repository');
    expect(prCall?.args).not.toContain(body);

    const ci = await harness.service.prepareCi('window-github', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    const ciResult = await harness.service.confirmCi('window-github', ci.planId, {
      confirm: () => Promise.resolve('approved'),
    });
    expect(ciResult).toMatchObject({
      sourceHead: fixture.sourceHead,
      headBranch: 'remote-topic',
      current: true,
    });
    expect(ciResult?.runs).toHaveLength(1);
    expect(ciResult?.runs[0]?.headSha).toBe(fixture.sourceHead);
    expect(runner.calls.every((call) => call.executable === runner.executable)).toBe(true);
  }, 60_000);

  it('binds native review, cached status, and every command to one CLI fingerprint', async () => {
    const fixture = await createFixture();
    const runner = new FakeGitHubRunner();
    runner.branches.set('main', fixture.baseCommit);
    runner.branches.set('remote-topic', fixture.sourceHead);
    const harness = createHarness(fixture, runner);
    const target = deliveryTarget();

    const changed = await harness.service.prepareGitHubStatus('window-cli-binding', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    harness.githubRuntime.identityFingerprint = 'f'.repeat(64);
    let nativeOpened = false;
    await expect(
      harness.service.confirmGitHubStatus('window-cli-binding', changed.planId, {
        confirm: () => {
          nativeOpened = true;
          return Promise.resolve('approved');
        },
      }),
    ).rejects.toThrow(/selected GitHub CLI changed/iu);
    expect(nativeOpened).toBe(false);
    expect(runner.calls).toHaveLength(0);

    const currentPlan = await harness.service.prepareGitHubStatus('window-cli-binding', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    const resolvesBeforeConfirm = harness.githubRuntime.resolveCalls;
    let nativePlan: OutboundApprovalPlan | undefined;
    await harness.service.confirmGitHubStatus('window-cli-binding', currentPlan.planId, {
      confirm: (plan) => {
        nativePlan = plan;
        return Promise.resolve('approved');
      },
    });
    expect(nativePlan?.disclosure.details).toEqual(
      expect.arrayContaining([
        { label: 'How GitHub CLI was found', value: 'Selected in Settings' },
        { label: 'GitHub CLI file', value: 'fake-gh' },
        { label: 'GitHub CLI fingerprint (SHA-256)', value: 'd'.repeat(64) },
        { label: 'GitHub CLI location', value: runner.executable },
      ]),
    );
    expect(harness.githubRuntime.resolveCalls - resolvesBeforeConfirm).toBeGreaterThanOrEqual(
      runner.calls.length,
    );

    harness.githubRuntime.identityFingerprint = 'a'.repeat(64);
    await expect(
      harness.service.preparePullRequest('window-cli-binding', {
        target,
        remote: 'github',
        baseBranch: 'main',
        destinationBranch: 'remote-topic',
        title: 'Must recheck after CLI change',
        body: '',
        draft: false,
      }),
    ).rejects.toThrow(/check this exact GitHub destination/iu);
  });

  it('allows missing automatic CLI status while keeping Git push independent', async () => {
    const fixture = await createFixture();
    const harness = createHarness(fixture);
    const target = deliveryTarget();
    harness.githubRuntime.available = false;
    harness.githubRuntime.identityFingerprint = 'f'.repeat(64);

    const statusPlan = await harness.service.prepareGitHubStatus('window-cli-missing', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    let nativePlan: OutboundApprovalPlan | undefined;
    const status = await harness.service.confirmGitHubStatus(
      'window-cli-missing',
      statusPlan.planId,
      {
        confirm: (plan) => {
          nativePlan = plan;
          return Promise.resolve('approved');
        },
      },
    );
    expect(status).toMatchObject({ installed: false, authenticated: false });
    expect(nativePlan?.disclosure.warning).toMatch(/did not find GitHub CLI/iu);
    await expect(
      harness.service.prepareCi('window-cli-missing', {
        target,
        remote: 'github',
        baseBranch: 'main',
        destinationBranch: 'remote-topic',
      }),
    ).rejects.toThrow(/GitHub CLI is unavailable/iu);

    const resolvesBeforePush = harness.githubRuntime.resolveCalls;
    const push = await harness.service.preparePush('window-cli-missing', {
      target,
      remote: 'origin',
      destinationBranch: 'published/without-gh',
    });
    await expect(
      harness.service.confirmPush('window-cli-missing', push.planId, {
        confirm: () => Promise.resolve('denied'),
      }),
    ).resolves.toBeNull();
    expect(harness.githubRuntime.resolveCalls).toBe(resolvesBeforePush);

    const pendingStatus = await harness.service.prepareGitHubStatus('window-cli-missing', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    const preservedPush = await harness.service.preparePush('window-cli-missing', {
      target,
      remote: 'origin',
      destinationBranch: 'published/still-independent',
    });
    harness.service.invalidateGitHubRuntime();
    await expect(
      harness.service.confirmGitHubStatus('window-cli-missing', pendingStatus.planId, {
        confirm: () => Promise.resolve('denied'),
      }),
    ).rejects.toThrow(/approval plan is unavailable/iu);
    await expect(
      harness.service.confirmPush('window-cli-missing', preservedPush.planId, {
        confirm: () => Promise.resolve('denied'),
      }),
    ).resolves.toBeNull();
  });

  it('discloses the selected GitHub base to source impact when it differs from the recorded run-base impact', async () => {
    const fixture = await createFixture();
    const firstSourceCommit = fixture.sourceHead;
    await writeFile(path.join(fixture.worktree, 'follow-up.txt'), 'reviewed follow-up\n');
    await git(fixture.worktree, ['add', '--', 'follow-up.txt']);
    await git(fixture.worktree, ['commit', '-m', 'Reviewed follow-up']);
    fixture.sourceHead = await git(fixture.worktree, ['rev-parse', 'HEAD']);

    // Simulate the selected PR base already containing the first reviewed agent commit.
    await git(fixture.repository, ['reset', '--hard', firstSourceCommit]);
    const runner = new FakeGitHubRunner();
    runner.branches.set('main', firstSourceCommit);
    runner.branches.set('remote-topic', fixture.sourceHead);
    const harness = createHarness(fixture, runner);
    const target = deliveryTarget();

    const statusPlan = await harness.service.prepareGitHubStatus('window-pr-impact', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
    });
    await harness.service.confirmGitHubStatus('window-pr-impact', statusPlan.planId, {
      confirm: () => Promise.resolve('approved'),
    });

    const pr = await harness.service.preparePullRequest('window-pr-impact', {
      target,
      remote: 'github',
      baseBranch: 'main',
      destinationBranch: 'remote-topic',
      title: 'Only the remaining reviewed change',
      body: 'Exact impact body',
      draft: false,
    });
    expect(pr).toMatchObject({
      baseOid: firstSourceCommit,
      headOid: fixture.sourceHead,
      commitCount: 1,
      commits: [fixture.sourceHead],
      fileCount: 1,
      files: [{ oldPath: null, newPath: 'follow-up.txt', status: 'added' }],
    });

    let nativePlan: OutboundApprovalPlan | undefined;
    await expect(
      harness.service.confirmPullRequest('window-pr-impact', pr.planId, {
        confirm: (plan) => {
          nativePlan = plan;
          return Promise.resolve('denied');
        },
      }),
    ).resolves.toBeNull();
    expect(nativePlan?.disclosure.details).toContainEqual({
      label: 'Commit range',
      value: `${firstSourceCommit}..${fixture.sourceHead}`,
    });
    const disclosedFiles = nativePlan?.disclosure.details
      .filter((detail) => detail.label.startsWith('Files'))
      .map((detail) => detail.value)
      .join('\n');
    expect(disclosedFiles).toContain('follow-up.txt');
    expect(disclosedFiles).not.toContain('feature.txt');
  });
});

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly managedRoot: string;
  readonly worktree: string;
  readonly worktreeId: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly bareRemote: string;
  readonly secondBareRemote: string;
  sourceHead: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgeboard-remote-delivery-'));
  roots.push(root);
  const repositoryPath = path.join(root, 'repository');
  await mkdir(repositoryPath);
  const repository = await realpath(repositoryPath);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Fixture Author']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(repository, 'README.md'), '# fixture\n');
  await git(repository, ['add', '--', 'README.md']);
  await git(repository, ['commit', '-m', 'Initial commit']);
  const managedRoot = path.join(root, 'managed');
  await mkdir(managedRoot);
  const ownership = (
    await new WorktreeService(new RepositoryService()).provision({
      repositoryPath: repository,
      managedRoot,
      agentId: 'remote-agent',
      taskId: 'remote-node',
      branchPrefix: 'agent/source',
    })
  ).ownership;
  await writeFile(path.join(ownership.worktreePath, 'feature.txt'), 'reviewed\n');
  await git(ownership.worktreePath, ['add', '--', 'feature.txt']);
  await git(ownership.worktreePath, ['commit', '-m', 'Reviewed feature']);
  const bareRemote = path.join(root, 'remote.git');
  const secondBareRemote = path.join(root, 'second-remote.git');
  await git(root, ['init', '--bare', bareRemote]);
  await git(root, ['init', '--bare', secondBareRemote]);
  await git(ownership.worktreePath, ['remote', 'add', 'origin', bareRemote]);
  await git(ownership.worktreePath, [
    'remote',
    'add',
    'github',
    'https://github.com/owner/repository.git',
  ]);
  return {
    root,
    repository,
    managedRoot: ownership.managedRoot,
    worktree: ownership.worktreePath,
    worktreeId: ownership.id,
    branch: ownership.branch,
    baseRef: ownership.baseRef,
    baseCommit: ownership.baseCommit,
    sourceHead: await git(ownership.worktreePath, ['rev-parse', 'HEAD']),
    bareRemote,
    secondBareRemote,
  };
}

function createHarness(fixture: Fixture, runner = new FakeGitHubRunner()) {
  const store = new LocalStore(path.join(fixture.root, 'state', 'forgeboard.sqlite3'));
  stores.add(store);
  store.saveProject(project(fixture.repository));
  store.saveRun(runRecord(fixture));
  const repositories = new RepositoryService();
  const targets = new GitTargetResolver(store, repositories, () => ({
    worktreeRoot: fixture.managedRoot,
  }));
  const readiness = new MutableReadiness(fixture);
  const audit = { appendAudit: vi.fn() };
  const outbound = new OutboundActionGate(audit);
  const operations = new PermitBoundGitRemoteOperations(
    repositories,
    new ChangeService(repositories),
  );
  const githubRuntime = new MutableGitHubRuntime(runner);
  const service = new GitRemoteDeliveryService(
    targets,
    repositories,
    readiness,
    readiness,
    outbound,
    audit,
    { operations, githubCliRuntime: githubRuntime },
  );
  services.add(service);
  return { service, readiness, runner, githubRuntime, audit, outbound };
}

class MutableReadiness implements GitShippingReadinessAuthority {
  public failNext = false;
  public revalidateCalls = 0;

  public constructor(private readonly fixture: Fixture) {}

  public async get(input: {
    target: GitDeliveryReadinessTarget;
  }): Promise<GitDeliveryReadinessGetView> {
    const binding = await this.bind(input.target);
    return {
      target: input.target,
      source: {
        sourceHead: binding.view.sourceFingerprint.sourceHead,
        sourceTree: binding.view.sourceFingerprint.sourceTree,
        worktreeId: binding.view.sourceFingerprint.worktreeId,
        runId: binding.view.sourceFingerprint.runId,
      },
      availableChecks: binding.view.availableChecks,
      readiness: binding.view,
      staleReason: null,
      refreshedAt: NOW,
    };
  }

  public async bind(target: GitDeliveryReadinessTarget): Promise<GitShippingReadinessBinding> {
    const sourceHead = await git(this.fixture.worktree, ['rev-parse', 'HEAD']);
    const sourceTree = await git(this.fixture.worktree, ['rev-parse', 'HEAD^{tree}']);
    const sourceFingerprint = {
      sourceHead,
      sourceTree,
      worktreeId: this.fixture.worktreeId,
      runId: target.runId,
      requiredCheckConfigurationDigest: hash('configuration'),
      digest: hash(`${sourceHead}:${sourceTree}`),
    };
    const evidenceFingerprint = hash(`evidence:${sourceHead}`);
    const snapshot = {
      readinessId: READINESS_ID,
      target,
      sourceFingerprint,
      availableChecks: [
        {
          checkId: 'test' as const,
          label: 'Deterministic tests',
          kind: 'test' as const,
          availability: 'configured' as const,
          configurationDigest: hash('test-command'),
        },
      ],
      requiredChecks: [
        {
          checkId: 'test' as const,
          label: 'Deterministic tests',
          kind: 'test' as const,
          configurationDigest: hash('test-command'),
          state: 'passed' as const,
          executionId: EXECUTION_ID,
          sourceFingerprint,
          startedAt: NOW,
          endedAt: NOW,
          updatedAt: NOW,
        },
      ],
      approvals: [
        {
          approvalId: APPROVAL_ID,
          authority: 'human' as const,
          actorId: 'fixture-human',
          actorLabel: 'Fixture human',
          sourceFingerprint,
          evidenceFingerprint,
          approvedAt: NOW,
        },
      ],
      evidenceFingerprint,
      updatedAt: NOW,
    };
    const view: GitDeliveryReadinessView = {
      ...snapshot,
      evaluation: evaluateGitDeliveryReadiness(snapshot),
    };
    return { approvalId: APPROVAL_ID, view };
  }

  public revalidate(
    _target: GitDeliveryReadinessTarget,
    binding: GitShippingReadinessBinding,
  ): Promise<GitDeliveryReadinessView> {
    this.revalidateCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('Delivery readiness changed after review.'));
    }
    return Promise.resolve(binding.view);
  }
}

interface FakeCall {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: GitHubCommandOptions;
}

class FakeGitHubRunner implements GitHubCommandRunner {
  public readonly executable = path.resolve(path.parse(process.cwd()).root, 'test-bin', 'fake-gh');
  public readonly calls: FakeCall[] = [];
  public readonly branches = new Map<string, string>();

  public run(
    args: readonly string[],
    options: GitHubCommandOptions = {},
  ): Promise<GitHubCommandResult> {
    this.calls.push({ executable: this.executable, args: [...args], options });
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    if (args[0] === '--version') stdout = 'gh version 99.0.0\n';
    else if (args[0] === 'config') stdout = '\n';
    else if (args[0] === 'auth') stdout = 'authenticated\n';
    else if (args[0] === 'repo') {
      stdout = JSON.stringify({
        nameWithOwner: 'owner/repository',
        url: 'https://github.com/owner/repository',
        defaultBranchRef: { name: 'main' },
      });
    } else if (args[0] === 'api') {
      const endpoint = args.find((argument) => argument.includes('/heads/')) ?? '';
      const branch = decodeURIComponent(endpoint.split('/heads/')[1] ?? '');
      const oid = this.branches.get(branch);
      if (oid === undefined) {
        exitCode = 1;
        stdout =
          'HTTP/2.0 404 Not Found\r\ncontent-type: application/json\r\n\r\n{"message":"Not Found"}';
        stderr = 'missing';
      } else {
        stdout = JSON.stringify({ object: { sha: oid } });
        if (args.includes('--include')) {
          stdout = `HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n${stdout}`;
        }
      }
    } else if (args[0] === 'pr') {
      stdout = 'https://github.com/owner/repository/pull/42\n';
    } else if (args[0] === 'run') {
      const current = this.branches.get('remote-topic') ?? 'a'.repeat(40);
      stdout = JSON.stringify([
        {
          databaseId: 42,
          name: 'Current verify',
          workflowName: 'CI',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/owner/repository/actions/runs/42',
          headBranch: 'remote-topic',
          headSha: current,
        },
        {
          databaseId: 41,
          name: 'Stale verify',
          workflowName: 'CI',
          status: 'completed',
          conclusion: 'failure',
          url: 'https://github.com/owner/repository/actions/runs/41',
          headBranch: 'remote-topic',
          headSha: 'a'.repeat(40),
        },
      ]);
    } else {
      exitCode = 1;
      stderr = 'unsupported fake gh call';
    }
    return Promise.resolve({
      executable: this.executable,
      args: [...args],
      stdout,
      stderr,
      exitCode,
    });
  }
}

class MutableGitHubRuntime {
  public identityFingerprint = 'e'.repeat(64);
  public resolveCalls = 0;
  public available = true;
  readonly #missingRunner: GitHubCommandRunner = {
    executable: 'gh',
    run: () =>
      Promise.reject(
        new GitEngineError('COMMAND_FAILED', 'GitHub CLI is unavailable.', {
          executableMissing: true,
        }),
      ),
  };

  public constructor(private readonly runner: GitHubCommandRunner) {}

  public resolveCommandRuntime(): Promise<GitHubCliCommandRuntime> {
    this.resolveCalls += 1;
    if (!this.available) {
      return Promise.resolve({
        source: 'automatic',
        available: false,
        executable: this.#missingRunner.executable,
        identityFingerprint: this.identityFingerprint,
        review: null,
        status: {
          source: 'automatic',
          state: 'unavailable',
          identity: null,
          verifiedAt: null,
          checkedAt: NOW,
        },
        runner: this.#missingRunner,
      });
    }
    const identity = {
      source: 'custom' as const,
      filename: path.basename(this.runner.executable),
      sizeBytes: 42,
      sha256: 'd'.repeat(64),
      version: '99.0.0',
    };
    return Promise.resolve({
      source: 'custom',
      available: true,
      executable: this.runner.executable,
      identityFingerprint: this.identityFingerprint,
      review: {
        source: 'custom',
        executablePath: this.runner.executable,
        identity,
      },
      status: {
        source: 'custom',
        state: 'ready',
        identity,
        verifiedAt: NOW,
        checkedAt: NOW,
      },
      runner: this.runner,
    });
  }
}

function project(repository: string): Project {
  return {
    id: PROJECT_ID,
    name: 'Remote delivery fixture',
    path: repository,
    openedAt: NOW,
    missing: false,
    health: {
      isGitRepository: true,
      branch: 'main',
      dirty: false,
      remotes: [],
      packageManager: 'unknown',
      frameworks: [],
      scripts: {},
      hasSubmodules: false,
      sensitiveWarnings: [],
    },
  };
}

function runRecord(fixture: Fixture): StoredRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    nodeId: 'remote-node',
    adapterId: 'remote-agent',
    status: 'succeeded',
    cwd: fixture.worktree,
    branch: fixture.branch,
    worktreeId: fixture.worktreeId,
    repositoryRoot: fixture.repository,
    managedRoot: fixture.managedRoot,
    baseRef: fixture.baseRef,
    baseCommit: fixture.baseCommit,
    startedAt: NOW,
    endedAt: NOW,
    exitCode: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function deliveryTarget() {
  return {
    kind: 'agent-worktree' as const,
    projectId: PROJECT_ID,
    runId: RUN_ID,
  };
}

async function prepareFixturePush(service: GitRemoteDeliveryService, ownerId: string) {
  return await service.preparePush(ownerId, {
    target: deliveryTarget(),
    remote: 'origin',
    destinationBranch: 'published/reviewed-topic',
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function git(cwd: string, args: readonly string[], allowFailure = false): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error !== null && !allowFailure) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
