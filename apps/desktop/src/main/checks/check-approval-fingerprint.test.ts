import { describe, expect, it } from 'vitest';

import {
  checkApprovalFingerprint,
  type CheckApprovalBinding,
} from './check-approval-fingerprint.js';

function binding(): CheckApprovalBinding {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    checkId: 'test',
    label: 'Test',
    kind: 'test',
    executable: '/usr/local/bin/pnpm',
    arguments: ['run', 'test'],
    cwd: '/projects/example',
    environmentVariableNames: ['CI'],
    rootIdentity: {
      path: '/projects/example',
      device: 1,
      inode: 2,
      size: 64,
      mode: 16_893,
      modifiedAtMs: 100,
      changedAtMs: 101,
      contentDigest: null,
    },
    executableIdentities: [
      {
        path: '/usr/local/bin/pnpm',
        device: 1,
        inode: 3,
        size: 256,
        mode: 33_253,
        modifiedAtMs: 200,
        changedAtMs: 201,
        contentDigest: 'a'.repeat(64),
      },
      {
        path: '/projects/example/package.json',
        device: 1,
        inode: 4,
        size: 512,
        mode: 33_188,
        modifiedAtMs: 300,
        changedAtMs: 301,
        contentDigest: 'b'.repeat(64),
      },
    ],
  };
}

describe('checkApprovalFingerprint', () => {
  it('is deterministic and content bound without receiving environment values', () => {
    const first = checkApprovalFingerprint(binding());
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkApprovalFingerprint(binding())).toBe(first);
  });

  it('changes for command, root, executable, and package-script drift', () => {
    const original = binding();
    const fingerprint = checkApprovalFingerprint(original);
    expect(checkApprovalFingerprint({ ...original, arguments: ['run', 'test:unit'] })).not.toBe(
      fingerprint,
    );
    expect(
      checkApprovalFingerprint({
        ...original,
        rootIdentity: { ...original.rootIdentity, inode: 99 },
      }),
    ).not.toBe(fingerprint);
    expect(
      checkApprovalFingerprint({
        ...original,
        executableIdentities: original.executableIdentities.map((identity, index) =>
          index === 0 ? { ...identity, mode: identity.mode ^ 0o111 } : identity,
        ),
      }),
    ).not.toBe(fingerprint);
    expect(
      checkApprovalFingerprint({
        ...original,
        executableIdentities: original.executableIdentities.map((identity, index) =>
          index === 1 ? { ...identity, contentDigest: 'c'.repeat(64) } : identity,
        ),
      }),
    ).not.toBe(fingerprint);
  });
});
