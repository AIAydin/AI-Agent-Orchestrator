import {
  CollaborationStateVectorSchema,
  MAX_COLLABORATION_STATE_VECTOR_BYTES,
} from './delivery-contracts.js';

export function encodeCollaborationStateVector(stateVector: Uint8Array): string {
  if (
    stateVector.byteLength === 0 ||
    stateVector.byteLength > MAX_COLLABORATION_STATE_VECTOR_BYTES
  ) {
    throw new Error('The collaboration state vector is outside the supported bounds.');
  }
  return Buffer.from(stateVector).toString('base64url');
}

export function decodeCollaborationStateVector(encoded: string): Uint8Array {
  const parsed = CollaborationStateVectorSchema.parse(encoded);
  const stateVector = Buffer.from(parsed, 'base64url');
  if (
    stateVector.byteLength === 0 ||
    stateVector.byteLength > MAX_COLLABORATION_STATE_VECTOR_BYTES ||
    stateVector.toString('base64url') !== parsed
  ) {
    throw new Error('The collaboration state vector is not canonical.');
  }
  return new Uint8Array(stateVector);
}
