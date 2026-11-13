import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compilePackedTranscriptBroadSurfaceRgba8V1,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  projectAnnotationPolicyV1,
  unpackPartitionedTranscriptSceneBinaryV4,
  type Feature,
  type PackedPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';
import type { ResolvedTranscript } from '@waypoint/genome-data';
import { mergeFeatureCacheFragmentsV1 } from './assembly-feature-fragment-pool';
import {
  writeAssemblyOverviewFeaturesCache,
  writeAssemblyOverviewFeaturesCacheFromFragmentsV1,
} from './assembly-overview-features-cache';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneMissResult,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  compileAndPublishBroadRasterArtifactForPackedScene,
  compileAndCommitExpandedAnnotationSceneWorkerJob,
  compileAndCommitExpandedAnnotationSceneWorkerSetJob,
  compileExpandedAnnotationSceneEnvelope,
  createAuthorizedExpandedAnnotationSourcePathGuard,
  readExpandedAnnotationSceneTrackInventoryWorkerJob,
  buildFeatureCacheFragmentsV1,
  type ExpandedAnnotationSceneWorkerJob,
} from './assembly-expanded-annotation-scene-compiler';
import { ASSEMBLY_FEATURES_CACHE_VERSION } from './assembly-overview-features-cache';
import {
  annotationSceneCompilerContractFingerprint,
  computeAssemblyAnnotationSceneSourceFingerprint,
  writeAssemblyAnnotationSceneCache,
} from './assembly-overview-texture-cache';
import {
  COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1,
  openCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterSourceCellV1,
} from './compiled-broad-raster-artifact';

type ExpandedCompilerDeps = Parameters<typeof compileAndCommitExpandedAnnotationSceneWorkerJob>[1];

const CHROMS = [
  { chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 1_000 },
  { chrom: 'chrX', sourcePath: '/ws/chrX.gff3.gz', length: 1_000 },
  { chrom: 'chrY', sourcePath: '/ws/chrY.gff3.gz', length: 1_000 },
];
const SOURCE_SHA = 'a'.repeat(64);
const REQUEST: AssemblyAnnotationSceneReadRequest = {
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyId: 'grch-test',
  workspaceRoot: '/ws',
  chromosomes: CHROMS,
  scope: {
    kind: 'complete-assembly',
    placements: CHROMS.map((chromosome) => ({
      chrom: chromosome.chrom,
      length: chromosome.length,
      annotationCoverage: 'sourced',
    })),
  },
  datasetContract: {
    datasetId: 'waypoint:assembly-annotation:grch-test',
    datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
    sourceSha256: SOURCE_SHA,
  },
  artifact: {
    artifactKey: assemblyAnnotationSceneArtifactKey({
      themeMode: 'light',
      trackType: 'mRNA',
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    }),
    themeMode: 'light',
    trackType: 'mRNA',
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  },
  requestedPolicy: { isoformMode: 'expanded', laneLimit: 2 },
};
const AUTHORIZED_MISS: AssemblyAnnotationSceneMissResult = {
  status: 'miss',
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  fingerprint: 'b'.repeat(24),
  sourceBuildFingerprint: 'c'.repeat(64),
};
const FEATURES_MANIFEST = {
  version: ASSEMBLY_FEATURES_CACHE_VERSION,
  assemblyId: REQUEST.assemblyId,
  fingerprint: 'd'.repeat(24),
  cacheContractToken: 'features-contract',
  mode: 'expanded',
  featureCount: 6,
};

function rasterPublicationDeps() {
  return {
    publishBroadRaster: async (input: {
      cells:
        | AsyncIterable<CompiledBroadRasterSourceCellV1>
        | Iterable<CompiledBroadRasterSourceCellV1>;
    }): Promise<{ catalogFingerprint: string }> => {
      for await (const _cell of input.cells) {
        continue;
      }
      return { catalogFingerprint: 'e'.repeat(64) };
    },
  };
}

function transcript(input: {
  id: number;
  start: number;
  end: number;
  sourceId: string;
  transcriptId: string;
  geneId?: string;
  primary?: boolean;
}): Feature {
  return {
    id: input.id,
    type: 'mRNA',
    annotationTrackId: 'mRNA',
    annotationTrackLane: 0,
    start: input.start,
    end: input.end,
    direction: 'forward',
    displayName: input.transcriptId,
    color: 0x336699,
    lane: 0,
    exons: [
      { start: input.start + 1, end: input.start + 40 },
      { start: input.end - 49, end: input.end },
    ],
    cds: [{ start: input.start + 20, end: input.end - 20 }],
    transcriptId: input.transcriptId,
    qualifiers: {
      ID: input.sourceId,
      Name: input.transcriptId,
      ...(input.geneId ? { gene: input.geneId } : {}),
      ...(input.primary ? { tag: 'MANE_Select' } : {}),
    },
  };
}

function resolvedOverviewTranscript(
  chrom: string,
  transcriptId: string,
  geneId: string,
  start: number,
  end: number,
  primary = false
): ResolvedTranscript {
  return {
    chrom,
    source: 'fixture',
    type: 'mRNA',
    start,
    end,
    score: null,
    strand: '+',
    phase: null,
    attributes: {
      ID: [transcriptId],
      gene: [geneId],
      ...(primary ? { tag: ['MANE_Select'] } : {}),
    },
    raw: '',
    exons: [
      { start: start + 1, end: start + 40 },
      { start: end - 39, end },
    ],
    cds: [{ start: start + 20, end: end - 20 }],
    transcriptId,
    geneId,
  };
}

const BY_CHROM: Record<string, Feature[]> = {
  chr1: [
    transcript({
      id: 10,
      start: 100,
      end: 400,
      sourceId: 'rna-A',
      transcriptId: 'TX-A',
      geneId: 'gene-a',
      primary: true,
    }),
    transcript({
      id: 11,
      start: 150,
      end: 450,
      sourceId: 'rna-B',
      transcriptId: 'TX-B',
      geneId: 'gene-a',
    }),
    transcript({
      id: 12,
      start: 160,
      end: 460,
      sourceId: 'rna-C',
      transcriptId: 'TX-C',
      geneId: 'gene-a',
    }),
    {
      ...transcript({ id: 13, start: 500, end: 800, sourceId: 'gene-D', transcriptId: 'GENE-D' }),
      type: 'gene',
      annotationTrackId: 'gene',
    },
  ],
  chrX: [
    transcript({
      id: 20,
      start: 1_100,
      end: 1_400,
      sourceId: 'rna-SHOX',
      transcriptId: 'SHOX',
      geneId: 'SHOX',
    }),
  ],
  chrY: [
    transcript({
      id: 20,
      start: 2_100,
      end: 2_400,
      sourceId: 'rna-SHOX',
      transcriptId: 'SHOX',
      geneId: 'SHOX',
    }),
  ],
};

const ENVELOPE = JSON.stringify({ manifest: FEATURES_MANIFEST, byChrom: BY_CHROM });

function job(): ExpandedAnnotationSceneWorkerJob {
  return {
    request: REQUEST,
    authorizedMiss: AUTHORIZED_MISS,
    runtimeSourceBuildFingerprint: 'runtime-build-a',
    authorizedSourceRealPaths: CHROMS.map((chromosome) => ({
      inputPath: chromosome.sourcePath!,
      realPath: chromosome.sourcePath!,
    })),
  };
}

function jobForTrack(trackType: string): ExpandedAnnotationSceneWorkerJob {
  const artifact = {
    ...REQUEST.artifact,
    trackType,
    artifactKey: assemblyAnnotationSceneArtifactKey({
      themeMode: REQUEST.artifact.themeMode,
      trackType,
      partitionSpanBp: REQUEST.artifact.partitionSpanBp,
      annotationBarHeightPx: REQUEST.artifact.annotationBarHeightPx,
      laneAlgorithmToken: REQUEST.artifact.laneAlgorithmToken,
      mapperContractToken: REQUEST.artifact.mapperContractToken,
      geometryContractToken: REQUEST.artifact.geometryContractToken,
      interactionContractToken: REQUEST.artifact.interactionContractToken,
    }),
  };
  return { ...job(), request: { ...REQUEST, artifact } };
}

describe('expanded annotation-scene worker compiler', () => {
  it('accepts a one-base 1-indexed inclusive CDS when compiling a cold lane-limit variant', async () => {
    const byChrom = {
      ...BY_CHROM,
      chr1: BY_CHROM.chr1.map((feature, index) => {
        if (index === 0) return { ...feature, cds: [{ start: 120, end: 120 }] };
        if (index === 3) {
          return {
            ...feature,
            type: 'region',
            annotationTrackId: 'genomic DNA',
            exons: [{ start: feature.start, end: feature.end }],
          };
        }
        return feature;
      }),
    };

    await expect(
      compileExpandedAnnotationSceneEnvelope(job(), {
        rawFileJson: JSON.stringify({ manifest: FEATURES_MANIFEST, byChrom }),
        manifest: FEATURES_MANIFEST,
      })
    ).resolves.toMatchObject({ featureCount: 5, droppedCount: 0 });
  });

  it('does not treat genomic RNA as a transcript envelope', async () => {
    const byChrom = {
      ...BY_CHROM,
      chr1: BY_CHROM.chr1.map((feature, index) =>
        index === 0
          ? {
              ...feature,
              start: 0,
              end: 1000,
              type: 'region',
              annotationTrackId: 'genomic RNA',
              exons: [{ start: 0, end: 1000 }],
              cds: [],
            }
          : feature
      ),
    };

    await expect(
      compileExpandedAnnotationSceneEnvelope(jobForTrack('genomic RNA'), {
        rawFileJson: JSON.stringify({ manifest: FEATURES_MANIFEST, byChrom }),
        manifest: FEATURES_MANIFEST,
      })
    ).resolves.toMatchObject({ featureCount: 1, droppedCount: 0 });
  });

  it('normalizes an RNA parent envelope to its child spans before compiling its raster source', async () => {
    const byChrom = {
      ...BY_CHROM,
      chr1: BY_CHROM.chr1.map((feature, index) =>
        index === 0
          ? {
              ...feature,
              type: 'lnc_RNA',
              annotationTrackId: 'lnc_RNA',
              exons: [{ start: feature.start, end: feature.end }],
              cds: [],
            }
          : feature
      ),
    };

    await expect(
      compileExpandedAnnotationSceneEnvelope(jobForTrack('lnc_RNA'), {
        rawFileJson: JSON.stringify({ manifest: FEATURES_MANIFEST, byChrom }),
        manifest: FEATURES_MANIFEST,
      })
    ).resolves.toMatchObject({ featureCount: 1, droppedCount: 0 });
  });

  it('folds repeated ordinary source parents into one raster and hit-test record', async () => {
    const cDnaMatch = {
      ...transcript({
        id: 40,
        start: 700,
        end: 900,
        sourceId: 'match-40',
        transcriptId: 'MATCH-40',
      }),
      type: 'cDNA_match',
      annotationTrackId: 'cDNA_match',
      exons: undefined,
      cds: undefined,
    };
    const manifest = { ...FEATURES_MANIFEST, featureCount: FEATURES_MANIFEST.featureCount + 2 };
    const byChrom = { ...BY_CHROM, chr1: [...BY_CHROM.chr1, cDnaMatch, { ...cDnaMatch }] };

    await expect(
      compileExpandedAnnotationSceneEnvelope(jobForTrack('cDNA_match'), {
        rawFileJson: JSON.stringify({ manifest, byChrom }),
        manifest,
      })
    ).resolves.toMatchObject({ featureCount: 1, droppedCount: 0 });
  });

  it('packs one direct-bank v4 scene with canonical membership and runtime lane projections', async () => {
    const compiled = await compileExpandedAnnotationSceneEnvelope(job(), {
      rawFileJson: ENVELOPE,
      manifest: FEATURES_MANIFEST,
    });
    const unpacked = await unpackPartitionedTranscriptSceneBinaryV4(
      compiled.packed.manifest,
      compiled.packed.payload
    );

    expect(compiled.featureCount).toBe(5);
    expect(compiled.droppedCount).toBe(0);
    expect(compiled.packed.manifest.featureCount).toBe(5);
    expect(compiled.packed.packWork.retainedExpandedSourceGlyphBytes).toBe(0);
    expect(compiled.packed.packWork.retainedPolicyGpuBytes).toBe(0);
    expect(
      projectAnnotationPolicyV1(unpacked.policyProjection, {
        isoformMode: 'expanded',
        laneLimit: null,
      }).features
    ).toHaveLength(5);
    expect(
      projectAnnotationPolicyV1(unpacked.policyProjection, {
        isoformMode: 'canonical',
        laneLimit: null,
      }).features
    ).toHaveLength(3);
    expect(
      projectAnnotationPolicyV1(unpacked.policyProjection, {
        isoformMode: 'expanded',
        laneLimit: 2,
      }).features
    ).toHaveLength(4);
  });

  it('commits the compiled scene and compact interaction through the real cache validator', async () => {
    const compiled = await compileExpandedAnnotationSceneEnvelope(job(), {
      rawFileJson: ENVELOPE,
      manifest: FEATURES_MANIFEST,
    });
    const sourceStat = { size: 128, mtimeMs: 1, ctimeMs: 1 };
    const expectedSourceFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
      REQUEST,
      {
        assertSafePath: async () => {},
        statSource: async () => sourceStat,
      }
    );
    const expectedSourceBuildFingerprint = annotationSceneCompilerContractFingerprint(
      REQUEST.datasetContract,
      REQUEST.artifact,
      REQUEST.scope
    );
    expect(expectedSourceFingerprint).not.toBeNull();
    expect(expectedSourceBuildFingerprint).not.toBeNull();

    const files = new Map<string, Buffer>();
    const result = await writeAssemblyAnnotationSceneCache(
      {
        ...REQUEST,
        expectedSourceFingerprint: expectedSourceFingerprint!,
        expectedSourceBuildFingerprint: expectedSourceBuildFingerprint!,
        manifest: compiled.packed.manifest,
        payload: compiled.packed.payload,
        compiledBroadInteraction: compiled.compiledBroadInteraction,
      },
      {
        assertSafePath: async () => {},
        statSource: async () => sourceStat,
        mkdirImpl: async () => {},
        writeFileImpl: async (path, contents) => {
          files.set(path, Buffer.from(contents));
        },
        renameImpl: async (from, to) => {
          const contents = files.get(from);
          if (!contents) throw new Error(`Missing temporary cache file: ${from}`);
          files.set(to, contents);
          files.delete(from);
        },
        unlinkImpl: async (path) => {
          files.delete(path);
        },
        sourceBuildFingerprint: 'runtime-build-a',
      }
    );

    expect(result).toMatchObject({ fingerprint: expectedSourceFingerprint });
  });

  it('compiles independently addressable spliced-RNA and source-shape track products', async () => {
    const lncRna = {
      ...transcript({
        id: 14,
        start: 810,
        end: 980,
        sourceId: 'rna-LNC',
        transcriptId: 'LNC-1',
      }),
      type: 'lnc_RNA',
      annotationTrackId: 'lnc_RNA',
      cds: [],
    };
    const byChrom = { ...BY_CHROM, chr1: [...BY_CHROM.chr1, lncRna] };
    const manifest = { ...FEATURES_MANIFEST, featureCount: FEATURES_MANIFEST.featureCount + 1 };
    const cache = {
      rawFileJson: JSON.stringify({ manifest, byChrom }),
      manifest,
    };

    const [lnc, gene] = await Promise.all([
      compileExpandedAnnotationSceneEnvelope(jobForTrack('lnc_RNA'), cache),
      compileExpandedAnnotationSceneEnvelope(jobForTrack('gene'), cache),
    ]);

    expect(lnc.featureCount).toBe(1);
    expect(lnc.packed.manifest.sourcePrimitiveCount).toBe(3);
    expect(lnc.packed.manifest.policyContract.annotationTypes).toEqual(['lnc_RNA']);
    expect(gene.featureCount).toBe(1);
    expect(gene.packed.manifest.sourcePrimitiveCount).toBe(1);
    expect(gene.packed.manifest.policyContract.annotationTypes).toEqual(['gene']);
  });

  it('accepts an explicitly empty partition for a sourced placement', async () => {
    const emptyPartitionManifest = {
      ...FEATURES_MANIFEST,
      featureCount: FEATURES_MANIFEST.featureCount - BY_CHROM.chrY.length,
    };
    const compiled = await compileExpandedAnnotationSceneEnvelope(job(), {
      rawFileJson: JSON.stringify({
        manifest: emptyPartitionManifest,
        byChrom: { ...BY_CHROM, chrY: [] },
      }),
      manifest: emptyPartitionManifest,
    });

    expect(compiled.featureCount).toBeGreaterThan(0);
    expect(compiled.packed.manifest.featureCount).toBe(compiled.featureCount);
  });

  it('fails closed on mode, fingerprint-envelope, missing-chromosome, and local-coordinate drift', async () => {
    await expect(
      compileExpandedAnnotationSceneEnvelope(job(), {
        rawFileJson: JSON.stringify({
          manifest: { ...FEATURES_MANIFEST, mode: 'canonical' },
          byChrom: BY_CHROM,
        }),
        manifest: FEATURES_MANIFEST,
      })
    ).rejects.toThrow(/manifest/i);
    await expect(
      compileExpandedAnnotationSceneEnvelope(job(), {
        rawFileJson: JSON.stringify({
          manifest: { ...FEATURES_MANIFEST, fingerprint: 'e'.repeat(24) },
          byChrom: BY_CHROM,
        }),
        manifest: FEATURES_MANIFEST,
      })
    ).rejects.toThrow(/manifest/i);
    await expect(
      compileExpandedAnnotationSceneEnvelope(job(), {
        rawFileJson: JSON.stringify({
          manifest: { ...FEATURES_MANIFEST, featureCount: 5 },
          byChrom: { chr1: BY_CHROM.chr1, chrX: BY_CHROM.chrX },
        }),
        manifest: { ...FEATURES_MANIFEST, featureCount: 5 },
      })
    ).rejects.toThrow(/chromosome/i);
    await expect(
      compileExpandedAnnotationSceneEnvelope(job(), {
        rawFileJson: JSON.stringify({
          manifest: FEATURES_MANIFEST,
          byChrom: {
            ...BY_CHROM,
            chrY: [
              transcript({
                id: 20,
                start: 100,
                end: 400,
                sourceId: 'rna-SHOX',
                transcriptId: 'SHOX',
              }),
            ],
          },
        }),
        manifest: FEATURES_MANIFEST,
      })
    ).rejects.toThrow(/global/i);
    await expect(
      compileExpandedAnnotationSceneEnvelope(job(), {
        rawFileJson: JSON.stringify({
          manifest: FEATURES_MANIFEST,
          byChrom: {
            ...BY_CHROM,
            chr1: BY_CHROM.chr1.map((feature, index) =>
              index === 0 ? { ...feature, cds: [{ start: 0, end: feature.start + 20 }] } : feature
            ),
          },
        }),
        manifest: FEATURES_MANIFEST,
      })
    ).rejects.toThrow(/global feature coordinates/i);
  });

  it('passes the authorized scene revision into the existing CAS and reports stale rejection', async () => {
    const readFeaturesCache = vi.fn(async () => ({
      rawFileJson: ENVELOPE,
      manifest: FEATURES_MANIFEST,
    }));
    const writeSceneCache = vi.fn(async () => null);
    const result = await compileAndCommitExpandedAnnotationSceneWorkerJob(job(), {
      ...rasterPublicationDeps(),
      assertSafePath: async () => {},
      readFeaturesCache,
      writeSceneCache,
    });

    expect(result.status).toBe('stale');
    expect(readFeaturesCache).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'expanded', overviewExtentsOnly: false }),
      expect.not.objectContaining({ sourceBuildFingerprint: expect.anything() })
    );
    expect(writeSceneCache).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceFingerprint: AUTHORIZED_MISS.fingerprint,
        expectedSourceBuildFingerprint: AUTHORIZED_MISS.sourceBuildFingerprint,
        payload: expect.any(Uint8Array),
        compiledBroadInteraction: {
          manifest: expect.objectContaining({
            sourceScene: expect.objectContaining({
              payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              contractSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            }),
          }),
          payload: expect.any(Uint8Array),
        },
      }),
      expect.any(Object)
    );
  });

  it('publishes a complete background raster with at most one borrowed cell', async () => {
    const events: string[] = [];
    let consumedOrdinal = -1;
    let liveBorrowedCells = 0;
    let peakLiveBorrowedCells = 0;
    const compileBroadRaster: typeof compilePackedTranscriptBroadSurfaceRgba8V1 = async (input) => {
      const pixels = new Uint8Array(4);
      let ordinal = 0;
      for (const isoformMode of ['canonical', 'expanded'] as const) {
        for (const level of input.surfaceManifest.levels) {
          for (let tileX = 0; tileX < level.tileCount; tileX += 1) {
            for (const slab of input.surfaceManifest.laneSlabs[isoformMode]) {
              pixels[0] = ordinal + 1;
              events.push(`compiler:offer:${ordinal}`);
              await input.onCell({
                isoformMode,
                level: level.level,
                tileX,
                laneSlabIndex: slab.slabIndex,
                pixels,
              } as Parameters<typeof input.onCell>[0]);
              expect(consumedOrdinal).toBe(ordinal);
              ordinal += 1;
            }
          }
        }
      }
      return {
        emittedCellCount: ordinal,
        transparentCellCount: 0,
        primitiveRasterizationCount: ordinal,
        pixelBufferAllocationCount: 1,
        peakLivePixelBufferCount: 1,
        peakLivePixelBytes: pixels.byteLength,
      };
    };
    const publishBroadRaster = vi.fn(
      async (input: {
        cells:
          | AsyncIterable<CompiledBroadRasterSourceCellV1>
          | Iterable<CompiledBroadRasterSourceCellV1>;
      }): Promise<{ catalogFingerprint: string }> => {
        events.push('raster:publish:start');
        let ordinal = 0;
        for await (const cell of input.cells) {
          if (
            cell.occupancy !== COMPILED_BROAD_RASTER_OCCUPANCY_RGBA8_V1 ||
            !('premultipliedRgba' in cell)
          ) {
            throw new Error('fixture expected an occupied decoded raster cell');
          }
          liveBorrowedCells += 1;
          peakLiveBorrowedCells = Math.max(peakLiveBorrowedCells, liveBorrowedCells);
          const valueBeforeAwait = cell.premultipliedRgba[0];
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(cell.premultipliedRgba[0]).toBe(valueBeforeAwait);
          expect(valueBeforeAwait).toBe(ordinal + 1);
          consumedOrdinal = ordinal;
          liveBorrowedCells -= 1;
          ordinal += 1;
        }
        events.push('raster:publish:complete');
        return { catalogFingerprint: 'e'.repeat(64) };
      }
    );
    const resolveBroadRasterArtifactDirectory = vi.fn(() => '/ws/broad-raster');
    const compiled = await compileExpandedAnnotationSceneEnvelope(job(), {
      rawFileJson: ENVELOPE,
      manifest: FEATURES_MANIFEST,
    });
    await expect(
      compileAndPublishBroadRasterArtifactForPackedScene(
        {
          request: job().request,
          sourceFingerprint: AUTHORIZED_MISS.fingerprint,
          packed: compiled.packed,
        },
        {
          compileBroadRaster,
          publishBroadRaster,
          resolveBroadRasterArtifactDirectory,
        }
      )
    ).resolves.toEqual({
      status: 'published',
      sourceFingerprint: AUTHORIZED_MISS.fingerprint,
      surfaceManifestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      catalogFingerprint: 'e'.repeat(64),
      quarantinedCorruptArtifact: false,
    });

    expect(peakLiveBorrowedCells).toBe(1);
    expect(liveBorrowedCells).toBe(0);
    expect(events.at(-1)).toBe('raster:publish:complete');
    expect(resolveBroadRasterArtifactDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        request: REQUEST,
        sourceFingerprint: AUTHORIZED_MISS.fingerprint,
        surfaceManifestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
    expect(publishBroadRaster).toHaveBeenCalledTimes(1);
  });

  it('commits the reusable scene without waiting for any raster publisher', async () => {
    const writeSceneCache = vi.fn(async (input: { expectedSourceFingerprint: string }) => ({
      fingerprint: input.expectedSourceFingerprint,
      byteCount: 123,
      scenePath: '/ws/scene.bin',
      manifestPath: '/ws/scene.json',
    }));

    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerJob(job(), {
        assertSafePath: async () => {},
        readFeaturesCache: async () => ({ rawFileJson: ENVELOPE, manifest: FEATURES_MANIFEST }),
        writeSceneCache,
      })
    ).resolves.toMatchObject({ status: 'committed' });
    expect(writeSceneCache).toHaveBeenCalledTimes(1);
  });

  it('reads and parses one complete assembly envelope for every track in a product set', async () => {
    const readFeaturesCache = vi.fn(async () => ({
      rawFileJson: ENVELOPE,
      manifest: FEATURES_MANIFEST,
    }));
    const writeSceneCache = vi.fn(async (input: { expectedSourceFingerprint: string }) => ({
      fingerprint: input.expectedSourceFingerprint,
      byteCount: 123,
      scenePath: '/ws/scene.bin',
      manifestPath: '/ws/scene.json',
    }));
    const compileBroadCompanion = vi.fn(async ({ sourceFingerprint, request }) => ({
      status: 'published' as const,
      sourceFingerprint,
      surfaceManifestFingerprint:
        request.artifact.trackType === 'gene' ? 'e'.repeat(64) : 'f'.repeat(64),
      catalogFingerprint: request.artifact.trackType === 'gene' ? '1'.repeat(64) : '2'.repeat(64),
      quarantinedCorruptArtifact: false as const,
    }));

    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerSetJob(
        { jobs: [jobForTrack('gene'), jobForTrack('mRNA')] },
        {
          assertSafePath: async () => {},
          readFeaturesCache,
          writeSceneCache,
          compileBroadCompanion,
        }
      )
    ).resolves.toMatchObject({
      results: [
        {
          status: 'committed',
          featureCount: 1,
          broadCompanion: { sourceFingerprint: AUTHORIZED_MISS.fingerprint },
        },
        {
          status: 'committed',
          featureCount: 5,
          broadCompanion: { sourceFingerprint: AUTHORIZED_MISS.fingerprint },
        },
      ],
    });
    expect(readFeaturesCache).toHaveBeenCalledTimes(1);
    expect(writeSceneCache).toHaveBeenCalledTimes(2);
    expect(compileBroadCompanion).toHaveBeenCalledTimes(2);
  });

  it('rasterizes while the scene is written but publishes only a committed scene', async () => {
    const publishBroadRaster = vi.fn();
    const encodeBroadRasterCells = vi.fn(async () => []);
    const result = await compileAndCommitExpandedAnnotationSceneWorkerSetJob(
      { jobs: [jobForTrack('mRNA')] },
      {
        assertSafePath: async () => {},
        readFeaturesCache: async () => ({ rawFileJson: ENVELOPE, manifest: FEATURES_MANIFEST }),
        writeSceneCache: vi.fn(async () => null),
        compileBroadCompanion: (input) =>
          compileAndPublishBroadRasterArtifactForPackedScene(input, {
            resolveBroadRasterArtifactDirectory: () => '/unused',
            encodeBroadRasterCells,
            publishBroadRaster,
          }),
      }
    );
    expect(result.results[0]).toMatchObject({ status: 'stale' });
    const staleResult = result.results[0];
    expect(
      'broadCompanion' in staleResult ? staleResult.broadCompanion : undefined
    ).toBeUndefined();
    expect(encodeBroadRasterCells).toHaveBeenCalledTimes(1);
    expect(publishBroadRaster).not.toHaveBeenCalled();
  });

  it('publishes the same admissible raster bytes from the resident cold scene as the legacy reread path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'waypoint-fused-raster-'));
    try {
      const fusedDirectory = join(root, 'fused');
      const legacyDirectory = join(root, 'legacy');
      let capturedPacked: PackedPartitionedTranscriptSceneBinaryV4 | null = null;
      const writeSceneCache: NonNullable<
        Parameters<typeof compileAndCommitExpandedAnnotationSceneWorkerSetJob>[1]['writeSceneCache']
      > = vi.fn(async (input) => {
        capturedPacked = {
          manifest: input.manifest,
          payload: input.payload,
          ...(input.roleSidecar ? { roleSidecar: input.roleSidecar } : {}),
          packWork: {
            sourcePrimitiveCount: input.manifest.sourcePrimitiveCount,
            expandedDirectPrimitiveCount: input.manifest.directContract.expanded.instanceCount,
            canonicalDirectPrimitiveCount: input.manifest.directContract.canonical.instanceCount,
            retainedExpandedSourceGlyphBytes: 0,
            retainedPolicyGpuBytes: 0,
            fineRecordIndexCount:
              input.manifest.sections.expandedFineBankRecordIndices.count +
              input.manifest.sections.canonicalFineBankRecordIndices.count,
          },
        };
        return {
          fingerprint: input.expectedSourceFingerprint,
          byteCount: input.payload.byteLength,
          scenePath: join(root, 'scene.bin'),
          manifestPath: join(root, 'scene.json'),
        };
      });
      const fusedResult = await compileAndCommitExpandedAnnotationSceneWorkerSetJob(
        { jobs: [jobForTrack('mRNA')] },
        {
          assertSafePath: async () => {},
          readFeaturesCache: async () => ({
            rawFileJson: ENVELOPE,
            manifest: FEATURES_MANIFEST,
          }),
          writeSceneCache,
          compileBroadCompanion: (input) =>
            compileAndPublishBroadRasterArtifactForPackedScene(input, {
              resolveBroadRasterArtifactDirectory: () => fusedDirectory,
            }),
        }
      );
      if (!capturedPacked) throw new Error('fixture did not capture the committed packed scene');
      const legacyReceipt = await compileAndPublishBroadRasterArtifactForPackedScene(
        {
          request: jobForTrack('mRNA').request,
          sourceFingerprint: AUTHORIZED_MISS.fingerprint,
          packed: capturedPacked,
        },
        { resolveBroadRasterArtifactDirectory: () => legacyDirectory }
      );
      const fusedFirst = fusedResult.results[0];
      const fusedReceipt = 'broadCompanion' in fusedFirst ? fusedFirst.broadCompanion : undefined;
      if (!fusedReceipt) throw new Error('fused compiler omitted the broad companion receipt');
      if (!legacyReceipt) throw new Error('legacy compiler omitted the broad companion receipt');
      const [fusedReader, legacyReader] = await Promise.all([
        openCompiledBroadRasterArtifactV1({
          artifactDirectory: fusedDirectory,
          expectedSurfaceManifestFingerprint: fusedReceipt.surfaceManifestFingerprint,
        }),
        openCompiledBroadRasterArtifactV1({
          artifactDirectory: legacyDirectory,
          expectedSurfaceManifestFingerprint: legacyReceipt.surfaceManifestFingerprint,
        }),
      ]);

      expect(writeSceneCache).toHaveBeenCalledTimes(1);
      expect(fusedReceipt).toEqual(legacyReceipt);
      expect(fusedReader.manifest).toEqual(legacyReader.manifest);
      expect(fusedReader.manifest.pixelFormat).toBe('rgba8-role-weights.v1');
      expect(fusedReader.manifest.roleTable?.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers the exact sorted drawable track inventory from the compiler source envelope', async () => {
    const lncRna = {
      ...transcript({
        id: 30,
        start: 810,
        end: 980,
        sourceId: 'rna-LNC',
        transcriptId: 'LNC-1',
      }),
      type: 'transcript',
      annotationTrackId: 'lnc_RNA',
      cds: [],
    };
    const byChrom = { ...BY_CHROM, chr1: [...BY_CHROM.chr1, lncRna, { ...lncRna }] };
    const manifest = { ...FEATURES_MANIFEST, featureCount: FEATURES_MANIFEST.featureCount + 2 };
    const readFeaturesCache = vi.fn(async () => ({
      rawFileJson: JSON.stringify({ manifest, byChrom }),
      manifest,
    }));

    await expect(
      readExpandedAnnotationSceneTrackInventoryWorkerJob(job(), {
        assertSafePath: async () => {},
        readFeaturesCache,
      })
    ).resolves.toEqual({ status: 'ready', trackTypes: ['gene', 'lnc_RNA', 'mRNA'] });
    expect(readFeaturesCache).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'expanded', overviewExtentsOnly: false }),
      expect.any(Object)
    );
  });

  it('never lists the hidden whole-sequence source record as a track', async () => {
    const wholeSequence = {
      ...transcript({ id: 31, start: 1, end: 980, sourceId: 'region-1', transcriptId: 'REGION-1' }),
      type: 'region',
      annotationTrackId: 'source',
      cds: [],
    };
    const byChrom = { ...BY_CHROM, chr1: [...BY_CHROM.chr1, wholeSequence] };
    const manifest = { ...FEATURES_MANIFEST, featureCount: FEATURES_MANIFEST.featureCount + 1 };

    await expect(
      readExpandedAnnotationSceneTrackInventoryWorkerJob(job(), {
        assertSafePath: async () => {},
        readFeaturesCache: async () => ({
          rawFileJson: JSON.stringify({ manifest, byChrom }),
          manifest,
        }),
      })
    ).resolves.toEqual({ status: 'ready', trackTypes: ['gene', 'mRNA'] });
  });

  it('fails inventory closed when the complete compiler source envelope is absent', async () => {
    await expect(
      readExpandedAnnotationSceneTrackInventoryWorkerJob(job(), {
        assertSafePath: async () => {},
        readFeaturesCache: async () => null,
      })
    ).resolves.toEqual({ status: 'features-cache-miss', trackTypes: [] });
  });

  it('discovers inventory from complete per-chromosome source caches when the derived assembly envelope is cold', async () => {
    const readOverviewCaches = vi.fn(async () => ({
      byChrom: {
        chr1: {
          chrom: 'chr1',
          features: [resolvedOverviewTranscript('chr1', 'TX-1', 'gene-1', 100, 600, true)],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
        chrX: {
          chrom: 'chrX',
          features: [resolvedOverviewTranscript('chrX', 'TX-X', 'gene-x', 100, 400)],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
        chrY: {
          chrom: 'chrY',
          features: [resolvedOverviewTranscript('chrY', 'TX-Y', 'gene-y', 100, 400)],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
      },
      hits: 3,
      misses: 0,
    }));

    await expect(
      readExpandedAnnotationSceneTrackInventoryWorkerJob(job(), {
        assertSafePath: async () => {},
        readFeaturesCache: async () => null,
        readOverviewCaches,
      })
    ).resolves.toEqual({ status: 'ready', trackTypes: ['mRNA'] });
    expect(readOverviewCaches).toHaveBeenCalledTimes(1);
  });

  it('writes the same feature cache bytes and inventory from parallel chromosome slices', async () => {
    const byChrom = {
      chr1: {
        chrom: 'chr1',
        features: [resolvedOverviewTranscript('chr1', 'TX-1', 'gene-1', 100, 600, true)],
        layerTypes: ['mRNA'],
        cacheState: 'hit' as const,
      },
      chrX: {
        chrom: 'chrX',
        features: [resolvedOverviewTranscript('chrX', 'TX-X', 'gene-x', 100, 400)],
        layerTypes: ['mRNA'],
        cacheState: 'hit' as const,
      },
      chrY: {
        chrom: 'chrY',
        features: [resolvedOverviewTranscript('chrY', 'TX-Y', 'gene-y', 100, 400)],
        layerTypes: ['mRNA'],
        cacheState: 'hit' as const,
      },
    };
    const readOverviewCaches = vi.fn(
      async (input: { chromosomes: readonly { chrom: string }[] }) => ({
        byChrom: Object.fromEntries(
          input.chromosomes.map((chromosome) => [
            chromosome.chrom,
            byChrom[chromosome.chrom as keyof typeof byChrom],
          ])
        ),
        hits: input.chromosomes.length,
        misses: 0,
      })
    );
    const written: string[] = [];
    const cacheDeps = {
      mkdirImpl: async () => {},
      writeFileImpl: async (_path: string, data: string | Uint8Array) => {
        written.push(String(data));
      },
      statSource: async () => ({ size: 1, mtimeMs: 1 }),
    };
    const assertSafePath = async () => {};
    const whole = await readExpandedAnnotationSceneTrackInventoryWorkerJob(job(), {
      assertSafePath,
      readFeaturesCache: async () => null,
      readOverviewCaches: readOverviewCaches as never,
      writeFeaturesCache: (input, deps) =>
        writeAssemblyOverviewFeaturesCache(input, { ...deps, ...cacheDeps } as never),
    });
    const sliced = await readExpandedAnnotationSceneTrackInventoryWorkerJob(job(), {
      assertSafePath,
      readFeaturesCache: async () => null,
      buildFeatureCacheFragments: async (sliceJob) =>
        mergeFeatureCacheFragmentsV1(sliceJob, [
          await buildFeatureCacheFragmentsV1(sliceJob, [2], {
            assertSafePath,
            readOverviewCaches: readOverviewCaches as never,
          }),
          await buildFeatureCacheFragmentsV1(sliceJob, [0, 1], {
            assertSafePath,
            readOverviewCaches: readOverviewCaches as never,
          }),
        ]),
      writeFeaturesCacheFragments: (input, deps) =>
        writeAssemblyOverviewFeaturesCacheFromFragmentsV1(input, {
          ...deps,
          ...cacheDeps,
        } as never),
    });
    expect(sliced).toEqual(whole);
    expect(written).toHaveLength(2);
    expect(written[1]).toBe(written[0]);
  });

  it('always builds the expanded superset when the requested runtime policy changes', async () => {
    const overview = {
      byChrom: {
        chr1: {
          chrom: 'chr1',
          features: [
            resolvedOverviewTranscript('chr1', 'TX-PRIMARY', 'gene-a', 100, 600, true),
            resolvedOverviewTranscript('chr1', 'TX-ALT', 'gene-a', 120, 500),
          ],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
        chrX: {
          chrom: 'chrX',
          features: [resolvedOverviewTranscript('chrX', 'TX-X', 'gene-x', 100, 400)],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
        chrY: {
          chrom: 'chrY',
          features: [resolvedOverviewTranscript('chrY', 'TX-Y', 'gene-y', 100, 400)],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
      },
      hits: 3,
      misses: 0,
    };
    const readOverviewCaches = vi.fn<NonNullable<ExpandedCompilerDeps['readOverviewCaches']>>(
      async () => overview
    );
    const readFeaturesCache = vi.fn<NonNullable<ExpandedCompilerDeps['readFeaturesCache']>>(
      async () => null
    );
    const writeSceneCache = vi.fn<NonNullable<ExpandedCompilerDeps['writeSceneCache']>>(
      async (input) => ({
        fingerprint: input.expectedSourceFingerprint,
        byteCount: 123,
        scenePath: '/ws/scene.bin',
        manifestPath: '/ws/scene.json',
      })
    );
    const jobForMode = (isoformMode: 'canonical' | 'expanded') => ({
      ...job(),
      request: {
        ...REQUEST,
        requestedPolicy: { isoformMode, laneLimit: 2 },
      },
    });
    const deps = {
      ...rasterPublicationDeps(),
      assertSafePath: async () => {},
      readFeaturesCache,
      readOverviewCaches,
      writeSceneCache,
    };

    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerJob(jobForMode('canonical'), deps)
    ).resolves.toMatchObject({ status: 'committed', featureCount: 4, droppedCount: 0 });
    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerJob(jobForMode('expanded'), deps)
    ).resolves.toMatchObject({ status: 'committed', featureCount: 4, droppedCount: 0 });

    expect(readFeaturesCache.mock.calls.map(([input]) => input.mode)).toEqual([
      'expanded',
      'expanded',
    ]);
    expect(readOverviewCaches).toHaveBeenCalledTimes(2);
    for (const [input] of readOverviewCaches.mock.calls) {
      expect(input.chromosomes).toEqual(CHROMS);
    }
    expect(writeSceneCache.mock.calls.map(([input]) => input.artifact)).toEqual([
      REQUEST.artifact,
      REQUEST.artifact,
    ]);
    expect(
      new Set(writeSceneCache.mock.calls.map(([input]) => input.manifest.integrity.payloadSha256))
        .size
    ).toBe(1);
  });

  it('preserves unsourced placements while requesting every sourced partition in assembly order', async () => {
    const chromosomes: AssemblyAnnotationSceneReadRequest['chromosomes'] = [
      { chrom: 'scaffold-a', sourcePath: '/ws/scaffold-a.gff3', length: 1_000 },
      { chrom: 'gap', sourcePath: null, length: 500 },
      { chrom: 'plasmid', sourcePath: '/ws/plasmid.gff3', length: 1_000 },
    ];
    const request: AssemblyAnnotationSceneReadRequest = {
      ...REQUEST,
      assemblyId: 'sparse-assembly',
      chromosomes,
      scope: {
        kind: 'complete-assembly',
        placements: chromosomes.map((chromosome) => ({
          chrom: chromosome.chrom,
          length: chromosome.length,
          annotationCoverage: chromosome.sourcePath == null ? 'unsourced' : 'sourced',
        })),
      },
      datasetContract: {
        ...REQUEST.datasetContract,
        datasetId: 'waypoint:assembly-annotation:sparse-assembly',
      },
    };
    const sparseJob: ExpandedAnnotationSceneWorkerJob = {
      ...job(),
      request,
      authorizedSourceRealPaths: [chromosomes[0], chromosomes[2]].map((chromosome) => ({
        inputPath: chromosome.sourcePath!,
        realPath: chromosome.sourcePath!,
      })),
    };
    const readOverviewCaches = vi.fn(async () => ({
      byChrom: {
        'scaffold-a': {
          chrom: 'scaffold-a',
          features: [resolvedOverviewTranscript('scaffold-a', 'TX-A', 'gene-a', 100, 400)],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
        plasmid: {
          chrom: 'plasmid',
          features: [resolvedOverviewTranscript('plasmid', 'TX-P', 'gene-p', 100, 400)],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
      },
      hits: 2,
      misses: 0,
    }));
    const writeSceneCache = vi.fn(async (input: { expectedSourceFingerprint: string }) => ({
      fingerprint: input.expectedSourceFingerprint,
      byteCount: 123,
      scenePath: '/ws/scene.bin',
      manifestPath: '/ws/scene.json',
    }));

    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerJob(sparseJob, {
        ...rasterPublicationDeps(),
        assertSafePath: async () => {},
        readFeaturesCache: async () => null,
        readOverviewCaches,
        writeSceneCache,
      })
    ).resolves.toMatchObject({ status: 'committed', featureCount: 2 });
    expect(readOverviewCaches).toHaveBeenCalledWith(
      {
        chromosomes: [chromosomes[0], chromosomes[2]],
        workspaceRoot: '/ws',
      },
      expect.any(Object)
    );
    expect(writeSceneCache).toHaveBeenCalledWith(
      expect.objectContaining({ chromosomes }),
      expect.any(Object)
    );
  });

  it('refuses missing, stale, extra, or unauthorized source coverage without publishing a scene', async () => {
    const completeByChrom = Object.fromEntries(
      CHROMS.map((chromosome) => [
        chromosome.chrom,
        {
          chrom: chromosome.chrom,
          features: [
            resolvedOverviewTranscript(
              chromosome.chrom,
              `TX-${chromosome.chrom}`,
              `gene-${chromosome.chrom}`,
              100,
              400
            ),
          ],
          layerTypes: ['mRNA'],
          cacheState: 'hit' as const,
        },
      ])
    );
    const writeSceneCache = vi.fn();
    const baseDeps = {
      ...rasterPublicationDeps(),
      assertSafePath: async () => {},
      readFeaturesCache: async () => null,
      writeSceneCache,
    };

    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerJob(job(), {
        ...baseDeps,
        readOverviewCaches: async () => ({
          byChrom: {
            ...completeByChrom,
            chrY: { ...completeByChrom.chrY, cacheState: 'miss' as const, features: [] },
          },
          hits: 2,
          misses: 1,
        }),
      })
    ).resolves.toMatchObject({ status: 'features-cache-miss' });
    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerJob(job(), {
        ...baseDeps,
        readOverviewCaches: async () => ({
          byChrom: { ...completeByChrom, forged: completeByChrom.chr1 },
          hits: 4,
          misses: 0,
        }),
      })
    ).resolves.toMatchObject({ status: 'features-cache-miss' });
    await expect(
      compileAndCommitExpandedAnnotationSceneWorkerJob(
        { ...job(), authorizedSourceRealPaths: [...job().authorizedSourceRealPaths].reverse() },
        {
          ...baseDeps,
          readOverviewCaches: async () => ({ byChrom: completeByChrom, hits: 3, misses: 0 }),
        }
      )
    ).rejects.toThrow(/unauthorized/i);
    expect(writeSceneCache).not.toHaveBeenCalled();
  });

  it('rejects unapproved source paths and source realpath changes inside the worker', async () => {
    const guard = createAuthorizedExpandedAnnotationSourcePathGuard(
      [{ inputPath: '/ws/chr1.gff3.gz', realPath: '/real/chr1.gff3.gz' }],
      async (path) => (path === '/ws/chr1.gff3.gz' ? '/changed/chr1.gff3.gz' : path)
    );
    await expect(guard('/ws/chr2.gff3.gz')).rejects.toThrow(/unauthorized/i);
    await expect(guard('/ws/chr1.gff3.gz')).rejects.toThrow(/changed/i);
  });
});
