// @vitest-environment node
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '@waypoint/platform/node-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkMigrationStorageGate } from './disk-space';

const destination = '/requested/migration/destination';
const estimate = {
  compressedArchiveBytes: 8 * 1024 ** 3,
  declaredUncompressedBytes: 8 * 1024 ** 3,
  projectedObjectBytes: 0,
  largestTemporaryBytes: 0,
};
const capacity: storage.StorageCapacity = {
  destinationPath: destination,
  totalBytes: 3996329328640,
  freeBytes: 2336145408,
  importantBytes: 789331063752,
  opportunisticBytes: 48239351818,
  availableBytes: 789331063752,
  source: 'macos-important-usage',
  purpose: 'important',
};

afterEach(() => vi.restoreAllMocks());

describe('migration destination capacity', () => {
  it('admits a requested migration using reclaimable capacity, not raw free bytes', async () => {
    const query = vi.spyOn(storage, 'readStorageCapacity').mockResolvedValue(capacity);
    const gate = await checkMigrationStorageGate(destination, estimate);
    expect(query).toHaveBeenCalledExactlyOnceWith(destination, { purpose: 'important' });
    expect(gate).toMatchObject({
      allowed: true,
      availableBytes: 789331063752,
      immediatelyFreeBytes: 2336145408,
      capacitySource: 'macos-important-usage',
      issue: null,
    });
    expect(gate.requiredBytes).toBeGreaterThan(capacity.freeBytes);
  });

  it('keeps genuine insufficient requested-work capacity and its source distinct', async () => {
    vi.spyOn(storage, 'readStorageCapacity').mockResolvedValue({ ...capacity, availableBytes: 1 });
    const gate = await checkMigrationStorageGate(destination, estimate);
    expect(gate.allowed).toBe(false);
    expect(gate.issue?.details).toMatchObject({
      availableBytes: 1,
      immediatelyFreeBytes: 2336145408,
      capacitySource: 'macos-important-usage',
    });
  });

  it('propagates unknown capacity without falsely diagnosing insufficient storage', async () => {
    const unknown = Object.assign(new Error('Available storage capacity is unknown.'), {
      code: 'STORAGE_CAPACITY_UNKNOWN',
    });
    vi.spyOn(storage, 'readStorageCapacity').mockRejectedValue(unknown);
    await expect(checkMigrationStorageGate(destination, estimate)).rejects.toBe(unknown);
  });

  it('queries a real local destination through the application adapter', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'migration-capacity-')));
    try {
      const gate = await checkMigrationStorageGate(root, {
        compressedArchiveBytes: 0,
        declaredUncompressedBytes: 0,
        projectedObjectBytes: 0,
        largestTemporaryBytes: 0,
        minimumSafetyMarginBytes: 0,
      });
      expect(gate.allowed).toBe(true);
      expect(gate.capacitySource).toBe(
        process.platform === 'darwin' ? 'macos-important-usage' : 'filesystem-available'
      );
      expect(Number.isSafeInteger(gate.availableBytes)).toBe(true);
    } catch (error) {
      expect(process.platform).toBe('darwin');
      expect(error).toMatchObject({
        code: 'STORAGE_CAPACITY_UNKNOWN',
        cause: { code: 'ETIMEDOUT' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});
