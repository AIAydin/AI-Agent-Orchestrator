import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type * as Y from 'yjs';

import type { CollaborationAwarenessState } from '../../shared/collaboration/index.js';

export type CollaborationProviderStatus = 'connecting' | 'connected' | 'disconnected';

export interface CollaborationProviderCallbacks {
  readonly onAuthenticated: () => void;
  readonly onAuthenticationFailed: () => void;
  readonly onStatus: (status: CollaborationProviderStatus) => void;
  readonly onSynced: () => void;
  readonly onDisconnect: () => void;
  readonly onAwarenessChange: () => void;
}

export interface CollaborationProviderFactoryInput extends CollaborationProviderCallbacks {
  readonly document: Y.Doc;
  readonly serverUrl: string;
  readonly roomId: string;
  readonly accessToken: string;
  readonly reconnect: boolean;
}

export interface CollaborationProviderHandle {
  readonly document: Y.Doc;
  setLocalAwareness(state: CollaborationAwarenessState): void;
  awarenessStates(): ReadonlyArray<{
    readonly clientId: number;
    readonly state: unknown;
  }>;
  clearCredential(): void;
  destroy(): void;
}

export type CollaborationProviderFactory = (
  input: CollaborationProviderFactoryInput,
) => CollaborationProviderHandle;

export const createHocuspocusCollaborationProvider: CollaborationProviderFactory = (input) => {
  let provider: HocuspocusProvider | undefined;
  provider = new HocuspocusProvider({
    name: input.roomId,
    url: input.serverUrl,
    document: input.document,
    token: input.accessToken,
    onAuthenticated: () => input.onAuthenticated(),
    onAuthenticationFailed: () => input.onAuthenticationFailed(),
    onStatus: ({ status }) => {
      switch (status) {
        case WebSocketStatus.Connecting:
          input.onStatus('connecting');
          break;
        case WebSocketStatus.Connected:
          input.onStatus('connected');
          break;
        case WebSocketStatus.Disconnected:
          input.onStatus('disconnected');
          break;
      }
    },
    onSynced: ({ state }) => {
      if (state) input.onSynced();
    },
    onDisconnect: () => {
      if (!input.reconnect) provider?.disconnect();
      input.onDisconnect();
    },
    onAwarenessChange: () => input.onAwarenessChange(),
  });

  return {
    document: input.document,
    setLocalAwareness: (state) => provider?.awareness?.setLocalState(state),
    awarenessStates: () =>
      provider?.awareness === null || provider?.awareness === undefined
        ? []
        : [...provider.awareness.getStates()].map(([clientId, state]) => ({
            clientId,
            state,
          })),
    clearCredential: () => {
      if (provider !== undefined) provider.configuration.token = null;
    },
    destroy: () => {
      if (provider === undefined) return;
      provider.configuration.token = null;
      provider.destroy();
      provider = undefined;
    },
  };
};
