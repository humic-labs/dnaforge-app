// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { dbPrimerToPrimerDisplay } from '../primers/adapters';
import * as sequenceAdapters from './adapters';
import {
  annotatedSequenceToParsedPlasmid,
  annotationDataToAnnotation,
  findCDSAtPosition,
  findStructureAnnotationByLabel,
  findStructureAnnotationAtPosition,
  isStructureAnnotationType,
  primerDisplayToMinimapPrimer,
  structureViewDisabledReason,
  withAnnotationDisplayColorsForMinimap,
  withPrimerDisplaysForMinimap,
} from './adapters';
import type { DbBoundPrimerRow } from '../primers/types';
import type { ParsedPlasmid } from '@waypoint/plasmid-viewer';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { AnnotationData } from './types';
import { buildCustomGeneticCode, type Annotation } from '@waypoint/sequence-utils';

it('preserves stable source annotation identity in the ordinary plasmid adapter', () => {
  const result = annotatedSequenceToParsedPlasmid({
    name: 'result',
    sequence: 'ACGT',
    length: 4,
    annotations: [
      {
        sourceId: 'reference:feature:19',
        name: 'duplicate name',
        type: 'gene',
        start: 1,
        end: 4,
        direction: 1,
      },
    ],
  });
  expect(result.features[0].sourceId).toBe('reference:feature:19');
});

function createDbBoundPrimerRow(overrides?: Partial<DbBoundPrimerRow>): DbBoundPrimerRow {
  return {
    id: 'primer-uuid-1',
    catalog_number: 'P042',
    name: 'lacZ_F1',
    sequence: 'ATCGATCGATCGATCGATCG',
    direction: 'forward',
    length: 20,
    tm: 58.4,
    gc_percent: 50.0,
    origin: 'manual',
    origin_details: null,
    status: 'designed',
    vendor: null,
    order_date: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stock_location: null,
    concentration: null,
    notes: null,
    workspace_id: 1,
    created_at: Date.now(),
    updated_at: Date.now(),

    binding_id: 'bind-uuid-1',
    binding_start: 100,
    binding_end: 120,
    strand: 1,
    source: 'manual',
    binding_created_at: Date.now(),
    binding_updated_at: Date.now(),
    ...overrides,
  };
}

describe('dbPrimerToPrimerDisplay', () => {
  it('maps core fields correctly', () => {
    const row = createDbBoundPrimerRow();
    const display = dbPrimerToPrimerDisplay(row);

    expect(display.id).toBe('bind-uuid-1');
    expect(display.name).toBe('lacZ_F1');
    expect(display.bases).toBe('ATCGATCGATCGATCGATCG');
    expect(display.tm).toBe(58.4);
    expect(display.gc).toBe(50.0);
    expect(display.direction).toBe('forward');
    expect(display.start).toBe(100);
    expect(display.end).toBe(120);
  });

  it('maps forward direction correctly', () => {
    const row = createDbBoundPrimerRow({
      direction: 'forward',
      strand: 1,
      binding_start: 100,
      binding_end: 120,
    });
    const display = dbPrimerToPrimerDisplay(row);

    expect(display.direction).toBe('forward');
    expect(display.start).toBe(100);
    expect(display.end).toBe(120);
  });

  it('maps reverse direction correctly', () => {
    const row = createDbBoundPrimerRow({
      direction: 'reverse',
      strand: -1,
      binding_start: 100,
      binding_end: 120,
    });
    const display = dbPrimerToPrimerDisplay(row);

    expect(display.direction).toBe('reverse');
    expect(display.start).toBe(100);
    expect(display.end).toBe(120);
  });

  it('uses binding strand for direction, not primer.direction', () => {
    const row = createDbBoundPrimerRow({
      direction: 'forward',
      strand: -1,
    });
    const display = dbPrimerToPrimerDisplay(row);

    expect(display.direction).toBe('reverse');
  });

  it('computes mismatches when reference sequence provided', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCG',
      binding_start: 0,
      binding_end: 8,
    });

    const referenceSequence = 'ATCAATCG';

    const display = dbPrimerToPrimerDisplay(row, referenceSequence);

    expect(display.mismatches).toEqual([{ position: 3, oligoBase: 'G', templateBase: 'A' }]);
  });

  it('returns empty mismatches when sequences match', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCG',
      binding_start: 0,
      binding_end: 8,
    });
    const referenceSequence = 'ATCGATCG';

    const display = dbPrimerToPrimerDisplay(row, referenceSequence);

    expect(display.mismatches).toEqual([]);
  });

  it('handles null binding position (unresolved primer)', () => {
    const row = createDbBoundPrimerRow({
      binding_start: null as unknown as number,
      binding_end: null as unknown as number,
    });
    const display = dbPrimerToPrimerDisplay(row);

    expect(display.start).toBe(0);
    expect(display.end).toBe(0);
  });

  it('sets overhangLength to 0 for library primers', () => {
    const row = createDbBoundPrimerRow();
    const display = dbPrimerToPrimerDisplay(row);

    expect(display.overhangLength).toBe(0);
  });

  it('uses golden color for library primers', () => {
    const row = createDbBoundPrimerRow();
    const display = dbPrimerToPrimerDisplay(row);

    expect(display.pbsColor).toBe('#D97706');
  });

  it('slices reference to binding window before mismatch comparison', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCG',
      binding_start: 100,
      binding_end: 108,
    });

    const fullRef = 'A'.repeat(100) + 'ATCAATCG' + 'A'.repeat(100);
    const display = dbPrimerToPrimerDisplay(row, fullRef);
    expect(display.mismatches).toEqual([{ position: 3, oligoBase: 'G', templateBase: 'A' }]);
  });

  it('reverse-complements reference for reverse primer — exact match', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'CGATCGAT',
      direction: 'reverse',
      strand: -1,
      binding_start: 0,
      binding_end: 8,
    });

    const ref = 'ATCGATCG';
    const display = dbPrimerToPrimerDisplay(row, ref);
    expect(display.mismatches).toEqual([]);
  });

  it('detects mismatches for reverse primers after revcomp', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'CGATCGAT',
      direction: 'reverse',
      strand: -1,
      binding_start: 0,
      binding_end: 8,
    });
    const ref = 'ATCAATCG';

    const display = dbPrimerToPrimerDisplay(row, ref);
    expect(display.mismatches).toEqual([{ position: 3, oligoBase: 'C', templateBase: 'T' }]);
  });

  it('origin-spanning primer on circular sequence: computes mismatches across origin', () => {
    const ref =
      'ATCGATCGATCGATCGATCG'.slice(10) + 'N'.repeat(4980) + 'ATCGATCGATCGATCGATCG'.slice(0, 10);

    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCGATCGATCGATCG',
      binding_start: 4990,
      binding_end: 10,
    });
    const display = dbPrimerToPrimerDisplay(row, ref);

    expect(display.mismatches).toEqual([]);
    expect(display.start).toBe(4990);
    expect(display.end).toBe(10);
  });

  it('empty reference sequence: does not crash, returns no mismatches', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCG',
      binding_start: 0,
      binding_end: 8,
    });
    const display = dbPrimerToPrimerDisplay(row, '');

    expect(display.mismatches).toBeUndefined();
    expect(display.bases).toBe('ATCGATCG');
    expect(display.start).toBe(0);
    expect(display.end).toBe(8);
  });

  it('primer longer than reference at binding site: compares up to available length', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCGATCGATCGATCG',
      binding_start: 0,
      binding_end: 20,
    });
    const shortRef = 'ATCGATCGAT';

    const display = dbPrimerToPrimerDisplay(row, shortRef);

    expect(display.mismatches).toEqual([]);
  });

  it('primer longer than reference at binding site: detects mismatch in overlap', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCGATCGATCGATCG',
      binding_start: 0,
      binding_end: 20,
    });
    const shortRef = 'ATCGAACGAT';

    const display = dbPrimerToPrimerDisplay(row, shortRef);

    expect(display.mismatches).toEqual([{ position: 5, oligoBase: 'T', templateBase: 'A' }]);
  });

  it('null direction defaults to forward for display and mismatch computation', () => {
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCG',
      direction: null as unknown as string,
      strand: 1,
      binding_start: 0,
      binding_end: 8,
    });
    const ref = 'ATCAATCG';

    const display = dbPrimerToPrimerDisplay(row, ref);

    expect(display.direction).toBe('forward');
    expect(display.mismatches).toEqual([{ position: 3, oligoBase: 'G', templateBase: 'A' }]);
  });

  it('binding position at sequence end: works correctly', () => {
    const ref = 'AAAAAAAAATCGATCG';
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCG',
      binding_start: 8,
      binding_end: 16,
    });

    const display = dbPrimerToPrimerDisplay(row, ref);

    expect(display.mismatches).toEqual([]);
    expect(display.start).toBe(8);
    expect(display.end).toBe(16);
  });

  it('binding position at sequence end with mismatch: detects correctly', () => {
    const ref = 'AAAAAAAAATCAATCG';
    const row = createDbBoundPrimerRow({
      sequence: 'ATCGATCG',
      binding_start: 8,
      binding_end: 16,
    });

    const display = dbPrimerToPrimerDisplay(row, ref);

    expect(display.mismatches).toEqual([{ position: 3, oligoBase: 'G', templateBase: 'A' }]);
  });
});

describe('withPrimerDisplaysForMinimap', () => {
  const plasmid: ParsedPlasmid = {
    name: 'test',
    sequence: 'A'.repeat(200),
    length: 200,
    circular: true,
    features: [],
    primers: [],
  };

  it('retains saved primer chemistry through the bound-row and minimap adapters', () => {
    const display = dbPrimerToPrimerDisplay(
      createDbBoundPrimerRow({
        vendor: 'IDT',
        sequence: 'atcgtatcgatcgatcgatcg',
        modifications: '/5Phos/atcg/iBiodT/atcgatcgatcgatcg',
      })
    );
    const primer = withPrimerDisplaysForMinimap(plasmid, [display]).primers[0];
    expect(display.modificationMarkers).toHaveLength(2);
    expect(primer).toMatchObject({
      id: display.id,
      sourcePrimerId: display.sourcePrimerId,
      bases: display.bases,
      modificationMarkers: display.modificationMarkers,
    });
  });

  it('uses the same primer list that WorkspaceViewer passes to the Canvas2D sequence view', () => {
    const canvasPrimer: PrimerDisplay = {
      id: '__candidate_primer__',
      name: 'Candidate primer visible in canvas',
      bases: 'ATCGATCGATCG',
      start: 40,
      end: 52,
      direction: 'forward',
      tm: 54,
      gc: 50,
      mismatches: [],
      isCandidate: true,
    };

    const result = withPrimerDisplaysForMinimap(plasmid, [canvasPrimer]);

    expect(plasmid.primers).toHaveLength(0);
    expect(result.primers).toHaveLength(1);
    expect(result.primers[0]).toMatchObject({
      id: '__candidate_primer__',
      name: 'Candidate primer visible in canvas',
      start: 40,
      end: 52,
      direction: 'forward',
      bases: 'ATCGATCGATCG',
      isCandidate: true,
    });
  });

  it('leaves parsed plasmid primers unchanged when WorkspaceViewer has no canvas primer prop', () => {
    const parsedPrimer = {
      id: 'parsed-primer',
      name: 'Parsed primer',
      bases: 'ATCG',
      start: 1,
      end: 5,
      direction: 'reverse' as const,
      tm: 50,
      gc: 50,
      mismatches: [],
      hasExplicitSequence: true,
    };
    const result = withPrimerDisplaysForMinimap({ ...plasmid, primers: [parsedPrimer] });

    expect(result.primers).toEqual([parsedPrimer]);
  });

  it('preserves assembly primer metadata for WebGL minimap rendering', () => {
    const canvasPrimer: PrimerDisplay = {
      id: 'gg-primer',
      sourcePrimerId: 'source-primer',
      name: 'Golden Gate primer',
      bases: 'GGTCTCAACCGGTTAA',
      start: 80,
      end: 96,
      direction: 'forward',
      tm: 61.5,
      gc: 52,
      mismatches: [],
      overhangLength: 10,
      pbsColor: '#7c3aed',
      overhangColor: '#dc2626',
      cutPositionInOverhang: 6,
      enzymeName: 'BsaI',
      suppressCutSiteRendering: true,
      recognitionStart: 1,
      recognitionEnd: 7,
      scarAbsolutePosition: 84,
      cognate4bpLength: 2,
      synthetic4bpSpacerLength: 1,
      spacerLength: 3,
      junctionIndex: 4,
      isScarMarkerOnly: true,
      isDraft: true,
      isCandidate: true,
    };

    const primer = primerDisplayToMinimapPrimer(canvasPrimer) as Record<string, unknown>;

    expect(primer).toMatchObject({
      id: 'gg-primer',
      sourcePrimerId: 'source-primer',
      overhangLength: 10,
      pbsColor: '#7c3aed',
      overhangColor: '#dc2626',
      cutPositionInOverhang: 6,
      enzymeName: 'BsaI',
      suppressCutSiteRendering: true,
      recognitionStart: 1,
      recognitionEnd: 7,
      scarAbsolutePosition: 84,
      cognate4bpLength: 2,
      synthetic4bpSpacerLength: 1,
      spacerLength: 3,
      junctionIndex: 4,
      isScarMarkerOnly: true,
      isDraft: true,
      isCandidate: true,
    });
  });
});

describe('withAnnotationDisplayColorsForMinimap', () => {
  const plasmid: ParsedPlasmid = {
    name: 'colors',
    sequence: 'A'.repeat(100),
    length: 100,
    circular: false,
    primers: [],
    features: [
      {
        type: 'promoter',
        displayName: 'manual-red',
        start: 1,
        end: 20,
        direction: 'forward',
        color: '#111111',
        qualifiers: {},
      },
    ],
  };

  it('resolves minimap feature colors through the active annotation color lens', () => {
    expect(withAnnotationDisplayColorsForMinimap(plasmid, 'auto-type').features[0].color).toBe(
      '#22C55E'
    );
    expect(withAnnotationDisplayColorsForMinimap(plasmid, 'manual').features[0].color).toBe(
      '#111111'
    );
  });

  it('does not mutate the source plasmid DTO', () => {
    withAnnotationDisplayColorsForMinimap(plasmid, 'auto-type');
    expect(plasmid.features[0].color).toBe('#111111');
  });
});

describe('annotationDataToAnnotation — segments', () => {
  it('preserves segments through AnnotationData → Annotation conversion', () => {
    const data: AnnotationData & { segments?: Array<{ start: number; end: number }> } = {
      id: 'ann_1',
      name: 'SplicedCDS',
      type: 'CDS',
      start: 1,
      end: 300,
      strand: 'forward',
      qualifiers: { _locationString: ['join(1..100,200..300)'] },
      segments: [
        { start: 1, end: 100 },
        { start: 200, end: 300 },
      ],
    };

    const annotation = annotationDataToAnnotation(data);

    expect(annotation.segments).toEqual([
      { start: 1, end: 100 },
      { start: 200, end: 300 },
    ]);
    expect(annotation.qualifiers?._locationString?.[0]).toBe('join(1..100,200..300)');
  });
});

describe('findCDSAtPosition', () => {
  const cds: Annotation = {
    name: 'GeneA',
    type: 'CDS',
    start: 100,
    end: 300,
    direction: 1,
  };
  const promoter: Annotation = {
    name: 'prom',
    type: 'promoter',
    start: 50,
    end: 99,
    direction: 1,
  };
  const annotations = [promoter, cds];

  it('returns CDS when hitAnnotation is a CDS', () => {
    const result = findCDSAtPosition(annotations, 150, cds);
    expect(result).toBe(cds);
  });

  it('returns CDS by position when hitAnnotation is null (chevron click)', () => {
    const result = findCDSAtPosition(annotations, 149, null);
    expect(result).toBe(cds);
  });

  it('returns CDS by position when hitAnnotation is a non-CDS type', () => {
    const result = findCDSAtPosition(annotations, 149, promoter);
    expect(result).toBe(cds);
  });

  it('returns null when position is outside all CDS ranges', () => {
    const result = findCDSAtPosition(annotations, 49, null);
    expect(result).toBeNull();
  });

  it('returns null when position is null and no selection', () => {
    const result = findCDSAtPosition(annotations, null, null);
    expect(result).toBeNull();
  });

  it('returns CDS when highlightedRange matches CDS bounding box (double-click)', () => {
    const result = findCDSAtPosition(annotations, null, null, { start: 99, end: 299 });
    expect(result).toBe(cds);
  });

  it('returns CDS when position is null but selection overlaps CDS', () => {
    const result = findCDSAtPosition(annotations, null, null, { start: 120, end: 250 });
    expect(result).toBe(cds);
  });

  it('returns CDS at exact start boundary', () => {
    const result = findCDSAtPosition(annotations, 99, null);
    expect(result).toBe(cds);
  });

  it('returns CDS at exact end boundary', () => {
    const result = findCDSAtPosition(annotations, 299, null);
    expect(result).toBe(cds);
  });

  it('returns null just outside CDS range', () => {
    const result = findCDSAtPosition(annotations, 300, null);
    expect(result).toBeNull();
  });
});

describe('findStructureAnnotationAtPosition', () => {
  const cds: Annotation = {
    name: 'GeneA',
    type: 'CDS',
    start: 100,
    end: 300,
    direction: 1,
  };
  const rrna: Annotation = {
    name: '16S ribosomal RNA',
    type: 'rRNA',
    start: 500,
    end: 2050,
    direction: 1,
  };
  const trna: Annotation = {
    name: 'tRNA-Met',
    type: 'tRNA',
    start: 2200,
    end: 2275,
    direction: -1,
  };
  const promoter: Annotation = {
    name: 'prom',
    type: 'promoter',
    start: 50,
    end: 99,
    direction: 1,
  };
  const annotations = [promoter, cds, rrna, trna];

  it('uses the same searchable type classifier for CDS and RNA feature families', () => {
    expect(isStructureAnnotationType('CDS')).toBe(true);
    expect(isStructureAnnotationType('rRNA')).toBe(true);
    expect(isStructureAnnotationType('tRNA')).toBe(true);
    expect(isStructureAnnotationType('misc_RNA')).toBe(true);
    expect(isStructureAnnotationType('promoter')).toBe(false);
  });

  it('returns RNA when hitAnnotation is an RNA annotation', () => {
    const result = findStructureAnnotationAtPosition(annotations, 550, rrna);
    expect(result).toBe(rrna);
  });

  it('returns RNA by position when no annotation bar was directly hit', () => {
    const result = findStructureAnnotationAtPosition(annotations, 2199, null);
    expect(result).toBe(trna);
  });

  it('returns CDS by position for legacy protein structure lookup', () => {
    const result = findStructureAnnotationAtPosition(annotations, 149, null);
    expect(result).toBe(cds);
  });

  it('does not expose structure lookup for non-structure annotations', () => {
    const result = findStructureAnnotationAtPosition(annotations, 49, promoter);
    expect(result).toBeNull();
  });

  it('returns RNA when a highlighted range matches an RNA feature', () => {
    const result = findStructureAnnotationAtPosition(annotations, null, null, {
      start: 499,
      end: 2049,
    });
    expect(result).toBe(rrna);
  });

  it('finds structure annotations by label token across CDS and RNA feature families', () => {
    const qualifiedRna: Annotation = {
      ...rrna,
      qualifiers: { gene: ['rrsC'], product: ['16S ribosomal RNA'] },
    };

    expect(findStructureAnnotationByLabel([cds, qualifiedRna], 'GeneA')).toBe(cds);
    expect(findStructureAnnotationByLabel([cds, qualifiedRna], 'rrsC')).toBe(qualifiedRna);
    expect(findStructureAnnotationByLabel([promoter, qualifiedRna], 'prom')).toBeNull();
  });

  it('keeps forward RNA structure annotations enabled even when GenBank omits direction', () => {
    const directionlessRna: Annotation = {
      name: 'ffs ncRNA (signal recognition particle 4.5S RNA)',
      type: 'ncRNA',
      start: 1192467,
      end: 1192580,
    };

    expect(structureViewDisabledReason(directionlessRna, 4_641_652)).toBeNull();
  });

  it('keeps RNA structure annotations enabled when parsed as direction 0', () => {
    const rnaWithNeutralDirection: Annotation = {
      name: 'rrsC rRNA (16S ribosomal RNA)',
      type: 'rRNA',
      start: 16175,
      end: 17716,
      direction: 0,
    };

    expect(structureViewDisabledReason(rnaWithNeutralDirection, 4_641_652)).toBeNull();
  });

  it('still disables direction-less CDS structure lookup because translation is ambiguous', () => {
    const directionlessCds: Annotation = {
      name: 'bad CDS',
      type: 'CDS',
      start: 100,
      end: 300,
    };

    expect(structureViewDisabledReason(directionlessCds, 1_000)).toBe('missing_direction');
  });

  it('applies the CDS direction rule case-insensitively', () => {
    const lowercaseCds: Annotation = {
      name: 'bad lowercase CDS',
      type: 'cds',
      start: 100,
      end: 300,
    };

    expect(structureViewDisabledReason(lowercaseCds, 1_000)).toBe('missing_direction');
  });

  it('disables RNA structure lookup when the searchable polymer sequence is too short', () => {
    expect(
      structureViewDisabledReason(
        {
          name: 'tiny RNA',
          type: 'ncRNA',
          start: 10,
          end: 20,
        },
        1_000
      )
    ).toBe('too_short');
  });

  it('does not enable non-structure annotations even when they are long enough', () => {
    expect(
      structureViewDisabledReason(
        {
          name: 'promoter',
          type: 'promoter',
          start: 10,
          end: 200,
        },
        1_000
      )
    ).toBe('unsupported_feature');
  });
});

describe('annotatedSequenceToParsedPlasmid and the record genetic code ', () => {
  const cds: Annotation = {
    name: 'gene',
    type: 'CDS',
    start: 1,
    end: 30,
    direction: 1,
  };

  it("carries the code the record's own genes declare", () => {
    const plasmid = annotatedSequenceToParsedPlasmid({
      id: 'r',
      name: 'r',
      sequence: 'ATG'.repeat(10),
      length: 30,
      circular: false,
      annotations: [{ ...cds, qualifiers: { transl_table: ['4'] } }],
    });

    expect(plasmid.geneticCode).toBe(4);
  });

  it('carries a custom code the user chose, which no feature can declare', () => {
    const built = buildCustomGeneticCode({
      id: 'gc-3f2a9c1e',
      revision: 1,
      name: 'Amber suppression (pAzF at TAG)',
      base: 11,
      changes: { TAG: { kind: 'residue', residue: 'pAzF' } },
      residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
    });
    if (!built.ok) throw new Error('fixture must build');

    const plasmid = annotatedSequenceToParsedPlasmid({
      id: 'r',
      name: 'r',
      sequence: 'ATG'.repeat(10),
      length: 30,
      circular: false,
      chosenGeneticCode: built.definition,
      annotations: [cds],
    });

    expect(plasmid.geneticCode).toEqual(built.definition);
  });

  it('falls back to the standard code rather than leaving the map to guess', () => {
    const plasmid = annotatedSequenceToParsedPlasmid({
      id: 'r',
      name: 'r',
      sequence: 'ATG'.repeat(10),
      length: 30,
      circular: false,
      annotations: [cds],
    });

    expect(plasmid.geneticCode).toBe(1);
  });
});

const UNUSED_SEQUENCE_DATA_ADAPTERS = [
  'sequenceDataToAnnotatedSequence',
  'primerDataToPrimerDisplay',
  'sequenceDataToParsedPlasmid',
  'annotatedSequenceToSequenceData',
  'annotationLabelMatches',
  'createMockSequenceData',
  'annotationDataToPlasmidFeature',
  'primerDataToPlasmidPrimer',
  'annotationToAnnotationData',
] as const;

describe('sequence adapter public surface', () => {
  it('does not export unused SequenceData conversion helpers', () => {
    for (const name of UNUSED_SEQUENCE_DATA_ADAPTERS) {
      expect(sequenceAdapters).not.toHaveProperty(name);
    }
    expect(typeof sequenceAdapters.annotatedSequenceToParsedPlasmid).toBe('function');
    expect(typeof sequenceAdapters.annotationDataToAnnotation).toBe('function');
  });
});
