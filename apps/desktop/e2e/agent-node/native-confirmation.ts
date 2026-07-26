import type { ElectronApplication } from '@playwright/test';

export async function choosePath(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: () => Promise.resolve({ canceled: false, filePaths: [path] }),
    });
  }, selectedPath);
}
