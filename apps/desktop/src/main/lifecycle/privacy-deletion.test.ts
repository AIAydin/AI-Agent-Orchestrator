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
      'authorize-deletion',
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

  it('fails closed before service reset when the final authorization audit cannot persist', async () => {
    const fixture = createFixture(0, false);
    fixture.coordinator.authorizeDeletion = () => {
      fixture.order.push('authorize-deletion');
      throw new Error('audit unavailable');
    };

    await expect(performPrivacyDeletion(fixture.coordinator)).rejects.toThrow('audit unavailable');

    expect(fixture.order).toEqual(['pause-backups', 'list-missing', 'authorize-deletion']);
    expect(fixture.resetDataServices).not.toHaveBeenCalled();
    expect(fixture.deleteData).not.toHaveBeenCalled();
  });

  it('fails closed before resetting services when authority changes during backup inspection', async () => {
    const fixture = createFixture(0, false);
    let current = true;
    const coordinator = {
      ...fixture.coordinator,
      assertCurrent: () => {
        if (!current) throw new Error('origin changed');
      },
      listMissingBackupIds: () => {
        fixture.order.push('list-missing');
        current = false;
        return Promise.resolve([]);
      },
    };

    await expect(performPrivacyDeletion(coordinator)).rejects.toThrow('origin changed');

    expect(fixture.resetDataServices).not.toHaveBeenCalled();
    expect(fixture.deleteData).not.toHaveBeenCalled();
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
      assertCurrent: () => undefined,
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
      authorizeDeletion: () => {
        order.push('authorize-deletion');
      },
      resetDataServices,
      deleteData,
    },
    confirmForgetMissingBackups,
    deleteData,
    order,
    resetDataServices,
  };
}
