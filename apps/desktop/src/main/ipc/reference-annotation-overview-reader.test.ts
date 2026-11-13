import { describe, expect, it, vi } from 'vitest';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyReferenceAssetGenerationV1,
  IndexedGenomeManifest,
} from '../../shared/indexed-genome';
import {
  annotationOverviewMayBeBuiltAtRuntime,
  readAnnotationOverviewForSession,
} from './reference-annotation-overview-reader';

const MANIFEST: IndexedGenomeManifest = {
  chrom: 'chr1',
  fastaPath: '/cache/generations/a/prepared/chr1/chr1.fa',
  faiPath: '/cache/generations/a/prepared/chr1/chr1.fa.fai',
  gffPath: '/cache/generations/a/prepared/chr1/chr1.gff3.gz',
  tbiPath: '/cache/generations/a/prepared/chr1/chr1.gff3.gz.tbi',
  length: 100,
};
const PREPARED_RESULT = {
  features: [],
  featureModel: 'resolved-transcript-v2',
  cacheState: 'hit',
  sourceRecordCount: 0,
  sourceRepresentationComplete: true,
  layerTypes: [],
} as const;
const ASSET_GENERATION: AssemblyReferenceAssetGenerationV1 = {
  contract: 'assembly-reference-asset-generation.v1',
  sourceFingerprint: 'a'.repeat(24),
  inventoryFingerprint: 'b'.repeat(64),
  themeMode: 'light',
};
const REFERENCE_SESSION = {
  assemblySearchSource: {} as AssemblyAnnotationSceneReadRequest,
  assemblyAssetGeneration: ASSET_GENERATION,
};
const IMPORTED_SEARCH_SESSION = {
  assemblySearchSource: {} as AssemblyAnnotationSceneReadRequest,
};

describe('reference annotation overview runtime ownership', () => {
  it('reads a prepared reference overview without invoking a runtime builder', async () => {
    const readPrepared = vi.fn().mockResolvedValue(PREPARED_RESULT);
    const readOrStart = vi.fn();
    const buildOverviewTile = vi.fn();

    expect(annotationOverviewMayBeBuiltAtRuntime(REFERENCE_SESSION)).toBe(false);
    await expect(
      readAnnotationOverviewForSession(
        { session: REFERENCE_SESSION, manifest: MANIFEST, buildOverviewTile },
        { readPrepared, readOrStart }
      )
    ).resolves.toEqual({ status: 'cached', result: PREPARED_RESULT });
    expect(readOrStart).not.toHaveBeenCalled();
    expect(buildOverviewTile).not.toHaveBeenCalled();
  });

  it('fails closed instead of repairing a missing prepared reference overview', async () => {
    const readOrStart = vi.fn();

    await expect(
      readAnnotationOverviewForSession(
        { session: REFERENCE_SESSION, manifest: MANIFEST, buildOverviewTile: vi.fn() },
        { readPrepared: vi.fn().mockResolvedValue(null), readOrStart }
      )
    ).rejects.toThrow('Required prepared reference annotation overview is unavailable');
    expect(readOrStart).not.toHaveBeenCalled();
  });

  it('also fails closed for prepared internal chromosome sessions without search ownership', async () => {
    const readPrepared = vi.fn().mockResolvedValue(PREPARED_RESULT);
    const readOrStart = vi.fn();
    const session = { assemblyAssetGeneration: ASSET_GENERATION };

    expect(annotationOverviewMayBeBuiltAtRuntime(session)).toBe(false);
    await expect(
      readAnnotationOverviewForSession(
        { session, manifest: MANIFEST, buildOverviewTile: vi.fn() },
        { readPrepared, readOrStart }
      )
    ).resolves.toEqual({ status: 'cached', result: PREPARED_RESULT });
    expect(readOrStart).not.toHaveBeenCalled();
  });

  it('never mutates a reference generation while process-local admission is still pending', async () => {
    const readPrepared = vi.fn().mockResolvedValue(PREPARED_RESULT);
    const readOrStart = vi.fn();
    const session = {
      assemblyAnnotationProductsReadiness: 'pending' as const,
    };

    expect(annotationOverviewMayBeBuiltAtRuntime(session)).toBe(false);
    await expect(
      readAnnotationOverviewForSession(
        { session, manifest: MANIFEST, buildOverviewTile: vi.fn() },
        { readPrepared, readOrStart }
      )
    ).resolves.toEqual({ status: 'cached', result: PREPARED_RESULT });
    expect(readOrStart).not.toHaveBeenCalled();
  });

  it('never mutates an internal reference child before its generation receipt is attached', async () => {
    const readPrepared = vi.fn().mockResolvedValue(PREPARED_RESULT);
    const readOrStart = vi.fn();
    const session = {
      preparedReferenceReadOnly: true as const,
    };

    expect(annotationOverviewMayBeBuiltAtRuntime(session)).toBe(false);
    await expect(
      readAnnotationOverviewForSession(
        { session, manifest: MANIFEST, buildOverviewTile: vi.fn() },
        { readPrepared, readOrStart }
      )
    ).resolves.toEqual({ status: 'cached', result: PREPARED_RESULT });
    expect(readOrStart).not.toHaveBeenCalled();
  });

  it('fails closed for a missing pending-admission reference overview instead of repairing in place', async () => {
    const readOrStart = vi.fn();
    const session = {
      assemblyAnnotationProductsReadiness: 'pending' as const,
    };

    await expect(
      readAnnotationOverviewForSession(
        { session, manifest: MANIFEST, buildOverviewTile: vi.fn() },
        { readPrepared: vi.fn().mockResolvedValue(null), readOrStart }
      )
    ).rejects.toThrow('Required prepared reference annotation overview is unavailable');
    expect(readOrStart).not.toHaveBeenCalled();
  });

  it('retains lazy overview generation for ordinary imported sequences', async () => {
    const lazy = {
      status: 'building',
      completion: Promise.resolve({
        features: [],
        featureModel: 'resolved-transcript-v2',
        cacheState: 'miss',
        sourceRecordCount: 0,
        sourceRepresentationComplete: true,
        layerTypes: [],
      }),
    } as const;
    const readOrStart = vi.fn().mockResolvedValue(lazy);

    expect(annotationOverviewMayBeBuiltAtRuntime(IMPORTED_SEARCH_SESSION)).toBe(true);
    await expect(
      readAnnotationOverviewForSession(
        {
          session: IMPORTED_SEARCH_SESSION,
          manifest: MANIFEST,
          buildOverviewTile: vi.fn(),
        },
        { readPrepared: vi.fn(), readOrStart }
      )
    ).resolves.toEqual(lazy);
    expect(readOrStart).toHaveBeenCalledTimes(1);
  });
});
