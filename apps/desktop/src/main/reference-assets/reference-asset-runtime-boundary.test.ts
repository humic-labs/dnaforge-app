import { describe, expect, it } from 'vitest';

import {
  assertReferenceAssetRuntimeWriteAllowed,
  isPreparedReferenceAssetPath,
  ReferenceAssetRuntimeMutationError,
} from './reference-asset-runtime-boundary';

describe('prepared reference asset runtime boundary', () => {
  it('rejects the singleton cache root and every descendant', () => {
    const referenceAssetCacheRoot =
      '/Users/test/Library/Application Support/DNAForge/reference-assets';

    for (const candidatePath of [
      referenceAssetCacheRoot,
      `${referenceAssetCacheRoot}/grch38`,
      `${referenceAssetCacheRoot}/grch38/generations/current/prepared/chr11`,
    ]) {
      expect(() =>
        assertReferenceAssetRuntimeWriteAllowed({ referenceAssetCacheRoot, candidatePath })
      ).toThrow(ReferenceAssetRuntimeMutationError);
      expect(isPreparedReferenceAssetPath({ referenceAssetCacheRoot, candidatePath })).toBe(true);
    }
  });

  it('allows ordinary workspace caches and separator-safe prefix collisions', () => {
    const referenceAssetCacheRoot = '/Users/test/.config/DNAForge/reference-assets';

    for (const candidatePath of [
      '/Users/test/workspaces/project-a',
      '/Users/test/.config/DNAForge/reference-assets-backup',
    ]) {
      expect(() =>
        assertReferenceAssetRuntimeWriteAllowed({ referenceAssetCacheRoot, candidatePath })
      ).not.toThrow();
      expect(isPreparedReferenceAssetPath({ referenceAssetCacheRoot, candidatePath })).toBe(false);
    }
  });

  it('applies Windows separator and case rules', () => {
    expect(
      isPreparedReferenceAssetPath({
        referenceAssetCacheRoot: 'C:\\Users\\Test\\AppData\\Roaming\\DNAForge\\reference-assets',
        candidatePath:
          'c:\\users\\test\\appdata\\roaming\\dnaforge\\reference-assets\\grch38\\generations\\a',
      })
    ).toBe(true);
  });
});
