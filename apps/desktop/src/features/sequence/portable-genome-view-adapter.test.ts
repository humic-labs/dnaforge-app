// @vitest-environment node

import type {
  AdmittedTrackSource,
  PortableGenomeViewReference,
  PortableGenomeViewTrackSourceRef,
} from '@waypoint/genome-data';
import { describe, expect, it } from 'vitest';

import type {
  IndexedGenomeDataTrackState,
  IndexedGenomeTabState,
} from '../../shared/indexed-genome';
import {
  portableAdmittedContentFingerprint,
  portableVariantTrackId,
  portableFingerprintFromIdentity,
  projectPortableGenomeView,
  restorePortableGenomeView,
} from './portable-genome-view-adapter';

const ASSEMBLY_ID = 'grch38';
const BUNDLE_FINGERPRINT = 'a'.repeat(64);
const SOURCE_FINGERPRINT = 'b'.repeat(24);
const INVENTORY_FINGERPRINT = 'c'.repeat(64);
const CONTENT_FINGERPRINT = `sha256:${'d'.repeat(64)}`;
const REFERENCE_SIGNATURE = `sha256:${'e'.repeat(64)}`;

const HOSTED_REFERENCE: PortableGenomeViewReference = {
  kind: 'hosted-reference',
  catalogId: 'grch38',
  assemblyId: ASSEMBLY_ID,
  bundleFingerprint: BUNDLE_FINGERPRINT,
  sourceFingerprint: SOURCE_FINGERPRINT,
  inventoryFingerprint: INVENTORY_FINGERPRINT,
};

const HOSTED_TRACK_SOURCE: PortableGenomeViewTrackSourceRef = {
  kind: 'hosted-track',
  provider: 'ucsc',
  catalogId: 'gc5BaseBw',
  assemblyId: ASSEMBLY_ID,
  contentFingerprint: CONTENT_FINGERPRINT,
  referenceSignature: REFERENCE_SIGNATURE,
};

function admittedSource(
  scientificKind: AdmittedTrackSource['scientificKind'],
  overrides: Partial<AdmittedTrackSource> = {}
): AdmittedTrackSource {
  return {
    admissionVersion: 1,
    uri: 'https://example.invalid/inert-source.bw',
    formatId: scientificKind === 'quantitative' ? 'bigwig' : 'bigbed',
    fingerprint: CONTENT_FINGERPRINT,
    readerKind: 'bbi',
    scientificKind,
    assemblyId: ASSEMBLY_ID,
    referenceReceipt: {
      assemblyId: ASSEMBLY_ID,
      referenceSignature: REFERENCE_SIGNATURE,
      sourceSignature: 'inert-source-signature',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible',
      checkedAt: '2026-09-01T12:00:00.000Z',
    },
    provenance: {
      provider: 'ucsc',
      catalogId: 'ucsc-native\u0000hg38\u0000gc5BaseBw\u0000',
      track: 'gc5BaseBw',
    },
    ...overrides,
  };
}

function dataTrack(
  trackId: string,
  scientificKind: AdmittedTrackSource['scientificKind'],
  order: number
): IndexedGenomeDataTrackState {
  return {
    trackId,
    trackType: scientificKind,
    label: `${trackId} label`,
    order,
    color: 0x16a34a,
    trackPx: 160,
    laneHeightPx: 20,
    maxLanes: 12,
    visible: true,
    source: admittedSource(scientificKind),
  };
}

function indexedGenome(): IndexedGenomeTabState {
  return {
    sourcePath: '/runtime/cache/grch38/chr1.fa',
    workspaceRoot: '/runtime/cache/grch38',
    sourceExt: '.fa',
    chrom: 'chr1',
    assembly: {
      assemblyId: ASSEMBLY_ID,
      displayName: 'GRCh38',
      chromosomes: [
        {
          chrom: 'chr1',
          length: 248_956_422,
          manifest: {
            chrom: 'chr1',
            fastaPath: '/runtime/cache/grch38/chr1.fa',
            faiPath: '/runtime/cache/grch38/chr1.fa.fai',
          },
        },
      ],
    },
    scope: { kind: 'chromosome', chrom: 'chr1' },
    assemblyPortableBundleFingerprint: BUNDLE_FINGERPRINT,
    assemblyAssetGeneration: {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      inventoryFingerprint: INVENTORY_FINGERPRINT,
      themeMode: 'light',
    },
  };
}

function projectionInput(state: IndexedGenomeTabState) {
  return {
    id: 'view-1',
    name: 'Portable GRCh38 view',
    provenance: {
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:05:00.000Z',
      createdBy: { kind: 'user' as const, id: 'user-1' },
    },
    indexedGenome: state,
    reference: HOSTED_REFERENCE,
    liveViewport: { chrom: 'chr1', start0: 100, end0: 900 },
    annotation: {
      policy: { isoformMode: 'expanded' as const, laneLimit: 8 },
      visibilityByTrackId: { genes: true, repeats: false },
      orderedTrackIds: ['genes', 'repeats'],
    },
  };
}

describe('portable genome view desktop adapter', () => {
  it('projects data, BAM, and variant tracks without serializing runtime locators', async () => {
    const state = indexedGenome();
    const quantitative = dataTrack('signal', 'quantitative', 2);
    const annotation: IndexedGenomeDataTrackState = {
      ...dataTrack('transcripts', 'transcript', 1),
      source: admittedSource('transcript', {
        uri: '/workspace/tracks/transcripts.bb',
        fingerprint: 'legacy-local-generation',
        provenance: {},
      }),
    };
    state.dataTracks = [quantitative, annotation];
    state.bamTracks = [
      {
        trackId: 'tumor-reads',
        label: 'Tumor reads',
        order: 0,
        source: {
          bamPath: '/private/data/tumor.bam',
          indexPath: '/runtime/indexes/tumor.bam.bai',
          referencePath: '/runtime/cache/grch38.fa',
        },
        visible: false,
        coverageCutoffDepth: 125,
      },
    ];
    state.variantSource = {
      sourcePath: '/private/data/tumor.vcf.gz',
      queryPath: '/runtime/queries/tumor.vcf.gz',
      indexPath: '/runtime/indexes/tumor.vcf.gz.tbi',
      format: 'vcf',
      label: 'Tumor variants',
      sourceSizeBytes: 42,
      sourceMtimeNs: '1234',
      sourceIdentity: 'f'.repeat(64),
      matchedReferences: ['chr1'],
      samples: ['tumor'],
      attachedAt: 123,
    };
    const variantTrackId = portableVariantTrackId(state.variantSource);
    const result = await projectPortableGenomeView({
      ...projectionInput(state),
      trackSourceRefsByTrackId: {
        transcripts: {
          kind: 'workspace-track',
          entityId: 'track-transcripts',
          assemblyId: ASSEMBLY_ID,
          contentFingerprint: `sha256:${'1'.repeat(64)}`,
          referenceSignature: REFERENCE_SIGNATURE,
          relativePathHint: 'tracks/transcripts.bb',
        },
        'tumor-reads': {
          kind: 'workspace-track',
          entityId: 'track-tumor-reads',
          assemblyId: ASSEMBLY_ID,
          contentFingerprint: `sha256:${'2'.repeat(64)}`,
          referenceSignature: REFERENCE_SIGNATURE,
          relativePathHint: 'reads/tumor.bam',
        },
        [variantTrackId]: {
          kind: 'workspace-track',
          entityId: 'track-tumor-variants',
          assemblyId: ASSEMBLY_ID,
          contentFingerprint: `sha256:${state.variantSource.sourceIdentity}`,
          referenceSignature: REFERENCE_SIGNATURE,
          relativePathHint: 'variants/tumor.vcf.gz',
        },
      },
      variantPresentation: { selectedSamples: ['tumor'], filteredToPassing: true },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a portable document.');
    expect(result.document.tracks).toMatchObject([
      {
        trackId: 'tumor-reads',
        order: 0,
        visible: false,
        presentation: { kind: 'aligned-reads', coverageCutoffDepth: 125 },
      },
      {
        trackId: 'transcripts',
        order: 1,
        presentation: { kind: 'annotation', color: '#16a34a' },
      },
      {
        trackId: 'signal',
        order: 2,
        source: HOSTED_TRACK_SOURCE,
        presentation: { kind: 'quantitative', scale: { kind: 'auto' } },
      },
      {
        trackId: variantTrackId,
        order: 3,
        presentation: {
          kind: 'variants',
          selectedSamples: ['tumor'],
          filteredToPassing: true,
        },
      },
    ]);
    expect(result.document.viewport).toEqual({
      kind: 'locus',
      chrom: 'chr1',
      start0: 100,
      end0: 900,
    });
    const portableJson = JSON.stringify(result.document);
    expect(portableJson).not.toContain('/runtime/');
    expect(portableJson).not.toContain('/private/');
    expect(portableJson).not.toContain('example.invalid');
    expect(portableJson).not.toContain('sourcePath');
    expect(portableJson).not.toContain('bamPath');
    expect(portableJson).not.toContain('readiness');
  });

  it('projects admitted local, credentialed, and hub sources as durable requests', async () => {
    const admittedAt = '2026-09-21T12:00:00.000Z';
    const state = indexedGenome();
    const coverage: IndexedGenomeDataTrackState = {
      ...dataTrack('coverage', 'quantitative', 0),
      source: admittedSource('quantitative', {
        admissionVersion: 2,
        admittedAt,
        uri: '/lab/run1/coverage.bw',
        input: { kind: 'path', path: '/lab/run1/coverage.bw' },
        fingerprint: `sha256:${'1'.repeat(64)}`,
        request: {
          contract: 'dnaforge.track-admission-request.v1',
          assemblyId: ASSEMBLY_ID,
          source: { kind: 'local-file', path: '/lab/run1/coverage.bw' },
          formatId: 'bigwig',
          scientificKind: 'quantitative',
          ingress: { kind: 'file-picker' },
        },
        provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'coverage.bw' },
      }),
    };
    const hubGenes: IndexedGenomeDataTrackState = {
      ...dataTrack('hub-genes', 'transcript', 1),
      source: admittedSource('transcript', {
        admissionVersion: 2,
        admittedAt,
        uri: 'https://hub.example.org/genes.bb',
        input: { kind: 'url', url: 'https://hub.example.org/genes.bb' },
        fingerprint: `sha256:${'2'.repeat(64)}`,
        request: {
          contract: 'dnaforge.track-admission-request.v1',
          assemblyId: ASSEMBLY_ID,
          source: {
            kind: 'ucsc-track',
            sourceKind: 'ucsc-hub',
            genome: 'hg38',
            track: 'genes',
            hubUrl: 'https://hub.example.org/hub.txt',
          },
          formatId: 'bigbed',
          scientificKind: 'transcript',
          label: 'Hub genes',
          ingress: { kind: 'hub' },
        },
        provenance: {
          provider: 'ucsc',
          sourceKind: 'ucsc-hub',
          catalogId: 'ucsc-hub\u0000hg38\u0000genes\u0000https://hub.example.org/hub.txt',
          ucscGenome: 'hg38',
          track: 'genes',
          hubUrl: 'https://hub.example.org/hub.txt',
          label: 'Hub genes',
        },
      }),
    };
    state.dataTracks = [coverage, hubGenes];
    state.bamTracks = [
      {
        trackId: 'private-reads',
        label: 'Private reads',
        order: 2,
        source: {
          bamPath: 'https://private.example.org/reads.cram',
          indexPath: '/runtime/indexes/reads.crai',
          referencePath: '/runtime/cache/grch38.fa',
        },
        admittedSource: admittedSource('reads', {
          admissionVersion: 2,
          admittedAt,
          readerKind: 'bam',
          formatId: 'cram',
          uri: 'https://private.example.org/reads.cram',
          input: { kind: 'url', url: 'https://private.example.org/reads.cram' },
          index: { kind: 'url', url: 'https://private.example.org/reads.cram.crai' },
          fingerprint: `sha256:${'3'.repeat(64)}`,
          request: {
            contract: 'dnaforge.track-admission-request.v1',
            assemblyId: ASSEMBLY_ID,
            source: {
              kind: 'http',
              url: 'https://private.example.org/reads.cram',
              authRef: 'credential:lab',
            },
            index: {
              kind: 'http',
              url: 'https://private.example.org/reads.cram.crai',
              authRef: 'credential:lab',
            },
            reference: { kind: 'local-file', path: '/runtime/cache/grch38.fa' },
            formatId: 'cram',
            scientificKind: 'reads',
            ingress: { kind: 'url' },
          },
          provenance: { provider: 'http', sourceKind: 'http', label: 'Private reads' },
        }),
        visible: true,
        coverageCutoffDepth: 0,
      },
    ];

    const result = await projectPortableGenomeView(projectionInput(state));

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a portable document.');
    expect(result.document.tracks).toMatchObject([
      {
        trackId: 'coverage',
        source: {
          kind: 'admitted-source',
          assemblyId: ASSEMBLY_ID,
          contentFingerprint: `sha256:${'1'.repeat(64)}`,
          referenceSignature: REFERENCE_SIGNATURE,
          request: { source: { kind: 'local-file', path: '/lab/run1/coverage.bw' } },
        },
      },
      {
        trackId: 'hub-genes',
        source: {
          kind: 'admitted-source',
          request: {
            source: { kind: 'ucsc-track', sourceKind: 'ucsc-hub' },
            ingress: { kind: 'hub' },
          },
        },
      },
      {
        trackId: 'private-reads',
        source: {
          kind: 'admitted-source',
          contentFingerprint: `sha256:${'3'.repeat(64)}`,
          request: {
            source: { kind: 'http', authRef: 'credential:lab' },
            index: { kind: 'http', authRef: 'credential:lab' },
          },
        },
        presentation: { kind: 'aligned-reads' },
      },
    ]);
    const portableJson = JSON.stringify(result.document);
    expect(portableJson).not.toContain('/runtime/indexes');
    expect(portableJson).not.toContain('bamPath');
    expect(portableJson).not.toMatch(/bearer|token|signature=/iu);
  });

  it('reports every unresolved current track family instead of dropping layers', async () => {
    const state = indexedGenome();
    state.dataTracks = [
      {
        ...dataTrack('local-intervals', 'interval', 0),
        source: admittedSource('interval', {
          fingerprint: 'not-a-portable-fingerprint',
          provenance: {},
        }),
      },
    ];
    state.bamTracks = [
      {
        trackId: 'reads',
        label: 'Reads',
        source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
        visible: true,
        coverageCutoffDepth: 0,
      },
    ];
    state.variantSource = {
      sourcePath: '/data/calls.bcf',
      queryPath: '/cache/calls.bcf',
      indexPath: '/cache/calls.bcf.csi',
      format: 'bcf',
      label: 'Calls',
      sourceSizeBytes: 1,
      sourceMtimeNs: '1',
      sourceIdentity: '9'.repeat(64),
      matchedReferences: ['chr1'],
      samples: [],
      attachedAt: 1,
    };

    const result = await projectPortableGenomeView(projectionInput(state));

    expect(result).toEqual({
      status: 'unsupported',
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'unsupported-track-source',
          trackId: 'local-intervals',
          trackFamily: 'data',
        }),
        expect.objectContaining({
          code: 'unsupported-track-source',
          trackId: 'reads',
          trackFamily: 'aligned-reads',
        }),
        expect.objectContaining({
          code: 'unsupported-track-source',
          trackId: portableVariantTrackId(state.variantSource),
          trackFamily: 'variants',
        }),
      ]),
    });
    if (result.status !== 'unsupported') throw new Error('Expected unsupported sources.');
    expect(result.issues).toHaveLength(3);
  });

  it('refuses to label hosted validator metadata as a content fingerprint', async () => {
    const state = indexedGenome();
    state.dataTracks = [
      {
        ...dataTrack('remote-signal', 'quantitative', 0),
        source: admittedSource('quantitative', {
          fingerprint: ['catalog-id', 'url-hash', '"etag"', 'last-modified', '1024'].join('\u0000'),
        }),
      },
    ];

    const result = await projectPortableGenomeView(projectionInput(state));

    expect(result).toMatchObject({
      status: 'unsupported',
      issues: [
        expect.objectContaining({
          code: 'unsupported-track-source',
          trackId: 'remote-signal',
        }),
      ],
    });
  });

  it('refuses to silently drop a signal-to-reads composition from a portable view', async () => {
    const state = indexedGenome();
    state.signalReadPileupViews = [
      {
        contract: 'dnaforge.signal-read-pileup-view.v1',
        trackId: 'combined',
        readsTrackId: 'reads',
        signalTrackId: 'signal',
        label: 'Accessibility + reads',
        order: 2,
        visible: true,
        color: 0xa8ceff,
        trackPx: 276,
        laneHeightPx: 3,
        maxLanes: 80,
        overflowBandHeightPx: 36,
        coverageCutoffDepth: 80,
        loadingAnimation: 'diagonal-scan',
      },
    ];

    const result = await projectPortableGenomeView(projectionInput(state));

    expect(result).toEqual({
      status: 'unsupported',
      issues: [
        {
          code: 'unsupported-composed-view',
          message:
            'Signal-to-reads view Accessibility + reads cannot be represented by the current portable genome-view schema. Save it as a Track View or share its .dnaforge-tracks.json manifest.',
          trackId: 'combined',
          trackFamily: 'composition',
        },
      ],
    });
  });

  it('rejects an unsafe workspace hint through the shared document authority', async () => {
    const state = indexedGenome();
    state.bamTracks = [
      {
        trackId: 'reads',
        label: 'Reads',
        source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
        visible: true,
        coverageCutoffDepth: 0,
      },
    ];

    const result = await projectPortableGenomeView({
      ...projectionInput(state),
      trackSourceRefsByTrackId: {
        reads: {
          kind: 'workspace-track',
          entityId: 'track-reads',
          assemblyId: ASSEMBLY_ID,
          contentFingerprint: CONTENT_FINGERPRINT,
          referenceSignature: REFERENCE_SIGNATURE,
          relativePathHint: '../outside/reads.bam',
        },
      },
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      issues: [
        {
          code: 'invalid-document',
          message: expect.stringContaining('relativePathHint'),
        },
      ],
    });
  });

  it('restores validated reference, viewport, annotation, and ordered source recipes', async () => {
    const state = indexedGenome();
    state.dataTracks = [dataTrack('signal', 'quantitative', 0)];
    const projected = await projectPortableGenomeView(projectionInput(state));
    if (projected.status !== 'ready') throw new Error('Expected a portable document.');

    const restored = restorePortableGenomeView(projected.document);

    expect(restored.reference).toEqual(HOSTED_REFERENCE);
    expect(restored.indexedGenomeView).toEqual({
      scope: { kind: 'locus', chrom: 'chr1', start: 100, end: 900 },
      indexedViewport: { start0: 100, end0: 900 },
      viewportTarget: { chrom: 'chr1', start0: 100, end0: 900 },
      viewport: { kind: 'locus', chrom: 'chr1', start0: 100, end0: 900 },
    });
    expect(restored.annotation).toEqual({
      policy: { isoformMode: 'expanded', laneLimit: 8 },
      visibilityByTrackId: { genes: true, repeats: false },
      orderedTrackIds: ['genes', 'repeats'],
    });
    expect(restored.tracks.map((track) => track.trackId)).toEqual(['signal']);
    expect(JSON.stringify(restored)).not.toContain('uri');
  });

  it('rejects a hosted reference pin that does not match the current admitted bundle', async () => {
    const state = indexedGenome();
    const result = await projectPortableGenomeView({
      ...projectionInput(state),
      reference: { ...HOSTED_REFERENCE, bundleFingerprint: '0'.repeat(64) },
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'reference-identity-conflict' }),
      ]),
    });
  });

  it('does not treat inherited object properties as source identity pins', async () => {
    const state = indexedGenome();
    state.dataTracks = [dataTrack('constructor', 'quantitative', 0)];

    const result = await projectPortableGenomeView(projectionInput(state));

    expect(result).toMatchObject({
      status: 'ready',
      document: {
        tracks: [
          {
            trackId: 'constructor',
            source: HOSTED_TRACK_SOURCE,
          },
        ],
      },
    });
  });

  it('hashes real provider identity receipts while preserving existing SHA-256 identities', async () => {
    await expect(portableFingerprintFromIdentity(CONTENT_FINGERPRINT)).resolves.toBe(
      CONTENT_FINGERPRINT
    );
    await expect(
      portableFingerprintFromIdentity('ucsc-native\u0000hg38\u0000knownGene\u0000')
    ).resolves.toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('captures a zoomed live locus even while the assembly remains in all scope', async () => {
    const state = indexedGenome();
    state.scope = { kind: 'all' };

    const result = await projectPortableGenomeView(projectionInput(state));

    expect(result).toMatchObject({
      status: 'ready',
      document: { viewport: { kind: 'locus', chrom: 'chr1', start0: 100, end0: 900 } },
    });
  });

  it('captures and restores a cross-chromosome assembly camera without collapsing to all', async () => {
    const state = indexedGenome();
    state.scope = { kind: 'all' };
    state.assembly!.chromosomes.push({
      chrom: 'chr2',
      length: 1_000,
      manifest: {
        chrom: 'chr2',
        fastaPath: '/runtime/cache/grch38/chr2.fa',
        faiPath: '/runtime/cache/grch38/chr2.fa.fai',
      },
    });

    const result = await projectPortableGenomeView({
      ...projectionInput(state),
      liveViewport: null,
      assemblyViewportRange: { start0: 248_956_000, end0: 248_957_000 },
    });

    expect(result).toMatchObject({
      status: 'ready',
      document: {
        viewport: { kind: 'assembly-range', start0: 248_956_000, end0: 248_957_000 },
      },
    });
    if (result.status !== 'ready') throw new Error('Expected a portable document.');
    expect(restorePortableGenomeView(result.document).indexedGenomeView).toMatchObject({
      scope: { kind: 'all' },
      indexedViewport: { start0: 248_956_000, end0: 248_957_000 },
      viewport: { kind: 'assembly-range', start0: 248_956_000, end0: 248_957_000 },
    });
  });
});

describe('portableAdmittedContentFingerprint', () => {
  const generation = (root: string, mtimeNs: string) => ({
    contract: 'aligned-read-source-generation.v1' as const,
    alignment: { canonicalPath: `${root}/reads.cram`, size: 757, mtimeNs, ctimeNs: `${mtimeNs}7` },
    index: { canonicalPath: `${root}/reads.cram.crai`, size: 45, mtimeNs, ctimeNs: `${mtimeNs}7` },
  });
  const localReads = (root: string, mtimeNs = '1700000000000000000'): AdmittedTrackSource =>
    admittedSource('reads', {
      admissionVersion: 2,
      readerKind: 'bam',
      formatId: 'cram',
      fingerprint: `sha256:${root.length.toString(16).padStart(64, '0')}`,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: ASSEMBLY_ID,
        source: { kind: 'local-file', path: `${root}/reads.cram` },
        formatId: 'cram',
        ingress: { kind: 'file-picker' },
      },
      alignedReadGeneration: generation(root, mtimeNs),
    });

  it('identifies local reads by their bytes, not by where they live', async () => {
    const saved = await portableAdmittedContentFingerprint(localReads('/lab/run1'));
    expect(saved).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(await portableAdmittedContentFingerprint(localReads('/mnt/moved'))).toBe(saved);
    expect(
      await portableAdmittedContentFingerprint(localReads('/lab/run1', '1800000000000000000'))
    ).not.toBe(saved);
  });

  it('identifies local calls by the prepared file size and modification time', async () => {
    const calls = admittedSource('variants', {
      admissionVersion: 2,
      readerKind: 'variant',
      formatId: 'vcf',
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: ASSEMBLY_ID,
        source: { kind: 'local-file', path: '/lab/calls.vcf.gz' },
        formatId: 'vcf',
        ingress: { kind: 'file-picker' },
      },
    });
    const saved = await portableAdmittedContentFingerprint(calls, {
      sizeBytes: 4096,
      mtimeNs: '1700000000000000000',
    });
    expect(
      await portableAdmittedContentFingerprint(
        { ...calls, fingerprint: `sha256:${'1'.repeat(64)}` },
        { sizeBytes: 4096, mtimeNs: '1700000000000000000' }
      )
    ).toBe(saved);
    expect(
      await portableAdmittedContentFingerprint(calls, {
        sizeBytes: 4097,
        mtimeNs: '1700000000000000000',
      })
    ).not.toBe(saved);
  });

  it('keeps the admission fingerprint for remote and content-hashed sources', async () => {
    const remote = admittedSource('quantitative', {
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: ASSEMBLY_ID,
        source: { kind: 'http', url: 'https://example.invalid/signal.bw' },
        formatId: 'bigwig',
        ingress: { kind: 'url' },
      },
    });
    expect(await portableAdmittedContentFingerprint(remote)).toBe(
      await portableFingerprintFromIdentity(remote.fingerprint)
    );
  });
});
