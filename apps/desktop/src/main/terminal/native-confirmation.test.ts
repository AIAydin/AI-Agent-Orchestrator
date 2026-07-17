import type { BrowserWindow, Dialog, MessageBoxOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalLaunchNativeReview } from './service.js';
import { confirmTerminalLaunch, terminalLaunchMessage } from './native-confirmation.js';

const parent = {} as BrowserWindow;

describe('native terminal confirmation', () => {
  it('discloses exact native authority with cancel as the safe default', async () => {
    const review = nativeReview();
    let shown: MessageBoxOptions | undefined;
    const checks: string[] = [];
    const dialog = {
      showMessageBox: vi.fn((_parent: BrowserWindow, options: MessageBoxOptions) => {
        shown = options;
        checks.push('show');
        return Promise.resolve({ response: 1, checkboxChecked: false });
      }),
    } as unknown as Pick<Dialog, 'showMessageBox'>;

    await expect(
      confirmTerminalLaunch(dialog, parent, review, () => checks.push('current')),
    ).resolves.toBe('approved');

    expect(checks).toEqual(['current', 'show', 'current']);
    expect(shown).toMatchObject({
      type: 'warning',
      buttons: ['Cancel', 'Launch terminal'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(shown?.detail).toContain('Executable: "/private/tools/zsh"');
    expect(shown?.detail).toContain('Working directory: "/private/project/apps/desktop"');
    expect(shown?.detail).toContain('1. "-l"');
    expect(shown?.detail).toContain('"PATH", "TERM"');
    expect(shown?.detail).toContain('not sandboxed');
    expect(shown?.detail).toContain('single-use');
  });

  it('escapes control and directional text and fails closed when ownership changes', async () => {
    const review = nativeReview({ arguments: ['safe\nnext\u202Ehidden'] });
    const message = terminalLaunchMessage(review);
    expect(message.detail).toContain('safe\\nnext\\u202ehidden');

    let checks = 0;
    const showMessageBox = vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    await expect(
      confirmTerminalLaunch(
        { showMessageBox } as unknown as Pick<Dialog, 'showMessageBox'>,
        parent,
        review,
        () => {
          checks += 1;
          if (checks === 2) throw new Error('terminal window changed');
        },
      ),
    ).rejects.toThrow(/window changed/u);
    expect(showMessageBox).toHaveBeenCalledOnce();
  });
});

function nativeReview(
  exactOverrides: Partial<TerminalLaunchNativeReview['exact']> = {},
): TerminalLaunchNativeReview {
  return {
    view: {
      kind: 'terminal-launch',
      planId: '10000000-0000-4000-8000-000000000001',
      projectId: '20000000-0000-4000-8000-000000000001',
      projectName: 'Forgeboard',
      nodeId: 'terminal-1',
      executable: '/private/tools/zsh',
      arguments: [...(exactOverrides.arguments ?? ['-l'])],
      cwdRelative: 'apps/desktop',
      environmentVariableNames: ['PATH', 'TERM'],
      columns: 120,
      rows: 40,
      permission: {
        label: 'Local terminal (not sandboxed)',
        sandboxed: false,
        filesystem: 'operating-system-user',
        network: 'operating-system-user',
        detail: 'The working directory is not a security sandbox.',
      },
      expiresAt: '2026-07-17T17:00:00.000Z',
    },
    exact: {
      executable: '/private/tools/zsh',
      arguments: ['-l'],
      cwd: '/private/project/apps/desktop',
      environmentVariableNames: ['PATH', 'TERM'],
      ...exactOverrides,
    },
  };
}
