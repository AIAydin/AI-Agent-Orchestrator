export interface MicrophonePermissionInput {
  readonly permission: string;
  readonly isMainWindow: boolean;
  readonly voiceCommandsEnabled: boolean;
  readonly details: unknown;
  readonly requireAudioDetail: boolean;
}

export function allowsForgeboardMicrophone(input: MicrophonePermissionInput): boolean {
  if (input.permission !== 'media' || !input.isMainWindow || !input.voiceCommandsEnabled) {
    return false;
  }
  if (!input.requireAudioDetail) return true;
  if (
    typeof input.details !== 'object' ||
    input.details === null ||
    !('mediaTypes' in input.details)
  ) {
    return false;
  }
  const mediaTypes = (input.details as { mediaTypes?: unknown }).mediaTypes;
  return (
    Array.isArray(mediaTypes) &&
    mediaTypes.includes('audio') &&
    mediaTypes.every((type) => type === 'audio')
  );
}
