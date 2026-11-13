import { describe, expect, it, vi } from 'vitest';
import type { GenomeAssembly } from '@waypoint/genome-data';

import {
  prepareCurrentAssemblyAnnotationProductSet,
  preparePortableAssemblyAnnotationProductSet,
} from './prepareAssemblyAnnotationProductSet';

const { readInventory } = vi.hoisted(() => ({ readInventory: vi.fn() }));
vi.mock('../../platform', () => ({
  platform: () => ({ genome: { readAssemblyAnnotationProductSetInventoryV1: readInventory } }),
}));

const assembly: GenomeAssembly = {
  assemblyId: 'assembly-test',
  displayName: 'Assembly Test',
  chromosomes: [
    {
      chrom: 'chr1',
      displayName: 'chr1',
      length: 1_000,
      manifest: {
        chrom: 'chr1',
        fastaPath: '/workspace/chr1.fa',
        faiPath: '/workspace/chr1.fa.fai',
        gffPath: '/workspace/chr1.gff3.gz',
        tbiPath: '/workspace/chr1.gff3.gz.tbi',
        length: 1_000,
      },
    },
  ],
};

const generation = {
  contract: 'assembly-reference-asset-generation.v1' as const,
  sourceFingerprint: 'a'.repeat(64),
  inventoryFingerprint: 'b'.repeat(64),
  themeMode: 'light' as const,
};

describe('portable assembly capability projection', () => {
  it('carries exact source authority when detail is ready even while search remains pending', async () => {
    const result = await preparePortableAssemblyAnnotationProductSet(assembly, {
      workspaceRoot: '/workspace',
      themeMode: 'light',
      policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 2 },
      trackTypes: ['enhancer', 'mRNA'],
      datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
      annotationAssetGeneration: generation,
      searchReady: false,
    });

    expect(result).toMatchObject({
      annotationProductsReadiness: 'ready',
      searchReadiness: 'pending',
      generation,
      searchSource: {
        assemblyId: 'assembly-test',
        workspaceRoot: '/workspace',
        datasetContract: {
          datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
        },
        artifact: { themeMode: 'light', trackType: 'mRNA' },
      },
    });
  });
});

describe('opening a published reference', () => {
  it('names the published generation so main confirms it from the commit record', async () => {
    readInventory.mockResolvedValue({
      status: 'ready',
      sourceFingerprint: generation.sourceFingerprint,
      inventoryFingerprint: generation.inventoryFingerprint,
      trackTypes: ['mRNA'],
    });

    await prepareCurrentAssemblyAnnotationProductSet(assembly, {
      workspaceRoot: '/workspace',
      themeMode: 'light',
      policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: 2 },
      expectedGeneration: {
        sourceFingerprint: generation.sourceFingerprint,
        inventoryFingerprint: generation.inventoryFingerprint,
      },
    });

    expect(readInventory).toHaveBeenCalledWith({
      seedProduct: expect.objectContaining({ expectedAssetGeneration: generation }),
    });
  });
});
