import { describe, expect, it, vi } from 'vitest';

import { performPrivacyDeletion } from './privacy-deletion.js';

describe('performPrivacyDeletion', () => {
  it('leaves services and storage untouched when missing-backup approval is cancelled', async () => {
    const fixture = createFixture(2, false);

    await expect(performPrivacyDeletion(fixture.coordinator)).resolves.toBe(false);

    expect(fixture.order).toEqual(['pause-backups', 'list-missing', 'confirm:2']);
    expect(fixture.resetDataServices).not.toHaveBeenCalled();
    expect(fixture.deleteData).not.toHaveBeenCalled();
  });

  it('resets services only after approval and explicitly forgets the missing records', async () => {
    const fixture = createFixture(1, true);

    await expect(performPrivacyDeletion(fixture.coordinator)).resolves.toBe(true);

    expect(fixture.order).toEqual([
      'pause-backups',
      'list-missing',
      'confirm:1',
      'reset-services',
      'delete:missing-1',
    ]);
    expect(fixture.deleteData).toHaveBeenCalledWith(['missing-1']);
  });

  it('skips the extra warning when every recorded backup is available', async () => {
    const fixture = createFixture(0, false);

    await expect(performPrivacyDeletion(fixture.coordinator)).resolves.toBe(true);

    expect(fixture.confirmForgetMissingBackups).not.toHaveBeenCalled();
    expect(fixture.deleteData).toHaveBeenCalledWith([]);
  });
});

function createFixture(missingBackupCount: number, confirmMissing: boolean) {
  const order: string[] = [];
  const resetDataServices = vi.fn(() => {
    order.push('reset-services');
    return Promise.resolve();
  });
  const deleteData = vi.fn((approvedMissingBackupIds: string[]) => {
    order.push(`delete:${approvedMissingBackupIds.join(',')}`);
    return Promise.resolve();
  });
  const confirmForgetMissingBackups = vi.fn((count: number) => {
    order.push(`confirm:${String(count)}`);
    return Promise.resolve(confirmMissing);
  });
  return {
    coordinator: {
      pauseBackups: () => {
        order.push('pause-backups');
        return Promise.resolve();
      },
      listMissingBackupIds: () => {
        order.push('list-missing');
        return Promise.resolve(
          Array.from({ length: missingBackupCount }, (_, index) => `missing-${String(index + 1)}`),
        );
      },
      confirmForgetMissingBackups,
      resetDataServices,
      deleteData,
    },
    confirmForgetMissingBackups,
    deleteData,
    order,
    resetDataServices,
  };
}
