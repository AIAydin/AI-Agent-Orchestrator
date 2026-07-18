import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import type { CollaborationAwarenessState } from '../../shared/collaboration/index.js';

export type CollaborationProviderStatus = 'connecting' | 'connected' | 'disconnected';

export interface CollaborationProviderCallbacks {
  readonly onAuthenticated: () => void;
  readonly onAuthenticationFailed: () => void;
  readonly onStatus: (status: CollaborationProviderStatus) => void;
  readonly onSynced: () => void;
  readonly onDisconnect: () => void;
  readonly onAwarenessChange: () => void;
  readonly onStateless: (payload: string) => void;
}

export interface CollaborationProviderFactoryInput extends CollaborationProviderCallbacks {
  readonly document: Y.Doc;
  readonly serverUrl: string;
  readonly roomId: string;
  readonly accessToken: string;
  readonly reconnect: boolean;
  readonly initialAwareness: CollaborationAwarenessState;
}

export interface CollaborationProviderHandle {
  readonly document: Y.Doc;
  setLocalAwareness(state: CollaborationAwarenessState): void;
  awarenessStates(): ReadonlyArray<{
    readonly clientId: number;
    readonly state: unknown;
  }>;
  sendStateless(payload: string): void;
  replaceCredential(accessToken: string): void;
  clearCredential(): void;
  destroy(): void;
}

export type CollaborationProviderFactory = (
  input: CollaborationProviderFactoryInput,
) => CollaborationProviderHandle;

export const createHocuspocusCollaborationProvider: CollaborationProviderFactory = (input) => {
  const awareness = new Awareness(input.document);
  awareness.setLocalState(input.initialAwareness);
  let provider: HocuspocusProvider | undefined;
  provider = new HocuspocusProvider({
    name: input.roomId,
    url: input.serverUrl,
    document: input.document,
    awareness,
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
    onStateless: ({ payload }) => input.onStateless(payload),
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
    sendStateless: (payload) => provider?.sendStateless(payload),
    replaceCredential: (accessToken) => {
      if (provider === undefined) throw new Error('The collaboration provider is unavailable.');
      provider.configuration.token = accessToken;
    },
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
