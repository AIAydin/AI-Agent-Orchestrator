import { describe, expect, it } from 'vitest';

import { environmentNames, redactAuditValue, redactEnvironment } from './audit.js';
import {
  DockerIsolatedPermissionProfileSchema,
  HOST_CREDENTIAL_MOUNT_ACKNOWLEDGEMENT,
  ImpactConfirmationSchema,
  PermissionProfileSchema,
  isApprovalActive,
  isImpactConfirmationSatisfied,
} from './permissions.js';

const NOW = '2026-07-14T12:00:00.000Z';

describe('permissions and audit redaction', () => {
  it('validates all four honest permission profiles as distinct capabilities', () => {
    const common = {
      schemaVersion: 1,
      name: 'Profile',
      description: 'An explicit capability profile shown before agent launch.',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const profiles = [
      {
        ...common,
        id: 'plan',
        kind: 'plan-read-only',
        filesystem: 'project-read-only',
        network: 'provider-only',
        processExecution: 'agent-only',
      },
      {
        ...common,
        id: 'worktree',
        kind: 'worktree-write',
        filesystem: 'assigned-worktree-write',
        network: 'provider-only',
        processExecution: 'agent-and-approved-commands',
      },
      {
        ...common,
        id: 'docker',
        kind: 'docker-isolated',
        filesystem: 'single-worktree-mount',
        network: 'disabled',
        processExecution: 'container-only',
        docker: {
          image: 'forgeboard-agent:local',
          nonRootUser: 'forgeboard',
          cpuLimit: 2,
          memoryMbLimit: 4096,
        },
      },
      {
        ...common,
        id: 'custom',
        kind: 'custom',
        runtime: 'host',
        filesystem: 'explicit-paths',
        readPaths: ['src'],
        writePaths: ['src/generated'],
        ignoredFileRead: 'deny',
        sensitiveFileRead: 'deny',
        executablePolicy: 'selected-agent-only',
        allowedLaunchExecutables: [],
        forgeboardManagedActions: { developmentServers: 'deny', tests: 'allow' },
        network: 'provider-only',
        processExecution: 'agent-and-approved-commands',
        requireReviewBeforePrimary: true,
        acknowledgesCwdIsNotSandbox: true,
      },
    ];
    expect(profiles.map((profile) => PermissionProfileSchema.parse(profile).kind)).toEqual([
      'plan-read-only',
      'worktree-write',
      'docker-isolated',
      'custom',
    ]);
    expect(
      PermissionProfileSchema.safeParse({
        ...profiles[3],
        acknowledgesCwdIsNotSandbox: false,
      }).success,
    ).toBe(false);
  });

  it('binds approvals to the exact action, project, agent, run, and fingerprint', () => {
    const approval = {
      schemaVersion: 1 as const,
      id: 'approval-1',
      scope: {
        projectId: 'project-1',
        action: 'git-push' as const,
        resourceFingerprint: '0123456789abcdef',
        agentId: 'agent-1',
        runId: 'run-1',
      },
      decision: 'approved' as const,
      decidedBy: 'user-1',
      reason: 'Reviewed the exact branch and commit range',
      createdAt: NOW,
      expiresAt: '2026-07-14T13:00:00.000Z',
      singleUse: true,
    };
    expect(isApprovalActive(approval, approval.scope, new Date(NOW))).toBe(true);
    expect(
      isApprovalActive(
        approval,
        { ...approval.scope, resourceFingerprint: 'fedcba9876543210' },
        new Date(NOW),
      ),
    ).toBe(false);
    expect(isApprovalActive({ ...approval, consumedAt: NOW }, approval.scope, new Date(NOW))).toBe(
      false,
    );
  });

  it('requires exact high-impact confirmation text', () => {
    const confirmation = ImpactConfirmationSchema.parse({
      action: 'git-destructive',
      title: 'Discard changes',
      impact: 'This permanently discards the selected uncommitted changes.',
      affectedResources: ['src/index.ts'],
      requiredPhrase: 'DISCARD src/index.ts',
      enteredPhrase: 'discard src/index.ts',
    });
    expect(isImpactConfirmationSatisfied(confirmation)).toBe(false);
    expect(
      isImpactConfirmationSatisfied({
        ...confirmation,
        enteredPhrase: confirmation.requiredPhrase,
      }),
    ).toBe(true);
  });

  it('redacts nested secrets, bearer tokens, URL credentials, and env assignments', () => {
    expect(
      redactAuditValue({
        api_token: 'secret-value',
        nested: {
          password: 'hunter2',
          safe: 'TOKEN=abc Bearer xyz https://user:pass@example.test',
        },
      }),
    ).toEqual({
      api_token: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
        safe: 'TOKEN=[REDACTED] Bearer [REDACTED] https://[REDACTED]@example.test',
      },
    });
  });

  it('discloses environment names in stable order but never values', () => {
    const environment = { Z_TOKEN: 'top-secret', HOME: '/home/user', A_FLAG: '1' };
    expect(environmentNames(environment)).toEqual(['A_FLAG', 'HOME', 'Z_TOKEN']);
    expect(redactEnvironment(environment)).toEqual({
      A_FLAG: '[REDACTED]',
      HOME: '[REDACTED]',
      Z_TOKEN: '[REDACTED]',
    });
  });

  it('allows host credential mounts only with exact paths and a scoped approval acknowledgement', () => {
    const profile = DockerIsolatedPermissionProfileSchema.parse({
      schemaVersion: 1,
      id: 'docker-approved',
      name: 'Explicit credential mount',
      description: 'Container profile with a user-approved provider credential mount.',
      kind: 'docker-isolated',
      filesystem: 'single-worktree-mount',
      network: 'enabled',
      processExecution: 'container-only',
      docker: {
        image: 'forgeboard-agent:local',
        nonRootUser: 'forgeboard',
        cpuLimit: 2,
        memoryMbLimit: 4096,
        credentialMount: {
          enabled: true,
          paths: ['/home/user/.config/provider'],
          approvalId: 'approval-1',
          acknowledgement: HOST_CREDENTIAL_MOUNT_ACKNOWLEDGEMENT,
        },
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(profile.docker.credentialMount).toMatchObject({
      enabled: true,
      approvalId: 'approval-1',
    });
    expect(
      DockerIsolatedPermissionProfileSchema.safeParse({
        ...profile,
        docker: { ...profile.docker, credentialMount: { enabled: true, paths: ['/tmp'] } },
      }).success,
    ).toBe(false);
  });
});
