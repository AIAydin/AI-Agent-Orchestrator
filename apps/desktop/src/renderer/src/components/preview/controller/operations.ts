import type { PreviewTargetView } from '../../../../../shared/preview/targets.js';
import type { IpcResult } from '../../../../../shared/application/contracts.js';
import { unwrap } from '../../../lib/ipc.js';

export interface PreviewRendererOperations {
  listTargets(projectId: string): Promise<PreviewTargetView[]>;
}

interface TargetBridge {
  listTargets?(input: { projectId: string }): Promise<IpcResult<PreviewTargetView[]>>;
}

export function browserPreviewOperations(): PreviewRendererOperations {
  const forgeboard = window.forgeboard as typeof window.forgeboard & {
    previews: typeof window.forgeboard.previews & TargetBridge;
  };

  return {
    async listTargets(projectId) {
      if (!forgeboard.previews.listTargets) {
        return [
          {
            target: { kind: 'primary' },
            label: 'Primary checkout',
            badge: 'Primary checkout',
            available: true,
          },
        ];
      }
      return unwrap(await forgeboard.previews.listTargets({ projectId }));
    },
  };
}
