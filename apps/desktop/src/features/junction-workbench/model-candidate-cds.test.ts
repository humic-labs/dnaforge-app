import { describe, expect, it } from 'vitest';
import { getCodonsForSingleCDS } from '@waypoint/workspace-editor';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import PUBLIC_PUC19_GB from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import type { DesignAnnotation, DesignRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import {
  createAssemblyFixtureApi,
  normalizeFixture,
} from '../design/public/assembly-real-fixture-api';
import { applyOverrideToCanonicalModels, buildJunctionWorkbenchModels } from './model';
import { SourceContextRegistry, createJunctionSourceWindowRequests } from './SourceContextRegistry';
import { buildProductOwnerPreviewSequence } from './WorkbenchPaintingContract';

function qualifierValue(
  qualifiers: Record<string, string | string[]> | undefined,
  key: string
): string | undefined {
  const value = qualifiers?.[key];
  return Array.isArray(value) ? value[0] : value;
}

describe('candidate CDS continuation across junction', () => {
  it('emits a forward-strand candidate when a left-source CDS spans the contribution boundary, ending at first stop in product', () => {
    const leftBody = 'ATG' + 'AAA'.repeat(8) + 'CCC';
    const leftUpstream = 'GGG'.repeat(20);
    const leftDownstream = 'GAA' + 'TTT' + 'TAA' + 'CCC'.repeat(20);
    const leftSource = leftUpstream + leftBody + leftDownstream;
    const leftRegion: DesignRegion = {
      id: 'left',
      sourceSequenceId: 'left-src',
      sourceSequenceName: 'left-src',
      sourceStart: leftUpstream.length,
      sourceEnd: leftUpstream.length + leftBody.length,
      sequence: leftBody,
      annotations: [],
      sourceSequence: leftSource,
      sourceAnnotations: [
        {
          name: 'cds1',
          type: 'CDS',
          start: leftUpstream.length,
          end: leftUpstream.length + leftBody.length + 12,
          strand: 'forward',
          color: '#16a34a',
          qualifiers: { codon_start: '1' },
        },
      ],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const rightBody = 'TTT' + 'TAA' + 'CCC'.repeat(20);
    const rightUpstream = 'GGG'.repeat(20);
    const rightDownstream = 'AAA'.repeat(20);
    const rightSource = rightUpstream + rightBody + rightDownstream;
    const rightRegion: DesignRegion = {
      id: 'right',
      sourceSequenceId: 'right-src',
      sourceSequenceName: 'right-src',
      sourceStart: rightUpstream.length,
      sourceEnd: rightUpstream.length + rightBody.length,
      sequence: rightBody,
      annotations: [],
      sourceSequence: rightSource,
      sourceAnnotations: [],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const design: SequenceDesign = {
      id: 'cds-junction-fwd',
      name: 'CDS junction forward',
      topology: 'circular',
      regions: [leftRegion, rightRegion],
      spacers: [{ junctionIndex: 0, sequence: 'GAA' }],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };

    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 200 }
    );
    const productRow = models[0].rows.find((r) => r.kind === 'product')!;
    const candidates = productRow.annotations.filter(
      (a) => qualifierValue(a.qualifiers, 'candidate') === 'true'
    );

    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    expect(candidate.name).toContain('cds1');
    expect(candidate.name).toContain('predicted continuation');
    expect(candidate.direction).toBe(1);
    expect(candidate.type).toBe('CDS');

    const anchor = productRow.anchorRowPosition;
    expect(candidate.start).toBe(1);
    expect(candidate.end).toBe(anchor + 9);
  });

  it('emits a reverse-strand candidate when a right-source CDS spans the contribution boundary backward', () => {
    const rightBody = 'AAATTTGGGCCC' + 'AAA'.repeat(6);
    const rightUpstream = 'GGGAAA' + 'CCC'.repeat(20);
    const rightDownstream = 'AAA'.repeat(20);
    const rightSource = rightUpstream + rightBody + rightDownstream;
    const rightRegion: DesignRegion = {
      id: 'right',
      sourceSequenceId: 'right-src',
      sourceSequenceName: 'right-src',
      sourceStart: rightUpstream.length,
      sourceEnd: rightUpstream.length + rightBody.length,
      sequence: rightBody,
      annotations: [],
      sourceSequence: rightSource,
      sourceAnnotations: [
        {
          name: 'cds-rev',
          type: 'CDS',
          start: rightUpstream.length - 9,
          end: rightUpstream.length + 6,
          strand: 'reverse',
          color: '#dc2626',
          qualifiers: { codon_start: '1' },
        },
      ],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const leftBody = 'AAA'.repeat(6) + 'AAATTTGGGCCC';
    const leftUpstream = 'GGG'.repeat(20);
    const leftDownstream = 'CCC'.repeat(20);
    const leftSource = leftUpstream + leftBody + leftDownstream;
    const leftRegion: DesignRegion = {
      id: 'left',
      sourceSequenceId: 'left-src',
      sourceSequenceName: 'left-src',
      sourceStart: leftUpstream.length,
      sourceEnd: leftUpstream.length + leftBody.length,
      sequence: leftBody,
      annotations: [],
      sourceSequence: leftSource,
      sourceAnnotations: [],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const design: SequenceDesign = {
      id: 'cds-junction-rev',
      name: 'CDS junction reverse',
      topology: 'circular',
      regions: [leftRegion, rightRegion],
      spacers: [{ junctionIndex: 0, sequence: 'TTA' }],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };

    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 200 }
    );
    const productRow = models[0].rows.find((r) => r.kind === 'product')!;
    const candidates = productRow.annotations.filter(
      (a) => qualifierValue(a.qualifiers, 'candidate') === 'true'
    );

    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    expect(candidate.name).toContain('cds-rev');
    expect(candidate.direction).toBe(-1);
    expect(candidate.type).toBe('CDS');
  });

  it('copies source annotations and emits continuations when full annotations arrive from source windows', () => {
    const leftBody = 'ATG' + 'AAA'.repeat(8) + 'CCC';
    const leftUpstream = 'GGG'.repeat(20);
    const leftDownstream = 'GAA' + 'TTT' + 'TAA' + 'CCC'.repeat(20);
    const leftSource = leftUpstream + leftBody + leftDownstream;
    const leftCds: DesignAnnotation = {
      name: 'left-window-cds',
      type: 'CDS',
      start: leftUpstream.length,
      end: leftUpstream.length + leftBody.length + 12,
      strand: 'forward',
      color: '#16a34a',
      qualifiers: { codon_start: '1' },
    };
    const leftRegion: DesignRegion = {
      id: 'left',
      sourceSequenceId: 'left-src',
      sourceSequenceName: 'left-src',
      sourceStart: leftUpstream.length,
      sourceEnd: leftUpstream.length + leftBody.length,
      sequence: leftBody,
      annotations: [],
      sourceSequence: leftSource,
      sourceAnnotations: [leftCds],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const rightBody = 'TTT' + 'TAA' + 'CCC'.repeat(20);
    const rightUpstream = 'GGG'.repeat(20);
    const rightDownstream = 'AAA'.repeat(20);
    const rightSource = rightUpstream + rightBody + rightDownstream;
    const rightRegion: DesignRegion = {
      id: 'right',
      sourceSequenceId: 'right-src',
      sourceSequenceName: 'right-src',
      sourceStart: rightUpstream.length,
      sourceEnd: rightUpstream.length + rightBody.length,
      sequence: rightBody,
      annotations: [],
      sourceSequence: rightSource,
      sourceAnnotations: [],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const design: SequenceDesign = {
      id: 'windowed-source-annotations',
      name: 'Windowed source annotations',
      topology: 'circular',
      regions: [leftRegion, rightRegion],
      spacers: [{ junctionIndex: 0, sequence: 'GAA' }],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };

    const draft = computeDraftAssembly(design);
    const drafted = {
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
    };
    const stripped: SequenceDesign = {
      ...drafted,
      regions: drafted.regions.map((region) => ({
        ...region,
        sourceSequence: undefined,
        sourceAnnotations: undefined,
        sourceIsCircular: undefined,
      })),
    };
    const sourceWindows = new SourceContextRegistry({
      'left-src': {
        id: 'left-src',
        name: 'left-src',
        sequence: leftSource,
        length: leftSource.length,
        circular: false,
        annotations: [
          {
            name: leftCds.name,
            type: leftCds.type,
            start: leftCds.start + 1,
            end: leftCds.end,
            direction: 1,
            color: leftCds.color,
            qualifiers: leftCds.qualifiers,
          },
        ],
      },
      'right-src': {
        id: 'right-src',
        name: 'right-src',
        sequence: rightSource,
        length: rightSource.length,
        circular: false,
        annotations: [],
      },
    }).resolveWindows(createJunctionSourceWindowRequests(stripped, { maxWindowBp: 200 }));

    const models = buildJunctionWorkbenchModels(stripped, {
      maxWindowBp: 200,
      sourceWindows,
    });
    const productRow = models[0].rows.find((r) => r.kind === 'product')!;
    const copiedSourceCds = productRow.annotations.filter(
      (annotation) =>
        annotation.name === 'left-window-cds' &&
        qualifierValue(annotation.qualifiers, 'candidate') !== 'true'
    );
    const candidates = productRow.annotations.filter(
      (annotation) => qualifierValue(annotation.qualifiers, 'candidate') === 'true'
    );

    expect(copiedSourceCds).toHaveLength(0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toContain('left-window-cds');
    expect(candidates[0].start).toBeLessThan(productRow.anchorRowPosition + 1);
  });

  it('reprojects preview product CDS frame from the shifted source slice at non-3bp drag offsets', () => {
    const leftBody = 'ATG' + 'AAA'.repeat(8) + 'CCC';
    const leftUpstream = 'GGG'.repeat(20);
    const leftDownstream = 'GAA' + 'TTT' + 'TAA' + 'CCC'.repeat(20);
    const leftSource = leftUpstream + leftBody + leftDownstream;
    const leftCds: DesignAnnotation = {
      name: 'preview-left-cds',
      type: 'CDS',
      start: leftUpstream.length,
      end: leftUpstream.length + leftBody.length + 12,
      strand: 'forward',
      color: '#16a34a',
      qualifiers: { codon_start: '1' },
    };
    const rightBody = 'TTT' + 'TAA' + 'CCC'.repeat(20);
    const rightUpstream = 'GGG'.repeat(20);
    const rightDownstream = 'AAA'.repeat(20);
    const rightSource = rightUpstream + rightBody + rightDownstream;
    const design: SequenceDesign = {
      id: 'preview-frame-non-triplet',
      name: 'Preview frame non-triplet',
      topology: 'circular',
      regions: [
        {
          id: 'left',
          sourceSequenceId: 'left-src',
          sourceSequenceName: 'left-src',
          sourceStart: leftUpstream.length,
          sourceEnd: leftUpstream.length + leftBody.length,
          sequence: leftBody,
          annotations: [],
          sourceSequence: leftSource,
          sourceAnnotations: [leftCds],
          sourceIsCircular: false,
          sourceType: 'pcr',
        },
        {
          id: 'right',
          sourceSequenceId: 'right-src',
          sourceSequenceName: 'right-src',
          sourceStart: rightUpstream.length,
          sourceEnd: rightUpstream.length + rightBody.length,
          sequence: rightBody,
          annotations: [],
          sourceSequence: rightSource,
          sourceAnnotations: [],
          sourceIsCircular: false,
          sourceType: 'pcr',
        },
      ],
      spacers: [{ junctionIndex: 0, sequence: 'GAA' }],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };
    const draft = computeDraftAssembly(design);
    const drafted = {
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
    };
    const stripped: SequenceDesign = {
      ...drafted,
      regions: drafted.regions.map((region) => ({
        ...region,
        sourceSequence: undefined,
        sourceAnnotations: undefined,
        sourceIsCircular: undefined,
      })),
    };
    const sourceWindows = new SourceContextRegistry({
      'left-src': {
        id: 'left-src',
        name: 'left-src',
        sequence: leftSource,
        length: leftSource.length,
        circular: false,
        annotations: [
          {
            name: leftCds.name,
            type: leftCds.type,
            start: leftCds.start + 1,
            end: leftCds.end,
            direction: 1,
            color: leftCds.color,
            qualifiers: leftCds.qualifiers,
          },
        ],
      },
      'right-src': {
        id: 'right-src',
        name: 'right-src',
        sequence: rightSource,
        length: rightSource.length,
        circular: false,
        annotations: [],
      },
    }).resolveWindows(createJunctionSourceWindowRequests(stripped, { maxWindowBp: 200 }));
    const canonical = buildJunctionWorkbenchModels(stripped, {
      maxWindowBp: 200,
      sourceWindows,
    });
    const shifted = applyOverrideToCanonicalModels(
      canonical,
      sourceWindows,
      { junctionIndex: 0, rowKind: 'left-source', offsetBp: 1 },
      stripped
    );
    const productRow = shifted[0].rows.find((row) => row.kind === 'product')!;
    const leftSourceRow = shifted[0].rows.find((row) => row.kind === 'left-source')!;
    const preview = productRow.productDragPreview!;
    const copiedPreviewCds = preview.annotations.find(
      (annotation) =>
        annotation.name === 'preview-left-cds' &&
        qualifierValue(annotation.qualifiers, 'candidate') !== 'true'
    );
    const unifiedPreviewCds = preview.annotations.find(
      (annotation) =>
        annotation.name.includes('preview-left-cds') &&
        qualifierValue(annotation.qualifiers, 'candidate') === 'true'
    );

    expect(preview.owner).toBe('left');
    expect(copiedPreviewCds).toBeUndefined();
    expect(unifiedPreviewCds?.start).toBeLessThan(productRow.anchorRowPosition + 1);
    expect(unifiedPreviewCds?.end).toBeGreaterThan(productRow.anchorRowPosition);
    expect(qualifierValue(unifiedPreviewCds?.qualifiers, 'codon_start')).toBe('3');

    const renderedPreview = buildProductOwnerPreviewSequence({
      productRow,
      activeSourceRow: leftSourceRow,
      owner: 'left',
    });
    const renderedUnifiedCds = renderedPreview?.annotations.find(
      (annotation) =>
        annotation.name.includes('preview-left-cds') &&
        qualifierValue(annotation.qualifiers, 'candidate') === 'true'
    );
    expect(renderedUnifiedCds?.end).toBe(unifiedPreviewCds?.end);
    expect(renderedUnifiedCds?.end).toBeGreaterThan(productRow.anchorRowPosition);
  });

  it('recomputes preview candidate CDS frame after clipping to the visible product row', () => {
    const leftBody = 'ATG' + 'AAA'.repeat(58) + 'CCC';
    const leftUpstream = 'GGG'.repeat(20);
    const leftDownstream = 'AAA'.repeat(80);
    const leftSource = leftUpstream + leftBody + leftDownstream;
    const leftCds: DesignAnnotation = {
      name: 'long-preview-left-cds',
      type: 'CDS',
      start: leftUpstream.length,
      end: leftUpstream.length + leftBody.length + 60,
      strand: 'forward',
      color: '#16a34a',
      qualifiers: { codon_start: '1' },
    };
    const rightBody = 'AAA'.repeat(80);
    const rightUpstream = 'CCC'.repeat(20);
    const rightDownstream = 'GGG'.repeat(20);
    const rightSource = rightUpstream + rightBody + rightDownstream;
    const design: SequenceDesign = {
      id: 'preview-frame-clipped-row',
      name: 'Preview frame clipped row',
      topology: 'circular',
      regions: [
        {
          id: 'left',
          sourceSequenceId: 'left-src',
          sourceSequenceName: 'left-src',
          sourceStart: leftUpstream.length,
          sourceEnd: leftUpstream.length + leftBody.length,
          sequence: leftBody,
          annotations: [],
          sourceSequence: leftSource,
          sourceAnnotations: [leftCds],
          sourceIsCircular: false,
          sourceType: 'pcr',
        },
        {
          id: 'right',
          sourceSequenceId: 'right-src',
          sourceSequenceName: 'right-src',
          sourceStart: rightUpstream.length,
          sourceEnd: rightUpstream.length + rightBody.length,
          sequence: rightBody,
          annotations: [],
          sourceSequence: rightSource,
          sourceAnnotations: [],
          sourceIsCircular: false,
          sourceType: 'pcr',
        },
      ],
      spacers: [{ junctionIndex: 0, sequence: 'GAA' }],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };
    const draft = computeDraftAssembly(design);
    const drafted = {
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
    };
    const stripped: SequenceDesign = {
      ...drafted,
      regions: drafted.regions.map((region) => ({
        ...region,
        sourceSequence: undefined,
        sourceAnnotations: undefined,
        sourceIsCircular: undefined,
      })),
    };
    const sourceWindows = new SourceContextRegistry({
      'left-src': {
        id: 'left-src',
        name: 'left-src',
        sequence: leftSource,
        length: leftSource.length,
        circular: false,
        annotations: [
          {
            name: leftCds.name,
            type: leftCds.type,
            start: leftCds.start + 1,
            end: leftCds.end,
            direction: 1,
            color: leftCds.color,
            qualifiers: leftCds.qualifiers,
          },
        ],
      },
      'right-src': {
        id: 'right-src',
        name: 'right-src',
        sequence: rightSource,
        length: rightSource.length,
        circular: false,
        annotations: [],
      },
    }).resolveWindows(createJunctionSourceWindowRequests(stripped, { maxWindowBp: 200 }));
    const canonical = buildJunctionWorkbenchModels(stripped, {
      maxWindowBp: 200,
      sourceWindows,
    });
    const baseProductRow = canonical[0].rows.find((row) => row.kind === 'product')!;
    expect(baseProductRow.coordinateStart).toBeGreaterThan(0);

    for (const offsetBp of [1, 2, 4]) {
      const shifted = applyOverrideToCanonicalModels(
        canonical,
        sourceWindows,
        { junctionIndex: 0, rowKind: 'left-source', offsetBp },
        stripped
      );
      const productRow = shifted[0].rows.find((row) => row.kind === 'product')!;
      const preview = productRow.productDragPreview!;
      const candidate = preview.annotations.find(
        (annotation) =>
          annotation.name.includes('long-preview-left-cds') &&
          qualifierValue(annotation.qualifiers, 'candidate') === 'true'
      );
      const fullCandidateCodonOffset = positiveModulo(-offsetBp, 3);
      const expectedClippedCodonStart =
        positiveModulo(fullCandidateCodonOffset - productRow.coordinateStart, 3) + 1;

      expect(candidate?.start).toBe(1);
      expect(qualifierValue(candidate?.qualifiers, 'codon_start')).toBe(
        String(expectedClippedCodonStart)
      );
    }
  });

  it('previews right-source reverse CDS translation at every snapped source-drag offset', () => {
    const leftBody = 'AAA'.repeat(30);
    const leftUpstream = 'GGG'.repeat(20);
    const leftDownstream = 'CCC'.repeat(20);
    const leftSource = leftUpstream + leftBody + leftDownstream;
    const rightBody = 'ATG' + 'AAA'.repeat(29);
    const rightUpstream = 'GGA'.repeat(20);
    const rightDownstream = 'TTT'.repeat(20);
    const rightSource = rightUpstream + rightBody + rightDownstream;
    const rightAnnotations: DesignAnnotation[] = Array.from({ length: 24 }, (_, index) => {
      const start = rightUpstream.length - 30 + index * 13;
      return {
        name: `right-preview-reverse-cds-${index}`,
        type: 'CDS',
        start,
        end: start + 36,
        strand: 'reverse',
        color: '#dc2626',
        qualifiers: { codon_start: String((index % 3) + 1) },
      };
    });
    const design: SequenceDesign = {
      id: 'right-reverse-preview-diagnostic',
      name: 'Right reverse preview diagnostic',
      topology: 'circular',
      regions: [
        {
          id: 'left',
          sourceSequenceId: 'left-src',
          sourceSequenceName: 'left-src',
          sourceStart: leftUpstream.length,
          sourceEnd: leftUpstream.length + leftBody.length,
          sequence: leftBody,
          annotations: [],
          sourceSequence: leftSource,
          sourceAnnotations: [],
          sourceIsCircular: false,
          sourceType: 'pcr',
        },
        {
          id: 'right',
          sourceSequenceId: 'right-src',
          sourceSequenceName: 'right-src',
          sourceStart: rightUpstream.length,
          sourceEnd: rightUpstream.length + rightBody.length,
          sequence: rightBody,
          annotations: [],
          sourceSequence: rightSource,
          sourceAnnotations: rightAnnotations,
          sourceIsCircular: false,
          sourceType: 'pcr',
        },
      ],
      spacers: [{ junctionIndex: 0, sequence: 'GAA' }],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };
    const draft = computeDraftAssembly(design);
    const drafted = {
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
    };
    const sourceWindows = new SourceContextRegistry({}).resolveWindows(
      createJunctionSourceWindowRequests(drafted, { maxWindowBp: 160 })
    );
    const canonical = buildJunctionWorkbenchModels(drafted, {
      maxWindowBp: 160,
      sourceWindows,
    });
    const canonicalProduct = canonical[0].rows.find((row) => row.kind === 'product')!;
    const rowsByOffset = Array.from({ length: 16 }, (_, offsetBp) => {
      const shifted = applyOverrideToCanonicalModels(
        canonical,
        sourceWindows,
        { junctionIndex: 0, rowKind: 'right-source', offsetBp },
        drafted
      );
      const productRow = shifted[0].rows.find((row) => row.kind === 'product')!;
      const preview = productRow.productDragPreview;
      const matching = preview?.annotations.filter((annotation) =>
        annotation.name.includes('right-preview-reverse-cds')
      );
      return {
        offsetBp,
        owner: preview?.owner,
        canonicalAnnotationsPreserved: productRow.annotations === canonicalProduct.annotations,
        copied: matching?.filter(
          (annotation) => qualifierValue(annotation.qualifiers, 'candidate') !== 'true'
        ).length,
        candidates: matching?.filter(
          (annotation) => qualifierValue(annotation.qualifiers, 'candidate') === 'true'
        ).length,
        codonCounts: matching?.map(
          (annotation) =>
            getCodonsForSingleCDS(
              annotation,
              0,
              preview?.sequence.length ?? 0,
              preview?.sequence ?? ''
            ).length
        ),
      };
    });

    expect(rowsByOffset).toHaveLength(16);
    expect(rowsByOffset[0]).toEqual({
      offsetBp: 0,
      owner: undefined,
      canonicalAnnotationsPreserved: true,
      copied: undefined,
      candidates: undefined,
      codonCounts: undefined,
    });
    for (const row of rowsByOffset.slice(1)) {
      expect(row.owner).toBe('right');
      expect(row.canonicalAnnotationsPreserved).toBe(true);
      expect((row.copied ?? 0) + (row.candidates ?? 0)).toBeGreaterThan(0);
      expect(row.codonCounts?.some((count) => count > 0)).toBe(true);
    }
    expect(rowsByOffset.some((row) => (row.candidates ?? 0) > 0)).toBe(true);
  });

  it('anchors the reading frame on cds.start, not on the contribution boundary', () => {
    const leftBody = 'AAAAA' + 'CCC'.repeat(7) + 'GGG' + 'TTT';
    const leftPreCdsContext = 'CGT'.repeat(20);
    const leftPreCdsBeforeContribution = 'AAATGAA';
    const leftDownstream = 'CC' + 'TAA';
    const leftSource = leftPreCdsContext + leftPreCdsBeforeContribution + leftBody + leftDownstream;
    const cdsStartSrc = leftPreCdsContext.length;
    const leftSourceStart = leftPreCdsContext.length + leftPreCdsBeforeContribution.length;
    const leftSourceEnd = leftSourceStart + leftBody.length;
    const leftRegion: DesignRegion = {
      id: 'left',
      sourceSequenceId: 'left-src',
      sourceSequenceName: 'left-src',
      sourceStart: leftSourceStart,
      sourceEnd: leftSourceEnd,
      sequence: leftBody,
      annotations: [],
      sourceSequence: leftSource,
      sourceAnnotations: [
        {
          name: 'cds-upstream',
          type: 'CDS',
          start: cdsStartSrc,
          end: leftSourceEnd + 9,
          strand: 'forward',
          color: '#16a34a',
          qualifiers: { codon_start: '1' },
        },
      ],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const rightBody = 'TAA' + 'CCC'.repeat(20);
    const rightUpstream = 'GGG'.repeat(20);
    const rightDownstream = 'AAA'.repeat(20);
    const rightSource = rightUpstream + rightBody + rightDownstream;
    const rightRegion: DesignRegion = {
      id: 'right',
      sourceSequenceId: 'right-src',
      sourceSequenceName: 'right-src',
      sourceStart: rightUpstream.length,
      sourceEnd: rightUpstream.length + rightBody.length,
      sequence: rightBody,
      annotations: [],
      sourceSequence: rightSource,
      sourceAnnotations: [],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const design: SequenceDesign = {
      id: 'frame-anchor-test',
      name: 'frame anchor test',
      topology: 'circular',
      regions: [leftRegion, rightRegion],
      spacers: [],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };

    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 200 }
    );
    const productRow = models[0].rows.find((r) => r.kind === 'product')!;
    const candidates = productRow.annotations.filter(
      (a) => qualifierValue(a.qualifiers, 'candidate') === 'true'
    );

    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    expect(candidate.direction).toBe(1);
    const anchor = productRow.anchorRowPosition;
    expect(candidate.start).toBe(1);
    expect(candidate.end).toBe(anchor + 3);
    expect(qualifierValue(candidate.qualifiers, 'codon_start')).toBe('3');
  });

  it('does not emit candidates when no CDS spans the contribution boundary', () => {
    const body = 'ATGCGTAC'.repeat(80);
    const upstream = 'TTT'.repeat(20);
    const downstream = 'GGG'.repeat(20);
    const sourceSeq = upstream + body + downstream;
    const region: DesignRegion = {
      id: 'reg',
      sourceSequenceId: 'src',
      sourceSequenceName: 'src',
      sourceStart: upstream.length,
      sourceEnd: upstream.length + body.length,
      sequence: body,
      annotations: [],
      sourceSequence: sourceSeq,
      sourceAnnotations: [
        {
          name: 'fully-internal',
          type: 'CDS',
          start: upstream.length + 30,
          end: upstream.length + 60,
          strand: 'forward',
          color: '#16a34a',
        } satisfies DesignAnnotation,
      ],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };

    const design: SequenceDesign = {
      id: 'no-spanning-cds',
      name: 'No spanning CDS',
      topology: 'circular',
      regions: [region, { ...region, id: 'reg2', sourceSequenceId: 'src2' }],
      spacers: [],
      version: 0,
      assemblyState: 'drafting',
      validationErrors: [],
      proposedPlans: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date('2026-04-26T00:00:00.000Z'),
      updatedAt: new Date('2026-04-26T00:00:00.000Z'),
    };

    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 200 }
    );
    const productRow = models[0].rows.find((r) => r.kind === 'product')!;
    const candidates = productRow.annotations.filter(
      (a) => qualifierValue(a.qualifiers, 'candidate') === 'true'
    );
    expect(candidates).toHaveLength(0);
  });

  it('continues a real pUC19 source-cache CDS across a spacer-containing workbench junction', () => {
    const fixture = normalizeFixture({
      id: 'public-puc19-reverse-cds',
      label: 'pUC19',
      source: 'test-fixtures/sequences/circular/pUC19.gb',
      parsed: parseGenBankFull(PUBLIC_PUC19_GB),
    });
    const api = createAssemblyFixtureApi({ puc19: fixture });
    const design = api.design(
      [
        api.pcrRegion(fixture, 'puc19-pcr-left', 2000, 360),
        api.rdRegion(fixture, 'BsmBI', 'puc19-bsmbi-rd', { minLength: 20, noWrap: true }).region,
        api.pcrRegion(fixture, 'puc19-pcr-right', 240, 360),
      ],
      {
        assemblyMethod: 'gibson',
        spacers: [api.realSpacer(fixture, 1912, 5, 0), api.realSpacer(fixture, 2184, 7, 2)],
      }
    );
    const draft = computeDraftAssembly(design);
    design.homologyRegions = draft.homologyRegions;
    design.designPrimers = draft.designPrimers;
    const sourceWindows = new SourceContextRegistry({
      [fixture.id]: { ...fixture.parsed, id: fixture.id },
    }).resolveWindows(createJunctionSourceWindowRequests(design, { maxWindowBp: 500 }));
    const models = buildJunctionWorkbenchModels(design, { maxWindowBp: 500, sourceWindows });
    const model = models.find((candidateModel) => candidateModel.junctionIndex === 2);
    const productRow = model?.rows.find((row) => row.kind === 'product');
    if (!productRow) throw new Error('Missing real spacer product row.');

    const ampRContinuations = productRow.annotations.filter(
      (annotation) =>
        annotation.name === 'AmpR (predicted continuation)' &&
        qualifierValue(annotation.qualifiers, 'candidate') === 'true'
    );

    expect(ampRContinuations).toHaveLength(1);
    expect(ampRContinuations[0].direction).toBe(-1);
    expect(
      productRow.annotations.filter(
        (annotation) =>
          annotation.name === 'AmpR' &&
          qualifierValue(annotation.qualifiers, 'candidate') !== 'true'
      )
    ).toHaveLength(0);
    expect(productRow.spacerColumns?.length ?? 0).toBeGreaterThan(0);
    expect(
      productRow.spacerColumns?.map((column) =>
        annotationContainsRowPosition(ampRContinuations[0], column + 1)
      )
    ).toEqual(Array(productRow.spacerColumns?.length ?? 0).fill(true));
  });
});

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function annotationContainsRowPosition(
  annotation: ReturnType<
    typeof buildJunctionWorkbenchModels
  >[number]['rows'][number]['annotations'][number],
  oneBasedPosition: number
): boolean {
  const segments = annotation.segments ?? [{ start: annotation.start, end: annotation.end }];
  return segments.some(
    (segment) => oneBasedPosition >= segment.start && oneBasedPosition <= segment.end
  );
}
