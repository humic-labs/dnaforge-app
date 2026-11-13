import type {
  PortableGenomeViewTrack,
  UcscCatalogLeaf,
  UcscTrackSource,
} from '@waypoint/genome-data';
import { describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeTabState } from '../../shared/indexed-genome';
import {
  assertPreparedReferenceMatchesPortableView,
  createPortableGenomeViewDocument,
  portableHostedReferenceFromIndexedGenome,
  PortableReferenceMissingError,
  portableReferenceSignatureMatches,
  resolvePortableGenomeViewViewport,
  resolvePortableHostedDataTracks,
} from './portable-genome-view-roundtrip';

const BUNDLE = 'a'.repeat(64);
const SOURCE = 'b'.repeat(24);
const INVENTORY = 'c'.repeat(64);

function indexedGenome(): IndexedGenomeTabState {
  return {
    sourcePath: '/cache/grch38/chr1.fa',
    sourceExt: '.fa',
    chrom: 'chr1',
    assembly: {
      assemblyId: 'grch38',
      displayName: 'GRCh38',
      chromosomes: [
        {
          chrom: 'chr1',
          length: 1000,
          manifest: { chrom: 'chr1', fastaPath: '/cache/chr1.fa', faiPath: '/cache/chr1.fa.fai' },
        },
      ],
    },
    scope: { kind: 'all' },
    assemblyPortableBundleFingerprint: BUNDLE,
    assemblyAssetGeneration: {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: SOURCE,
      inventoryFingerprint: INVENTORY,
      themeMode: 'light',
    },
  };
}

const TRACK: PortableGenomeViewTrack = {
  trackId: 'ucsc:grch38-gc5BaseBw',
  trackType: 'quantitative',
  label: 'GC percent',
  order: 0,
  visible: true,
  source: {
    kind: 'hosted-track',
    provider: 'ucsc',
    catalogId: 'gc5BaseBw',
    assemblyId: 'grch38',
    contentFingerprint: `sha256:${'d'.repeat(64)}`,
    referenceSignature: `sha256:${'e'.repeat(64)}`,
  },
  presentation: {
    kind: 'quantitative',
    color: '#3b82f6',
    trackHeightPx: 96,
    scale: { kind: 'auto' },
  },
};

describe('portable genome view hosted round trip', () => {
  it('pins the currently admitted hosted reference and live view state', async () => {
    const result = await createPortableGenomeViewDocument({
      id: 'view-grch38',
      name: 'GRCh38 locus',
      createdAt: '2026-09-01T12:00:00.000Z',
      indexedGenome: indexedGenome(),
      liveViewport: { chrom: 'chr1', start0: 100, end0: 200 },
      annotation: {
        policy: { isoformMode: 'canonical', laneLimit: 2 },
        visibilityByTrackId: { gene: true },
        orderedTrackIds: ['gene'],
      },
    });

    expect(result).toMatchObject({
      status: 'ready',
      document: {
        reference: {
          kind: 'hosted-reference',
          catalogId: 'grch38',
          bundleFingerprint: BUNDLE,
          sourceFingerprint: SOURCE,
          inventoryFingerprint: INVENTORY,
        },
        viewport: { kind: 'locus', chrom: 'chr1', start0: 100, end0: 200 },
      },
    });
  });

  it('pins a prepared local reference by its index tables and chromosome signature', async () => {
    const local: IndexedGenomeTabState = { ...indexedGenome() };
    delete local.assemblyPortableBundleFingerprint;
    delete local.assemblyAssetGeneration;
    const faiTables: Record<string, string> = {
      '/cache/chr1.fa.fai': 'chr1\t1000\t6\t60\t61\n',
    };
    const readTextFile = vi.fn(async (path: string) => {
      const table = faiTables[path];
      if (table === undefined) throw new Error(`unexpected read of ${path}`);
      return table;
    });
    const save = () =>
      createPortableGenomeViewDocument({
        id: 'view-local',
        name: 'Lab assembly locus',
        createdAt: '2026-09-21T12:00:00.000Z',
        indexedGenome: local,
        liveViewport: { chrom: 'chr1', start0: 10, end0: 90 },
        annotation: {
          policy: { isoformMode: 'canonical', laneLimit: 2 },
          visibilityByTrackId: { gene: true },
          orderedTrackIds: ['gene'],
        },
        readTextFile,
      });
    const result = await save();

    expect(result).toMatchObject({
      status: 'ready',
      document: {
        reference: { kind: 'workspace-reference', entityId: 'grch38', assemblyId: 'grch38' },
      },
    });
    if (result.status !== 'ready' || result.document.reference.kind !== 'workspace-reference') {
      throw new Error('Expected a workspace reference.');
    }
    expect(result.document.reference.contentFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.document.reference.referenceSignature).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(result.document)).not.toContain('/cache/');
    expect(readTextFile).toHaveBeenCalledWith('/cache/chr1.fa.fai');

    const again = await save();
    if (again.status !== 'ready' || again.document.reference.kind !== 'workspace-reference') {
      throw new Error('Expected a workspace reference.');
    }
    expect(again.document.reference.contentFingerprint).toBe(
      result.document.reference.contentFingerprint
    );
    faiTables['/cache/chr1.fa.fai'] = 'chr1\t1000\t6\t80\t81\n';
    const reprepared = await save();
    if (
      reprepared.status !== 'ready' ||
      reprepared.document.reference.kind !== 'workspace-reference'
    ) {
      throw new Error('Expected a workspace reference.');
    }
    expect(reprepared.document.reference.contentFingerprint).not.toBe(
      result.document.reference.contentFingerprint
    );
    expect(reprepared.document.reference.referenceSignature).toBe(
      result.document.reference.referenceSignature
    );
  });

  it('matches a library reference to a saved view by chromosome table alone', async () => {
    const local: IndexedGenomeTabState = { ...indexedGenome() };
    delete local.assemblyPortableBundleFingerprint;
    delete local.assemblyAssetGeneration;
    const saved = await createPortableGenomeViewDocument({
      id: 'view-local',
      name: 'Lab assembly locus',
      createdAt: '2026-09-21T12:00:00.000Z',
      indexedGenome: local,
      liveViewport: { chrom: 'chr1', start0: 10, end0: 90 },
      annotation: {
        policy: { isoformMode: 'canonical', laneLimit: 2 },
        visibilityByTrackId: {},
        orderedTrackIds: [],
      },
      readTextFile: async () => 'chr1\t1000\t6\t60\t61\n',
    });
    if (saved.status !== 'ready' || saved.document.reference.kind !== 'workspace-reference') {
      throw new Error('Expected a workspace reference.');
    }
    const reference = saved.document.reference;
    await expect(
      portableReferenceSignatureMatches([{ name: 'chr1', length: 1000 }], reference)
    ).resolves.toBe(true);
    await expect(
      portableReferenceSignatureMatches([{ name: 'chr1', length: 1001 }], reference)
    ).resolves.toBe(false);
    await expect(
      portableReferenceSignatureMatches(
        [
          { name: 'chr1', length: 1000 },
          { name: 'chr2', length: 5 },
        ],
        reference
      )
    ).resolves.toBe(false);
    await expect(portableReferenceSignatureMatches([], reference)).resolves.toBe(false);

    const missing = new PortableReferenceMissingError(reference, []);
    expect(missing.code).toBe('PORTABLE_REFERENCE_MISSING');
    expect(missing.message).toBe(
      'This view was saved against reference grch38, which is not in this library.'
    );
  });

  it('rejects a hosted bundle replacement before opening against changed bytes', () => {
    const reference = portableHostedReferenceFromIndexedGenome(indexedGenome());
    expect(() =>
      assertPreparedReferenceMatchesPortableView(
        {
          id: 'grch38',
          name: 'GRCh38',
          organism: 'Homo sapiens',
          description: 'Human',
          assetCacheKey: 'grch38',
          members: [],
          portableView: {
            generationRoot: '/cache/new',
            bundleFingerprint: '0'.repeat(64),
            trackTypes: [],
          },
        },
        reference
      )
    ).toThrow(/changed since this view was saved/u);
  });

  it('rejects a matching bundle that omits prepared source and inventory generations', () => {
    const reference = portableHostedReferenceFromIndexedGenome(indexedGenome());
    expect(() =>
      assertPreparedReferenceMatchesPortableView(
        {
          id: 'grch38',
          name: 'GRCh38',
          organism: 'Homo sapiens',
          description: 'Human',
          assetCacheKey: 'grch38',
          members: [],
          portableView: {
            generationRoot: '/cache/current',
            bundleFingerprint: BUNDLE,
            trackTypes: [],
          },
        },
        reference
      )
    ).toThrow(/does not expose the prepared source and annotation inventory/u);
  });

  it('resolves all, chromosome, locus, and assembly-global cameras exactly', () => {
    const assembly = {
      chromosomes: [
        { chrom: 'chr1', length: 1_000 },
        { chrom: 'chr2', length: 500 },
      ],
    };

    expect(resolvePortableGenomeViewViewport({ kind: 'all' }, assembly)).toEqual({
      scope: { kind: 'all' },
      globalStart0: 0,
      globalEnd0: 1_500,
    });
    expect(
      resolvePortableGenomeViewViewport({ kind: 'chromosome', chrom: 'chr2' }, assembly)
    ).toEqual({
      scope: { kind: 'chromosome', chrom: 'chr2' },
      globalStart0: 1_000,
      globalEnd0: 1_500,
    });
    expect(
      resolvePortableGenomeViewViewport(
        { kind: 'locus', chrom: 'chr2', start0: 10, end0: 25 },
        assembly
      )
    ).toEqual({
      scope: { kind: 'locus', chrom: 'chr2', start: 10, end: 25 },
      globalStart0: 1_010,
      globalEnd0: 1_025,
    });
    expect(
      resolvePortableGenomeViewViewport(
        { kind: 'assembly-range', start0: 900, end0: 1_100 },
        assembly
      )
    ).toEqual({
      scope: { kind: 'all' },
      globalStart0: 900,
      globalEnd0: 1_100,
    });
    expect(() =>
      resolvePortableGenomeViewViewport(
        { kind: 'locus', chrom: 'chr2', start0: 490, end0: 510 },
        assembly
      )
    ).toThrow(/outside chromosome chr2/u);
  });

  it('re-resolves an exact UCSC track and rejects changed admission fingerprints', async () => {
    const catalogTrack: UcscCatalogLeaf = {
      sourceKind: 'ucsc-native',
      catalogId: 'internal',
      track: 'gc5BaseBw',
      shortLabel: 'GC percent',
      longLabel: 'GC percent',
      scientificKind: 'quantitative',
      formatId: 'bigwig',
      assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
    };
    const search = vi.fn(async () => [catalogTrack]);
    const admit = vi.fn(
      async () =>
        ({
          admissionVersion: 1,
          uri: 'ucsc://hg38/gc5BaseBw',
          formatId: 'bigwig',
          fingerprint: `sha256:${'d'.repeat(64)}`,
          readerKind: 'bbi',
          scientificKind: 'quantitative',
          assemblyId: 'grch38',
          referenceReceipt: {
            assemblyId: 'grch38',
            referenceSignature: `sha256:${'e'.repeat(64)}`,
            sourceSignature: 'source',
            contigMap: { chr1: 'chr1' },
            checkedContigs: 1,
            status: 'compatible',
            checkedAt: '2026-09-01T12:00:00.000Z',
          },
          provenance: {
            provider: 'ucsc',
            sourceKind: 'ucsc-native',
            catalogId: 'internal',
            ucscGenome: 'hg38',
            track: 'gc5BaseBw',
            label: 'GC percent',
          },
        }) satisfies UcscTrackSource
    );

    await expect(
      resolvePortableHostedDataTracks({
        tracks: [TRACK],
        indexedGenome: indexedGenome(),
        options: { search, admit },
      })
    ).resolves.toMatchObject([
      {
        trackId: TRACK.trackId,
        label: TRACK.label,
        order: 0,
        color: 0x3b82f6,
        trackPx: 96,
        visible: true,
      },
    ]);
    expect(search).toHaveBeenCalledWith({ genome: 'hg38', query: 'gc5BaseBw', limit: 50 });

    const changed = vi.fn(async () => ({ ...(await admit()), fingerprint: 'changed' }));
    await expect(
      resolvePortableHostedDataTracks({
        tracks: [TRACK],
        indexedGenome: indexedGenome(),
        options: { search, admit: changed },
      })
    ).rejects.toThrow(/changed since this view was saved/u);

    const fixedScaleTrack: PortableGenomeViewTrack = {
      ...TRACK,
      presentation: {
        ...TRACK.presentation,
        kind: 'quantitative',
        scale: { kind: 'fixed', min: 0, max: 100, transform: 'linear' },
      },
    };
    await expect(
      resolvePortableHostedDataTracks({
        tracks: [fixedScaleTrack],
        indexedGenome: indexedGenome(),
        options: { search, admit },
      })
    ).rejects.toThrow(/fixed quantitative scale that this viewer cannot restore exactly/u);

    const admittedInterval = vi.fn(async () => ({
      ...(await admit()),
      scientificKind: 'interval' as const,
    }));
    await expect(
      resolvePortableHostedDataTracks({
        tracks: [TRACK],
        indexedGenome: indexedGenome(),
        options: { search, admit: admittedInterval },
      })
    ).rejects.toThrow(/refused to reinterpret the track/u);

    const annotationTrack: PortableGenomeViewTrack = {
      ...TRACK,
      trackType: 'interval',
      presentation: {
        kind: 'annotation',
        color: '#3b82f6',
        trackHeightPx: 96,
        laneHeightPx: 20,
        maxLanes: 32,
      },
    };
    await expect(
      resolvePortableHostedDataTracks({
        tracks: [annotationTrack],
        indexedGenome: indexedGenome(),
        options: { search, admit },
      })
    ).rejects.toThrow(/refused to reinterpret the track/u);
  });

  it('fails closed for workspace tracks instead of dropping a layer', async () => {
    const workspaceTrack: PortableGenomeViewTrack = {
      ...TRACK,
      source: {
        kind: 'workspace-track',
        entityId: 'track-1',
        assemblyId: 'grch38',
        contentFingerprint: `sha256:${'d'.repeat(64)}`,
        referenceSignature: `sha256:${'e'.repeat(64)}`,
      },
    };

    await expect(
      resolvePortableHostedDataTracks({ tracks: [workspaceTrack], indexedGenome: indexedGenome() })
    ).rejects.toThrow(/will not guess a path or silently omit it/u);
  });
});
