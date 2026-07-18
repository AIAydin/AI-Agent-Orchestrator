import type { ElectronApplication } from '@playwright/test';

export async function chooseSettingsExportPath(
  app: ElectronApplication,
  path: string,
): Promise<void> {
  await app.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showSaveDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePath: selectedPath }),
    });
  }, path);
}

export async function chooseSettingsImportPath(
  app: ElectronApplication,
  path: string,
): Promise<void> {
  await app.evaluate(({ dialog }, selectedPath) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePaths: [selectedPath] }),
    });
  }, path);
}
