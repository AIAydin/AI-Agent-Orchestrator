import { describe, expect, it } from 'vitest';

import { commandPaletteShortcutLabel, opensCommandPalette } from './keyboard-preset.js';

const plain = {
  key: '',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe('keyboard presets', () => {
  it('uses Command/Ctrl+K only for the standard command-palette shortcut', () => {
    expect(opensCommandPalette({ ...plain, key: 'k', ctrlKey: true }, 'standard')).toBe(true);
    expect(opensCommandPalette({ ...plain, key: 'K', metaKey: true }, 'standard')).toBe(true);
    expect(
      opensCommandPalette({ ...plain, key: 'k', ctrlKey: true, shiftKey: true }, 'standard'),
    ).toBe(false);
    expect(opensCommandPalette({ ...plain, key: 'p', ctrlKey: true }, 'standard')).toBe(false);
  });

  it('uses VS Code F1 and Command/Ctrl+Shift+P shortcuts only in the VS Code preset', () => {
    expect(opensCommandPalette({ ...plain, key: 'F1' }, 'vscode')).toBe(true);
    expect(
      opensCommandPalette({ ...plain, key: 'p', ctrlKey: true, shiftKey: true }, 'vscode'),
    ).toBe(true);
    expect(
      opensCommandPalette({ ...plain, key: 'P', metaKey: true, shiftKey: true }, 'vscode'),
    ).toBe(true);
    expect(opensCommandPalette({ ...plain, key: 'k', ctrlKey: true }, 'vscode')).toBe(false);
    expect(opensCommandPalette({ ...plain, key: 'F1', altKey: true }, 'vscode')).toBe(false);
  });

  it('labels the shortcut that each preset actually handles', () => {
    expect(commandPaletteShortcutLabel('standard')).toContain('K');
    expect(commandPaletteShortcutLabel('vscode')).toContain('F1');
    expect(commandPaletteShortcutLabel('vscode')).toContain('P');
  });
});
