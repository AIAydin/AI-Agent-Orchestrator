import type { PreviewTargetView } from '../../../../../shared/preview/targets.js';
import type { IpcResult } from '../../../../../shared/application/contracts.js';
import type {
  PreviewConsoleView,
  PreviewScreenshotResult,
  PreviewSurfaceBoundsInput,
  PreviewSurfaceCreateInput,
  PreviewSurfaceEvent,
  PreviewSurfaceHistoryInput,
  PreviewSurfaceNavigateInput,
  PreviewSurfaceTarget,
  PreviewSurfaceView,
} from '../../../../../shared/preview/surface/contracts.js';
import { unwrap } from '../../../lib/ipc.js';

export interface PreviewRendererOperations {
  listTargets(projectId: string): Promise<PreviewTargetView[]>;
  createSurface(input: PreviewSurfaceCreateInput): Promise<PreviewSurfaceView>;
  setSurfaceBounds(input: PreviewSurfaceBoundsInput): Promise<PreviewSurfaceView>;
  navigateSurface(input: PreviewSurfaceNavigateInput): Promise<PreviewSurfaceView>;
  reloadSurface(input: PreviewSurfaceTarget): Promise<PreviewSurfaceView>;
  navigateSurfaceHistory(input: PreviewSurfaceHistoryInput): Promise<PreviewSurfaceView>;
  getSurfaceConsole(input: PreviewSurfaceTarget): Promise<PreviewConsoleView>;
  saveSurfaceScreenshot(input: PreviewSurfaceTarget): Promise<PreviewScreenshotResult>;
  openSurfaceExternally(input: PreviewSurfaceTarget): Promise<boolean>;
  closeSurface(input: PreviewSurfaceTarget): Promise<boolean>;
  onSurfaceEvent(listener: (event: PreviewSurfaceEvent) => void): () => void;
}

interface SurfaceBridge {
  create(input: PreviewSurfaceCreateInput): Promise<IpcResult<PreviewSurfaceView>>;
  setBounds(input: PreviewSurfaceBoundsInput): Promise<IpcResult<PreviewSurfaceView>>;
  navigate(input: PreviewSurfaceNavigateInput): Promise<IpcResult<PreviewSurfaceView>>;
  reload(input: PreviewSurfaceTarget): Promise<IpcResult<PreviewSurfaceView>>;
  history(input: PreviewSurfaceHistoryInput): Promise<IpcResult<PreviewSurfaceView>>;
  getConsole(input: PreviewSurfaceTarget): Promise<IpcResult<PreviewConsoleView>>;
  screenshot(input: PreviewSurfaceTarget): Promise<IpcResult<PreviewScreenshotResult>>;
  openExternal(input: PreviewSurfaceTarget): Promise<IpcResult<boolean>>;
  close(input: PreviewSurfaceTarget): Promise<IpcResult<boolean>>;
  onEvent(listener: (event: PreviewSurfaceEvent) => void): () => void;
}

interface TargetBridge {
  listTargets?(input: { projectId: string }): Promise<IpcResult<PreviewTargetView[]>>;
}

export function browserPreviewOperations(): PreviewRendererOperations | null {
  const forgeboard = window.forgeboard as typeof window.forgeboard & {
    previewSurfaces?: SurfaceBridge;
    previews: typeof window.forgeboard.previews & TargetBridge;
  };
  const surfaces = forgeboard.previewSurfaces;
  if (!surfaces) return null;

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
    async createSurface(input) {
      return unwrap(await surfaces.create(input));
    },
    async setSurfaceBounds(input) {
      return unwrap(await surfaces.setBounds(input));
    },
    async navigateSurface(input) {
      return unwrap(await surfaces.navigate(input));
    },
    async reloadSurface(input) {
      return unwrap(await surfaces.reload(input));
    },
    async navigateSurfaceHistory(input) {
      return unwrap(await surfaces.history(input));
    },
    async getSurfaceConsole(input) {
      return unwrap(await surfaces.getConsole(input));
    },
    async saveSurfaceScreenshot(input) {
      return unwrap(await surfaces.screenshot(input));
    },
    async openSurfaceExternally(input) {
      return unwrap(await surfaces.openExternal(input));
    },
    async closeSurface(input) {
      return unwrap(await surfaces.close(input));
    },
    onSurfaceEvent(listener) {
      return surfaces.onEvent(listener);
    },
  };
}
