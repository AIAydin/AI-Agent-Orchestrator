import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { exactPushDestination } from './push-security.js';

describe('exact push destination binding', () => {
  it('turns a relative local URL into an unambiguous absolute file target', () => {
    const repository = path.resolve('/tmp/forgeboard-project');
    expect(exactPushDestination('../remote.git', repository)).toEqual({
      expectedRemoteUrl: '../remote.git',
      pushTarget: path.resolve(repository, '../remote.git'),
      protocol: 'file',
    });
  });

  it('binds only the validated network protocol and rejects hostile SCP syntax', () => {
    expect(
      exactPushDestination('git@github.com:owner/repository.git', '/tmp/project'),
    ).toMatchObject({ protocol: 'ssh', pushTarget: 'git@github.com:owner/repository.git' });
    expect(
      exactPushDestination('https://github.com/owner/repository.git', '/tmp/project'),
    ).toMatchObject({ protocol: 'https' });
    expect(() =>
      exactPushDestination('-oProxyCommand=evil:owner/repository.git', '/tmp/project'),
    ).toThrow(/unsupported or ambiguous/iu);
    expect(() =>
      exactPushDestination('https://token@github.com/owner/repository.git', '/tmp/project'),
    ).toThrow(/unsupported or ambiguous/iu);
  });

  it('rejects encoded file-path separators before native execution', () => {
    expect(() =>
      exactPushDestination('file:///tmp/encoded%2Frepository.git', '/tmp/project'),
    ).toThrow(/unsupported or ambiguous/iu);
  });

  it('rejects encoded network paths before Git can decode a different SSH resource', () => {
    for (const encoded of [
      '%2F..%2Fother.git',
      '%0Aother.git',
      '%5cother.git',
      '%2e/other.git',
      '%2E%2E/other.git',
    ]) {
      expect(() =>
        exactPushDestination(`ssh://git@example.test/owner/repository${encoded}`, '/tmp/project'),
      ).toThrow(/unsupported or ambiguous/iu);
    }
  });
});
