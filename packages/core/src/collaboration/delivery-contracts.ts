import { z } from 'zod';

export const COLLABORATION_DELIVERY_PROTOCOL = 'forgeboard.delivery.v1' as const;
export const MAX_COLLABORATION_STATE_VECTOR_BYTES = 32_768;

const DeliveryIdSchema = z.string().uuid();
const SnapshotDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CollaborationStateVectorSchema = z
  .string()
  .min(1)
  .max(Math.ceil((MAX_COLLABORATION_STATE_VECTOR_BYTES * 4) / 3) + 8)
  .regex(/^[A-Za-z0-9_-]+$/);

export const CollaborationDeliveryRequestSchema = z
  .object({
    protocol: z.literal(COLLABORATION_DELIVERY_PROTOCOL),
    type: z.literal('confirm-delivery'),
    deliveryId: DeliveryIdSchema,
    stateVector: CollaborationStateVectorSchema,
  })
  .strict();
export type CollaborationDeliveryRequest = z.infer<typeof CollaborationDeliveryRequestSchema>;

export const CollaborationDeliveryAcknowledgementSchema = z
  .object({
    protocol: z.literal(COLLABORATION_DELIVERY_PROTOCOL),
    type: z.literal('delivery-acknowledged'),
    deliveryId: DeliveryIdSchema,
    stateVector: CollaborationStateVectorSchema,
    persistedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type CollaborationDeliveryAcknowledgement = z.infer<
  typeof CollaborationDeliveryAcknowledgementSchema
>;

export const CollaborationDeliveryRejectionSchema = z
  .object({
    protocol: z.literal(COLLABORATION_DELIVERY_PROTOCOL),
    type: z.literal('delivery-rejected'),
    deliveryId: DeliveryIdSchema,
    stateVector: CollaborationStateVectorSchema,
    reason: z.enum([
      'invalid-request',
      'not-authorized',
      'state-not-applied',
      'document-too-large',
    ]),
  })
  .strict();
export type CollaborationDeliveryRejection = z.infer<typeof CollaborationDeliveryRejectionSchema>;

export const CollaborationDeliveryResponseSchema = z.discriminatedUnion('type', [
  CollaborationDeliveryAcknowledgementSchema,
  CollaborationDeliveryRejectionSchema,
]);
export type CollaborationDeliveryResponse = z.infer<typeof CollaborationDeliveryResponseSchema>;

export const CollaborationPublishReceiptSchema = z
  .object({
    deliveryId: DeliveryIdSchema,
    snapshotDigest: SnapshotDigestSchema,
    disposition: z.enum(['sent', 'queued-offline']),
  })
  .strict();
export type CollaborationPublishReceipt = z.infer<typeof CollaborationPublishReceiptSchema>;

export function parseCollaborationDeliveryPayload(payload: string): unknown {
  if (new TextEncoder().encode(payload).byteLength > 65_536) {
    throw new Error('The collaboration delivery payload is too large.');
  }
  return JSON.parse(payload) as unknown;
}
