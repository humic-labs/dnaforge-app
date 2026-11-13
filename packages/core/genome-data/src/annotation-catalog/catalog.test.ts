import { reverseComplement } from '@waypoint/sequence-utils/iupac';
import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_TRACK_LAYOUT_SCHEMA,
  DEFAULT_FILTER,
  DEFAULT_PRESENTATION,
  applyAnnotationTrackCommand,
  assemblyAccession,
  createAnnotationSourceCatalog,
  createAnnotationVisualizationCatalog,
  createSourceRecordCache,
  operonsByDistanceSource,
  parseAnnotationTrackLayout,
  parseSourceRecords,
  predictOperonsByDistance,
  promoterWindowForStartSite,
  promoterWindowsFromStartSitesSource,
  recordAnchorBp,
  resolveAnnotationTracks,
  sourceId,
  trackBindingId,
  visualizationId,
  type CatalogRecord,
  type AnnotationSourceDefinition,
  type AnnotationTrackLayout,
  type GeneModel,
  type FeatureLocation,
  type SequenceReader,
  type TerminatorRecord,
  type TranscriptionStartSiteRecord,
} from './index';

const ASSEMBLY = assemblyAccession('NC_000913.3');
const OTHER_ASSEMBLY = assemblyAccession('NC_000964.3');

function fixedSequence(bases: string): SequenceReader {
  return { lengthBp: bases.length, slice: (start, end) => bases.slice(start, end) };
}

function staticSource(input: {
  id: string;
  kinds: AnnotationSourceDefinition['kinds'];
  records: readonly CatalogRecord[];
  assembly?: typeof ASSEMBLY;
}): AnnotationSourceDefinition {
  return {
    id: sourceId(input.id),
    label: input.id,
    kinds: input.kinds,
    assembly: input.assembly ?? ASSEMBLY,
    evidence: 'measured',
    derivedFrom: [],
    availability: { status: 'available' },
    provenance: {
      citation: 'test',
      url: 'https://example.org',
      doi: null,
      datasetVersion: 'test',
      liftedFrom: null,
      license: { spdx: 'CC0-1.0', attribution: `${input.id} attribution`, evidenceUrl: null },
    },
    load: async () => input.records,
  };
}

const tss = (
  id: string,
  bp: number,
  strand: '+' | '-',
  score: number | null = 10
): TranscriptionStartSiteRecord => ({
  id,
  kind: 'tss',
  strand,
  location: { shape: 'point', bp },
  classification: null,
  name: null,
  score,
  conditions: ['LB'],
});

const terminatorA = staticSource({
  id: 'terminators-a',
  kinds: ['terminator'],
  records: [
    {
      id: 'a1',
      kind: 'terminator',
      strand: '+',
      location: { shape: 'point', bp: 100 },
      mechanism: 'intrinsic',
      parts: [],
      terminationBp: null,
      peakBp: null,
      name: null,
      score: 90,
      conditions: [],
    },
    {
      id: 'a2',
      kind: 'terminator',
      strand: '-',
      location: { shape: 'point', bp: 300 },
      mechanism: 'intrinsic',
      parts: [],
      terminationBp: null,
      peakBp: null,
      name: null,
      score: 50,
      conditions: [],
    },
  ],
});
const terminatorB = staticSource({
  id: 'terminators-b',
  kinds: ['terminator'],
  records: [
    {
      id: 'b1',
      kind: 'terminator',
      strand: '+',
      location: { shape: 'region', start: 200, end: 260 },
      mechanism: 'rho-dependent',
      parts: [],
      terminationBp: null,
      peakBp: null,
      name: null,
      score: null,
      conditions: [],
    },
  ],
});
const startSites = staticSource({
  id: 'start-sites',
  kinds: ['tss'],
  records: [tss('s1', 50, '+')],
});
const wrongAssembly = staticSource({
  id: 'bsub-terminators',
  kinds: ['terminator'],
  records: [],
  assembly: OTHER_ASSEMBLY,
});

const visualizations = createAnnotationVisualizationCatalog([
  {
    id: visualizationId('terminator-hairpin'),
    label: 'Hairpin',
    description: '',
    accepts: ['terminator'],
  },
  {
    id: visualizationId('interval-box'),
    label: 'Boxes',
    description: '',
    accepts: ['promoter', 'terminator', 'transcription_unit', 'tss'],
  },
  {
    id: visualizationId('unit-arrows'),
    label: 'Unit arrows',
    description: '',
    accepts: ['transcription_unit'],
  },
]);

const sources = createAnnotationSourceCatalog([
  terminatorA,
  terminatorB,
  startSites,
  wrongAssembly,
]);

const layout: AnnotationTrackLayout = {
  schema: ANNOTATION_TRACK_LAYOUT_SCHEMA,
  assembly: ASSEMBLY,
  tracks: [
    {
      id: trackBindingId('terminators'),
      kind: 'terminator',
      sourceId: sourceId('terminators-a'),
      visualizationId: visualizationId('terminator-hairpin'),
      visible: true,
      label: null,
      presentation: DEFAULT_PRESENTATION,
      filter: DEFAULT_FILTER,
    },
  ],
};

const genes: GeneModel[] = [];

describe('applyAnnotationTrackCommand', () => {
  it('swaps a track source without touching its visualization', () => {
    const result = applyAnnotationTrackCommand({
      layout,
      sources,
      visualizations,
      command: {
        kind: 'set-source',
        trackId: trackBindingId('terminators'),
        sourceId: sourceId('terminators-b'),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.tracks[0].sourceId).toBe('terminators-b');
    expect(result.layout.tracks[0].visualizationId).toBe('terminator-hairpin');
    expect(layout.tracks[0].sourceId).toBe('terminators-a');
  });

  it('refuses a source that does not provide the track kind, leaving the layout unchanged', () => {
    const result = applyAnnotationTrackCommand({
      layout,
      sources,
      visualizations,
      command: {
        kind: 'set-source',
        trackId: trackBindingId('terminators'),
        sourceId: sourceId('start-sites'),
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(['source-wrong-kind']);
  });

  it('refuses a source for a different assembly', () => {
    const result = applyAnnotationTrackCommand({
      layout,
      sources,
      visualizations,
      command: {
        kind: 'set-source',
        trackId: trackBindingId('terminators'),
        sourceId: sourceId('bsub-terminators'),
      },
    });
    expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toEqual([
      'source-wrong-assembly',
    ]);
  });

  it('refuses a visualization that cannot draw the kind', () => {
    const result = applyAnnotationTrackCommand({
      layout,
      sources,
      visualizations,
      command: {
        kind: 'set-visualization',
        trackId: trackBindingId('terminators'),
        visualizationId: visualizationId('unit-arrows'),
      },
    });
    expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toEqual([
      'visualization-wrong-kind',
    ]);
  });

  it('reorders tracks', () => {
    const added = applyAnnotationTrackCommand({
      layout,
      sources,
      visualizations,
      command: {
        kind: 'add-track',
        binding: {
          ...layout.tracks[0],
          id: trackBindingId('starts'),
          kind: 'tss',
          sourceId: sourceId('start-sites'),
          visualizationId: visualizationId('interval-box'),
        },
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const moved = applyAnnotationTrackCommand({
      layout: added.layout,
      sources,
      visualizations,
      command: { kind: 'move-track', trackId: trackBindingId('starts'), toIndex: 0 },
    });
    expect(moved.ok ? moved.layout.tracks.map((t) => t.id) : []).toEqual(['starts', 'terminators']);
  });
});

describe('parseAnnotationTrackLayout', () => {
  it('round-trips a layout through JSON', () => {
    const parsed = parseAnnotationTrackLayout(JSON.parse(JSON.stringify(layout)));
    expect(parsed).toEqual({ ok: true, layout });
  });

  it('rejects an unknown kind at the boundary', () => {
    const raw = JSON.parse(JSON.stringify(layout));
    raw.tracks[0].kind = 'enhancer';
    expect(parseAnnotationTrackLayout(raw)).toEqual({
      ok: false,
      error: 'tracks[0]: unknown kind "enhancer"',
    });
  });
});

describe('resolveAnnotationTracks', () => {
  it('applies the score filter and reports the unfiltered count', async () => {
    const cache = createSourceRecordCache({
      catalog: sources,
      assembly: { accession: ASSEMBLY, lengthBp: 1000 },
      genes,
      sequence: fixedSequence('A'.repeat(1000)),
    });
    const [track] = await resolveAnnotationTracks({
      layout: { ...layout, tracks: [{ ...layout.tracks[0], filter: { minScore: 60 } }] },
      sources,
      visualizations,
      cache,
    });
    expect(track.state).toMatchObject({ status: 'ready', totalBeforeFilter: 2 });
    expect(track.state.status === 'ready' ? track.state.records.map((r) => r.id) : []).toEqual([
      'a1',
    ]);
  });

  it('turns a source that returns out-of-range records into a track error instead of drawing them', async () => {
    const tooLong = staticSource({
      id: 'too-long',
      kinds: ['tss'],
      records: [tss('x', 5000, '+')],
    });
    const catalog = createAnnotationSourceCatalog([tooLong]);
    const cache = createSourceRecordCache({
      catalog,
      assembly: { accession: ASSEMBLY, lengthBp: 1000 },
      genes,
      sequence: fixedSequence('A'.repeat(1000)),
    });
    await expect(cache.load(sourceId('too-long'))).rejects.toThrow('past 1000 bp');
  });
});

describe('derived promoter windows', () => {
  it('follows whichever start-site source it was built from', async () => {
    const bases = 'G'.repeat(28) + 'TATAAT' + 'G'.repeat(6) + 'A' + 'G'.repeat(59);
    const upstream = staticSource({ id: 'starts', kinds: ['tss'], records: [tss('s', 40, '+')] });
    const derived = promoterWindowsFromStartSitesSource({
      id: sourceId('promoters-from-starts'),
      upstream,
      upstreamBp: 35,
    });
    const catalog = createAnnotationSourceCatalog([upstream, derived]);
    const cache = createSourceRecordCache({
      catalog,
      assembly: { accession: ASSEMBLY, lengthBp: bases.length },
      genes,
      sequence: fixedSequence(bases),
    });
    const [promoter] = await cache.load(sourceId('promoters-from-starts'));
    expect(promoter).toMatchObject({
      kind: 'promoter',
      transcriptionStartBp: 40,
      location: { shape: 'region', start: 5, end: 41 },
      boxes: [{ element: 'minus10', start: 28, end: 34 }],
    });
    expect(derived.provenance.license.attribution).toContain('starts attribution');
  });

  it('finds the −10 box on the reverse strand', () => {
    const bases = 'G'.repeat(17) + 'ATTATA' + 'G'.repeat(40);
    const promoter = promoterWindowForStartSite({
      tss: tss('r', 10, '-'),
      sequence: fixedSequence(bases),
      upstreamBp: 30,
      idPrefix: 'p',
    });
    expect(promoter.boxes).toEqual([{ element: 'minus10', start: 17, end: 23 }]);
    expect(promoter.location).toEqual({ shape: 'region', start: 10, end: 41 });
  });

  const forwardWithHexamer = (hexamer: string) =>
    promoterWindowForStartSite({
      tss: tss('f', 40, '+'),
      sequence: fixedSequence('G'.repeat(28) + hexamer + 'G'.repeat(66)),
      upstreamBp: 35,
      idPrefix: 'p',
    });

  it('calls a −10 box at 5 of 6 matches', () => {
    expect(forwardWithHexamer('TATAGT').boxes).toEqual([
      { element: 'minus10', start: 28, end: 34 },
    ]);
  });

  it('calls no −10 box at 4 of 6 matches, the level chance reaches too often', () => {
    const promoter = forwardWithHexamer('TATGGT');
    expect(promoter.boxes).toEqual([]);
    expect(promoter.location).toEqual({ shape: 'region', start: 5, end: 41 });
  });

  it('applies the same 5 of 6 rule on the reverse strand', () => {
    const reverseWithHexamer = (hexamer: string) =>
      promoterWindowForStartSite({
        tss: tss('r', 10, '-'),
        sequence: fixedSequence('G'.repeat(17) + reverseComplement(hexamer) + 'G'.repeat(40)),
        upstreamBp: 30,
        idPrefix: 'p',
      });
    expect(reverseWithHexamer('TATAGT').boxes).toEqual([
      { element: 'minus10', start: 17, end: 23 },
    ]);
    expect(reverseWithHexamer('TATGGT').boxes).toEqual([]);
  });

  it('describes the searched box positions and the threshold in its provenance', () => {
    const upstream = staticSource({ id: 'starts', kinds: ['tss'], records: [] });
    const derived = promoterWindowsFromStartSitesSource({
      id: sourceId('promoters-from-starts'),
      upstream,
      upstreamBp: 60,
    });
    expect(derived.provenance.datasetVersion).toContain('start searched from −14 to −10');
    expect(derived.provenance.datasetVersion).toContain('span up to −5');
    expect(derived.provenance.datasetVersion).toContain('at least 5 of 6');
  });
});

describe('recordAnchorBp for terminators', () => {
  const terminator = (
    strand: '+' | '-',
    location: FeatureLocation,
    terminationBp: number | null,
    peakBp: number | null = null
  ): TerminatorRecord => ({
    id: 't',
    kind: 'terminator',
    strand,
    location,
    mechanism: 'intrinsic',
    parts: [],
    terminationBp,
    peakBp,
    name: null,
    score: null,
    conditions: [],
  });
  const region = (start: number, end: number): FeatureLocation => ({
    shape: 'region',
    start,
    end,
  });

  it("uses the last base of the span when no 3' end was measured", () => {
    expect(recordAnchorBp(terminator('+', region(279, 316), null))).toBe(315);
    expect(recordAnchorBp(terminator('-', region(9883, 9916), null))).toBe(9883);
    expect(recordAnchorBp(terminator('+', { shape: 'point', bp: 100 }, null))).toBe(100);
  });

  it('anchors a window-measured signal on its published peak, not the window edge', () => {
    expect(recordAnchorBp(terminator('+', region(9_200, 10_800), null, 10_000))).toBe(10_000);
    expect(recordAnchorBp(terminator('-', region(9_199, 10_799), null, 9_998))).toBe(9_998);
    expect(recordAnchorBp(terminator('+', region(9_200, 10_800), 9_500, 10_000))).toBe(9_500);
  });

  it("uses the measured 3' end on either strand", () => {
    expect(recordAnchorBp(terminator('+', region(279, 316), 308))).toBe(308);
    expect(recordAnchorBp(terminator('-', region(9883, 9916), 9891))).toBe(9891);
  });

  it("keeps a measured 3' end at base 0", () => {
    expect(recordAnchorBp(terminator('+', region(0, 20), 0))).toBe(0);
  });
});

describe('predictOperonsByDistance', () => {
  const gene = (name: string, start: number, end: number, strand: '+' | '-'): GeneModel => ({
    name,
    locusTag: name,
    start,
    end,
    strand,
  });

  it('joins close same-strand genes and orders reverse-strand units in transcription order', () => {
    const units = predictOperonsByDistance({
      genes: [
        gene('a', 0, 100, '+'),
        gene('b', 120, 200, '+'),
        gene('c', 400, 500, '+'),
        gene('d', 510, 600, '-'),
        gene('e', 620, 700, '-'),
      ],
      options: { maxGapBp: 50, minGenes: 2 },
      idPrefix: 'ops',
    });
    expect(units.map((u) => ({ genes: u.genes, strand: u.strand, location: u.location }))).toEqual([
      { genes: ['a', 'b'], strand: '+', location: { shape: 'region', start: 0, end: 200 } },
      { genes: ['e', 'd'], strand: '-', location: { shape: 'region', start: 510, end: 700 } },
    ]);
  });

  it('gives locus tags in transcription order only when every gene has one', () => {
    const units = predictOperonsByDistance({
      genes: [
        { name: 'thrL', locusTag: 'b0001', start: 189, end: 255, strand: '+' },
        { name: 'thrA', locusTag: 'b0002', start: 336, end: 2799, strand: '+' },
        { name: 'x', locusTag: 'bx1', start: 5000, end: 5100, strand: '-' },
        { name: 'y', locusTag: 'bx2', start: 5120, end: 5200, strand: '-' },
        { name: 'p', locusTag: 'bp1', start: 9000, end: 9100, strand: '+' },
        { name: 'q', locusTag: null, start: 9120, end: 9200, strand: '+' },
      ],
      options: { maxGapBp: 100, minGenes: 2 },
      idPrefix: 'ops',
    });
    expect(units.map((u) => [u.genes, u.geneLocusTags])).toEqual([
      [
        ['thrL', 'thrA'],
        ['b0001', 'b0002'],
      ],
      [
        ['y', 'x'],
        ['bx2', 'bx1'],
      ],
      [['p', 'q'], []],
    ]);
  });

  it('is a catalog source like any dataset', async () => {
    const definition = operonsByDistanceSource({
      id: sourceId('predicted-operons'),
      assembly: ASSEMBLY,
      options: { maxGapBp: 50, minGenes: 2 },
    });
    const catalog = createAnnotationSourceCatalog([definition]);
    const cache = createSourceRecordCache({
      catalog,
      assembly: { accession: ASSEMBLY, lengthBp: 1000 },
      genes: [gene('a', 0, 100, '+'), gene('b', 110, 200, '+')],
      sequence: fixedSequence('A'.repeat(1000)),
    });
    expect((await cache.load(sourceId('predicted-operons'))).length).toBe(1);
  });
});

describe('parseSourceRecords', () => {
  const assembly = { accession: ASSEMBLY, lengthBp: 1000 };
  const file = (records: unknown[]) => ({
    schema: 'dnaforge.annotation-source-records.v0',
    sourceId: 'demo',
    assembly: { accession: 'NC_000913.3', length: 1000 },
    records,
  });

  it('types records by kind and rejects bad coordinates with a bounded report', () => {
    const result = parseSourceRecords({
      raw: file([
        {
          id: 'demo:1',
          kind: 'terminator',
          start: 10,
          end: 11,
          strand: '+',
          resolution: 'point',
          score: 88,
          attributes: { mechanism: 'intrinsic', conditions: ['LB'] },
          parts: [{ role: 'u_tract', start: 3, end: 11 }],
        },
        {
          id: 'demo:2',
          kind: 'tss',
          start: 10,
          end: 12,
          strand: '-',
          resolution: 'point',
          score: null,
          attributes: {},
        },
        {
          id: 'demo:3',
          kind: 'transcription_unit',
          start: 990,
          end: 1001,
          strand: '+',
          resolution: 'region',
          score: null,
          attributes: {},
        },
      ]),
      expectedSourceId: 'demo',
      assembly,
    });
    expect(result.records).toEqual([
      {
        id: 'demo:1',
        kind: 'terminator',
        strand: '+',
        location: { shape: 'point', bp: 10 },
        mechanism: 'intrinsic',
        parts: [{ element: 'u-tract', start: 3, end: 11 }],
        terminationBp: null,
        peakBp: null,
        name: null,
        score: 88,
        conditions: ['LB'],
      },
    ]);
    expect(result.rejected.count).toBe(2);
  });

  it("reads a measured 3' end for terminators, and drops one outside the assembly", () => {
    const terminatorEntry = (id: string, strand: '+' | '-', terminationBp: unknown) => ({
      id,
      kind: 'terminator',
      start: 279,
      end: 316,
      strand,
      resolution: 'region',
      score: null,
      attributes: { mechanism: 'intrinsic', terminationBp },
    });
    const result = parseSourceRecords({
      raw: file([
        terminatorEntry('fwd', '+', 308),
        terminatorEntry('rev', '-', 290),
        terminatorEntry('zero', '+', 0),
        terminatorEntry('missing', '+', undefined),
        terminatorEntry('past-end', '+', 1000),
        terminatorEntry('negative', '-', -1),
        terminatorEntry('fraction', '+', 308.5),
        terminatorEntry('text', '+', '308'),
      ]),
      expectedSourceId: 'demo',
      assembly,
    });
    expect(result.rejected.count).toBe(0);
    expect(
      result.records.map((record) => [
        record.id,
        record.kind === 'terminator' ? record.terminationBp : 'not a terminator',
      ])
    ).toEqual([
      ['fwd', 308],
      ['rev', 290],
      ['zero', 0],
      ['missing', null],
      ['past-end', null],
      ['negative', null],
      ['fraction', null],
      ['text', null],
    ]);
    expect(result.records.map(recordAnchorBp)).toEqual([308, 290, 0, 315, 315, 279, 315, 315]);
  });

  it('reads unit locus tags in gene order, and drops them when they do not line up', () => {
    const unitEntry = (id: string, attributes: Record<string, unknown>) => ({
      id,
      kind: 'transcription_unit',
      start: 100,
      end: 900,
      strand: '-',
      resolution: 'region',
      score: null,
      attributes,
    });
    const result = parseSourceRecords({
      raw: file([
        unitEntry('tagged', { genes: ['b1417', 'b1416'], locusTags: ['b1417', 'b1416'] }),
        unitEntry('named', { genes: ['thrL', 'thrA'], locusTags: ['b0001', 'b0002'] }),
        unitEntry('untagged', { genes: ['yaaA'] }),
        unitEntry('short', { genes: ['thrL', 'thrA'], locusTags: ['b0001'] }),
        unitEntry('bad-entry', { genes: ['thrL', 'thrA'], locusTags: ['b0001', 7] }),
      ]),
      expectedSourceId: 'demo',
      assembly,
    });
    expect(
      result.records.map((record) =>
        record.kind === 'transcription_unit'
          ? { id: record.id, genes: record.genes, geneLocusTags: record.geneLocusTags }
          : null
      )
    ).toEqual([
      { id: 'tagged', genes: ['b1417', 'b1416'], geneLocusTags: ['b1417', 'b1416'] },
      { id: 'named', genes: ['thrL', 'thrA'], geneLocusTags: ['b0001', 'b0002'] },
      { id: 'untagged', genes: ['yaaA'], geneLocusTags: [] },
      { id: 'short', genes: ['thrL', 'thrA'], geneLocusTags: [] },
      { id: 'bad-entry', genes: ['thrL', 'thrA'], geneLocusTags: [] },
    ]);
  });

  it('refuses a file built for another assembly', () => {
    expect(() =>
      parseSourceRecords({
        raw: { ...file([]), assembly: { accession: 'U00096.2', length: 4639675 } },
        expectedSourceId: 'demo',
        assembly,
      })
    ).toThrow('does not match NC_000913.3');
  });
});

describe('parseSourceRecords peakBp', () => {
  it('reads the published peak of a window-measured terminator and ignores a peak outside the assembly', () => {
    const entry = (id: string, peakBp: unknown) => ({
      id,
      kind: 'terminator',
      start: 100,
      end: 900,
      strand: '+',
      resolution: 'region',
      score: 2.4,
      attributes: { mechanism: 'rho-dependent', peakBp },
    });
    const result = parseSourceRecords({
      raw: {
        schema: 'dnaforge.annotation-source-records.v0',
        sourceId: 'rho',
        assembly: { accession: 'NC_000913.3', length: 1000 },
        records: [entry('inside', 500), entry('outside', 5000), entry('absent', undefined)],
      },
      expectedSourceId: 'rho',
      assembly: { accession: assemblyAccession('NC_000913.3'), lengthBp: 1000 },
    });
    expect(result.rejected.count).toBe(0);
    expect(
      result.records.map((record) => [
        record.id,
        record.kind === 'terminator' ? record.peakBp : 'x',
      ])
    ).toEqual([
      ['inside', 500],
      ['outside', null],
      ['absent', null],
    ]);
    expect(result.records[0] && recordAnchorBp(result.records[0])).toBe(500);
  });
});
