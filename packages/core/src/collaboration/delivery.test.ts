import { describe, expect, it } from 'vitest';

import {
  CollaborationDeliveryRequestSchema,
  CollaborationDeliveryResponseSchema,
  decodeCollaborationStateVector,
  encodeCollaborationStateVector,
  parseCollaborationDeliveryPayload,
} from './delivery.js';

const DELIVERY_ID = '00000000-0000-4000-8000-000000000010';
describe('collaboration delivery protocol', () => {
  it('round-trips a bounded canonical Yjs state vector', () => {
    const encoded = encodeCollaborationStateVector(new Uint8Array([1, 2, 3, 250]));
    expect([...decodeCollaborationStateVector(encoded)]).toEqual([1, 2, 3, 250]);
    expect(
      CollaborationDeliveryRequestSchema.parse({
        protocol: 'forgeboard.delivery.v1',
        type: 'confirm-delivery',
        deliveryId: DELIVERY_ID,
        stateVector: encoded,
      }),
    ).toMatchObject({ deliveryId: DELIVERY_ID });
  });

  it('rejects non-canonical vectors, unknown fields, and oversized JSON', () => {
    expect(() => decodeCollaborationStateVector('AQID==')).toThrow();
    expect(
      CollaborationDeliveryRequestSchema.safeParse({
        protocol: 'forgeboard.delivery.v1',
        type: 'confirm-delivery',
        deliveryId: DELIVERY_ID,
        stateVector: 'AQID',
        extra: true,
      }).success,
    ).toBe(false);
    expect(() => parseCollaborationDeliveryPayload('x'.repeat(65_537))).toThrow();
  });

  it('keeps acknowledgements and bounded rejection reasons explicit', () => {
    expect(
      CollaborationDeliveryResponseSchema.parse({
        protocol: 'forgeboard.delivery.v1',
        type: 'delivery-acknowledged',
        deliveryId: DELIVERY_ID,
        stateVector: 'AQID',
        persistedAt: '2026-07-15T20:00:00.000Z',
      }).type,
    ).toBe('delivery-acknowledged');
    expect(
      CollaborationDeliveryResponseSchema.parse({
        protocol: 'forgeboard.delivery.v1',
        type: 'delivery-rejected',
        deliveryId: DELIVERY_ID,
        stateVector: 'AQID',
        reason: 'state-not-applied',
      }).type,
    ).toBe('delivery-rejected');
  });
});
