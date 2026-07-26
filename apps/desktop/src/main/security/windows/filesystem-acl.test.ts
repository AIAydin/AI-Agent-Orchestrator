import { describe, expect, it, vi } from 'vitest';

import {
  NativeWindowsFilesystemSecurity,
  WindowsAclBoundaryError,
  assertConfidentialWindowsParentAcl,
  assertPrivateWindowsDirectoryAcl,
  assertPrivateWindowsFileAcl,
  assertSafeWindowsParentAcl,
  parseWindowsDirectoryAcl,
  type WindowsDirectoryAcl,
} from './filesystem-acl.js';

const USER_SID = 'S-1-5-21-111-222-333-1001';
const SYSTEM_SID = 'S-1-5-18';

describe('Windows filesystem ACL boundary', () => {
  it('rejects another local principal with write or delete-child authority on a parent', () => {
    const report = parentAcl([
      rule(USER_SID, 0x1f01ff),
      rule(SYSTEM_SID, 0x1f01ff),
      rule('S-1-5-32-545', 0x40),
    ]);

    expectBoundaryCode(() => assertSafeWindowsParentAcl(report, USER_SID), 'unsafe-parent');
  });

  it('rejects generic write/all and inherit-only child write authority', () => {
    for (const dangerousRule of [
      rule('S-1-5-32-545', 0x40000000),
      rule('S-1-5-11', 0x10000000),
      rule('S-1-1-0', 0x40, { inheritanceFlags: 0x1, propagationFlags: 0x2 }),
      rule('S-1-5-32-545', 0x2, { inheritanceFlags: 0x2, propagationFlags: 0x2 }),
    ]) {
      expectBoundaryCode(
        () =>
          assertSafeWindowsParentAcl(
            parentAcl([rule(USER_SID, 0x1f01ff), rule(SYSTEM_SID, 0x1f01ff), dangerousRule]),
            USER_SID,
          ),
        'unsafe-parent',
      );
    }
  });

  it('allows read-only local users and contextual creator-owner inheritance', () => {
    const report = parentAcl([
      rule(USER_SID, 0x1f01ff),
      rule(SYSTEM_SID, 0x1f01ff),
      rule('S-1-5-32-545', 0x20_0a9),
      rule('S-1-3-0', 0x1f01ff, {
        inheritanceFlags: 0x3,
        propagationFlags: 0x2,
      }),
    ]);

    expect(() => assertSafeWindowsParentAcl(report, USER_SID)).not.toThrow();
    expectBoundaryCode(() => assertConfidentialWindowsParentAcl(report, USER_SID), 'unsafe-parent');
  });

  it('allows only trusted or non-discovering rules on a confidential parent', () => {
    const report = parentAcl([
      rule(USER_SID, 0x1f01ff),
      rule(SYSTEM_SID, 0x1f01ff),
      rule('S-1-5-32-545', 0x20_000),
      rule('S-1-3-0', 0x1f01ff, {
        inheritanceFlags: 0x3,
        propagationFlags: 0x2,
      }),
    ]);

    expect(() => assertConfidentialWindowsParentAcl(report, USER_SID)).not.toThrow();
    expectBoundaryCode(
      () =>
        assertConfidentialWindowsParentAcl(
          parentAcl([
            rule(USER_SID, 0x1f01ff),
            rule(SYSTEM_SID, 0x1f01ff),
            rule('S-1-5-32-545', 0x1, {
              inheritanceFlags: 0x2,
              propagationFlags: 0x2,
            }),
          ]),
          USER_SID,
        ),
      'unsafe-parent',
    );
  });

  it('rejects an absent/null DACL instead of treating an empty rule list as private', () => {
    expectBoundaryCode(
      () =>
        assertSafeWindowsParentAcl(
          {
            schemaVersion: 2,
            ownerSid: USER_SID,
            daclPresent: false,
            hasUnsupportedDaclAce: false,
            protected: false,
            rules: [],
          },
          USER_SID,
        ),
      'unsafe-parent',
    );
  });

  it('rejects a parent when raw inspection found an ACE omitted by projected access rules', () => {
    const report = parentAcl([rule(USER_SID, 0x1f01ff), rule(SYSTEM_SID, 0x1f01ff)]);

    expectBoundaryCode(
      () => assertSafeWindowsParentAcl({ ...report, hasUnsupportedDaclAce: true }, USER_SID),
      'unsafe-parent',
    );
  });

  it('requires an exact protected private DACL for the user SID and LocalSystem', () => {
    const exact: WindowsDirectoryAcl = {
      schemaVersion: 2,
      ownerSid: USER_SID,
      daclPresent: true,
      hasUnsupportedDaclAce: false,
      protected: true,
      rules: [rule(USER_SID, 0x1f01ff), rule(SYSTEM_SID, 0x1f01ff)],
    };
    expect(() => assertPrivateWindowsDirectoryAcl(exact, USER_SID)).not.toThrow();

    expectBoundaryCode(
      () =>
        assertPrivateWindowsDirectoryAcl(
          {
            ...exact,
            rules: [...exact.rules, rule('S-1-1-0', 0x1)],
          },
          USER_SID,
        ),
      'unsafe-private-directory',
    );
    expectBoundaryCode(
      () =>
        assertPrivateWindowsDirectoryAcl({ ...exact, ownerSid: 'S-1-5-21-9-9-9-1002' }, USER_SID),
      'unsafe-private-directory',
    );
    expectBoundaryCode(
      () => assertPrivateWindowsDirectoryAcl({ ...exact, hasUnsupportedDaclAce: true }, USER_SID),
      'unsafe-private-directory',
    );
  });

  it('requires exact non-inheriting private file rules for the user SID and LocalSystem', () => {
    const exact: WindowsDirectoryAcl = {
      schemaVersion: 2,
      ownerSid: USER_SID,
      daclPresent: true,
      hasUnsupportedDaclAce: false,
      protected: true,
      rules: [
        rule(USER_SID, 0x1f01ff, { inheritanceFlags: 0 }),
        rule(SYSTEM_SID, 0x1f01ff, { inheritanceFlags: 0 }),
      ],
    };
    expect(() => assertPrivateWindowsFileAcl(exact, USER_SID)).not.toThrow();
    expectBoundaryCode(
      () =>
        assertPrivateWindowsFileAcl(
          {
            ...exact,
            rules: [rule(USER_SID, 0x1f01ff), exact.rules[1]!],
          },
          USER_SID,
        ),
      'unsafe-private-file',
    );
    expectBoundaryCode(
      () => assertPrivateWindowsFileAcl({ ...exact, hasUnsupportedDaclAce: true }, USER_SID),
      'unsafe-private-file',
    );
  });

  it('parses only the exact bounded ACL report schema', () => {
    const serialized = JSON.stringify({
      schemaVersion: 2,
      ownerSid: USER_SID,
      daclPresent: true,
      hasUnsupportedDaclAce: false,
      protected: true,
      rules: [rule(USER_SID, 0x1f01ff), rule(SYSTEM_SID, 0x1f01ff)],
    });
    expect(parseWindowsDirectoryAcl(serialized).ownerSid).toBe(USER_SID);
    expectBoundaryCode(
      () =>
        parseWindowsDirectoryAcl(
          JSON.stringify({
            schemaVersion: 2,
            ownerSid: USER_SID,
            daclPresent: true,
            hasUnsupportedDaclAce: false,
            protected: true,
            rules: [],
            untrustedExtraField: true,
          }),
        ),
      'inspection-unavailable',
    );
    expectBoundaryCode(() => parseWindowsDirectoryAcl('{not-json'), 'inspection-unavailable');
  });

  it('passes weird literal paths only to the native authority and fails closed on inspection', async () => {
    const calls: string[] = [];
    const weirdPath = String.raw`C:\Users\A Name\$(not-code);'context`;
    const inspect = vi.fn((path: string) => {
      calls.push(path);
      return Promise.reject(new Error('injected ACL inspection failure'));
    });
    const authority = new NativeWindowsFilesystemSecurity(
      inspect,
      vi.fn(() => Promise.reject(new Error('unexpected protection call'))),
      () => Promise.resolve(USER_SID),
    );
    const sid = await authority.currentUserSid();

    await expect(authority.assertSafeParent(weirdPath, sid)).rejects.toMatchObject({
      code: 'inspection-unavailable',
    });
    expect(calls).toEqual([weirdPath]);
  });

  it('does not cache a failed token identity lookup', async () => {
    const resolveWindowsUserSid = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('identity unavailable'))
      .mockResolvedValueOnce(USER_SID);
    const authority = new NativeWindowsFilesystemSecurity(
      vi.fn(() => Promise.reject(new Error('unexpected inspection call'))),
      vi.fn(() => Promise.reject(new Error('unexpected protection call'))),
      resolveWindowsUserSid,
    );

    await expect(authority.currentUserSid()).rejects.toBeInstanceOf(WindowsAclBoundaryError);
    await expect(authority.currentUserSid()).resolves.toBe(USER_SID);
    expect(resolveWindowsUserSid).toHaveBeenCalledTimes(2);
  });

  it('protects and verifies a literal file path through the bounded authority', async () => {
    const filePath = String.raw`C:\Users\A Name\backup $(literal);'.sqlite3`;
    const exactFileReport = JSON.stringify({
      schemaVersion: 2,
      ownerSid: USER_SID,
      daclPresent: true,
      hasUnsupportedDaclAce: false,
      protected: true,
      rules: [
        rule(USER_SID, 0x1f01ff, { inheritanceFlags: 0 }),
        rule(SYSTEM_SID, 0x1f01ff, { inheritanceFlags: 0 }),
      ],
    });
    const inspect = vi.fn(() => Promise.resolve(exactFileReport));
    const protect = vi.fn(() => Promise.resolve());
    const authority = new NativeWindowsFilesystemSecurity(inspect, protect);

    await authority.protectPrivateFile(filePath, USER_SID);

    expect(protect).toHaveBeenCalledWith(filePath, USER_SID, false);
    expect(inspect).toHaveBeenCalledWith(filePath);
  });
});

function parentAcl(rules: readonly ReturnType<typeof rule>[]): WindowsDirectoryAcl {
  return {
    schemaVersion: 2,
    ownerSid: USER_SID,
    daclPresent: true,
    hasUnsupportedDaclAce: false,
    protected: false,
    rules,
  };
}

function rule(
  sid: string,
  rights: number,
  overrides: Partial<ReturnTypeRule> = {},
): ReturnTypeRule {
  return {
    sid,
    accessType: 'Allow',
    rights,
    inherited: false,
    inheritanceFlags: 0x3,
    propagationFlags: 0,
    ...overrides,
  };
}

interface ReturnTypeRule {
  readonly sid: string;
  readonly accessType: 'Allow' | 'Deny';
  readonly rights: number;
  readonly inherited: boolean;
  readonly inheritanceFlags: number;
  readonly propagationFlags: number;
}

function expectBoundaryCode(action: () => void, code: WindowsAclBoundaryError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WindowsAclBoundaryError);
    if (error instanceof WindowsAclBoundaryError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected Windows ACL boundary error ${code}.`);
}
