import type { AppSettings } from '../../../../../shared/application/contracts.js';
import type { NamedCommandDraft } from '../../configuration/useCommandReadiness.js';

export function settingsCommandDrafts(settings: AppSettings): NamedCommandDraft[] {
  return [
    {
      id: 'development',
      label: 'Development server',
      purpose: 'preview',
      command: settings.developmentCommand,
    },
    {
      id: 'check-lint',
      label: 'Lint command',
      purpose: 'check',
      command: settings.lintCommand,
    },
    {
      id: 'check-typecheck',
      label: 'Typecheck command',
      purpose: 'check',
      command: settings.typecheckCommand,
    },
    {
      id: 'check-test',
      label: 'Test command',
      purpose: 'check',
      command: settings.testCommand,
    },
    {
      id: 'check-build',
      label: 'Build command',
      purpose: 'check',
      command: settings.buildCommand,
    },
    ...(settings.customChecks ?? []).map(
      (check): NamedCommandDraft => ({
        id: `check-custom-${check.id}`,
        label: check.label.trim() || 'Custom check',
        purpose: 'check',
        command: check.command,
      }),
    ),
  ];
}
