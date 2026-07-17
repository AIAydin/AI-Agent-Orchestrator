import type { IpcResult } from '../../application/contracts.js';
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
} from './contracts.js';

export interface PreviewSurfaceApi {
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
