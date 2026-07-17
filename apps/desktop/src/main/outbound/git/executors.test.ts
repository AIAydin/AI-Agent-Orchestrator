import { describe, expect, it } from 'vitest';

import { ChangeService, RepositoryService } from '@forgeboard/git-engine';

import type { OutboundExecutionPermit } from '../outbound-action-gate.js';
import { PermitBoundGitRemoteOperations } from './executors.js';

describe('permit-bound Git remote operations', () => {
  it('rejects every outbound operation without the gate-issued opaque permit', async () => {
    const repositories = new RepositoryService();
    const operations = new PermitBoundGitRemoteOperations(
      repositories,
      new ChangeService(repositories),
    );
    const invalidPermit = {} as OutboundExecutionPermit;
    await expect(operations.push(invalidPermit, '/not-reached', null as never)).rejects.toThrow(
      /gate-issued permit/u,
    );
    await expect(operations.status(invalidPermit, '/not-reached', null as never)).rejects.toThrow(
      /gate-issued permit/u,
    );
    await expect(
      operations.createPullRequest(invalidPermit, '/not-reached', null as never, null as never),
    ).rejects.toThrow(/gate-issued permit/u);
    await expect(operations.readCiStatus(invalidPermit, null as never)).rejects.toThrow(
      /gate-issued permit/u,
    );
  });
});
