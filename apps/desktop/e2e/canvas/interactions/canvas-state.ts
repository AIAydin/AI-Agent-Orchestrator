import type { Page } from '@playwright/test';

interface IpcResult<T> {
  readonly ok: boolean;
  readonly value?: T;
}

export interface PersistedCanvasState {
  readonly nodes: readonly {
    readonly id: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly data: { readonly locked?: boolean; readonly title?: string };
  }[];
  readonly viewport: {
    readonly x: number;
    readonly y: number;
    readonly zoom: number;
  };
}

export async function readPersistedCanvas(page: Page): Promise<PersistedCanvasState | null> {
  return await page.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        forgeboard: {
          canvas: {
            load: (projectId: string) => Promise<IpcResult<PersistedCanvasState>>;
          };
          projects: {
            recent: () => Promise<IpcResult<readonly { id: string }[]>>;
          };
        };
      }
    ).forgeboard;
    const projects = await api.projects.recent();
    const project = projects.value?.[0];
    if (!projects.ok || project === undefined) return null;
    const canvas = await api.canvas.load(project.id);
    return canvas.ok && canvas.value !== undefined ? canvas.value : null;
  });
}

export async function readRenderedViewport(
  page: Page,
): Promise<{ x: number; y: number; zoom: number }> {
  return await page.locator('.react-flow__viewport').evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}

export function nodeByTitle(state: PersistedCanvasState, title: string) {
  const node = state.nodes.find((candidate) => candidate.data.title === title);
  if (node === undefined) throw new Error(`Persisted canvas node "${title}" was not found.`);
  return node;
}

export function viewportChanged(
  before: PersistedCanvasState['viewport'],
  after: PersistedCanvasState['viewport'] | undefined,
): boolean {
  return (
    after !== undefined &&
    (Math.abs(after.x - before.x) > 0.5 ||
      Math.abs(after.y - before.y) > 0.5 ||
      Math.abs(after.zoom - before.zoom) > 0.001)
  );
}

export function comparableViewport(viewport: PersistedCanvasState['viewport']): {
  x: number;
  y: number;
  zoom: number;
} {
  return {
    x: Number(viewport.x.toFixed(2)),
    y: Number(viewport.y.toFixed(2)),
    zoom: Number(viewport.zoom.toFixed(3)),
  };
}
