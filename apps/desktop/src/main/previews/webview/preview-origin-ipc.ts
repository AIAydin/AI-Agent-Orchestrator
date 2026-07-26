import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  IPC_CHANNELS,
  PreviewSetAllowedOriginInputSchema,
  type IpcResult,
} from '../../../shared/application/contracts.js';
import { previewWebviewPartition } from '../../../shared/preview/webview-partition.js';
import type { PreviewOriginRegistry } from './preview-origin-registry.js';

interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void;
}

/**
 * Registers the `previews:set-allowed-origin` IPC handler: the renderer's
 * only way to tell the main process which external origin (if any) a preview
 * node's guest webview should be pinned/relaxed to. The partition is always
 * reconstructed here from the validated `projectId`/`nodeId`/`slot` via the
 * same `previewWebviewPartition` helper the renderer uses to set the
 * `<webview partition>` attribute, so the two can never drift apart.
 */
export function registerPreviewOriginIpc(ipc: IpcMainLike, registry: PreviewOriginRegistry): void {
  ipc.handle(IPC_CHANNELS.previewsSetAllowedOrigin, (event, rawInput): IpcResult<null> => {
    try {
      // Mirrors the other preview IPC handlers' trust boundary: only the live
      // main frame of a Artemis window may register an allowed origin.
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Preview origin registration requires the active Artemis main frame.');
      }
      const input = PreviewSetAllowedOriginInputSchema.parse(rawInput);
      const origin = validatedAllowedOrigin(input.origin);
      const partition = previewWebviewPartition(
        input.projectId,
        input.nodeId,
        input.slot,
        input.authenticationEnabled,
      );
      registry.setConfiguration(
        partition,
        input.active ? { origin, authenticationEnabled: input.authenticationEnabled } : null,
      );
      return { ok: true, value: null };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof z.ZodError ? 'INVALID_REQUEST' : 'OPERATION_FAILED',
          message:
            error instanceof Error ? error.message : 'Could not register the preview origin.',
        },
      };
    }
  });
}

function validatedAllowedOrigin(candidate: string | null): string | null {
  if (candidate === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Preview origin must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Preview origin must use HTTP or HTTPS.');
  }
  if (parsed.origin !== candidate) {
    throw new Error('Preview origin must be a bare origin (scheme://host[:port]) with no path.');
  }
  return parsed.origin;
}
