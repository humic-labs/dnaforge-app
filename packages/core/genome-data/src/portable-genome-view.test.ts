import { describe, expect, it } from 'vitest';
import {
  createTrackAdmissionRequestId,
  directTrackAdmissionRequest,
} from './track-admission-request';

import {
  MAX_PORTABLE_GENOME_VIEW_BYTES,
  PORTABLE_GENOME_VIEW_SCHEMA,
  migratePortableGenomeViewDocument,
  parsePortableGenomeViewDocument,
  serializePortableGenomeViewDocument,
  type PortableGenomeViewDocument,
  type PortableGenomeViewTrack,
} from './portable-genome-view';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SOURCE_FINGERPRINT = 'd'.repeat(24);

function hostedDocument(): PortableGenomeViewDocument {
  return {
    schema: PORTABLE_GENOME_VIEW_SCHEMA,
    kind: 'indexed-genome-view',
    id: 'view-grch38-locus-1',
    name: 'GRCh38 review locus',
    provenance: {
      createdAt: '2026-09-01T16:00:00.000Z',
      updatedAt: '2026-09-01T16:05:00.000Z',
      createdBy: { kind: 'user', id: 'user-local' },
    },
    reference: {
      kind: 'hosted-reference',
      catalogId: 'hg38',
      assemblyId: 'GRCh38',
      bundleFingerprint: SHA_A,
      sourceFingerprint: SOURCE_FINGERPRINT,
      inventoryFingerprint: SHA_B,
    },
    viewport: { kind: 'locus', chrom: 'chr11', start0: 5_220_000, end0: 5_225_000 },
    annotation: {
      policy: { isoformMode: 'canonical', laneLimit: 2 },
      visibilityByTrackId: { gene: true, mRNA: false },
      orderedTrackIds: ['gene', 'mRNA'],
    },
    tracks: [
      {
        trackId: 'ucsc:knownGene',
        trackType: 'transcript',
        label: 'Known genes',
        order: 0,
        visible: true,
        source: {
          kind: 'hosted-track',
          provider: 'ucsc',
          catalogId: 'knownGene',
          assemblyId: 'GRCh38',
          contentFingerprint: `sha256:${SHA_C}`,
          referenceSignature: `sha256:${SHA_A}`,
        },
        presentation: {
          kind: 'annotation',
          color: '#3366cc',
          trackHeightPx: 48,
          laneHeightPx: 8,
          maxLanes: 12,
        },
      },
      {
        trackId: 'reads:tumor',
        trackType: 'reads',
        label: 'Tumor reads',
        order: 1,
        visible: false,
        source: {
          kind: 'workspace-track',
          entityId: 'alignment-tumor-1',
          assemblyId: 'GRCh38',
          contentFingerprint: `sha256:${SHA_B}`,
          referenceSignature: `sha256:${SHA_A}`,
          relativePathHint: 'Tracks/tumor.bam',
        },
        presentation: { kind: 'aligned-reads', coverageCutoffDepth: 400 },
      },
    ],
  };
}

function workspaceDocument(): PortableGenomeViewDocument {
  return {
    ...hostedDocument(),
    id: 'view-workspace-reference-1',
    reference: {
      kind: 'workspace-reference',
      entityId: 'reference-hg002-1',
      assemblyId: 'HG002',
      contentFingerprint: `sha256:${SHA_A}`,
      referenceSignature: `sha256:${SHA_B}`,
      relativePathHint: 'References/HG002/reference.fna',
    },
    viewport: { kind: 'chromosome', chrom: 'chr1' },
    tracks: [],
  };
}

function expectRejected(value: unknown, message: string): void {
  expect(() => parsePortableGenomeViewDocument(JSON.stringify(value))).toThrow(message);
}

describe('portable genome view document', () => {
  it('preserves the data track ID produced by an ordinary local file attachment', () => {
    const baseDocument = hostedDocument();
    const trackId = createTrackAdmissionRequestId(
      directTrackAdmissionRequest({
        assemblyId: 'GRCh38',
        input: { kind: 'path', path: '/data/regions.bed' },
        formatId: 'bed',
        scientificKind: 'interval',
        ingress: 'file-picker',
      })
    );
    const document: PortableGenomeViewDocument = {
      ...baseDocument,
      tracks: baseDocument.tracks.map((track, index) =>
        index === 0 ? { ...track, trackId } : track
      ),
    };
    expect(trackId).toMatch(/^data:regions\.bed-/u);
    expect(parsePortableGenomeViewDocument(serializePortableGenomeViewDocument(document))).toEqual(
      document
    );
  });

  it('round-trips a hosted-reference pointer recipe without runtime source bytes', () => {
    const document = hostedDocument();
    const serialized = serializePortableGenomeViewDocument(document);

    expect(parsePortableGenomeViewDocument(serialized)).toEqual(document);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized).not.toContain('fastaPath');
    expect(serialized).not.toContain('outputDir');
    expect(serialized).not.toContain('readiness');
    expect(serialized).not.toContain('records');
  });

  it('round-trips a workspace-reference pointer with a portable relative hint', () => {
    const document = workspaceDocument();

    expect(parsePortableGenomeViewDocument(serializePortableGenomeViewDocument(document))).toEqual(
      document
    );
  });

  it('preserves real annotation track IDs without sanitizing them', () => {
    const document: PortableGenomeViewDocument = {
      ...hostedDocument(),
      annotation: {
        ...hostedDocument().annotation,
        visibilityByTrackId: {
          'genomic DNA': true,
          'RNA/DNA ratio': false,
          'HGVS c.76A>T': true,
        },
        orderedTrackIds: ['genomic DNA', 'RNA/DNA ratio', 'HGVS c.76A>T'],
      },
    };

    expect(parsePortableGenomeViewDocument(serializePortableGenomeViewDocument(document))).toEqual(
      document
    );
  });

  it('accepts every explicit viewport and presentation variant', () => {
    const base = workspaceDocument();
    const variants: PortableGenomeViewDocument[] = [
      { ...base, viewport: { kind: 'all' } },
      { ...base, viewport: { kind: 'chromosome', chrom: 'chr1' } },
      { ...base, viewport: { kind: 'locus', chrom: 'chr1', start0: 0, end0: 1 } },
      { ...base, viewport: { kind: 'assembly-range', start0: 248_956_410, end0: 248_956_432 } },
      {
        ...base,
        tracks: [
          {
            trackId: 'signal-1',
            trackType: 'quantitative',
            label: 'Signal',
            order: 0,
            visible: true,
            source: {
              kind: 'workspace-track',
              entityId: 'signal-source-1',
              assemblyId: 'HG002',
              contentFingerprint: `sha256:${SHA_A}`,
              referenceSignature: `sha256:${SHA_B}`,
            },
            presentation: {
              kind: 'quantitative',
              color: '#112233',
              trackHeightPx: 72,
              scale: { kind: 'fixed', min: 0, max: 100, transform: 'linear' },
            },
          },
          {
            trackId: 'variants-1',
            trackType: 'variants',
            label: 'Variants',
            order: 1,
            visible: true,
            source: {
              kind: 'workspace-track',
              entityId: 'variant-source-1',
              assemblyId: 'HG002',
              contentFingerprint: `sha256:${SHA_C}`,
              referenceSignature: `sha256:${SHA_B}`,
            },
            presentation: {
              kind: 'variants',
              selectedSamples: ['sample-a', 'sample-b'],
              filteredToPassing: true,
            },
          },
        ],
      },
    ];

    for (const document of variants) {
      expect(
        parsePortableGenomeViewDocument(serializePortableGenomeViewDocument(document))
      ).toEqual(document);
    }
  });

  it('exposes a migration boundary for current documents', () => {
    expect(migratePortableGenomeViewDocument(hostedDocument())).toEqual(hostedDocument());
  });

  it('migrates V1 without inventing sequence facts and retains every saved setting', () => {
    const current = hostedDocument();
    expect(
      migratePortableGenomeViewDocument({ ...current, schema: 'dnaforge.genome-view.v1' })
    ).toEqual(current);
  });

  it('rejects unknown future schemas instead of guessing', () => {
    expectRejected(
      { ...hostedDocument(), schema: 'dnaforge.genome-view.v3' },
      'unsupported schema'
    );
  });

  it('rejects oversized input before parsing', () => {
    const content = ' '.repeat(MAX_PORTABLE_GENOME_VIEW_BYTES + 1);

    expect(() => parsePortableGenomeViewDocument(content)).toThrow('exceeds');
  });

  it('refuses to serialize a document that its own input budget would reject', () => {
    const document = workspaceDocument();
    const selectedSamples = Array.from(
      { length: 1_024 },
      (_, index) => `sample-${index}-${'x'.repeat(130)}`
    );
    const tracks = Array.from(
      { length: 8 },
      (_, order): PortableGenomeViewTrack => ({
        trackId: `variants-${order}`,
        trackType: 'variants',
        label: `Variants ${order}`,
        order,
        visible: true,
        source: {
          kind: 'workspace-track',
          entityId: `variant-source-${order}`,
          assemblyId: 'HG002',
          contentFingerprint: `sha256:${SHA_C}`,
          referenceSignature: `sha256:${SHA_B}`,
        },
        presentation: {
          kind: 'variants',
          selectedSamples,
          filteredToPassing: true,
        },
      })
    );

    expect(() => serializePortableGenomeViewDocument({ ...document, tracks })).toThrow(
      'output limit'
    );
  });

  it.each([
    ['/absolute/reference.fna', 'absolute'],
    ['C:\\reference\\reference.fna', 'absolute'],
    ['../reference/reference.fna', 'traversal'],
    ['References/../reference.fna', 'traversal'],
  ])('rejects non-portable workspace path %s', (relativePathHint, message) => {
    const document = workspaceDocument();
    const reference = document.reference;
    if (reference.kind !== 'workspace-reference') throw new Error('fixture reference changed');

    expectRejected({ ...document, reference: { ...reference, relativePathHint } }, message);
  });

  it('rejects credentials and URL locators, including inert signed-URL canaries', () => {
    const document = hostedDocument();
    const first = document.tracks[0];
    if (!first || first.source.kind !== 'hosted-track') throw new Error('fixture track changed');

    expectRejected(
      {
        ...document,
        tracks: [
          {
            ...first,
            source: {
              ...first.source,
              url: 'https://example.invalid/track?X-Amz-Signature=INERT_CANARY',
            },
          },
        ],
      },
      'URL'
    );
    expectRejected(
      { ...document, name: 'track.bigwig?X-Amz-Signature=INERT_CANARY' },
      'signed URL'
    );
    expectRejected({ ...document, name: 'Bearer INERT_CREDENTIAL_CANARY' }, 'credential');
    expectRejected({ ...document, credential: 'INERT_CREDENTIAL_CANARY' }, 'credential');
  });

  it.each([
    ['GitHub token', `ghp_${'A'.repeat(32)}`],
    ['GitHub fine-grained token', `github_pat_${'A'.repeat(32)}`],
    ['AWS access key', `AKIA${'A'.repeat(16)}`],
    ['JWT', `eyJ${'A'.repeat(12)}.${'B'.repeat(12)}.${'C'.repeat(12)}`],
    ['provider API key', `sk-proj-${'A'.repeat(32)}`],
  ])('rejects an inert %s-shaped value in an allowed display field', (_kind, name) => {
    expectRejected({ ...hostedDocument(), name }, 'credential value');
  });

  it.each([
    ['embedded HTTPS URL', 'Evidence at https://example.invalid/reference', 'URL locator'],
    ['embedded custom URL', 'Evidence at track+canary://example.invalid/reference', 'URL locator'],
    ['embedded file URI', 'Evidence at file:/var/tmp/inert-reference', 'URL locator'],
    ['embedded email URI', 'Contact mailto:curator@example.invalid', 'URL locator'],
    ['embedded URN', 'Identity urn:example:inert-reference', 'URL locator'],
    ['embedded data URI', 'Payload data:text/plain,INERT_CANARY', 'URL locator'],
    ['embedded POSIX path', 'Evidence at /var/tmp/inert-reference', 'absolute path'],
    ['embedded Windows drive path', 'Evidence at C:\\Temp\\inert-reference', 'absolute path'],
    [
      'embedded Windows UNC path',
      'Evidence at \\\\inert-server\\inert-share\\reference',
      'absolute path',
    ],
  ])('rejects an %s recursively inside a nested label', (_case, label, message) => {
    const document = hostedDocument();
    const first = document.tracks[0];
    if (!first) throw new Error('fixture track changed');

    expectRejected({ ...document, tracks: [{ ...first, label }] }, message);
  });

  it.each([
    ['https://example.invalid/inert-track', 'URL locator'],
    ['/var/tmp/inert-track', 'absolute path'],
    ['C:\\Temp\\inert-track', 'absolute path'],
  ])('rejects locator-shaped annotation map key %s', (trackId, message) => {
    const document = hostedDocument();

    expectRejected(
      {
        ...document,
        annotation: {
          ...document.annotation,
          visibilityByTrackId: { [trackId]: true },
        },
      },
      message
    );
  });

  it.each([
    ['bundleFingerprint', 'bad'],
    ['sourceFingerprint', 'a'.repeat(23)],
    ['inventoryFingerprint', 'g'.repeat(64)],
  ])('rejects invalid hosted-reference %s', (field, invalid) => {
    const document = hostedDocument();
    const reference = document.reference;
    if (reference.kind !== 'hosted-reference') throw new Error('fixture reference changed');

    expectRejected({ ...document, reference: { ...reference, [field]: invalid } }, 'fingerprint');
  });

  it('carries admitted-source tracks as durable requests and refuses credential material', () => {
    const base = hostedDocument();
    const admitted = {
      kind: 'admitted-source' as const,
      assemblyId: base.reference.assemblyId,
      contentFingerprint: `sha256:${'a'.repeat(64)}`,
      referenceSignature: `sha256:${'b'.repeat(64)}`,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: base.reference.assemblyId,
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
        formatId: 'cram',
        scientificKind: 'reads',
        label: 'Lab reads',
        ingress: { kind: 'url' },
      },
    };
    const [firstTrack] = base.tracks;
    if (!firstTrack) throw new Error('hosted document fixture has no tracks');
    const track = {
      ...firstTrack,
      trackId: 'lab-reads',
      trackType: 'aligned-reads',
      order: base.tracks.length,
      source: admitted,
      presentation: { kind: 'aligned-reads' as const, coverageCutoffDepth: 0 },
    };
    const parsed = migratePortableGenomeViewDocument({ ...base, tracks: [...base.tracks, track] });
    const restored = parsed.tracks.at(-1)?.source;
    expect(restored).toMatchObject({ kind: 'admitted-source', request: { formatId: 'cram' } });
    if (restored?.kind !== 'admitted-source') throw new Error('expected an admitted source');
    expect(restored.request.source).toEqual(admitted.request.source);

    expect(() =>
      migratePortableGenomeViewDocument({
        ...base,
        tracks: [
          ...base.tracks,
          {
            ...track,
            source: {
              ...admitted,
              request: {
                ...admitted.request,
                source: {
                  kind: 'http',
                  url: 'https://private.example.org/reads.cram?X-Amz-Signature=INERT_SIGNATURE_CANARY',
                },
              },
            },
          },
        ],
      })
    ).toThrow(/credential parameters|signed URL/u);
    expect(() =>
      migratePortableGenomeViewDocument({
        ...base,
        tracks: [
          ...base.tracks,
          {
            ...track,
            source: { ...admitted, request: { ...admitted.request, assemblyId: 'other' } },
          },
        ],
      })
    ).toThrow(/names assembly other/u);
  });

  it('rejects invalid content fingerprints', () => {
    const document = workspaceDocument();
    const reference = document.reference;
    if (reference.kind !== 'workspace-reference') throw new Error('fixture reference changed');

    expectRejected(
      { ...document, reference: { ...reference, contentFingerprint: 'git:deadbeef' } },
      'fingerprint'
    );
  });

  it.each([
    [{ kind: 'locus', chrom: 'chr1', start0: -1, end0: 10 }, 'start0'],
    [{ kind: 'locus', chrom: 'chr1', start0: 10, end0: 10 }, 'end0'],
    [{ kind: 'locus', chrom: 'chr1', start0: 20, end0: 10 }, 'end0'],
    [{ kind: 'locus', chrom: 'chr1', start0: 1.5, end0: 10 }, 'start0'],
    [{ kind: 'assembly-range', start0: -1, end0: 10 }, 'start0'],
    [{ kind: 'assembly-range', start0: 10, end0: 10 }, 'end0'],
    [{ kind: 'assembly-range', start0: 20, end0: 10 }, 'end0'],
    [{ kind: 'assembly-range', start0: 1.5, end0: 10 }, 'start0'],
  ])('rejects invalid half-open viewport %o', (viewport, message) => {
    expectRejected({ ...hostedDocument(), viewport }, message);
  });

  it('rejects duplicate track IDs and duplicate global orders', () => {
    const document = hostedDocument();
    const [first, second] = document.tracks;
    if (!first || !second) throw new Error('fixture tracks changed');

    expectRejected(
      { ...document, tracks: [first, { ...second, trackId: first.trackId }] },
      'duplicated track ID'
    );
    expectRejected(
      { ...document, tracks: [first, { ...second, order: first.order }] },
      'duplicated track order'
    );
  });

  it('rejects duplicate annotation ordering and invalid annotation policy', () => {
    const document = hostedDocument();

    expectRejected(
      {
        ...document,
        annotation: { ...document.annotation, orderedTrackIds: ['gene', 'gene'] },
      },
      'annotation track order'
    );
    expectRejected(
      {
        ...document,
        annotation: {
          ...document.annotation,
          policy: { isoformMode: 'canonical', laneLimit: 0 },
        },
      },
      'laneLimit'
    );
  });

  it.each([
    [
      'an ordered annotation omitted from the visibility map',
      { visibilityByTrackId: { gene: true }, orderedTrackIds: ['gene', 'mRNA'] },
    ],
    [
      'a visible annotation omitted from the saved order',
      { visibilityByTrackId: { gene: true, mRNA: false }, orderedTrackIds: ['gene'] },
    ],
  ])('rejects inconsistent annotation membership when %s', (_scenario, annotation) => {
    const document = hostedDocument();

    expectRejected(
      { ...document, annotation: { ...document.annotation, ...annotation } },
      'must name exactly the same tracks'
    );
  });

  it('rejects unknown runtime and decoded-data fields at every strict boundary', () => {
    const document = hostedDocument();
    const first = document.tracks[0];
    if (!first) throw new Error('fixture track changed');

    expectRejected({ ...document, outputDir: 'cache' }, 'unsupported field');
    expectRejected(
      { ...document, tracks: [{ ...first, records: [{ start: 1, end: 2 }] }] },
      'unsupported field'
    );
  });
});
