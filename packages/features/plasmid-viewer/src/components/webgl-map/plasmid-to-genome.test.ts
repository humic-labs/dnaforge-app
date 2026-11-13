import { describe, it, expect } from 'vitest';
import {
  PRIMER_COLOR,
  PRIMER_OVERHANG_COLOR,
  PRIMER_PBS_COLOR,
  PRIMER_RENDER_ID_OFFSET,
  convertFeature,
  convertPlasmid,
  convertPrimer,
  cssColorToHex,
  primerRenderId,
} from './plasmid-to-genome';
import type { PlasmidFeature, ParsedPlasmid } from '../../types';

function genomeFeatures(genome: ReturnType<typeof convertPlasmid>) {
  return genome.features ?? [];
}

describe('cssColorToHex', () => {
  it('converts #-prefixed hex string', () => {
    expect(cssColorToHex('#3b82f6')).toBe(0x3b82f6);
  });

  it('converts non-prefixed hex string', () => {
    expect(cssColorToHex('ef4444')).toBe(0xef4444);
  });

  it('returns fallback for invalid color', () => {
    expect(cssColorToHex('not-a-color')).toBe(0x9ca3af);
  });

  it('handles black', () => {
    expect(cssColorToHex('#000000')).toBe(0x000000);
  });

  it('handles white', () => {
    expect(cssColorToHex('#ffffff')).toBe(0xffffff);
  });
});

describe('convertFeature', () => {
  const makePF = (overrides?: Partial<PlasmidFeature>): PlasmidFeature => ({
    type: 'CDS',
    start: 100,
    end: 500,
    direction: 'forward',
    qualifiers: {},
    displayName: 'lacZ',
    color: '#3b82f6',
    ...overrides,
  });

  it('converts coordinates: 1-indexed inclusive → 0-indexed exclusive-end', () => {
    const f = convertFeature(makePF({ start: 1, end: 100 }), 0);
    expect(f.start).toBe(0);
    expect(f.end).toBe(100);
  });

  it('preserves type and direction', () => {
    const f = convertFeature(makePF({ type: 'promoter', direction: 'reverse' }), 5);
    expect(f.type).toBe('promoter');
    expect(f.direction).toBe('reverse');
    expect(f.id).toBe(5);
  });

  it('preserves canonical feature identity independently of renderer array IDs', () => {
    const f = convertFeature(
      makePF({ sourceId: 'source:19', canonicalIdentity: 'annotation:19' }),
      5
    );
    expect(f.id).toBe(5);
    expect(f.sourceId).toBe('source:19');
    expect(f.canonicalIdentity).toBe('annotation:19');
  });

  it('converts CSS color to PixiJS hex number', () => {
    const f = convertFeature(makePF({ color: '#22c55e' }), 0);
    expect(f.color).toBe(0x22c55e);
  });

  it('sets lane to 0 when no indexed source lane is present', () => {
    const f = convertFeature(makePF(), 0);
    expect(f.lane).toBe(0);
    expect(f.cdsLane).toBeUndefined();
  });

  it('preserves indexed source _lane qualifiers for stable tiled rendering', () => {
    const f = convertFeature(makePF({ type: 'mRNA', qualifiers: { _lane: ['7'] } }), 0);
    expect(f.lane).toBe(7);
    expect(f.qualifiers?._lane).toBe('7');
  });

  it('uses indexed source _lane as cdsLane for CDS rows', () => {
    const f = convertFeature(makePF({ type: 'CDS', qualifiers: { _lane: ['3'] } }), 0);
    expect(f.lane).toBe(3);
    expect(f.cdsLane).toBe(3);
  });

  it('handles feature at position 1 (start of sequence)', () => {
    const f = convertFeature(makePF({ start: 1, end: 1 }), 0);
    expect(f.start).toBe(0);
    expect(f.end).toBe(1);
  });

  it('handles none direction', () => {
    const f = convertFeature(makePF({ direction: 'none' }), 0);
    expect(f.direction).toBe('none');
  });

  it('preserves spliced CDS metadata for WebGL intron rendering', () => {
    const feature = convertFeature(
      makePF({
        segments: [
          { start: 1, end: 6 },
          { start: 10, end: 15 },
        ],
        qualifiers: {
          _locationString: ['join(1..6,10..15)'],
          codon_start: ['1'],
        },
      }),
      0
    );

    expect(feature.segments).toEqual([
      { start: 1, end: 6 },
      { start: 10, end: 15 },
    ]);
    expect(feature.qualifiers).toMatchObject({
      _locationString: 'join(1..6,10..15)',
      codon_start: '1',
    });
    expect(feature.exons).toEqual(feature.segments);
    expect(feature.cds).toEqual(feature.segments);
    expect(feature.compositeKind).toBe('compound-cds');
  });

  it('uses indexed composite geometry for an ordinary joined RNA without inferring a CDS', () => {
    const segments = [
      { start: 100, end: 150 },
      { start: 400, end: 500 },
    ];
    const feature = convertFeature(
      makePF({
        type: 'mRNA',
        sourceId: 'reference:transcript:19',
        direction: 'reverse',
        segments,
        qualifiers: { transcript_id: ['NM_017607.4'] },
      }),
      19
    );
    expect(feature).toMatchObject({
      id: 19,
      type: 'mRNA',
      sourceId: 'reference:transcript:19',
      direction: 'reverse',
      start: 99,
      end: 500,
      exons: segments,
      cds: [],
      compositeKind: 'transcript',
      transcriptId: 'NM_017607.4',
    });
    expect(feature.segments).toEqual(segments);
  });

  it('preserves overlapping coding parts and source order for programmed recoding', () => {
    const segments = [
      { start: 100, end: 200 },
      { start: 200, end: 500 },
    ];
    const feature = convertFeature(
      makePF({ segments, qualifiers: { ribosomal_slippage: [''] } }),
      0
    );
    expect(feature.exons).toEqual(segments);
    expect(feature.cds).toEqual(segments);
    expect(feature.segments).toEqual(segments);
  });

  it('does not turn an origin-wrapping join into an intron through the circle', () => {
    const segments = [
      { start: 900, end: 1000 },
      { start: 1, end: 100 },
    ];
    const feature = convertFeature(makePF({ start: 900, end: 100, segments }), 0);
    expect(feature).toMatchObject({ start: 899, end: 100, segments });
    expect(feature.exons).toBeUndefined();
  });

  it('leaves ordinary regulatory features on their own source geometry', () => {
    const feature = convertFeature(makePF({ type: 'promoter' }), 0);
    expect(feature.exons).toBeUndefined();
    expect(feature.cds).toBeUndefined();
  });

  it('keeps repeated source qualifier values without mutating the source arrays', () => {
    const source = makePF({ qualifiers: { note: ['first note', 'second note'] } });
    const feature = convertFeature(source, 0);
    expect(feature.qualifiers?.note).toBe('first note');
    expect(feature.qualifierValues?.note).toEqual(['first note', 'second note']);
    expect(feature.qualifierValues?.note).not.toBe(source.qualifiers.note);
    expect(source.qualifiers.note).toEqual(['first note', 'second note']);
  });
});

describe('convertPlasmid', () => {
  it('carries the code the record reads by through to the genome ', () => {
    const plasmid: ParsedPlasmid = {
      name: 'mito',
      length: 12,
      circular: false,
      sequence: 'ATGTGAAAATAA',
      features: [],
      primers: [],
      geneticCode: 4,
    };

    expect(convertPlasmid(plasmid).geneticCode).toBe(4);
  });

  it('leaves the code unset when the record never resolved one', () => {
    const plasmid: ParsedPlasmid = {
      name: 'plain',
      length: 4,
      circular: false,
      sequence: 'ATGC',
      features: [],
      primers: [],
    };

    expect(convertPlasmid(plasmid).geneticCode).toBeUndefined();
  });

  it('converts a complete plasmid with features', () => {
    const plasmid: ParsedPlasmid = {
      name: 'pUC19',
      length: 2686,
      circular: true,
      sequence: 'ATGC'.repeat(100),
      features: [
        {
          type: 'CDS',
          start: 1,
          end: 500,
          direction: 'forward',
          qualifiers: {},
          displayName: 'lacZ',
          color: '#3b82f6',
        },
        {
          type: 'promoter',
          start: 501,
          end: 600,
          direction: 'forward',
          qualifiers: {},
          displayName: 'lac promoter',
          color: '#22c55e',
        },
      ],
      primers: [],
    };

    const genome = convertPlasmid(plasmid);
    expect(genome.name).toBe('pUC19');
    expect(genome.length).toBe(2686);
    expect(genome.circular).toBe(true);
    const features = genomeFeatures(genome);
    expect(features).toHaveLength(2);
    expect(features[0].start).toBe(0);
    expect(features[0].end).toBe(500);
    expect(features[1].start).toBe(500);
    expect(features[1].end).toBe(600);
  });

  it('converts plasmid without sequence', () => {
    const plasmid: ParsedPlasmid = {
      name: 'test',
      length: 1000,
      circular: false,
      sequence: '',
      features: [],
      primers: [],
    };
    const genome = convertPlasmid(plasmid);
    expect(genome.sequence).toBeUndefined();
    expect(genomeFeatures(genome)).toHaveLength(0);
  });

  it('assigns sequential IDs to features', () => {
    const plasmid: ParsedPlasmid = {
      name: 'test',
      length: 1000,
      circular: true,
      sequence: 'A'.repeat(1000),
      features: Array.from({ length: 5 }, (_, i) => ({
        type: 'gene',
        start: i * 100 + 1,
        end: (i + 1) * 100,
        direction: 'forward' as const,
        qualifiers: {},
        displayName: `gene${i}`,
        color: '#3b82f6',
      })),
      primers: [],
    };
    const genome = convertPlasmid(plasmid);
    expect(genomeFeatures(genome).map((f) => f.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('converts primers into a separate WebGL primer track', () => {
    const plasmid: ParsedPlasmid = {
      name: 'test',
      length: 1000,
      circular: true,
      sequence: 'A'.repeat(1000),
      features: [],
      primers: [
        {
          id: 'primer-a',
          name: 'Primer A',
          start: 10,
          end: 30,
          direction: 'forward',
          bases: 'A'.repeat(20),
          tm: 55,
          gc: 50,
          mismatches: [],
          hasExplicitSequence: true,
        },
      ],
    };

    const genome = convertPlasmid(plasmid);

    expect(genome.features).toHaveLength(0);
    expect(genome.primers).toEqual([
      {
        id: 'primer-a',
        sourcePrimerId: undefined,
        renderId: PRIMER_RENDER_ID_OFFSET,
        name: 'Primer A',
        start: 10,
        end: 30,
        direction: 'forward',
        color: PRIMER_COLOR,
        bases: 'A'.repeat(20),
        overhangLength: undefined,
        editablePbsEndpoint: false,
        pbsColor: PRIMER_PBS_COLOR,
        overhangColor: PRIMER_OVERHANG_COLOR,
        cutPositionInOverhang: undefined,
        enzymeName: undefined,
        suppressCutSiteRendering: undefined,
        recognitionStart: undefined,
        recognitionEnd: undefined,
        scarAbsolutePosition: undefined,
        cognate4bpLength: undefined,
        synthetic4bpSpacerLength: undefined,
        spacerLength: undefined,
        junctionIndex: undefined,
        isScarMarkerOnly: undefined,
        mismatches: [],
      },
    ]);
  });

  it('preserves unsaved primer state for WebGL styling and hit testing', () => {
    const plasmid: ParsedPlasmid = {
      name: 'test',
      length: 1000,
      circular: true,
      sequence: 'A'.repeat(1000),
      features: [],
      primers: [
        {
          id: 'candidate-primer',
          name: 'Candidate Primer',
          start: 10,
          end: 30,
          direction: 'forward',
          bases: 'A'.repeat(20),
          tm: 55,
          gc: 50,
          mismatches: [],
          hasExplicitSequence: true,
          isCandidate: true,
        },
        {
          id: 'draft-primer',
          name: 'Draft Primer',
          start: 40,
          end: 60,
          direction: 'reverse',
          bases: 'T'.repeat(20),
          tm: 55,
          gc: 50,
          mismatches: [],
          hasExplicitSequence: true,
          isDraft: true,
        },
      ],
    };

    const genome = convertPlasmid(plasmid);

    expect(genome.primers?.[0]).toMatchObject({ id: 'candidate-primer', isCandidate: true });
    expect(genome.primers?.[1]).toMatchObject({ id: 'draft-primer', isDraft: true });
  });

  it('preserves outline-only Plannotate draft state for WebGL annotation styling', () => {
    const plasmid: ParsedPlasmid = {
      name: 'test',
      length: 1000,
      circular: true,
      sequence: 'A'.repeat(1000),
      features: [
        {
          type: 'gene',
          start: 1,
          end: 100,
          direction: 'forward',
          qualifiers: { source: ['pLannotate-draft'] },
          displayName: 'draft gene',
          color: '#22c55e',
          outlineOnly: true,
        },
      ],
      primers: [],
    };

    const genome = convertPlasmid(plasmid);

    expect(genomeFeatures(genome)[0]).toMatchObject({
      outlineOnly: true,
      qualifiers: { source: 'pLannotate-draft' },
    });
  });

  it('can hide features and primers independently', () => {
    const plasmid: ParsedPlasmid = {
      name: 'test',
      length: 1000,
      circular: true,
      sequence: 'A'.repeat(1000),
      features: [
        {
          type: 'gene',
          start: 1,
          end: 100,
          direction: 'forward',
          qualifiers: {},
          displayName: 'gene0',
          color: '#3b82f6',
        },
      ],
      primers: [
        {
          id: 'primer-a',
          name: 'Primer A',
          start: 10,
          end: 30,
          direction: 'reverse',
          bases: 'A'.repeat(20),
          tm: 55,
          gc: 50,
          mismatches: [],
          hasExplicitSequence: true,
        },
      ],
    };

    expect(convertPlasmid(plasmid, { showFeatures: false }).features).toHaveLength(0);
    expect(convertPlasmid(plasmid, { showPrimers: false }).primers).toHaveLength(0);
  });
});

describe('convertPrimer', () => {
  it('never makes a digest-scar marker draggable as a primer', () => {
    expect(
      convertPrimer(
        {
          id: 'scar',
          name: 'scar',
          start: 10,
          end: 14,
          direction: 'forward',
          bases: 'ATCC',
          tm: 0,
          gc: 0,
          mismatches: [],
          hasExplicitSequence: true,
          isScarMarkerOnly: true,
        },
        0,
        true
      ).editablePbsEndpoint
    ).toBe(false);
  });
  it('uses stable numeric render ids for hit testing', () => {
    const primer = convertPrimer(
      {
        id: 'primer-b',
        name: 'Primer B',
        start: 20,
        end: 40,
        direction: 'reverse',
        bases: 'A'.repeat(20),
        tm: 55,
        gc: 50,
        mismatches: [],
        hasExplicitSequence: true,
      },
      7
    );

    expect(primer.renderId).toBe(primerRenderId(7));
    expect(primer.renderId).toBe(PRIMER_RENDER_ID_OFFSET + 7);
    expect(primer.color).toBe(PRIMER_COLOR);
    expect(primer.bases).toBe('A'.repeat(20));
  });

  it('preserves compound primer metadata for high-zoom rendering', () => {
    const primer = convertPrimer(
      {
        id: 'primer-c',
        name: 'Primer C',
        start: 20,
        end: 52,
        direction: 'forward',
        bases: 'A'.repeat(32),
        tm: 55,
        gc: 50,
        mismatches: [{ position: 4, oligoBase: 'A', templateBase: 'G' }],
        hasExplicitSequence: true,
        overhangLength: 12,
        pbsColor: '#123456',
        overhangColor: '#abcdef',
        cutPositionInOverhang: 7,
        recognitionStart: 1,
        recognitionEnd: 7,
        spacerLength: 2,
      },
      2
    );

    expect(primer.overhangLength).toBe(12);
    expect(primer.pbsColor).toBe(0x123456);
    expect(primer.overhangColor).toBe(0xabcdef);
    expect(primer.cutPositionInOverhang).toBe(7);
    expect(primer.recognitionStart).toBe(1);
    expect(primer.recognitionEnd).toBe(7);
    expect(primer.spacerLength).toBe(2);
    expect(primer.mismatches).toEqual([{ position: 4 }]);
  });

  it('preserves Golden Gate assembly metadata for WebGL primer role rendering', () => {
    const primer = convertPrimer(
      {
        id: 'gg-primer',
        sourcePrimerId: 'source-primer',
        name: 'Golden Gate Primer',
        start: 20,
        end: 48,
        direction: 'reverse',
        bases: 'A'.repeat(28),
        tm: 55,
        gc: 50,
        mismatches: [],
        hasExplicitSequence: true,
        overhangLength: 12,
        cutPositionInOverhang: 6,
        enzymeName: 'BsaI',
        suppressCutSiteRendering: true,
        recognitionStart: 1,
        recognitionEnd: 7,
        scarAbsolutePosition: 32,
        cognate4bpLength: 3,
        synthetic4bpSpacerLength: 1,
        spacerLength: 2,
        junctionIndex: 5,
        isScarMarkerOnly: true,
      },
      3
    );

    expect(primer).toMatchObject({
      id: 'gg-primer',
      sourcePrimerId: 'source-primer',
      overhangLength: 12,
      cutPositionInOverhang: 6,
      enzymeName: 'BsaI',
      suppressCutSiteRendering: true,
      recognitionStart: 1,
      recognitionEnd: 7,
      scarAbsolutePosition: 32,
      cognate4bpLength: 3,
      synthetic4bpSpacerLength: 1,
      spacerLength: 2,
      junctionIndex: 5,
      isScarMarkerOnly: true,
    });
  });
});
