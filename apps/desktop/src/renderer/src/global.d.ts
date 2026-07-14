import type { ForgeboardApi } from '../../shared/api.js';

declare global {
  interface Window {
    forgeboard: ForgeboardApi;
  }
}

export {};
