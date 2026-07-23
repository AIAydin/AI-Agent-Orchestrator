import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  BrowserCompanionInput,
  BrowserCompanionNavigationInput,
  BrowserCompanionFrame,
  BrowserCompanionStatus,
} from '../../../../../../shared/browser-companion/contracts.js';
import { unwrap } from '../../../../lib/ipc.js';

const CLOSED_STATUS: BrowserCompanionStatus = {
  state: 'closed',
  url: null,
  title: '',
  chromeVersion: null,
  profilePersisted: true,
  error: null,
};

export function useBrowserCompanion(projectId: string, nodeId: string, active: boolean) {
  const key = { projectId, nodeId };
  const [status, setStatus] = useState<BrowserCompanionStatus>(CLOSED_STATUS);
  const [snapshot, setSnapshot] = useState<BrowserCompanionFrame | null>(null);
  const [busy, setBusy] = useState(false);
  const framePending = useRef(false);
  const frameSequence = useRef(0);
  const connected = useRef(false);

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!active || typeof window === 'undefined' || !window.forgeboard) return;
    try {
      const next = unwrap(await window.forgeboard.browserCompanion.status(key));
      connected.current = next.state === 'connected';
      setStatus(next);
      if (next.state !== 'connected') {
        frameSequence.current = 0;
        setSnapshot(null);
      }
    } catch (error) {
      setStatus({
        ...CLOSED_STATUS,
        state: 'failed',
        error: error instanceof Error ? error.message : 'Could not connect to Google Chrome.',
      });
      connected.current = false;
    }
  }, [active, projectId, nodeId]);

  const refreshFrame = useCallback(async (): Promise<void> => {
    if (
      !active ||
      !connected.current ||
      framePending.current ||
      typeof window === 'undefined' ||
      !window.forgeboard
    )
      return;
    framePending.current = true;
    try {
      const next = unwrap(
        await window.forgeboard.browserCompanion.frame({
          ...key,
          afterSequence: frameSequence.current,
        }),
      );
      if (next !== null) {
        frameSequence.current = next.sequence;
        setSnapshot(next);
      }
    } catch {
      // Status polling reports a stable error. A single dropped frame should
      // not replace the last usable image or interrupt pointer input.
    } finally {
      framePending.current = false;
    }
  }, [active, projectId, nodeId]);

  useEffect(() => {
    if (!active) {
      connected.current = false;
      frameSequence.current = 0;
      setStatus(CLOSED_STATUS);
      setSnapshot(null);
      return;
    }
    void refreshStatus();
    void refreshFrame();
    const statusTimer = window.setInterval(() => void refreshStatus(), 1_500);
    const frameTimer = window.setInterval(() => void refreshFrame(), 50);
    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(frameTimer);
    };
  }, [active, refreshFrame, refreshStatus]);

  const perform = useCallback(
    async (operation: () => Promise<BrowserCompanionStatus>): Promise<void> => {
      setBusy(true);
      try {
        setStatus(await operation());
        await refreshStatus();
        await refreshFrame();
      } catch (error) {
        setStatus({
          ...CLOSED_STATUS,
          state: 'failed',
          error: error instanceof Error ? error.message : 'Google Chrome operation failed.',
        });
      } finally {
        setBusy(false);
      }
    },
    [refreshFrame, refreshStatus],
  );

  const send = useCallback(
    async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch {
        await refreshStatus();
      }
    },
    [refreshStatus],
  );

  return {
    status,
    snapshot,
    busy,
    open: async (url: string) =>
      await perform(async () =>
        unwrap(await window.forgeboard.browserCompanion.open({ ...key, url })),
      ),
    focus: async () =>
      await perform(async () => unwrap(await window.forgeboard.browserCompanion.focus(key))),
    close: async () =>
      await perform(async () => unwrap(await window.forgeboard.browserCompanion.close(key))),
    clear: async () =>
      await perform(async () => unwrap(await window.forgeboard.browserCompanion.clear(key))),
    setViewport: async (width: number, height: number) =>
      await send(async () =>
        unwrap(
          await window.forgeboard.browserCompanion.setViewport({
            ...key,
            width,
            height,
          }),
        ),
      ),
    dispatchInput: async (event: BrowserCompanionInput['event']) =>
      await send(async () =>
        unwrap(
          await window.forgeboard.browserCompanion.dispatchInput({
            ...key,
            event,
          }),
        ),
      ),
    navigate: async (action: BrowserCompanionNavigationInput['action']) =>
      await send(async () =>
        unwrap(await window.forgeboard.browserCompanion.navigate({ ...key, action })),
      ),
  };
}
