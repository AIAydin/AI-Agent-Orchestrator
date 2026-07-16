import type { AppSettings } from '../../../../../shared/application/contracts.js';
import { settingsCommandReadinessDrafts } from '../../../../../shared/settings/readiness-requests.js';
import type { NamedCommandDraft } from '../../configuration/useCommandReadiness.js';

export function settingsCommandDrafts(settings: AppSettings): NamedCommandDraft[] {
  return settingsCommandReadinessDrafts(settings);
}
