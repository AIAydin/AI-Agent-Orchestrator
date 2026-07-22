import { z } from 'zod';

const BrowserCompanionNodeKeyShape = {
  projectId: z.string().trim().min(1).max(512),
  nodeId: z.string().trim().min(1).max(512),
} as const;

export const BrowserCompanionNodeKeySchema = z.object(BrowserCompanionNodeKeyShape).strict();
export type BrowserCompanionNodeKey = z.infer<typeof BrowserCompanionNodeKeySchema>;

export const BrowserCompanionOpenInputSchema = z
  .object({
    ...BrowserCompanionNodeKeyShape,
    url: z
      .string()
      .url()
      .max(32_768)
      .refine((value) => {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
      }, 'Chrome websites must use HTTPS and cannot contain credentials.'),
  })
  .strict();
export type BrowserCompanionOpenInput = z.infer<typeof BrowserCompanionOpenInputSchema>;

export const BrowserCompanionViewportInputSchema = z
  .object({
    ...BrowserCompanionNodeKeyShape,
    width: z.number().int().min(320).max(2_560),
    height: z.number().int().min(200).max(1_600),
  })
  .strict();
export type BrowserCompanionViewportInput = z.infer<typeof BrowserCompanionViewportInputSchema>;

const BrowserCompanionPointerEventSchema = z
  .object({
    kind: z.literal('pointer'),
    type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']),
    x: z.number().finite().min(0).max(2_560),
    y: z.number().finite().min(0).max(1_600),
    button: z.enum(['none', 'left', 'middle', 'right']),
    buttons: z.number().int().min(0).max(7),
    clickCount: z.number().int().min(0).max(3),
  })
  .strict();

const BrowserCompanionWheelEventSchema = z
  .object({
    kind: z.literal('wheel'),
    x: z.number().finite().min(0).max(2_560),
    y: z.number().finite().min(0).max(1_600),
    deltaX: z.number().finite().min(-4_096).max(4_096),
    deltaY: z.number().finite().min(-4_096).max(4_096),
    modifiers: z.number().int().min(0).max(15),
  })
  .strict();

const BrowserCompanionKeyEventSchema = z
  .object({
    kind: z.literal('key'),
    type: z.enum(['keyDown', 'keyUp']),
    key: z.string().max(64),
    code: z.string().max(64),
    text: z.string().max(16),
    modifiers: z.number().int().min(0).max(15),
    autoRepeat: z.boolean(),
  })
  .strict();

const BrowserCompanionTextEventSchema = z
  .object({
    kind: z.literal('text'),
    text: z.string().min(1).max(16_384),
  })
  .strict();

export const BrowserCompanionInputSchema = z
  .object({
    ...BrowserCompanionNodeKeyShape,
    event: z.discriminatedUnion('kind', [
      BrowserCompanionPointerEventSchema,
      BrowserCompanionWheelEventSchema,
      BrowserCompanionKeyEventSchema,
      BrowserCompanionTextEventSchema,
    ]),
  })
  .strict();
export type BrowserCompanionInput = z.infer<typeof BrowserCompanionInputSchema>;

export const BrowserCompanionNavigationInputSchema = z
  .object({
    ...BrowserCompanionNodeKeyShape,
    action: z.enum(['back', 'forward', 'reload']),
  })
  .strict();
export type BrowserCompanionNavigationInput = z.infer<typeof BrowserCompanionNavigationInputSchema>;

export const BrowserCompanionStatusSchema = z
  .object({
    state: z.enum(['closed', 'launching', 'connected', 'failed', 'unavailable']),
    url: z.string().url().nullable(),
    title: z.string().max(1_024),
    chromeVersion: z.string().max(128).nullable(),
    profilePersisted: z.literal(true),
    error: z.string().max(2_048).nullable(),
  })
  .strict();
export type BrowserCompanionStatus = z.infer<typeof BrowserCompanionStatusSchema>;

export const BrowserCompanionSnapshotSchema = z
  .object({
    mimeType: z.literal('image/png'),
    data: z.string().max(12 * 1_024 * 1_024),
  })
  .strict();
export type BrowserCompanionSnapshot = z.infer<typeof BrowserCompanionSnapshotSchema>;

export const BrowserCompanionFrameRequestSchema = z
  .object({
    ...BrowserCompanionNodeKeyShape,
    afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type BrowserCompanionFrameRequest = z.infer<typeof BrowserCompanionFrameRequestSchema>;

export const BrowserCompanionFrameSchema = z
  .object({
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    mimeType: z.literal('image/jpeg'),
    data: z.string().max(6 * 1_024 * 1_024),
  })
  .strict();
export type BrowserCompanionFrame = z.infer<typeof BrowserCompanionFrameSchema>;

export const BROWSER_COMPANION_IPC_CHANNELS = Object.freeze({
  open: 'browser-companion:open',
  status: 'browser-companion:status',
  focus: 'browser-companion:focus',
  close: 'browser-companion:close',
  clear: 'browser-companion:clear',
  snapshot: 'browser-companion:snapshot',
  frame: 'browser-companion:frame',
  viewport: 'browser-companion:viewport',
  input: 'browser-companion:input',
  navigate: 'browser-companion:navigate',
});
