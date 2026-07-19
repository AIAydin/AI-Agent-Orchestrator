import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import {
  captureExternalApplication,
  launchExternalApplication,
  sameExternalApplication,
  type ExternalApplicationIdentity,
} from './external-application.js';

describe('external application launcher', () => {
  it('passes the workspace as one literal argument without a shell', async () => {
    const listeners = new Map<string, () => void>();
    const child = {
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return child;
      }),
      unref: vi.fn(),
    };
    spawnMock.mockReturnValue(child);
    const application: ExternalApplicationIdentity = {
      kind: 'executable',
      configuredPath: '/Applications/Editor',
      canonicalPath: '/Applications/Editor',
      displayName: 'Editor',
      identity: '1:2:3:4',
    };

    const launched = launchExternalApplication(
      application,
      '/workspace/with spaces/$(must-stay-literal)',
    );
    listeners.get('spawn')?.();
    await launched;

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Editor',
      ['/workspace/with spaces/$(must-stay-literal)'],
      {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('launches a reviewed macOS bundle through Launch Services without a shell', async () => {
    const listeners = new Map<string, () => void>();
    const child = {
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
        return child;
      }),
      unref: vi.fn(),
    };
    spawnMock.mockReturnValue(child);
    const application: ExternalApplicationIdentity = {
      kind: 'macos-app-bundle',
      configuredPath: '/Applications/Visual Studio Code.app',
      canonicalPath: '/Applications/Visual Studio Code.app',
      displayName: 'Visual Studio Code.app',
      identity: 'reviewed-bundle',
    };

    const launched = launchExternalApplication(application, '/workspace/$HOME literal');
    listeners.get('spawn')?.();
    await launched;

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', '/Applications/Visual Studio Code.app', '/workspace/$HOME literal'],
      {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
  });

  it('captures the bundle plist and executable identity and detects executable replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-macos-app-'));
    try {
      const bundle = join(root, 'Editor.app');
      const macos = join(bundle, 'Contents', 'MacOS');
      await mkdir(macos, { recursive: true });
      await writeFile(join(bundle, 'Contents', 'Info.plist'), 'plist');
      const executable = join(macos, 'Editor');
      await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const options = {
        platform: 'darwin' as const,
      };

      const before = await captureExternalApplication(bundle, options);
      expect(before).toMatchObject({
        kind: 'macos-app-bundle',
        canonicalPath: await realpath(bundle),
        displayName: 'Editor.app',
      });
      await writeFile(executable, '#!/bin/sh\necho replaced\n', { mode: 0o700 });
      const after = await captureExternalApplication(bundle, options);
      expect(sameExternalApplication(before, after)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an application bundle whose executable escapes through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeboard-macos-app-link-'));
    try {
      const bundle = join(root, 'Editor.app');
      const macos = join(bundle, 'Contents', 'MacOS');
      await mkdir(macos, { recursive: true });
      await writeFile(join(bundle, 'Contents', 'Info.plist'), 'plist');
      const outside = join(root, 'outside-editor');
      await writeFile(outside, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      await symlink(outside, join(macos, 'Editor'));

      await expect(
        captureExternalApplication(bundle, {
          platform: 'darwin',
        }),
      ).rejects.toThrow('leaves its bundle');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
