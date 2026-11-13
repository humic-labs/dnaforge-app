import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import { buildJunctionWorkbenchModels } from './model';
import { SourceContextRegistry, createJunctionSourceWindowRequests } from './SourceContextRegistry';

interface DragVariant {
  name: string;
  build: () => SequenceDesign;
}

const VARIANTS: DragVariant[] = [
  { name: 'gibson 2-region no spacer', build: () => buildGibsonDesign({ spacers: [] }) },
  {
    name: 'gibson 2-region with 6bp spacer',
    build: () => buildGibsonDesign({ spacers: [{ junctionIndex: 0, sequence: 'AGCTGT' }] }),
  },
  {
    name: 'gibson 3-region with mixed spacers',
    build: () =>
      buildGibsonDesign({
        regions: 3,
        spacers: [
          { junctionIndex: 0, sequence: 'TT' },
          { junctionIndex: 1, sequence: '' },
          { junctionIndex: 2, sequence: 'GAGAG' },
        ],
      }),
  },
  { name: 'nebuilder 2-region no spacer', build: () => buildGibsonDesign({ method: 'nebuilder' }) },
];

const OFFSETS = [-20, -5, +5, +20];

describe('source-register drag override — model invariants', () => {
  for (const variant of VARIANTS) {
    describe(variant.name, () => {
      it.each(OFFSETS)(
        'C1: offsetBp=%d shifts bases at canonical viewport positions on the active source row',
        (offsetBp) => {
          const baseline = buildModelsWithOverride(variant.build(), null);
          const shifted = buildModelsWithOverride(variant.build(), {
            junctionIndex: 0,
            rowKind: 'left-source',
            offsetBp,
          });
          const baselineRow = baseline[0].rows.find((r) => r.kind === 'left-source')!;
          const shiftedRow = shifted[0].rows.find((r) => r.kind === 'left-source')!;
          const anchor = baselineRow.anchorRowPosition;
          const baselineSlice = baselineRow.sequence.slice(anchor - 12, anchor);
          const shiftedSlice = shiftedRow.sequence.slice(anchor - 12, anchor);
          expect(
            shiftedSlice,
            `shift offsetBp=${offsetBp} produced an identical visible band — ` +
              `source axis path didn't reach the canvas. baseline=${baselineSlice} shifted=${shiftedSlice}`
          ).not.toBe(baselineSlice);
        }
      );

      it.each(OFFSETS)(
        'C1: offsetBp=%d shifts bases on the active right source row',
        (offsetBp) => {
          const baseline = buildModelsWithOverride(variant.build(), null);
          const shifted = buildModelsWithOverride(variant.build(), {
            junctionIndex: 0,
            rowKind: 'right-source',
            offsetBp,
          });
          const baselineRow = baseline[0].rows.find((r) => r.kind === 'right-source')!;
          const shiftedRow = shifted[0].rows.find((r) => r.kind === 'right-source')!;
          const anchor = baselineRow.anchorRowPosition;
          const baselineSlice = baselineRow.sequence.slice(anchor, anchor + 12);
          const shiftedSlice = shiftedRow.sequence.slice(anchor, anchor + 12);
          expect(
            shiftedSlice,
            `right-source offsetBp=${offsetBp} produced identical visible band. ` +
              `baseline=${baselineSlice} shifted=${shiftedSlice}`
          ).not.toBe(baselineSlice);
        }
      );

      it.each(OFFSETS)(
        'C2: offsetBp=%d preserves row.contributingColumns on left source',
        (offsetBp) => {
          const { baseline, shifted } = buildPair(variant, 'left-source', offsetBp);
          expect(shifted.contributingColumns).toEqual(baseline.contributingColumns);
        }
      );

      it.each(OFFSETS)('C2: offsetBp=%d preserves row.mutedColumns on left source', (offsetBp) => {
        const { baseline, shifted } = buildPair(variant, 'left-source', offsetBp);
        expect(shifted.mutedColumns).toEqual(baseline.mutedColumns);
      });

      it.each(OFFSETS)(
        'C2: offsetBp=%d preserves row.anchorRowPosition on left source',
        (offsetBp) => {
          const { baseline, shifted } = buildPair(variant, 'left-source', offsetBp);
          expect(shifted.anchorRowPosition).toBe(baseline.anchorRowPosition);
        }
      );

      it.each(OFFSETS)(
        'C2: offsetBp=%d preserves row.contributingColumns on right source',
        (offsetBp) => {
          const { baseline, shifted } = buildPair(variant, 'right-source', offsetBp);
          expect(shifted.contributingColumns).toEqual(baseline.contributingColumns);
        }
      );

      it.each(OFFSETS)('C2: offsetBp=%d preserves row.mutedColumns on right source', (offsetBp) => {
        const { baseline, shifted } = buildPair(variant, 'right-source', offsetBp);
        expect(shifted.mutedColumns).toEqual(baseline.mutedColumns);
      });

      it.each(OFFSETS)(
        'C1: offsetBp=%d shifts annotations on the active source row by -offsetBp',
        (offsetBp) => {
          const designWithCds = withSourceCds(variant.build(), 'left');
          const baseline = buildModelsWithOverride(designWithCds, null);
          const shifted = buildModelsWithOverride(designWithCds, {
            junctionIndex: 0,
            rowKind: 'left-source',
            offsetBp,
          });
          const canonicalRow = baseline[0].rows.find((r) => r.kind === 'left-source')!;
          const shiftedRow = shifted[0].rows.find((r) => r.kind === 'left-source')!;
          expect(shiftedRow.dragShiftedAnnotations).toBeDefined();
          expect(shiftedRow.dragShiftedAnnotations!.length).toBe(canonicalRow.annotations.length);
          for (let i = 0; i < canonicalRow.annotations.length; i++) {
            expect(shiftedRow.dragShiftedAnnotations![i].start, `annotation #${i}.start`).toBe(
              canonicalRow.annotations[i].start - offsetBp
            );
            expect(shiftedRow.dragShiftedAnnotations![i].end, `annotation #${i}.end`).toBe(
              canonicalRow.annotations[i].end - offsetBp
            );
          }
          expect(shiftedRow.annotations).toEqual(canonicalRow.annotations);
          if (canonicalRow.continuousAnnotations) {
            expect(shiftedRow.dragShiftedContinuousAnnotations).toBeDefined();
            for (let i = 0; i < canonicalRow.continuousAnnotations.length; i++) {
              expect(
                shiftedRow.dragShiftedContinuousAnnotations![i].start,
                `continuous annotation #${i}.start`
              ).toBe(canonicalRow.continuousAnnotations[i].start - offsetBp);
            }
          }
        }
      );

      it('C2: offsetBp=0 leaves models structurally identical to baseline', () => {
        const baseline = buildModelsWithOverride(variant.build(), null);
        const zeroShift = buildModelsWithOverride(variant.build(), {
          junctionIndex: 0,
          rowKind: 'left-source',
          offsetBp: 0,
        });
        for (let i = 0; i < baseline.length; i++) {
          for (const row of baseline[i].rows) {
            const counterpart = zeroShift[i].rows.find((r) => r.id === row.id)!;
            expect(counterpart.sequence).toBe(row.sequence);
            expect(counterpart.contributingColumns).toEqual(row.contributingColumns);
            expect(counterpart.mutedColumns).toEqual(row.mutedColumns);
            expect(counterpart.anchorRowPosition).toBe(row.anchorRowPosition);
          }
        }
      });
    });
  }
});

function withSourceCds(design: SequenceDesign, side: 'left' | 'right'): SequenceDesign {
  return {
    ...design,
    regions: design.regions.map((region, idx) => {
      const targetIdx = side === 'left' ? 0 : 1;
      if (idx !== targetIdx) return region;
      return {
        ...region,
        sourceAnnotations: [
          {
            name: `${region.id}-cds`,
            type: 'CDS',
            start: side === 'left' ? region.sourceEnd - 12 : region.sourceStart,
            end: side === 'left' ? region.sourceEnd : region.sourceStart + 12,
            strand: 'forward',
            color: '#16a34a',
            qualifiers: { codon_start: '1' },
          },
        ],
      };
    }),
  };
}

function buildPair(
  variant: DragVariant,
  rowKind: 'left-source' | 'right-source',
  offsetBp: number
) {
  const baselineModels = buildModelsWithOverride(variant.build(), null);
  const shiftedModels = buildModelsWithOverride(variant.build(), {
    junctionIndex: 0,
    rowKind,
    offsetBp,
  });
  return {
    baseline: baselineModels[0].rows.find((r) => r.kind === rowKind)!,
    shifted: shiftedModels[0].rows.find((r) => r.kind === rowKind)!,
  };
}

function buildModelsWithOverride(
  design: SequenceDesign,
  override: {
    junctionIndex: number;
    rowKind: 'left-source' | 'right-source';
    offsetBp: number;
  } | null
) {
  const draft = computeDraftAssembly(design);
  const drafted = {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
  };
  const sourceSequences = Object.fromEntries(
    drafted.regions.map((region) => [
      region.sourceSequenceId,
      {
        id: region.sourceSequenceId,
        name: region.sourceSequenceName,
        sequence: region.sourceSequence!,
        length: region.sourceSequence!.length,
        circular: false,
        annotations: (region.sourceAnnotations ?? []).map((annotation) => ({
          name: annotation.name,
          type: annotation.type,
          start: annotation.start,
          end: annotation.end,
          strand: annotation.strand === 'reverse' ? -1 : annotation.strand === 'forward' ? 1 : 0,
          color: annotation.color,
          qualifiers: annotation.qualifiers,
        })),
      },
    ])
  );
  const stripped: SequenceDesign = {
    ...drafted,
    regions: drafted.regions.map((region) => ({
      ...region,
      sourceSequence: undefined,
      sourceAnnotations: undefined,
      sourceIsCircular: undefined,
    })),
  };
  const sourceWindows = new SourceContextRegistry(sourceSequences).resolveWindows(
    createJunctionSourceWindowRequests(stripped, { maxWindowBp: 200 })
  );
  return buildJunctionWorkbenchModels(stripped, {
    maxWindowBp: 200,
    sourceWindows,
    sourceDragOverride: override ?? undefined,
  });
}

interface BuildOptions {
  method?: SequenceDesign['assemblyMethod'];
  regions?: 2 | 3;
  spacers?: Array<{ junctionIndex: number; sequence: string }>;
}

function buildGibsonDesign(opts: BuildOptions = {}): SequenceDesign {
  const { method = 'gibson', regions = 2, spacers = [] } = opts;
  const now = new Date('2026-04-26T00:00:00.000Z');
  const all = makeRegions(regions);
  return {
    id: `model-drag-${method}-${regions}`,
    name: `Model drag override design (${method}, ${regions} regions)`,
    topology: 'circular',
    regions: all,
    spacers,
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: method,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: method === 'goldengate' ? { enzyme: 'BsaI' } : undefined,
    goldenGateJunctions: method === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRegions(count: 2 | 3): DesignRegion[] {
  const labels = ['alpha', 'beta', 'gamma'].slice(0, count) as readonly string[];
  return labels.map((label, idx) => regionFor(label, idx));
}

function regionFor(label: string, index: number): DesignRegion {
  const bodies = ['ATGCGTAC', 'GGCATACC', 'TGAGTCAA'];
  const ups = ['T', 'A', 'C'];
  const downs = ['G', 'C', 'A'];
  const body = bodies[index % bodies.length].repeat(80);
  const upstream = ups[index % ups.length].repeat(320);
  const downstream = downs[index % downs.length].repeat(320);
  const sourceSequence = upstream + body + downstream;
  return {
    id: label,
    sourceSequenceId: label,
    sourceSequenceName: label,
    sourceStart: upstream.length,
    sourceEnd: upstream.length + body.length,
    sequence: body,
    annotations: [],
    sourceSequence,
    sourceAnnotations: [],
    sourceIsCircular: false,
    sourceType: 'pcr',
  };
}
