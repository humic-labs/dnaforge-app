import { describe, expect, it } from 'vitest';
import type { DesignAnnotation, DesignRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import { buildJunctionWorkbenchModels } from './model';

interface SetupOptions {
  leftBody: string;
  rightBody: string;
  spacer: string;
  leftCds?: {
    startBeforeBodyBy?: number;
    endAfterBodyBy?: number;
    codonStart?: 1 | 2 | 3;
  };
  rightReverseCds?: {
    startBeforeBodyBy?: number;
    endAfterBodyStartBy?: number;
    codonStart?: 1 | 2 | 3;
  };
  rightDownstreamContext?: string;
}

function makeDesign(opts: SetupOptions): SequenceDesign {
  const leftUpstream = 'GGG'.repeat(40);
  const leftDownstream = (opts.rightDownstreamContext ?? '') + 'CCC'.repeat(40);
  const leftSource = leftUpstream + opts.leftBody + leftDownstream;
  const leftSourceStart = leftUpstream.length;
  const leftSourceEnd = leftSourceStart + opts.leftBody.length;

  const rightUpstream = 'AAA'.repeat(40);
  const rightDownstream = 'TTT'.repeat(40);
  const rightSource = rightUpstream + opts.rightBody + rightDownstream;
  const rightSourceStart = rightUpstream.length;
  const rightSourceEnd = rightSourceStart + opts.rightBody.length;

  const leftSourceAnnotations: DesignAnnotation[] = [];
  if (opts.leftCds) {
    const start = leftSourceStart - (opts.leftCds.startBeforeBodyBy ?? 0);
    const end = leftSourceEnd + (opts.leftCds.endAfterBodyBy ?? 0);
    leftSourceAnnotations.push({
      name: 'left-cds',
      type: 'CDS',
      start,
      end,
      strand: 'forward',
      color: '#16a34a',
      qualifiers: { codon_start: String(opts.leftCds.codonStart ?? 1) },
    });
  }

  const rightSourceAnnotations: DesignAnnotation[] = [];
  if (opts.rightReverseCds) {
    const start = rightSourceStart - (opts.rightReverseCds.startBeforeBodyBy ?? 0);
    const end = rightSourceStart + (opts.rightReverseCds.endAfterBodyStartBy ?? 0);
    rightSourceAnnotations.push({
      name: 'right-rev-cds',
      type: 'CDS',
      start,
      end,
      strand: 'reverse',
      color: '#dc2626',
      qualifiers: { codon_start: String(opts.rightReverseCds.codonStart ?? 1) },
    });
  }

  const leftRegion: DesignRegion = {
    id: 'left',
    sourceSequenceId: 'left-src',
    sourceSequenceName: 'left-src',
    sourceStart: leftSourceStart,
    sourceEnd: leftSourceEnd,
    sequence: opts.leftBody,
    annotations: [],
    sourceSequence: leftSource,
    sourceAnnotations: leftSourceAnnotations,
    sourceIsCircular: false,
    sourceType: 'pcr',
  };
  const rightRegion: DesignRegion = {
    id: 'right',
    sourceSequenceId: 'right-src',
    sourceSequenceName: 'right-src',
    sourceStart: rightSourceStart,
    sourceEnd: rightSourceEnd,
    sequence: opts.rightBody,
    annotations: [],
    sourceSequence: rightSource,
    sourceAnnotations: rightSourceAnnotations,
    sourceIsCircular: false,
    sourceType: 'pcr',
  };

  return {
    id: `case-${Math.random().toString(36).slice(2, 8)}`,
    name: 'case',
    topology: 'circular',
    regions: [leftRegion, rightRegion],
    spacers: opts.spacer ? [{ junctionIndex: 0, sequence: opts.spacer }] : [],
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
}

function buildAndCollectCandidates(opts: SetupOptions) {
  const design = makeDesign(opts);
  const draft = computeDraftAssembly(design);
  const models = buildJunctionWorkbenchModels(
    { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
    { maxWindowBp: 200 }
  );
  const productRow = models[0].rows.find((r) => r.kind === 'product')!;
  const candidates = productRow.annotations.filter((a) =>
    annotationQualifierIncludes(a.qualifiers?.candidate, 'true')
  );
  return { models, productRow, candidates };
}

function annotationQualifierIncludes(value: string | string[] | undefined, expected: string) {
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}

describe('candidate CDS continuation — case matrix', () => {
  it('Case 1: in-frame spacer (3 bp), forward left CDS extending past, walks until stop in right body', () => {
    const { candidates, productRow } = buildAndCollectCandidates({
      leftBody: 'ATGAAAAAACCC',
      rightBody: 'TTTGGGTAA' + 'CCC'.repeat(20),
      spacer: 'GGT',
      leftCds: { endAfterBodyBy: 30 },
    });
    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    const anchor = productRow.anchorRowPosition;
    expect(candidate.direction).toBe(1);
    expect(candidate.start).toBe(1);
    expect(candidate.end).toBe(anchor + 12);
  });

  it('Case 2: out-of-frame spacer (1 bp), forward left CDS, walks SHIFTED frame', () => {
    const { candidates, productRow } = buildAndCollectCandidates({
      leftBody: 'ATGAAAAAACCC',
      rightBody: 'CCCCCCCCTAA' + 'GGG'.repeat(20),
      spacer: 'G',
      leftCds: { endAfterBodyBy: 30 },
    });
    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    const anchor = productRow.anchorRowPosition;
    expect(candidate.direction).toBe(1);
    expect(candidate.start).toBe(1);
    expect(candidate.end).toBe(anchor + 12);
  });

  it('Case 3: out-of-frame spacer (2 bp), forward left CDS, walks shifted frame', () => {
    const { candidates, productRow } = buildAndCollectCandidates({
      leftBody: 'ATGAAAAAACCC',
      rightBody: 'CTAA' + 'GGG'.repeat(20),
      spacer: 'GG',
      leftCds: { endAfterBodyBy: 30 },
    });
    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    const anchor = productRow.anchorRowPosition;
    expect(candidate.direction).toBe(1);
    expect(candidate.start).toBe(1);
    expect(candidate.end).toBe(anchor + 6);
  });

  it('Case 4: in-frame spacer (3 bp) + downstream content as fusion: walk continues into right body', () => {
    const { candidates, productRow } = buildAndCollectCandidates({
      leftBody: 'ATGAAAAAACCC',
      rightBody: 'TTTAAATAA' + 'GGG'.repeat(20),
      spacer: 'GGT',
      leftCds: { endAfterBodyBy: 30 },
    });
    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    const anchor = productRow.anchorRowPosition;
    expect(candidate.direction).toBe(1);
    expect(candidate.start).toBe(1);
    expect(candidate.end).toBe(anchor + 12);
  });

  it('Case 5: codon_start = 2 shifts the frame anchor by 1 base', () => {
    const { candidates, productRow } = buildAndCollectCandidates({
      leftBody: 'AAAAAAAACCCC',
      rightBody: 'A' + 'GGG'.repeat(20),
      spacer: 'GTA',
      leftCds: { endAfterBodyBy: 30, codonStart: 2 },
    });
    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    const anchor = productRow.anchorRowPosition;
    expect(candidate.direction).toBe(1);
    expect(candidate.start).toBe(1);
    expect(candidate.end).toBe(anchor + 4);
    expect(annotationQualifierIncludes(candidate.qualifiers?.codon_start, '2')).toBe(true);
  });

  it('Case 6: reverse-strand right CDS, mirror of forward case', () => {
    const { candidates, productRow } = buildAndCollectCandidates({
      leftBody: 'AAACCCGGGTTT',
      rightBody: 'AAACCCGGGTTT',
      spacer: 'TTA',
      rightReverseCds: { startBeforeBodyBy: 9, endAfterBodyStartBy: 6 },
    });
    expect(candidates.length).toBe(1);
    const candidate = candidates[0];
    const anchor = productRow.anchorRowPosition;
    expect(candidate.direction).toBe(-1);
    expect(candidate.start).toBe(anchor + 1);
    expect(candidate.end).toBe(anchor + 9);
  });

  it('Case 6b: reverse-strand first-region CDS wraps through the previous junction spacer to the stop', () => {
    const now = new Date('2026-04-26T00:00:00.000Z');
    const firstBody = 'CCCGGG' + 'AAA'.repeat(40);
    const secondBody = 'GCC'.repeat(90);
    const originSpacer = 'TTA';
    const firstUpstream = 'AAA'.repeat(40);
    const firstDownstream = 'TTT'.repeat(40);
    const firstSourceStart = firstUpstream.length;
    const firstRegion: DesignRegion = {
      id: 'first',
      sourceSequenceId: 'first-src',
      sourceSequenceName: 'first-src',
      sourceStart: firstSourceStart,
      sourceEnd: firstSourceStart + firstBody.length,
      sequence: firstBody,
      annotations: [],
      sourceSequence: firstUpstream + firstBody + firstDownstream,
      sourceAnnotations: [
        {
          name: 'origin-rev-cds',
          type: 'CDS',
          start: firstSourceStart - 9,
          end: firstSourceStart + 6,
          strand: 'reverse',
          color: '#dc2626',
          qualifiers: { codon_start: '1' },
        },
      ],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };
    const secondUpstream = 'GGG'.repeat(40);
    const secondRegion: DesignRegion = {
      id: 'second',
      sourceSequenceId: 'second-src',
      sourceSequenceName: 'second-src',
      sourceStart: secondUpstream.length,
      sourceEnd: secondUpstream.length + secondBody.length,
      sequence: secondBody,
      annotations: [],
      sourceSequence: secondUpstream + secondBody + 'CCC'.repeat(40),
      sourceAnnotations: [],
      sourceIsCircular: false,
      sourceType: 'pcr',
    };
    const design: SequenceDesign = {
      id: 'origin-reverse-cds',
      name: 'origin reverse CDS',
      topology: 'circular',
      regions: [firstRegion, secondRegion],
      spacers: [{ junctionIndex: 1, sequence: originSpacer }],
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
      createdAt: now,
      updatedAt: now,
    };

    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 160 }
    );
    const model = models.find((item) => item.junctionIndex === 1);
    expect(model).toBeDefined();
    const productRow = model!.rows.find((row) => row.kind === 'product')!;
    const candidate = productRow.annotations.find(
      (annotation) => annotation.name.includes('origin-rev-cds') && annotation.direction === -1
    );
    expect(candidate).toBeDefined();

    const productLength = firstBody.length + secondBody.length + originSpacer.length;
    const candidateProductPositions = productRow.points
      .slice(candidate!.start - 1, candidate!.end)
      .map((point) => point.productPosition);

    expect(candidateProductPositions).toEqual([
      productLength - 3,
      productLength - 2,
      productLength - 1,
      0,
      1,
      2,
      3,
      4,
      5,
    ]);
  });

  it('Case 7: both forward (left) and reverse (right) CDSs cross same junction → two candidates', () => {
    const { candidates } = buildAndCollectCandidates({
      leftBody: 'ATGAAAAAACCC',
      rightBody: 'AAACCCGGGTTT',
      spacer: 'TTA',
      leftCds: { endAfterBodyBy: 30 },
      rightReverseCds: { startBeforeBodyBy: 9, endAfterBodyStartBy: 6 },
    });
    expect(candidates.length).toBe(2);
    const directions = candidates.map((c) => c.direction).sort();
    expect(directions).toEqual([-1, 1]);
  });

  it('Case 8: no candidate when CDS terminates inside contribution (does not reach boundary)', () => {
    const { candidates } = buildAndCollectCandidates({
      leftBody: 'ATGAAAAAACCCAAATAA' + 'TTT'.repeat(10),
      rightBody: 'AAACCCGGGTTT',
      spacer: 'GGT',
      leftCds: { endAfterBodyBy: -10 },
    });
    expect(candidates).toHaveLength(0);
  });
});
