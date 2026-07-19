export type CollaborationTransportEffect =
  | {
      readonly kind: 'document-sync' | 'awareness';
      readonly phase: 'initial' | 'reconnect';
      readonly connectionAttempt: number;
    }
  | {
      readonly kind: 'delivery-confirmation';
      readonly phase: 'initial' | 'retry';
      readonly deliveryId: string;
      readonly attempt: number;
    }
  | {
      readonly kind: 'delivery-settlement';
      readonly disposition: 'acknowledged' | 'rejected';
      readonly deliveryId: string;
    };

/** Synchronous so a missing durable audit prevents the immediately following transport effect. */
export type CollaborationTransportEffectAuthorizer = (effect: CollaborationTransportEffect) => void;
