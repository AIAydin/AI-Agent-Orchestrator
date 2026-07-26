import type { IpcMainInvokeEvent } from 'electron';

/** Rejects destroyed renderers and every frame except the active Artemis main frame. */
export function assertLiveMainFrame(
  event: IpcMainInvokeEvent,
  operation = 'Artemis request',
): void {
  if (
    event.sender.isDestroyed() ||
    event.senderFrame === null ||
    event.senderFrame.detached === true ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error(`${operation} requires the active Artemis main frame.`);
  }
}
