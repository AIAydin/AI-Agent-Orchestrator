import type { GitHealth } from './contracts.js';

const SAFE_PACKAGE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const MAX_DETECTED_SCRIPTS = 256;

const PREVIEW_SCRIPT_PRIORITY = [
  'dev',
  'develop',
  'preview',
  'serve',
  'start',
  'start:dev',
] as const;

export interface DetectedPreviewScript {
  name: string;
  declaration: string;
  executable: Exclude<GitHealth['packageManager'], 'unknown'>;
  arguments: ['run', string];
}

/**
 * Turns passive package metadata into commands that can be displayed in the UI.
 * Script declarations are display-only: they are never split or passed to a shell.
 */
export function detectedPreviewScripts(health: GitHealth): DetectedPreviewScript[] {
  if (health.packageManager === 'unknown') return [];
  return Object.entries(health.scripts)
    .filter(
      (entry): entry is [string, string] =>
        isSafePackageScriptName(entry[0]) && typeof entry[1] === 'string',
    )
    .slice(0, MAX_DETECTED_SCRIPTS)
    .map(([name, declaration]) => ({
      name,
      declaration,
      executable: health.packageManager as Exclude<GitHealth['packageManager'], 'unknown'>,
      arguments: ['run', name],
    }));
}

export function preferredPreviewScript(scripts: readonly DetectedPreviewScript[]): string | null {
  for (const preferred of PREVIEW_SCRIPT_PRIORITY) {
    if (scripts.some((script) => script.name === preferred)) return preferred;
  }
  const prefixed = scripts.find(
    (script) =>
      script.name.startsWith('dev:') ||
      script.name.startsWith('preview:') ||
      script.name.startsWith('serve:'),
  );
  return prefixed?.name ?? scripts[0]?.name ?? null;
}

export function isSafePackageScriptName(value: string): boolean {
  return SAFE_PACKAGE_SCRIPT_NAME.test(value);
}
