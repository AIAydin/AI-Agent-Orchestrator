import { z } from 'zod';

import {
  CanvasDocumentSchema,
  CanvasEdgeSchema,
  CanvasNodeSchema,
} from '../../application/contracts.js';

export const CANVAS_HISTORY_LIMIT = 50;
export const CANVAS_HISTORY_MAX_BYTES = 16 * 1024 * 1024;

export const CanvasHistoryGraphSchema = z
  .object({
    nodes: z.array(CanvasNodeSchema),
    edges: z.array(CanvasEdgeSchema),
  })
  .strict();
export type CanvasHistoryGraph = z.infer<typeof CanvasHistoryGraphSchema>;

export const CanvasHistoryStateSchema = z
  .object({
    projectId: z.string().uuid(),
    canvasId: z.string().uuid(),
    past: z.array(CanvasHistoryGraphSchema).max(CANVAS_HISTORY_LIMIT),
    future: z.array(CanvasHistoryGraphSchema).max(CANVAS_HISTORY_LIMIT),
  })
  .strict();
export type CanvasHistoryState = z.infer<typeof CanvasHistoryStateSchema>;

export function fitCanvasHistory(state: CanvasHistoryState): CanvasHistoryState {
  const fitted = {
    ...state,
    past: state.past.slice(-CANVAS_HISTORY_LIMIT),
    future: state.future.slice(0, CANVAS_HISTORY_LIMIT),
  };
  while (new TextEncoder().encode(JSON.stringify(fitted)).byteLength > CANVAS_HISTORY_MAX_BYTES) {
    if (fitted.past.length >= fitted.future.length && fitted.past.length > 0) {
      fitted.past = fitted.past.slice(1);
    } else if (fitted.future.length > 0) {
      fitted.future = fitted.future.slice(0, -1);
    } else {
      break;
    }
  }
  return CanvasHistoryStateSchema.parse(fitted);
}

export const CanvasHistorySaveInputSchema = z
  .object({
    document: CanvasDocumentSchema,
    history: CanvasHistoryStateSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.history.projectId !== input.document.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Canvas history project does not match the document.',
        path: ['history', 'projectId'],
      });
    }
    if (input.history.canvasId !== input.document.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Canvas history canvas does not match the document.',
        path: ['history', 'canvasId'],
      });
    }
  });
export type CanvasHistorySaveInput = z.infer<typeof CanvasHistorySaveInputSchema>;

export const CanvasWorkspaceStateSchema = z
  .object({
    document: CanvasDocumentSchema,
    history: CanvasHistoryStateSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.history.projectId !== state.document.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Loaded canvas history project does not match the document.',
        path: ['history', 'projectId'],
      });
    }
    if (state.history.canvasId !== state.document.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Loaded canvas history canvas does not match the document.',
        path: ['history', 'canvasId'],
      });
    }
  });
export type CanvasWorkspaceState = z.infer<typeof CanvasWorkspaceStateSchema>;

export function emptyCanvasHistory(projectId: string, canvasId: string): CanvasHistoryState {
  return CanvasHistoryStateSchema.parse({ projectId, canvasId, past: [], future: [] });
}
