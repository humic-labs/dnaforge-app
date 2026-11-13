import { describe, expect, it } from 'vitest';
import { parseWorkspaceSyncStoragePolicy } from './workspace-sync-storage-policy';
import { parseWorkspaceSyncManifest } from './workspace-sync-manifest';

const policy = {
  schemaVersion: 1,
  policyKey: 'lab-expanded',
  revision: 7,
  maxFileBytes: 12 * 1024 ** 3,
  maxProjectBytes: 120 * 1024 ** 3,
  maxFiles: 2000,
  storageQuotaBytes: 240 * 1024 ** 3,
};
const entry = (path: string, sizeBytes: number) => ({
  path,
  sizeBytes,
  contentSha256: 'a'.repeat(64),
  contentType: 'application/octet-stream',
});

describe('backend storage policy contract', () => {
  it('accepts a named allowance larger than the previous fixed limits', () => {
    expect(parseWorkspaceSyncStoragePolicy(policy)).toEqual(policy);
    expect(
      parseWorkspaceSyncManifest(
        { schemaVersion: 1, files: [entry('asset.bin', 8 * 1024 ** 3)] },
        policy
      ).ok
    ).toBe(true);
  });

  it('enforces nondefault file, project and count allowances', () => {
    const small = { ...policy, maxFileBytes: 100, maxProjectBytes: 150, maxFiles: 2 };
    expect(
      parseWorkspaceSyncManifest({ schemaVersion: 1, files: [entry('a.bin', 101)] }, small).ok
    ).toBe(false);
    expect(
      parseWorkspaceSyncManifest(
        { schemaVersion: 1, files: [entry('a.bin', 100), entry('b.bin', 51)] },
        small
      ).ok
    ).toBe(false);
    expect(
      parseWorkspaceSyncManifest(
        { schemaVersion: 1, files: [entry('a.bin', 1), entry('b.bin', 1), entry('c.bin', 1)] },
        small
      ).ok
    ).toBe(false);
  });

  it('keeps historical manifests readable after an allowance is reduced', () => {
    const stored = { schemaVersion: 1, files: [entry('a.bin', 8 * 1024 ** 3)] };
    expect(parseWorkspaceSyncManifest(stored).ok).toBe(true);
    expect(parseWorkspaceSyncManifest(stored, { ...policy, maxFileBytes: 1024 }).ok).toBe(false);
  });

  it.each([
    { maxFileBytes: 0 },
    { maxFileBytes: -1 },
    { maxFileBytes: 1.5 },
    { maxFileBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxProjectBytes: 1 },
    { storageQuotaBytes: 1 },
    { maxFiles: 2001 },
    { revision: 0 },
    { policyKey: '../bad' },
    { schemaVersion: 2 },
    { price: 10 },
  ])('fails closed on an invalid backend policy: %j', (change) => {
    expect(() => parseWorkspaceSyncStoragePolicy({ ...policy, ...change })).toThrow();
  });
});
