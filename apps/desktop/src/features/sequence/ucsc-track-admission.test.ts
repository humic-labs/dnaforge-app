import { beforeEach, describe, expect, it, vi } from 'vitest';

import { datasetForAdmittedTrack } from './admitted-track-dataset';
import { admitUcscCatalogTrackSource, hubDataTrackAdmissionRequest } from './ucsc-track-admission';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  fetchWhole: vi.fn(),
  open: vi.fn(),
  queryQuantitative: vi.fn(),
  closeSource: vi.fn(),
}));

vi.mock('./ucsc-track-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ucsc-track-client')>()),
  admitUcscTrack: mocks.admit,
  fetchUcscWholeTrack: mocks.fetchWhole,
}));

vi.mock('./bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: mocks.open,
    queryQuantitative: mocks.queryQuantitative,
    closeSource: mocks.closeSource,
  }),
}));

const TRACK = {
  sourceKind: 'ucsc-native' as const,
  catalogId: 'hg38:gc5BaseBw',
  track: 'gc5BaseBw',
  shortLabel: 'GC Percent',
  longLabel: 'GC percent in 5-base windows',
  scientificKind: 'quantitative' as const,
  formatId: 'bigwig' as const,
  assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
  bigDataUrl: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5Base.bw',
};

const CPG_TRACK = {
  sourceKind: 'ucsc-native' as const,
  catalogId: 'hg38:cpgIslandExt',
  track: 'cpgIslandExt',
  shortLabel: 'CpG Islands',
  longLabel: 'CpG Islands (Islands under 300 bases are light green)',
  scientificKind: 'interval' as const,
  formatId: 'ucsc-native' as const,
  assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
  type: 'bed 4 +',
};

const BIGBED_TRACK = {
  sourceKind: 'ucsc-native' as const,
  catalogId: 'hg38:genes',
  track: 'genes',
  shortLabel: 'Hub genes',
  longLabel: 'Transcript models from UCSC',
  scientificKind: 'transcript' as const,
  formatId: 'bigbed' as const,
  assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
  bigDataUrl: 'https://hgdownload.example.org/genes.bb',
};

describe('UCSC track admission', () => {
  beforeEach(() => {
    mocks.admit.mockReset().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:8042',
      sourceUri: TRACK.bigDataUrl,
      sourceToken: 'opaque-token',
      canonicalUrlHash: 'url-hash',
      representationSha256: 'd'.repeat(64),
      representationIdentityKind: 'strong-etag',
      byteLength: 1_764_507_851,
      etag: '"etag"',
      lastModified: 'Mon, 28 Jul 2026 00:00:00 GMT',
      provenanceId: 'provenance-id',
      expiresAtMs: Date.now() + 60_000,
    });
    mocks.open.mockReset().mockResolvedValue({
      fileType: 'bigwig',
      references: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ],
      zoomReductionLevels: [10, 100, 1_000],
      totalSummary: { basesCovered: 10, scoreMin: 0, scoreMax: 100 },
    });
    mocks.queryQuantitative.mockReset().mockResolvedValue([
      {
        starts: new Int32Array([0]),
        ends: new Int32Array([100]),
        values: new Float32Array([0, 10, 100]),
      },
    ]);
    mocks.fetchWhole.mockReset().mockResolvedValue({
      records: [{ chrom: 'chr1', chromStart: 28_735, chromEnd: 29_737, name: 'CpG: 111' }],
      complete: true,
      itemsReturned: 1,
      maxItemsOutput: 100_000,
      trackType: 'bed 4 +',
    });
    mocks.closeSource.mockReset().mockResolvedValue(undefined);
  });

  it('returns one durable source-neutral descriptor and keeps grants live-only', async () => {
    const source = await admitUcscCatalogTrackSource({
      assemblyId: 'grch38',
      assemblyReferences: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ],
      ucscTarget: { genomeId: 'hg38' },
      track: TRACK,
    });

    expect(source).toMatchObject({
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'grch38',
        source: {
          kind: 'ucsc-track',
          sourceKind: 'ucsc-native',
          genome: 'hg38',
          track: 'gc5BaseBw',
        },
        formatId: 'bigwig',
        scientificKind: 'quantitative',
        label: 'GC Percent',
        ingress: { kind: 'catalog' },
      },
      uri: TRACK.bigDataUrl,
      formatId: 'bigwig',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      quantitativeColumnSemantics: 'continuous-signal',
      assemblyId: 'grch38',
      referenceReceipt: {
        checkedContigs: 2,
        status: 'compatible',
      },
      provenance: {
        provider: 'ucsc',
        catalogId: TRACK.catalogId,
        track: TRACK.track,
      },
      expectedValidators: {
        etag: '"etag"',
        contentLength: 1_764_507_851,
      },
      fingerprint: `sha256:${'d'.repeat(64)}`,
    });
    expect(source).not.toHaveProperty('sourceToken');
    expect(source).not.toHaveProperty('session');
    expect(mocks.closeSource).toHaveBeenCalledOnce();
    expect(mocks.closeSource).toHaveBeenCalledWith('ucsc-native\u0000hg38\u0000gc5BaseBw\u0000');
  });

  it('changes the durable BigWig fingerprint when the exact representation identity changes', async () => {
    const admissionInput = {
      assemblyId: 'grch38',
      assemblyReferences: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ],
      ucscTarget: { genomeId: 'hg38' },
      track: TRACK,
    };
    const first = await admitUcscCatalogTrackSource(admissionInput);
    mocks.admit.mockResolvedValueOnce({
      baseUrl: 'http://127.0.0.1:8042',
      sourceUri: TRACK.bigDataUrl,
      sourceToken: 'opaque-token-2',
      canonicalUrlHash: 'url-hash',
      representationSha256: 'e'.repeat(64),
      representationIdentityKind: 'content-sha256',
      byteLength: 1_764_507_851,
      etag: '"etag"',
      lastModified: 'Mon, 28 Jul 2026 00:00:00 GMT',
      provenanceId: 'provenance-id',
      expiresAtMs: Date.now() + 60_000,
    });
    const changed = await admitUcscCatalogTrackSource(admissionInput);

    expect(first.fingerprint).toBe(`sha256:${'d'.repeat(64)}`);
    expect(changed.fingerprint).toBe(`sha256:${'e'.repeat(64)}`);
  });

  it('does not admit a source whose reference lengths diverge', async () => {
    mocks.open.mockResolvedValueOnce({
      fileType: 'bigwig',
      references: [{ name: 'chr1', length: 1 }],
      zoomReductionLevels: [],
    });

    await expect(
      admitUcscCatalogTrackSource({
        assemblyId: 'grch38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        ucscTarget: { genomeId: 'hg38' },
        track: TRACK,
      })
    ).rejects.toThrow('BigWig reference mismatch for chr1');
    expect(mocks.closeSource).toHaveBeenCalledOnce();
  });

  it('admits a sparse signal that has no chromosome Y without inventing a mapping for it', async () => {
    const source = await admitUcscCatalogTrackSource({
      assemblyId: 'grch38',
      assemblyReferences: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
        { name: 'chrY', length: 57_227_415 },
      ],
      ucscTarget: { genomeId: 'hg38' },
      track: TRACK,
    });

    expect(source.referenceReceipt).toMatchObject({
      checkedContigs: 2,
      status: 'compatible',
      contigMap: { chr1: 'chr1', chr2: 'chr2' },
    });
    expect(source.referenceReceipt.contigMap).not.toHaveProperty('chrY');
  });

  it('requests a complete native admission snapshot up to the provider million-record limit', async () => {
    await admitUcscCatalogTrackSource({
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      ucscTarget: { genomeId: 'hg38' },
      track: CPG_TRACK,
    });

    expect(mocks.fetchWhole).toHaveBeenCalledWith({
      genome: 'hg38',
      track: 'cpgIslandExt',
      hubUrl: undefined,
      maxItemsOutput: 1_000_000,
    });
  });

  it('opens a signal on the range its publisher drew it against', async () => {
    const source = await admitUcscCatalogTrackSource({
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      ucscTarget: { genomeId: 'hg38' },
      track: {
        ...TRACK,
        signalScale: { auto: false, alwaysZero: true, minimum: 0, maximum: 30 },
      },
    });

    expect(source).toMatchObject({ publishedSignalScale: { minimum: 0, maximum: 30 } });

    const dataset = datasetForAdmittedTrack({
      trackId: 'ucsc:hg38-gc5BaseBw',
      label: 'GC Percent',
      source,
    });
    expect(dataset.quantitativePresentation?.scale).toMatchObject({
      mode: 'fixed',
      min: 0,
      max: 30,
    });

    const unscaled = await admitUcscCatalogTrackSource({
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      ucscTarget: { genomeId: 'hg38' },
      track: TRACK,
    });
    expect(unscaled).not.toHaveProperty('publishedSignalScale');
    expect(
      datasetForAdmittedTrack({ trackId: 't', label: 'l', source: unscaled })
        .quantitativePresentation?.scale.mode
    ).not.toBe('fixed');
  });

  it('admits a semantic BigBed without running quantitative sampling', async () => {
    mocks.admit.mockResolvedValueOnce({
      baseUrl: 'http://127.0.0.1:8042',
      sourceUri: BIGBED_TRACK.bigDataUrl,
      sourceToken: 'opaque-bigbed-token',
      canonicalUrlHash: 'bigbed-url-hash',
      representationSha256: 'b'.repeat(64),
      representationIdentityKind: 'content-sha256',
      byteLength: 50_000,
      etag: '"bigbed-etag"',
      provenanceId: 'bigbed-provenance',
      expiresAtMs: Date.now() + 60_000,
    });
    mocks.open.mockResolvedValueOnce({
      fileType: 'bigbed',
      references: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ],
      zoomReductionLevels: [],
      fieldCount: 12,
    });

    const source = await admitUcscCatalogTrackSource({
      assemblyId: 'grch38',
      assemblyReferences: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ],
      ucscTarget: { genomeId: 'hg38' },
      track: BIGBED_TRACK,
    });

    expect(mocks.admit).toHaveBeenCalledWith({
      genome: 'hg38',
      track: 'genes',
      formatId: 'bigbed',
      probeChrom: 'chr1',
      hubUrl: undefined,
    });
    expect(source).toMatchObject({
      admissionVersion: 2,
      request: {
        source: { kind: 'ucsc-track', sourceKind: 'ucsc-native' },
        formatId: 'bigbed',
        scientificKind: 'transcript',
        ingress: { kind: 'catalog' },
      },
      uri: BIGBED_TRACK.bigDataUrl,
      formatId: 'bigbed',
      recommendedTypes: ['imported-transcript'],
      readerKind: 'bbi',
      scientificKind: 'transcript',
      fingerprint: `sha256:${'b'.repeat(64)}`,
      provenance: { sourceKind: 'ucsc-native' },
    });
    expect(source).not.toHaveProperty('quantitativeSummary');
    expect(mocks.queryQuantitative).not.toHaveBeenCalled();
    expect(mocks.closeSource).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'genePred gene models',
      'ncbiRefSeq',
      'NCBI RefSeq',
      'genePred',
      'transcript',
      ['imported-transcript'],
    ],
    ['ENCODE peak calls', 'encTfChipPk', 'TF ChIP peaks', 'narrowPeak', 'peak', ['peak']],
    ['RepeatMasker', 'rmsk', 'RepeatMasker', 'rmsk', 'repeat', ['repeat']],
  ] as const)(
    'keeps the meaning UCSC declared for native %s',
    async (_label, track, shortLabel, type, scientificKind, recommendedTypes) => {
      const source = await admitUcscCatalogTrackSource({
        assemblyId: 'grch38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        ucscTarget: { genomeId: 'hg38' },
        track: {
          ...CPG_TRACK,
          catalogId: `hg38:${track}`,
          track,
          shortLabel,
          type,
          scientificKind,
        },
      });

      expect(source).toMatchObject({
        formatId: 'ucsc-native',
        readerKind: 'ucsc-rest',
        scientificKind,
        recommendedTypes,
        request: { scientificKind, formatId: 'ucsc-native' },
      });
    }
  );

  it('admits a native CpG interval through the UCSC REST reader without BBI probing', async () => {
    const source = await admitUcscCatalogTrackSource({
      assemblyId: 'grch38',
      assemblyReferences: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ],
      ucscTarget: { genomeId: 'hg38' },
      track: CPG_TRACK,
    });

    expect(source).toMatchObject({
      admissionVersion: 2,
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: 'grch38',
        source: {
          kind: 'ucsc-track',
          sourceKind: 'ucsc-native',
          genome: 'hg38',
          track: 'cpgIslandExt',
        },
        formatId: 'ucsc-native',
        scientificKind: 'interval',
        label: 'CpG Islands',
        ingress: { kind: 'catalog' },
      },
      uri: 'ucsc://hg38/cpgIslandExt',
      input: { kind: 'url', url: 'ucsc://hg38/cpgIslandExt' },
      formatId: 'ucsc-native',
      recommendedTypes: ['generic-interval'],
      readerKind: 'ucsc-rest',
      scientificKind: 'interval',
      assemblyId: 'grch38',
      referenceReceipt: {
        assemblyId: 'grch38',
        contigMap: { chr1: 'chr1', chr2: 'chr2' },
        checkedContigs: 2,
        status: 'compatible',
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: 'ucsc-native',
        catalogId: 'hg38:cpgIslandExt',
        ucscGenome: 'hg38',
        track: 'cpgIslandExt',
        label: 'CpG Islands',
      },
    });
    expect(source.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(source.referenceReceipt.sourceSignature).toBe(source.fingerprint);
    expect(mocks.fetchWhole).toHaveBeenCalledWith({
      genome: 'hg38',
      track: 'cpgIslandExt',
      hubUrl: undefined,
      maxItemsOutput: 1_000_000,
    });
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('binds a native REST source fingerprint to the complete normalized track content', async () => {
    const admissionInput = {
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      ucscTarget: { genomeId: 'hg38' },
      track: CPG_TRACK,
    };
    const first = await admitUcscCatalogTrackSource(admissionInput);
    mocks.fetchWhole.mockResolvedValueOnce({
      records: [{ chrom: 'chr1', chromStart: 28_735, chromEnd: 29_738, name: 'CpG: 111' }],
      complete: true,
      itemsReturned: 1,
      maxItemsOutput: 100_000,
      trackType: 'bed 4 +',
    });
    const changed = await admitUcscCatalogTrackSource(admissionInput);

    expect(changed.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it('does not treat UCSC response ordering as a content revision', async () => {
    const records = [
      { chrom: 'chr1', chromStart: 10, chromEnd: 20, name: 'A' },
      { chrom: 'chr1', chromStart: 30, chromEnd: 40, name: 'B' },
    ];
    mocks.fetchWhole.mockResolvedValueOnce({
      records,
      complete: true,
      itemsReturned: records.length,
      maxItemsOutput: 100_000,
      trackType: 'bed 4 +',
    });
    const input = {
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      ucscTarget: { genomeId: 'hg38' },
      track: CPG_TRACK,
    };
    const first = await admitUcscCatalogTrackSource(input);
    mocks.fetchWhole.mockResolvedValueOnce({
      records: [...records].reverse(),
      complete: true,
      itemsReturned: records.length,
      maxItemsOutput: 100_000,
      trackType: 'bed 4 +',
    });
    const reordered = await admitUcscCatalogTrackSource(input);

    expect(reordered.fingerprint).toBe(first.fingerprint);
  });

  it('fails closed when UCSC cannot provide a complete native REST snapshot', async () => {
    mocks.fetchWhole.mockResolvedValueOnce({
      records: [],
      complete: false,
      itemsReturned: 100_000,
      maxItemsOutput: 100_000,
      trackType: 'bed 4 +',
    });

    await expect(
      admitUcscCatalogTrackSource({
        assemblyId: 'grch38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        ucscTarget: { genomeId: 'hg38' },
        track: CPG_TRACK,
      })
    ).rejects.toThrow('has no exact content revision');
  });

  it('rejects native tracks that do not match the exact assembly mapping', async () => {
    await expect(
      admitUcscCatalogTrackSource({
        assemblyId: 'grch38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        ucscTarget: { genomeId: 'ce11' },
        track: { ...CPG_TRACK, assembly: { ucscGenome: 'ce11', aliases: ['WBcel235'] } },
      })
    ).rejects.toThrow('maps to UCSC target hg38, not ce11');
  });

  it('admits a connected hub leaf on a target the hosted mapping does not know', async () => {
    const hubUrl = 'https://hub.example.org/hub.txt';
    mocks.open.mockResolvedValueOnce({
      fileType: 'bigbed',
      references: [{ name: 'chr1', length: 248_956_422 }],
      autoSql: 'table genes "genes" (string chrom; uint chromStart; uint chromEnd; string name;)',
    });
    mocks.admit.mockResolvedValueOnce({
      baseUrl: 'http://127.0.0.1:8042',
      sourceUri: 'https://hub.example.org/genes.bb',
      sourceToken: 'opaque-token',
      canonicalUrlHash: 'hub-url-hash',
      representationSha256: 'e'.repeat(64),
      representationIdentityKind: 'strong-etag',
      byteLength: 4_096,
      etag: '"hub-etag"',
      lastModified: null,
      provenanceId: 'provenance-id',
      expiresAtMs: Date.now() + 60_000,
    });

    const source = await admitUcscCatalogTrackSource({
      assemblyId: 'lab-assembly',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      ucscTarget: { genomeId: 'labAssembly', hubUrl },
      track: {
        ...BIGBED_TRACK,
        sourceKind: 'ucsc-hub',
        catalogId: 'labAssembly:genes',
        hubUrl,
        assembly: { ucscGenome: 'labAssembly', aliases: [] },
        bigDataUrl: 'genes.bb',
      },
    });

    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ genome: 'labAssembly', track: 'genes', hubUrl })
    );
    expect(source.request.source).toEqual({
      kind: 'ucsc-track',
      sourceKind: 'ucsc-hub',
      genome: 'labAssembly',
      track: 'genes',
      hubUrl,
    });
    expect(source.request.ingress).toEqual({ kind: 'hub' });
    expect(source.provenance).toMatchObject({ sourceKind: 'ucsc-hub', hubUrl });
  });

  it('turns hub reads and calls into durable HTTP admission requests', () => {
    const hubUrl = 'https://hub.example.org/lab/hub.txt';
    const ucscTarget = { genomeId: 'labAssembly', hubUrl };
    const reads = hubDataTrackAdmissionRequest({
      assemblyId: 'lab-assembly',
      ucscTarget,
      track: {
        ...BIGBED_TRACK,
        sourceKind: 'ucsc-hub',
        track: 'labReads',
        shortLabel: 'Lab reads',
        scientificKind: 'reads',
        formatId: 'bam',
        hubUrl,
        assembly: { ucscGenome: 'labAssembly', aliases: [] },
        bigDataUrl: 'data/sample.cram',
        bigDataIndex: 'data/sample.cram.crai',
      },
    });
    expect(reads).toEqual({
      contract: 'dnaforge.track-admission-request.v1',
      assemblyId: 'lab-assembly',
      source: { kind: 'http', url: 'https://hub.example.org/lab/data/sample.cram' },
      index: { kind: 'http', url: 'https://hub.example.org/lab/data/sample.cram.crai' },
      formatId: 'cram',
      scientificKind: 'reads',
      label: 'Lab reads',
      ingress: { kind: 'hub' },
    });

    const calls = hubDataTrackAdmissionRequest({
      assemblyId: 'lab-assembly',
      ucscTarget,
      track: {
        ...BIGBED_TRACK,
        sourceKind: 'ucsc-hub',
        track: 'labCalls',
        shortLabel: 'Lab calls',
        scientificKind: 'variants',
        formatId: 'vcf',
        hubUrl,
        assembly: { ucscGenome: 'labAssembly', aliases: [] },
        bigDataUrl: 'https://variants.example.org/calls.vcf.gz',
      },
    });
    expect(calls).toMatchObject({
      source: { kind: 'http', url: 'https://variants.example.org/calls.vcf.gz' },
      index: { kind: 'http', url: 'https://variants.example.org/calls.vcf.gz.tbi' },
      formatId: 'vcf',
      scientificKind: 'variants',
      ingress: { kind: 'hub' },
    });
    expect(() =>
      hubDataTrackAdmissionRequest({
        assemblyId: 'lab-assembly',
        ucscTarget,
        track: { ...BIGBED_TRACK, sourceKind: 'ucsc-hub', hubUrl },
      })
    ).toThrow('not a hub read or variant track');
  });

  it('rejects a native interval catalog leaf whose own genome differs', async () => {
    await expect(
      admitUcscCatalogTrackSource({
        assemblyId: 'grch38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        ucscTarget: { genomeId: 'hg38' },
        track: { ...CPG_TRACK, assembly: { ucscGenome: 'ce11', aliases: ['WBcel235'] } },
      })
    ).rejects.toThrow('belongs to ce11, not hg38');
  });

  it('admits GRCz12tu with the exact GenArk accession target', async () => {
    const track = {
      ...TRACK,
      catalogId: 'GCF_049306965.2:gc5BaseBw',
      assembly: { ucscGenome: 'GCF_049306965.2', aliases: ['GRCz12tu'] },
    };
    mocks.open.mockResolvedValueOnce({
      fileType: 'bigwig',
      references: [{ name: 'NC_091085.1', length: 59_659_304 }],
      zoomReductionLevels: [10],
    });

    const source = await admitUcscCatalogTrackSource({
      assemblyId: 'grcz12tu',
      assemblyReferences: [{ name: 'NC_091085.1', length: 59_659_304 }],
      ucscTarget: { genomeId: 'GCF_049306965.2' },
      track,
    });

    expect(mocks.admit).toHaveBeenCalledWith({
      genome: 'GCF_049306965.2',
      track: 'gc5BaseBw',
      formatId: 'bigwig',
      probeChrom: 'NC_091085.1',
      hubUrl: undefined,
    });
    expect(source).toMatchObject({
      assemblyId: 'grcz12tu',
      provenance: { ucscGenome: 'GCF_049306965.2' },
    });
    expect(source.provenance.ucscGenome).not.toBe('GRCz12tu');
    expect(source.provenance.ucscGenome).not.toBe('GCF_049306965.1');
  });
});
