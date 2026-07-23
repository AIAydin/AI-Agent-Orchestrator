import type { AppSettings } from '../../../../shared/application/contracts.js';

type KeyboardPreset = AppSettings['keyboardPreset'];

export interface KeyboardShortcutEvent {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function opensCommandPalette(event: KeyboardShortcutEvent, preset: KeyboardPreset): boolean {
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (preset === 'vscode') {
    return (
      (key === 'f1' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) ||
      (key === 'p' && command && event.shiftKey && !event.altKey)
    );
  }
  return key === 'k' && command && !event.altKey && !event.shiftKey;
}

export function commandPaletteShortcutLabel(preset: KeyboardPreset): string {
  return preset === 'vscode' ? 'F1 or ⌘/Ctrl+⇧P' : '⌘/Ctrl+K';
}
