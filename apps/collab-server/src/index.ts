import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadCollaborationConfig } from './config.js';
import { CollaborationService } from './server.js';

export * from './config.js';
export * from './metadata.js';
export * from './rate-limit.js';
export * from './server.js';
export * from './store.js';
export * from './tokens.js';
export * from './types.js';

async function main(): Promise<void> {
  const config = loadCollaborationConfig();
  for (const warning of config.warnings) console.warn(`[forgeboard-collab] ${warning}`);
  const service = new CollaborationService(config);
  const address = await service.start();
  console.info(
    `[forgeboard-collab] listening on ${address.httpUrl}; health check: ${address.httpUrl}/healthz`,
  );

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await service.stop();
  };
  process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      `[forgeboard-collab] startup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  });
}
