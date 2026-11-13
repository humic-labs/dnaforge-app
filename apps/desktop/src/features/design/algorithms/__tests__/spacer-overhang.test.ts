// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  computeDraftAssembly,
  reverseComplement,
  calculateNewEncodingForOverhang,
  recomputeHomologyMetadata,
  updatePrimerOverhangFromHomology,
  computeOverhangSequence,
} from '../draft-assembly';
import type { SequenceDesign, HomologyRegion } from '../../types';
import { getComposedSequence } from '../../types';

describe('Spacer handling in Gibson overhang updates', () => {
  const createTestDesign = (): SequenceDesign => ({
    id: 'test',
    name: 'Test Design',
    topology: 'circular',
    assemblyMethod: 'gibson',
    regions: [
      {
        id: 'r0',
        sourceSequenceId: 's0',
        sourceSequenceName: 'Region 0',
        sourceStart: 0,
        sourceEnd: 100,
        sequence: 'A'.repeat(100),
        annotations: [],
        sourceType: 'pcr',
      },
      {
        id: 'r1',
        sourceSequenceId: 's1',
        sourceSequenceName: 'Region 1',
        sourceStart: 0,
        sourceEnd: 100,
        sequence: 'T'.repeat(100),
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [{ id: 's0', junctionIndex: 0, sequence: 'GGGG' }],
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    status: 'draft',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('should correctly identify composed sequence structure', () => {
    const design = createTestDesign();
    const composed = getComposedSequence(design.regions, design.spacers);

    expect(composed.length).toBe(204);
    expect(composed.slice(0, 100)).toBe('A'.repeat(100));
    expect(composed.slice(100, 104)).toBe('GGGG');
    expect(composed.slice(104, 204)).toBe('T'.repeat(100));
  });

  it('should draft assembly with correct spacer handling', () => {
    const design = createTestDesign();
    design.backboneSequenceId = 's1';
    const result = computeDraftAssembly(design);

    expect(result.homologyRegions.length).toBe(2);
    expect(result.designPrimers.length).toBe(2);

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0);
    expect(junction0).toBeDefined();
    expect(junction0!.junctionPosition).toBe(104);

    const f0Pair = result.designPrimers.find((p) => p.fragmentIndex === 0);
    const f0Rev = f0Pair!.reverse;

    expect(f0Rev.overhang.spacerSequence).toBe(reverseComplement('GGGG'));
    expect(f0Rev.overhang.spacerSequence).toBe('CCCC');

    const ohLen = f0Rev.overhang.length;
    expect(ohLen).toBeGreaterThan(4);

    expect(f0Rev.overhang.sequence.slice(-4)).toBe('CCCC');
  });

  it('should correctly update reverse primer overhang when reducing below spacer length', () => {
    const design = createTestDesign();
    const composed = getComposedSequence(design.regions, design.spacers);
    const result = computeDraftAssembly(design);

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const f0Pair = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    const f0Rev = f0Pair.reverse;

    const originalLen = f0Rev.overhang.length;
    console.log('Original reverse overhang:', {
      length: originalLen,
      sequence: f0Rev.overhang.sequence,
      spacerSeq: f0Rev.overhang.spacerSequence,
    });

    const newEncoding = calculateNewEncodingForOverhang(junction0.encoding, 'reverse', 3);
    expect(newEncoding.onRight).toBe(3);
    expect(newEncoding.onLeft).toBe(junction0.encoding.onLeft);

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0, encoding: newEncoding },
      composed,
      junction0.encoding
    );

    console.log('Updated homology:', {
      sequence: updatedHomology.metadata?.sequence,
      onLeft: updatedHomology.encoding.onLeft,
      onRight: updatedHomology.encoding.onRight,
    });

    const rightPortion = updatedHomology.metadata!.sequence!.slice(updatedHomology.encoding.onLeft);
    expect(rightPortion).toBe('TTT');
    expect(rightPortion.length).toBe(3);

    const spacerSeq = 'GGGG';
    const updatedPrimer = updatePrimerOverhangFromHomology(
      f0Rev,
      updatedHomology,
      false,
      spacerSeq
    );

    console.log('Updated reverse primer overhang:', {
      length: updatedPrimer.overhang.length,
      sequence: updatedPrimer.overhang.sequence,
      spacerSeq: updatedPrimer.overhang.spacerSequence,
    });

    expect(updatedPrimer.overhang.length).toBe(3);
    expect(updatedPrimer.overhang.sequence).toBe('AAA');
    expect(updatedPrimer.overhang.spacerSequence).toBeUndefined();
  });

  it('should correctly update reverse primer overhang when reducing but keeping spacer', () => {
    const design = createTestDesign();
    const composed = getComposedSequence(design.regions, design.spacers);
    const result = computeDraftAssembly(design);

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const f0Pair = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    const f0Rev = f0Pair.reverse;

    const newEncoding = calculateNewEncodingForOverhang(junction0.encoding, 'reverse', 6);
    expect(newEncoding.onRight).toBe(6);

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0, encoding: newEncoding },
      composed,
      junction0.encoding
    );

    const rightPortion = updatedHomology.metadata!.sequence!.slice(updatedHomology.encoding.onLeft);
    expect(rightPortion).toBe('TTTTTT');
    expect(rightPortion.length).toBe(6);

    const spacerSeq = 'GGGG';
    const updatedPrimer = updatePrimerOverhangFromHomology(f0Rev, updatedHomology, true, spacerSeq);

    console.log('Updated reverse primer with spacer:', {
      length: updatedPrimer.overhang.length,
      sequence: updatedPrimer.overhang.sequence,
      spacerSeq: updatedPrimer.overhang.spacerSequence,
    });

    expect(updatedPrimer.overhang.length).toBe(10);
    expect(updatedPrimer.overhang.sequence).toBe('AAAAAACCCC');
    expect(updatedPrimer.overhang.spacerSequence).toBe('CCCC');
  });

  it('computeOverhangSequence should correctly extract reverse overhang', () => {
    const homology: HomologyRegion = {
      id: 'test',
      junctionIndex: 0,
      junctionPosition: 104,
      start: 92,
      end: 110,
      encoding: { onLeft: 12, onRight: 6 },
      metadata: {
        sequence: 'AAAAAAAAGGGGTTTTTT',
        tmEstimate: 50,
        gcContent: 33,
      },
    };

    const fwdOverhang = computeOverhangSequence('forward', homology);
    expect(fwdOverhang).toBe('AAAAAAAAGGGG');

    const revOverhang = computeOverhangSequence('reverse', homology);
    expect(revOverhang).toBe(reverseComplement('TTTTTT'));
    expect(revOverhang).toBe('AAAAAA');
  });

  it('full store flow: reduce reverse overhang below spacer length', () => {
    const design = createTestDesign();
    const composed = getComposedSequence(design.regions, design.spacers);
    const result = computeDraftAssembly(design);

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const f0Pair = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    const f0Rev = f0Pair.reverse;

    console.log('=== FULL STORE FLOW TEST ===');
    console.log('Initial junction0:', {
      junctionPosition: junction0.junctionPosition,
      encoding: junction0.encoding,
      sequence: junction0.metadata?.sequence,
    });
    console.log('Initial F0-rev overhang:', {
      length: f0Rev.overhang.length,
      sequence: f0Rev.overhang.sequence,
      spacerSeq: f0Rev.overhang.spacerSequence,
    });

    expect(junction0.junctionPosition).toBe(104);
    expect(f0Rev.overhang.spacerSequence).toBe('CCCC');

    const newLength = 3;
    const spacerSeq = 'GGGG';
    const spacerLen = 4;
    const direction = 'reverse' as const;

    let adjustedLength: number;
    let shouldIncludeSpacer: boolean;

    if (newLength >= spacerLen && spacerLen > 0) {
      shouldIncludeSpacer = true;
      adjustedLength = newLength - spacerLen;
    } else {
      shouldIncludeSpacer = spacerLen > 0 ? false : true;
      adjustedLength = newLength;
    }

    console.log('Store calculation:', {
      newLength,
      spacerLen,
      shouldIncludeSpacer,
      adjustedLength,
    });

    expect(shouldIncludeSpacer).toBe(false);
    expect(adjustedLength).toBe(3);

    const oldEncoding = junction0.encoding;
    const newEncoding = calculateNewEncodingForOverhang(oldEncoding, direction, adjustedLength);

    console.log('Encoding change:', {
      oldEncoding,
      newEncoding,
    });

    expect(newEncoding.onRight).toBe(3);
    expect(newEncoding.onLeft).toBe(oldEncoding.onLeft);

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0, encoding: newEncoding },
      composed,
      oldEncoding
    );

    console.log('Updated homology:', {
      sequence: updatedHomology.metadata?.sequence,
      seqLen: updatedHomology.metadata?.sequence?.length,
      start: updatedHomology.start,
      end: updatedHomology.end,
      encoding: updatedHomology.encoding,
    });

    const rightPortion = updatedHomology.metadata!.sequence!.slice(newEncoding.onLeft);
    console.log('Right portion (should be from Region 1):', {
      rightPortion,
      expected: 'TTT',
    });

    expect(rightPortion).toBe('TTT');

    const updatedPrimer = updatePrimerOverhangFromHomology(
      f0Rev,
      updatedHomology,
      false,
      spacerSeq
    );

    console.log('Updated reverse primer overhang:', {
      length: updatedPrimer.overhang.length,
      sequence: updatedPrimer.overhang.sequence,
      spacerSeq: updatedPrimer.overhang.spacerSequence,
    });

    expect(updatedPrimer.overhang.length).toBe(3);
    expect(updatedPrimer.overhang.sequence).toBe('AAA');
    expect(updatedPrimer.overhang.spacerSequence).toBeUndefined();

    const region1Start = composed.slice(104, 107);
    expect(region1Start).toBe('TTT');
    expect(updatedPrimer.overhang.sequence).toBe(reverseComplement(region1Start));

    console.log('=== TEST PASSED ===');
  });

  it('full store flow: distinct sequences verify correct region source', () => {
    const design: SequenceDesign = {
      id: 'test-distinct',
      name: 'Test Distinct Sequences',
      topology: 'circular',
      assemblyMethod: 'gibson',
      regions: [
        {
          id: 'r0',
          sourceSequenceId: 's0',
          sourceSequenceName: 'Region 0',
          sourceStart: 0,
          sourceEnd: 100,
          sequence: 'ACGT'.repeat(25),
          annotations: [],
          sourceType: 'pcr',
        },
        {
          id: 'r1',
          sourceSequenceId: 's1',
          sourceSequenceName: 'Region 1',
          sourceStart: 0,
          sourceEnd: 100,
          sequence: 'GCTA'.repeat(25),
          annotations: [],
          sourceType: 'pcr',
        },
      ],
      spacers: [{ id: 's0', junctionIndex: 0, sequence: 'AAAA' }],
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const composed = getComposedSequence(design.regions, design.spacers);
    const result = computeDraftAssembly(design);

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const f0Pair = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    const f0Rev = f0Pair.reverse;

    console.log('=== DISTINCT SEQUENCES TEST ===');
    console.log('Region 0 end (last 10bp):', composed.slice(90, 100));
    console.log('Spacer:', composed.slice(100, 104));
    console.log('Region 1 start (first 10bp):', composed.slice(104, 114));

    expect(composed.slice(100, 104)).toBe('AAAA');

    const region1First3 = composed.slice(104, 107);
    expect(region1First3).toBe('GCT');

    const expectedOverhang = reverseComplement('GCT');
    expect(expectedOverhang).toBe('AGC');

    const newLength = 3;
    const spacerSeq = 'AAAA';

    const oldEncoding = junction0.encoding;
    const newEncoding = calculateNewEncodingForOverhang(oldEncoding, 'reverse', newLength);

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0, encoding: newEncoding },
      composed,
      oldEncoding
    );

    const rightPortion = updatedHomology.metadata!.sequence!.slice(newEncoding.onLeft);
    console.log('Right portion:', rightPortion);
    expect(rightPortion).toBe('GCT');

    const updatedPrimer = updatePrimerOverhangFromHomology(
      f0Rev,
      updatedHomology,
      false,
      spacerSeq
    );

    console.log('Updated overhang:', updatedPrimer.overhang.sequence);
    console.log('Expected (RC of GCT):', expectedOverhang);

    expect(updatedPrimer.overhang.sequence).toBe('AGC');
    expect(updatedPrimer.overhang.sequence).toBe(expectedOverhang);

    const upstreamBases = composed.slice(97, 100);
    console.log('Upstream bases (wrong source would be):', upstreamBases);
    console.log('=== TEST COMPLETE ===');
  });

  it('full store flow: reduce FORWARD overhang below spacer length', () => {
    const design: SequenceDesign = {
      id: 'test-fwd',
      name: 'Test Forward Spacer Exclusion',
      topology: 'circular',
      assemblyMethod: 'gibson',
      regions: [
        {
          id: 'r0',
          sourceSequenceId: 's0',
          sourceSequenceName: 'Region 0',
          sourceStart: 0,
          sourceEnd: 100,
          sequence: 'ACGT'.repeat(25),
          annotations: [],
          sourceType: 'pcr',
        },
        {
          id: 'r1',
          sourceSequenceId: 's1',
          sourceSequenceName: 'Region 1',
          sourceStart: 0,
          sourceEnd: 100,
          sequence: 'GCTA'.repeat(25),
          annotations: [],
          sourceType: 'pcr',
        },
      ],
      spacers: [{ id: 's0', junctionIndex: 0, sequence: 'AAAA' }],
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const composed = getComposedSequence(design.regions, design.spacers);
    const result = computeDraftAssembly(design);

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const f1Pair = result.designPrimers.find((p) => p.fragmentIndex === 1)!;
    const f1Fwd = f1Pair.forward;

    console.log('=== FORWARD PRIMER SPACER EXCLUSION TEST ===');
    console.log('Composed structure:');
    console.log('  Region 0 (96-99):', composed.slice(96, 100));
    console.log('  Spacer (100-103):', composed.slice(100, 104));
    console.log('  Region 1 (104-107):', composed.slice(104, 108));

    expect(composed.slice(100, 104)).toBe('AAAA');
    expect(composed.slice(96, 100)).toBe('ACGT');

    const upstreamLast3 = composed.slice(97, 100);
    expect(upstreamLast3).toBe('CGT');

    const newLength = 3;
    const spacerSeq = 'AAAA';
    const adjustedLength = newLength;

    const oldEncoding = junction0.encoding;
    const newEncoding = calculateNewEncodingForOverhang(oldEncoding, 'forward', adjustedLength);

    expect(newEncoding.onLeft).toBe(3);

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0, encoding: newEncoding },
      composed,
      oldEncoding
    );

    console.log('Updated homology:', {
      sequence: updatedHomology.metadata?.sequence,
      encoding: updatedHomology.encoding,
    });

    const updatedPrimer = updatePrimerOverhangFromHomology(
      f1Fwd,
      updatedHomology,
      false,
      spacerSeq,
      composed
    );

    console.log('Updated forward primer overhang:', {
      length: updatedPrimer.overhang.length,
      sequence: updatedPrimer.overhang.sequence,
      spacerSeq: updatedPrimer.overhang.spacerSequence,
    });

    expect(updatedPrimer.overhang.length).toBe(3);
    expect(updatedPrimer.overhang.sequence).toBe('CGT');
    expect(updatedPrimer.overhang.spacerSequence).toBeUndefined();

    console.log('=== TEST PASSED ===');
  });

  it('full store flow: reduce reverse overhang but keep spacer', () => {
    const design = createTestDesign();
    const composed = getComposedSequence(design.regions, design.spacers);
    const result = computeDraftAssembly(design);

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const f0Pair = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    const f0Rev = f0Pair.reverse;

    const newLength = 10;
    const spacerSeq = 'GGGG';
    const spacerLen = 4;
    const direction = 'reverse' as const;

    let adjustedLength: number;
    let shouldIncludeSpacer: boolean;

    if (newLength >= spacerLen && spacerLen > 0) {
      shouldIncludeSpacer = true;
      adjustedLength = newLength - spacerLen;
    } else {
      shouldIncludeSpacer = spacerLen > 0 ? false : true;
      adjustedLength = newLength;
    }

    expect(shouldIncludeSpacer).toBe(true);
    expect(adjustedLength).toBe(6);

    const oldEncoding = junction0.encoding;
    const newEncoding = calculateNewEncodingForOverhang(oldEncoding, direction, adjustedLength);

    expect(newEncoding.onRight).toBe(6);
    expect(newEncoding.onLeft).toBe(oldEncoding.onLeft);

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0, encoding: newEncoding },
      composed,
      oldEncoding
    );

    const rightPortion = updatedHomology.metadata!.sequence!.slice(newEncoding.onLeft);
    expect(rightPortion).toBe('TTTTTT');

    const updatedPrimer = updatePrimerOverhangFromHomology(f0Rev, updatedHomology, true, spacerSeq);

    expect(updatedPrimer.overhang.length).toBe(10);
    expect(updatedPrimer.overhang.sequence).toBe('AAAAAACCCC');
    expect(updatedPrimer.overhang.spacerSequence).toBe('CCCC');
  });
});
