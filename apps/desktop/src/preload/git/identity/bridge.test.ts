import { describe, expect, it, vi } from 'vitest';

import { GIT_IDENTITY_IPC_CHANNEL } from '../../../shared/git/identity/contracts.js';
import { createGitIdentityApi } from './bridge.js';

const input = {
  source: 'settings' as const,
  name: 'Artemis Author',
  email: 'author@example.invalid',
};
const result = {
  request: input,
  identity: {
    name: input.name,
    email: input.email,
    nameSource: 'settings' as const,
    emailSource: 'settings' as const,
    ready: true,
  },
  checkedAt: '2026-07-18T16:00:00.000Z',
};

describe('Git identity preload bridge', () => {
  it('invokes only the exact channel with validated path-free input', async () => {
    const invoke = vi.fn(() => Promise.resolve({ ok: true as const, value: result }));
    const api = createGitIdentityApi(invoke);

    await expect(api.check(input)).resolves.toEqual({ ok: true, value: result });
    expect(invoke).toHaveBeenCalledWith(GIT_IDENTITY_IPC_CHANNEL, input);
    await expect(
      api.check({ ...input, repositoryPath: '/renderer/path' } as never),
    ).rejects.toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a main-process result that does not match the request', async () => {
    const invoke = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { ...result, identity: { ...result.identity, email: 'other@example.invalid' } },
      }),
    );

    await expect(createGitIdentityApi(invoke).check(input)).rejects.toBeTruthy();

    const otherInput = {
      ...input,
      name: 'Different Author',
      email: 'different@example.invalid',
    };
    invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        ...result,
        request: otherInput,
        identity: {
          ...result.identity,
          name: otherInput.name,
          email: otherInput.email,
        },
      },
    });
    await expect(createGitIdentityApi(invoke).check(input)).rejects.toThrow(/exact request/iu);
  });
});
