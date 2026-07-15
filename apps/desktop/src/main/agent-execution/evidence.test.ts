import { createCustomCliAdapter, type PermissionProfile } from '@forgeboard/agent-adapters';
import { TEST_AGENT_MANIFEST } from '@forgeboard/test-agent';
import { describe, expect, it } from 'vitest';

import { RunDisclosureSchema, type RunDisclosure } from '../../shared/contracts.js';
import { disclosureFingerprint } from './evidence.js';

const RUN_ID = '123fae6e-e213-4a10-a0db-0f85b791f7e9';
const PROJECT_ID = '223fae6e-e213-4a10-a0db-0f85b791f7e9';

const PERMISSION_PROFILE: PermissionProfile = {
  id: 'test-plan',
  name: 'Test plan',
  mode: 'custom',
  enforcement: 'disclosure-only',
  readRoots: ['/repo'],
  writeRoots: [],
  network: 'provider-controlled',
  approvalPolicy: 'Review before launch.',
  disclosure: 'Local test plan.',
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

describe('agent disclosure evidence', () => {
  it('binds the fingerprint to the exact enriched disclosure returned for review', () => {
    const adapter = createCustomCliAdapter({ ...TEST_AGENT_MANIFEST, id: 'test-agent' });
    const plan = adapter.prepareLaunch({
      prompt: 'Inspect this repository.',
      cwd: '/repo',
      permissionProfile: PERMISSION_PROFILE,
      contextAttachments: [],
      executable: process.execPath,
      extraArguments: [],
      environment: { inherit: 'none', variables: {}, unset: [] },
    });
    const reviewedDisclosure: RunDisclosure = {
      runId: RUN_ID,
      nodeId: 'agent-node',
      adapterId: 'test-agent',
      provider: plan.disclosure.provider,
      executable: plan.disclosure.executable,
      arguments: [...plan.disclosure.arguments],
      cwd: plan.disclosure.cwd,
      runtime: plan.disclosure.runtime,
      environmentVariableNames: [...plan.disclosure.environmentVariableNames],
      contextAttachments: [],
      contextManifestId: null,
      contextManifestDigest: null,
      permissionProfile: RunDisclosureSchema.shape.permissionProfile.parse({
        name: plan.disclosure.permissionProfile.name,
        mode: plan.disclosure.permissionProfile.mode,
        enforcement: plan.disclosure.permissionProfile.enforcement,
        readRoots: [...plan.disclosure.permissionProfile.readRoots],
        writeRoots: [...plan.disclosure.permissionProfile.writeRoots],
        network: plan.disclosure.permissionProfile.network,
        custom: PERMISSION_PROFILE.custom,
      }),
      warnings: ['Detection warning shown to the user.'],
      branch: 'main',
      baseCommit: '1'.repeat(40),
      primaryWasDirty: false,
    };
    const input = {
      planId: RUN_ID,
      runId: RUN_ID,
      projectId: PROJECT_ID,
      nodeId: 'agent-node',
      ownerId: 'owner-a',
      expiresAt: '2026-07-15T12:01:00.000Z',
      plan,
      reviewedDisclosure,
      context: { attachments: [] },
      worktree: null,
      before: { headOid: '1'.repeat(40), paths: new Map<string, string>() },
    };

    const reviewed = disclosureFingerprint(input);
    const warningChanged = disclosureFingerprint({
      ...input,
      reviewedDisclosure: { ...reviewedDisclosure, warnings: ['Different warning.'] },
    });
    const branchChanged = disclosureFingerprint({
      ...input,
      reviewedDisclosure: { ...reviewedDisclosure, branch: 'different-branch' },
    });

    expect(warningChanged).not.toBe(reviewed);
    expect(branchChanged).not.toBe(reviewed);
  });
});
