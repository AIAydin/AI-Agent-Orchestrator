import type { Dispatch, SetStateAction } from 'react';

import type { AppSettings } from '../../../../shared/application/contracts.js';
import { CollaborationSettings } from './collaboration/CollaborationSettings.js';

interface ConnectivitySettingsProps {
  readonly settings: AppSettings;
  readonly setSettings: Dispatch<SetStateAction<AppSettings>>;
  readonly busy: boolean;
}

export function ConnectivitySettings(props: ConnectivitySettingsProps) {
  return <CollaborationSettings {...props} />;
}
