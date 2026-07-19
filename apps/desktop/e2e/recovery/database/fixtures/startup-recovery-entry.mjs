import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { dialog } from 'electron';

const backupPath = requiredEnvironment('FORGEBOARD_E2E_RECOVERY_BACKUP');
const logPath = requiredEnvironment('FORGEBOARD_E2E_RECOVERY_LOG');
const mainEntry = requiredEnvironment('FORGEBOARD_E2E_MAIN_ENTRY');

Object.defineProperties(dialog, {
  showMessageBox: {
    configurable: true,
    value: async (options) => {
      append({
        kind: 'message',
        title: options.title,
        buttons: options.buttons,
        cancelId: options.cancelId,
        defaultId: options.defaultId,
      });
      return {
        checkboxChecked: false,
        response: options.title === 'Local data needs recovery' ? 1 : 0,
      };
    },
  },
  showOpenDialog: {
    configurable: true,
    value: async (options) => {
      append({
        kind: 'open',
        title: options.title,
        buttonLabel: options.buttonLabel,
        properties: options.properties,
      });
      return { canceled: false, filePaths: [backupPath] };
    },
  },
});

await import(pathToFileURL(mainEntry).href);

function append(record) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the startup-recovery fixture.`);
  return value;
}
