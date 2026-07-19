import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type {
  PreviewConsoleView,
  PreviewSurfaceBounds,
  PreviewSurfaceView,
} from '../../../../../shared/preview/surface/contracts.js';
import type { PreviewRendererOperations } from './operations.js';

interface UsePreviewSurfaceInput {
  operations: PreviewRendererOperations;
  projectId: string;
  nodeId: string;
  slot?: 'comparison-left' | 'comparison-right';
  url: string;
  touchEmulation: boolean;
  hostRef: RefObject<HTMLElement | null>;
}

export function usePreviewSurface({
  operations,
  projectId,
  nodeId,
  slot,
  url,
  touchEmulation,
  hostRef,
}: UsePreviewSurfaceInput) {
  const [surface, setSurface] = useState<PreviewSurfaceView | null>(null);
  const [consoleView, setConsoleView] = useState<PreviewConsoleView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const surfaceRef = useRef<PreviewSurfaceView | null>(null);

  const refreshConsole = useCallback(
    async (surfaceId: string) => {
      try {
        setConsoleView(await operations.getSurfaceConsole({ surfaceId }));
      } catch (cause) {
        setFailure(errorMessage(cause, 'Could not load the browser console output.'));
      }
    },
    [operations],
  );

  useEffect(() => {
    let active = true;
    let createdId: string | null = null;
    let frame = 0;
    let observer: ResizeObserver | null = null;
    let updateBounds: (() => void) | null = null;

    async function create() {
      const host = hostRef.current;
      if (!host) return;
      const bounds = elementBounds(host);
      try {
        const created = await operations.createSurface({
          projectId,
          nodeId,
          ...(slot === undefined ? {} : { slot }),
          url,
          bounds,
          touchEmulation,
        });
        createdId = created.surfaceId;
        if (!active) {
          await operations.closeSurface({ surfaceId: created.surfaceId }).catch(() => false);
          return;
        }
        surfaceRef.current = created;
        setSurface(created);
        setFailure(created.failure);
        await refreshConsole(created.surfaceId);

        updateBounds = () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            if (!active || !createdId || !hostRef.current) return;
            void operations
              .setSurfaceBounds({
                surfaceId: createdId,
                bounds: elementBounds(hostRef.current),
              })
              .then((next) => {
                if (active) setSurfaceView(next);
              })
              .catch((cause: unknown) => {
                if (active) setFailure(errorMessage(cause, 'Could not resize the preview.'));
              });
          });
        };
        observer = new ResizeObserver(updateBounds);
        observer.observe(host);
        window.addEventListener('resize', updateBounds);
        window.addEventListener('scroll', updateBounds, true);
      } catch (cause) {
        if (active) setFailure(errorMessage(cause, 'Could not open the preview.'));
      }
    }

    function setSurfaceView(next: PreviewSurfaceView) {
      surfaceRef.current = next;
      setSurface(next);
      setFailure(next.failure);
    }

    void create();
    return () => {
      active = false;
      observer?.disconnect();
      if (updateBounds) {
        window.removeEventListener('resize', updateBounds);
        window.removeEventListener('scroll', updateBounds, true);
      }
      cancelAnimationFrame(frame);
      const currentId = createdId ?? surfaceRef.current?.surfaceId;
      surfaceRef.current = null;
      if (currentId) {
        void operations.closeSurface({ surfaceId: currentId }).catch(() => false);
      }
    };
  }, [
    generation,
    hostRef,
    nodeId,
    operations,
    projectId,
    refreshConsole,
    slot,
    touchEmulation,
    url,
  ]);

  useEffect(
    () =>
      operations.onSurfaceEvent((event) => {
        const current = surfaceRef.current;
        if (!current) return;
        if (event.type === 'changed' && event.surface.surfaceId === current.surfaceId) {
          surfaceRef.current = event.surface;
          setSurface(event.surface);
          setFailure(event.surface.failure);
        } else if (event.type === 'console' && event.surfaceId === current.surfaceId) {
          void refreshConsole(current.surfaceId);
        }
      }),
    [operations, refreshConsole],
  );

  return {
    surface,
    consoleView,
    failure,
    retry: () => {
      setFailure(null);
      setGeneration((value) => value + 1);
    },
    async navigate(nextUrl: string) {
      if (!surface) return;
      const next = await operations.navigateSurface({
        surfaceId: surface.surfaceId,
        url: nextUrl,
      });
      surfaceRef.current = next;
      setSurface(next);
    },
    async reload() {
      if (!surface) return;
      const next = await operations.reloadSurface({
        surfaceId: surface.surfaceId,
      });
      surfaceRef.current = next;
      setSurface(next);
    },
    async history(direction: 'back' | 'forward') {
      if (!surface) return;
      const next = await operations.navigateSurfaceHistory({
        surfaceId: surface.surfaceId,
        direction,
      });
      surfaceRef.current = next;
      setSurface(next);
    },
    async screenshot() {
      if (!surface) return null;
      return operations.saveSurfaceScreenshot({ surfaceId: surface.surfaceId });
    },
    async openExternal() {
      if (!surface) return false;
      return operations.openSurfaceExternally({ surfaceId: surface.surfaceId });
    },
  };
}

export function elementBounds(element: HTMLElement): PreviewSurfaceBounds {
  const rect = element.getBoundingClientRect();
  const stageRect = element.closest<HTMLElement>('.preview-device-stage')?.getBoundingClientRect();
  const clip = stageRect ?? {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  const x = Math.max(rect.left, clip.left, 0);
  const y = Math.max(rect.top, clip.top, 0);
  const right = Math.min(rect.right, clip.right, window.innerWidth);
  const bottom = Math.min(rect.bottom, clip.bottom, window.innerHeight);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 64 || height < 64) {
    return {
      x: clamp(Math.round(x), 0, 32_768),
      y: clamp(Math.round(y), 0, 32_768),
      width: 64,
      height: 64,
      visible: false,
    };
  }
  return {
    x: clamp(Math.round(x), 0, 32_768),
    y: clamp(Math.round(y), 0, 32_768),
    width: clamp(width, 64, 8_192),
    height: clamp(height, 64, 8_192),
    visible: true,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
