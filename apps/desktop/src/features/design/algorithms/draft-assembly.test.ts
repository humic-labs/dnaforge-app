// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  reverseComplement,
  estimateTm,
  calculateGcContent,
  computeDraftAssembly,
  updatePrimerPbsLength,
  calculateNewEncodingForOverhang,
  recomputeHomologyMetadata,
  updatePrimerOverhangFromHomology,
  computePbsSequence,
  computeOverhangSequence,
  computePrimerDisplay,
} from './draft-assembly';
import { updatePrimerPbsWindow } from './recompute';
import { computeGoldenGateJunctions } from './golden-gate';
import type { SequenceDesign, DesignRegion, HomologyRegion, DesignPrimer } from '../types';

describe('reverseComplement', () => {
  it('returns reverse complement of a simple sequence', () => {
    expect(reverseComplement('ATCG')).toBe('CGAT');
  });

  it('handles longer sequences', () => {
    expect(reverseComplement('AATTCCGG')).toBe('CCGGAATT');
  });

  it('handles lowercase', () => {
    expect(reverseComplement('atcg')).toBe('cgat');
  });

  it('returns empty for empty input', () => {
    expect(reverseComplement('')).toBe('');
  });
});

describe('estimateTm', () => {
  it('calculates Tm using nearest-neighbor for AT-rich sequence', () => {
    const tm = estimateTm('ATATATATATAT');
    expect(tm).toBeGreaterThan(5);
    expect(tm).toBeLessThan(40);
  });

  it('calculates higher Tm for GC-rich sequence', () => {
    const tm = estimateTm('GCGCGCGCGCGC');
    expect(tm).toBeGreaterThan(60);
    expect(tm).toBeLessThan(85);
  });

  it('handles short sequences with Wallace fallback', () => {
    expect(estimateTm('ATGC')).toBe(12);
  });
});

describe('calculateGcContent', () => {
  it('calculates 50% for equal ATGC', () => {
    expect(calculateGcContent('ATGC')).toBe(50);
  });

  it('calculates 100% for all GC', () => {
    expect(calculateGcContent('GGCC')).toBe(100);
  });

  it('calculates 0% for all AT', () => {
    expect(calculateGcContent('AATT')).toBe(0);
  });
});

describe('computeDraftAssembly', () => {
  const region1: DesignRegion = {
    id: 'r1',
    sourceSequenceId: 's1',
    sourceSequenceName: 'Fragment 1',
    sourceStart: 0,
    sourceEnd: 100,
    sequence:
      'ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG',
    annotations: [],
  };

  const region2: DesignRegion = {
    id: 'r2',
    sourceSequenceId: 's2',
    sourceSequenceName: 'Fragment 2',
    sourceStart: 0,
    sourceEnd: 80,
    sequence: 'GCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA',
    annotations: [],
  };

  it('returns empty result for single fragment', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    expect(result.homologyRegions).toHaveLength(0);
    expect(result.designPrimers).toHaveLength(0);
  });

  it('computes primers for two-fragment circular assembly', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);

    expect(result.homologyRegions).toHaveLength(2);
    expect(result.designPrimers).toHaveLength(2);
  });

  it('reverse primer sequence is reverse complement of template', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const reversePrimer = result.designPrimers[0].reverse;

    const composedSeq = region1.sequence + region2.sequence;
    const pbsTemplate = composedSeq.slice(reversePrimer.pbs.start, reversePrimer.pbs.end);

    expect(reversePrimer.pbs.sequence).toBe(reverseComplement(pbsTemplate));
  });

  it('forward primer sequence is NOT reverse complemented', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const forwardPrimer = result.designPrimers[0].forward;

    const composedSeq = region1.sequence + region2.sequence;
    const pbsTemplate = composedSeq.slice(forwardPrimer.pbs.start, forwardPrimer.pbs.end);

    expect(forwardPrimer.pbs.sequence).toBe(pbsTemplate);
  });
});

describe('computeDraftAssembly - GoldenGate', () => {
  const region1: DesignRegion = {
    id: 'r1',
    sourceSequenceId: 's1',
    sourceSequenceName: 'Fragment 1',
    sourceStart: 0,
    sourceEnd: 100,
    sequence:
      'ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG',
    annotations: [],
  };

  const region2: DesignRegion = {
    id: 'r2',
    sourceSequenceId: 's2',
    sourceSequenceName: 'Fragment 2',
    sourceStart: 0,
    sourceEnd: 80,
    sequence: 'GCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA',
    annotations: [],
  };

  it('computes 4bp junctions for GoldenGate circular assembly', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);

    expect(result.homologyRegions).toHaveLength(0);

    expect(result.goldenGateJunctions).toBeDefined();
    expect(result.goldenGateJunctions).toHaveLength(2);

    const junction0 = result.goldenGateJunctions![0];
    expect(junction0.overhang.length).toBe(4);
    expect(junction0.overhangEnd - junction0.overhangStart).toBe(4);
  });

  it('GoldenGate primers include enzyme recognition site', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const forwardPrimer = result.designPrimers[0].forward;

    expect(forwardPrimer.goldenGateOverhang).toBeDefined();
    expect(forwardPrimer.goldenGateOverhang?.padding5prime).toBe('GCGC');
    expect(forwardPrimer.goldenGateOverhang?.enzymeSite).toBe('GGTCTC');
    expect(forwardPrimer.goldenGateOverhang?.spacer).toBe('A');
    expect(forwardPrimer.goldenGateOverhang?.overhang.length).toBe(4);

    expect(forwardPrimer.sequence.startsWith('GCGCGGTCTC')).toBe(true);
  });

  it('GoldenGate primers use enzyme-specific cut-offset spacer length', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BbsI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const forwardPrimer = result.designPrimers[0].forward;

    expect(forwardPrimer.goldenGateOverhang?.enzymeSite).toBe('GAAGAC');
    expect(forwardPrimer.goldenGateOverhang?.spacer).toBe('AA');
    expect(forwardPrimer.sequence.startsWith('GCGCGAAGACAA')).toBe(true);
  });

  it('GoldenGate uses centered offset (offset=0) for PCR+PCR', () => {
    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const junction = result.goldenGateJunctions![0];

    expect(junction.offset).toBe(0);
    expect(junction.overhangStart).toBe(junction.junctionPosition - 2);
    expect(junction.source.type).toBe('pcr-designed');
  });

  it('GoldenGate with spacer: junction position includes spacer length', () => {
    const region0: DesignRegion = {
      id: 'r0',
      sourceSequenceId: 's0',
      sourceSequenceName: 'Region 0',
      sourceStart: 0,
      sourceEnd: 10,
      sequence: 'AAAAAAAAAA',
      annotations: [],
    };
    const region1: DesignRegion = {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Region 1',
      sourceStart: 0,
      sourceEnd: 10,
      sequence: 'CCCCCCCCCC',
      annotations: [],
    };

    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test GoldenGate with Spacer',
      topology: 'circular',
      regions: [region0, region1],
      spacers: [{ id: 'sp0', junctionIndex: 0, sequence: 'GGGGG' }],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);

    const junction0 = result.goldenGateJunctions![0];
    expect(junction0.junctionPosition).toBe(15);

    expect(junction0.overhang).toBe('GGCC');
    expect(junction0.overhangStart).toBe(13);
    expect(junction0.overhangEnd).toBe(17);

    const junction1 = result.goldenGateJunctions![1];
    expect(junction1.junctionPosition).toBe(25);

    expect(junction1.overhang).toBe('CCAA');
  });

  it('GoldenGate with spacer: primer PBS positions account for spacer', () => {
    const region0: DesignRegion = {
      id: 'r0',
      sourceSequenceId: 's0',
      sourceSequenceName: 'Region 0',
      sourceStart: 0,
      sourceEnd: 10,
      sequence: 'AAAAAAAAAA',
      annotations: [],
    };
    const region1: DesignRegion = {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Region 1',
      sourceStart: 0,
      sourceEnd: 10,
      sequence: 'CCCCCCCCCC',
      annotations: [],
    };

    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test GoldenGate with Spacer',
      topology: 'circular',
      regions: [region0, region1],
      spacers: [{ id: 'sp0', junctionIndex: 0, sequence: 'GGGGG' }],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);

    const region1FwdPrimer = result.designPrimers[1].forward;
    expect(region1FwdPrimer.pbs.start).toBe(17);

    const region0FwdPrimer = result.designPrimers[0].forward;
    expect(region0FwdPrimer.pbs.start).toBe(2);
  });

  it('GoldenGate RD + spacer + PCR keeps the RD overhang anchored to the RD cut end and encodes spacer cargo in the PCR primer', () => {
    const rdSequence = 'AAAACCCCGGGGGCTA';
    const spacerSequence = 'GCTAT';
    const rdLeft: DesignRegion = {
      id: 'rd-left',
      sourceSequenceId: 'source-rd-left',
      sourceSequenceName: 'Left RD fragment',
      sourceStart: 0,
      sourceEnd: rdSequence.length,
      sequence: rdSequence,
      annotations: [],
      sourceType: 'rd',
      rdSourceEnzyme: 'BsaI',
      rdOverhangs: {
        upstream: 'AATG',
        downstream: 'GCTA',
      },
    };
    const pcrRight: DesignRegion = {
      id: 'pcr-right',
      sourceSequenceId: 'source-pcr-right',
      sourceSequenceName: 'Right PCR fragment',
      sourceStart: 0,
      sourceEnd: 40,
      sequence: 'TTTTACGTACGTACGTACGTACGTACGTACGTACGTACGT',
      annotations: [],
      sourceType: 'pcr',
    };
    const design: SequenceDesign = {
      id: 'd-rd-spacer-pcr',
      name: 'Golden Gate RD spacer PCR',
      topology: 'linear',
      regions: [rdLeft, pcrRight],
      spacers: [{ id: 'sp-rd-pcr', junctionIndex: 0, sequence: spacerSequence }],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const junction = result.goldenGateJunctions![0];
    const rightForward = result.designPrimers[1].forward;

    expect(junction.source).toEqual({ type: 'pcr-matched-rd', matchedRegionIndex: 0 });
    expect(junction.junctionPosition).toBe(rdSequence.length + spacerSequence.length);
    expect(junction.overhang).toBe('GCTA');
    expect(junction.overhangStart).toBe(rdSequence.length);
    expect(junction.overhangEnd).toBe(rdSequence.length + 4);
    expect(junction.offset).toBe(2 - spacerSequence.length);

    expect(rightForward.goldenGateOverhang?.overhang).toBe('GCTA');
    expect(rightForward.goldenGateOverhang?.literalExtra).toBe(spacerSequence.slice(4));
    expect(rightForward.goldenGateOverhang?.literalSpacerLength).toBe(
      spacerSequence.slice(4).length
    );
    expect(rightForward.pbs.start).toBe(rdSequence.length + spacerSequence.length);
    expect(rightForward.sequence).toContain(spacerSequence);
  });

  it.each([
    {
      name: 'RD + PCR',
      regions: [
        {
          id: 'rd-left',
          sourceSequenceId: 'source-rd-left',
          sourceSequenceName: 'Left RD fragment',
          sourceStart: 0,
          sourceEnd: 16,
          sequence: 'AAAACCCCGGGGGCTA',
          annotations: [],
          sourceType: 'rd' as const,
          rdSourceEnzyme: 'BsaI' as const,
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
        },
        {
          id: 'pcr-right',
          sourceSequenceId: 'source-pcr-right',
          sourceSequenceName: 'Right PCR fragment',
          sourceStart: 0,
          sourceEnd: 20,
          sequence: 'TTTTACGTACGTACGTACGT',
          annotations: [],
          sourceType: 'pcr' as const,
        },
      ],
      spacer: 'AAAAT',
      fixedOverhang: 'GCTA',
      assembledWindow: 'AAAA',
    },
    {
      name: 'PCR + RD',
      regions: [
        {
          id: 'pcr-left',
          sourceSequenceId: 'source-pcr-left',
          sourceSequenceName: 'Left PCR fragment',
          sourceStart: 0,
          sourceEnd: 20,
          sequence: 'ACGTACGTACGTACGTACGT',
          annotations: [],
          sourceType: 'pcr' as const,
        },
        {
          id: 'rd-right',
          sourceSequenceId: 'source-rd-right',
          sourceSequenceName: 'Right RD fragment',
          sourceStart: 0,
          sourceEnd: 20,
          sequence: 'TTTTGGGGCCCCAAAATTTT',
          annotations: [],
          sourceType: 'rd' as const,
          rdSourceEnzyme: 'BsaI' as const,
          rdOverhangs: { upstream: 'CAGT', downstream: 'GCTA' },
        },
      ],
      spacer: 'ATTA',
      fixedOverhang: 'CAGT',
      assembledWindow: 'TTTT',
    },
  ])(
    'marks an incompatible fixed $name overhang invalid instead of silently changing the assembled sequence',
    ({ regions, spacer, fixedOverhang, assembledWindow }) => {
      const [junction] = computeGoldenGateJunctions(
        regions,
        'linear',
        [{ id: 'spacer', junctionIndex: 0, sequence: spacer }],
        'BsaI'
      );

      expect(junction).toMatchObject({
        overhang: fixedOverhang,
        isValid: false,
        validationError: `Fixed RD overhang ${fixedOverhang} does not match assembled product window ${assembledWindow}`,
      });
    }
  );

  it('GoldenGate PCR + spacer + RD keeps the RD overhang anchored to the RD cut start and encodes reverse-complement spacer cargo in the PCR primer', () => {
    const pcrLeftSequence = 'ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGT';
    const rdSequence = 'CAGTTTTTGGGGCCCCAAAA';
    const spacerSequence = 'ATTA';
    const pcrLeft: DesignRegion = {
      id: 'pcr-left',
      sourceSequenceId: 'source-pcr-left',
      sourceSequenceName: 'Left PCR fragment',
      sourceStart: 0,
      sourceEnd: pcrLeftSequence.length,
      sequence: pcrLeftSequence,
      annotations: [],
      sourceType: 'pcr',
    };
    const rdRight: DesignRegion = {
      id: 'rd-right',
      sourceSequenceId: 'source-rd-right',
      sourceSequenceName: 'Right RD fragment',
      sourceStart: 0,
      sourceEnd: rdSequence.length,
      sequence: rdSequence,
      annotations: [],
      sourceType: 'rd',
      rdSourceEnzyme: 'BsaI',
      rdOverhangs: {
        upstream: 'CAGT',
        downstream: 'GCTA',
      },
    };
    const design: SequenceDesign = {
      id: 'd-pcr-spacer-rd',
      name: 'Golden Gate PCR spacer RD',
      topology: 'linear',
      regions: [pcrLeft, rdRight],
      spacers: [{ id: 'sp-pcr-rd', junctionIndex: 0, sequence: spacerSequence }],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const junction = result.goldenGateJunctions![0];
    const leftReverse = result.designPrimers[0].reverse;

    expect(junction.source).toEqual({ type: 'pcr-matched-rd', matchedRegionIndex: 1 });
    expect(junction.junctionPosition).toBe(pcrLeftSequence.length + spacerSequence.length);
    expect(junction.overhang).toBe('CAGT');
    expect(junction.overhangStart).toBe(pcrLeftSequence.length + spacerSequence.length);
    expect(junction.overhangEnd).toBe(pcrLeftSequence.length + spacerSequence.length + 4);
    expect(junction.offset).toBe(2);

    expect(leftReverse.goldenGateOverhang?.overhang).toBe(reverseComplement('CAGT'));
    expect(leftReverse.goldenGateOverhang?.literalExtra).toBe(reverseComplement(spacerSequence));
    expect(leftReverse.goldenGateOverhang?.literalSpacerLength).toBe(spacerSequence.length);
    expect(leftReverse.pbs.end).toBe(pcrLeftSequence.length);
    expect(leftReverse.sequence).toContain(
      `${reverseComplement('CAGT')}${reverseComplement(spacerSequence)}`
    );
  });

  it('GoldenGate RD + spacer + RD is invalid because no PCR primer can encode the spacer cargo', () => {
    const spacerSequence = 'GATTACA';
    const leftRd: DesignRegion = {
      id: 'left-rd',
      sourceSequenceId: 'source-left-rd',
      sourceSequenceName: 'Left RD',
      sourceStart: 0,
      sourceEnd: 16,
      sequence: 'AAAACCCCGGGGGCTA',
      annotations: [],
      sourceType: 'rd',
      rdSourceEnzyme: 'BsaI',
      rdOverhangs: {
        upstream: 'AATG',
        downstream: 'GCTA',
      },
    };
    const rightRd: DesignRegion = {
      id: 'right-rd',
      sourceSequenceId: 'source-right-rd',
      sourceSequenceName: 'Right RD',
      sourceStart: 0,
      sourceEnd: 16,
      sequence: 'GCTATTTTCCCCGGGG',
      annotations: [],
      sourceType: 'rd',
      rdSourceEnzyme: 'BsaI',
      rdOverhangs: {
        upstream: 'GCTA',
        downstream: 'CAGT',
      },
    };
    const design: SequenceDesign = {
      id: 'd-rd-spacer-rd',
      name: 'Golden Gate RD spacer RD',
      topology: 'linear',
      regions: [leftRd, rightRd],
      spacers: [{ id: 'sp-rd-rd', junctionIndex: 0, sequence: spacerSequence }],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const junction = result.goldenGateJunctions![0];

    expect(junction.source).toEqual({ type: 'rd-fixed', fromRegionIndex: 0 });
    expect(junction.overhang).toBe('GCTA');
    expect(junction.overhangStart).toBe(junction.junctionPosition);
    expect(junction.overhangEnd).toBe(junction.junctionPosition + 4);
    expect(junction.isValid).toBe(false);
    expect(junction.validationError).toContain('Spacer sequence between two restriction digest');
    expect(result.designPrimers.every((pair) => pair.forward.sequence === '')).toBe(true);
    expect(result.designPrimers.every((pair) => pair.reverse.sequence === '')).toBe(true);
  });

  it('GoldenGate marks RD junctions invalid when the RD source enzyme differs from the selected reaction enzyme', () => {
    const bsmBIRd: DesignRegion = {
      id: 'bsmBI-rd',
      sourceSequenceId: 'source-bsmBI-rd',
      sourceSequenceName: 'BsmBI RD fragment',
      sourceStart: 0,
      sourceEnd: 16,
      sequence: 'AAAACCCCGGGGGCTA',
      annotations: [],
      sourceType: 'rd',
      ggType: 'insert',
      rdSourceEnzyme: 'BsmBI',
      rdSourceEnzymeName: 'BsmBI',
      rdOverhangs: {
        upstream: 'AATG',
        downstream: 'GCTA',
      },
    };
    const pcrRight: DesignRegion = {
      id: 'pcr-right',
      sourceSequenceId: 'source-pcr-right',
      sourceSequenceName: 'Right PCR fragment',
      sourceStart: 0,
      sourceEnd: 40,
      sequence: 'TTTTACGTACGTACGTACGTACGTACGTACGTACGTACGT',
      annotations: [],
      sourceType: 'pcr',
    };
    const design: SequenceDesign = {
      id: 'd-rd-mismatched-enzyme',
      name: 'Golden Gate incompatible RD enzyme',
      topology: 'linear',
      regions: [bsmBIRd, pcrRight],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'goldengate',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const junction = result.goldenGateJunctions![0];

    expect(junction.overhang).toBe('GCTA');
    expect(junction.isValid).toBe(false);
    expect(junction.validationError).toContain('BsmBI');
    expect(junction.validationError).toContain('BsaI');
  });
});

describe('updatePrimerPbsLength', () => {
  const regions: DesignRegion[] = [
    {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Fragment 1',
      sourceStart: 0,
      sourceEnd: 50,
      sequence: 'ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG',
      annotations: [],
    },
  ];

  it("extends forward primer toward 3' end (higher positions)", () => {
    const forwardPrimer = {
      id: 'fwd1',
      name: 'F1-fwd',
      sequence: 'ATCGATCGATCGATCGATCG',
      pbs: { start: 0, end: 20, sequence: 'ATCGATCGATCGATCGATCG' },
      overhang: { length: 0, sequence: '' },
      direction: 'forward' as const,
      fragmentIndex: 0,
      junctionIndex: null,
      tm: 40,
      tmProvenance: { source: 'neb', verified: true },
    };

    const updated = updatePrimerPbsLength(forwardPrimer, 25, regions);

    expect(updated.pbs.start).toBe(0);
    expect(updated.pbs.end).toBe(25);
    expect(updated.pbs.sequence).toBe('ATCGATCGATCGATCGATCGATCGA');
    expect(updated.tmProvenance).toBeUndefined();
  });

  it('extends reverse primer PBS correctly with reverse complement', () => {
    const composedSeq = regions[0].sequence;
    const pbsStart = composedSeq.length - 20;
    const pbsEnd = composedSeq.length;
    const template = composedSeq.slice(pbsStart, pbsEnd);

    const reversePrimer = {
      id: 'rev1',
      name: 'F1-rev',
      sequence: reverseComplement(template),
      pbs: {
        start: pbsStart,
        end: pbsEnd,
        sequence: reverseComplement(template),
      },
      overhang: { length: 0, sequence: '' },
      direction: 'reverse' as const,
      fragmentIndex: 0,
      junctionIndex: null,
      tm: 40,
      tmProvenance: { source: 'neb', verified: true },
    };

    const updated = updatePrimerPbsLength(reversePrimer, 25, regions);

    expect(updated.pbs.start).toBe(52 - 25);
    expect(updated.pbs.end).toBe(52);

    const newTemplate = composedSeq.slice(27, 52);
    expect(updated.pbs.sequence).toBe(reverseComplement(newTemplate));

    const newFiveBpTemplate = composedSeq.slice(27, 32);

    expect(updated.pbs.sequence.endsWith(reverseComplement(newFiveBpTemplate))).toBe(true);
    expect(updated.tmProvenance).toBeUndefined();
  });

  it('never extends a forward PBS into the next assembly fragment', () => {
    const twoRegions: DesignRegion[] = [
      { ...regions[0], id: 'left', sequence: 'A'.repeat(40) },
      { ...regions[0], id: 'right', sequence: 'C'.repeat(40) },
    ];
    const primer: DesignPrimer = {
      id: 'left-forward',
      name: 'left-forward',
      sequence: 'A'.repeat(20),
      pbs: { start: 0, end: 20, sequence: 'A'.repeat(20) },
      overhang: { length: 0, sequence: '' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: null,
      tm: 40,
    };

    const updated = updatePrimerPbsLength(primer, 60, twoRegions);

    expect(updated.pbs).toMatchObject({ start: 0, end: 40, sequence: 'A'.repeat(40) });
    expect(updated.pbs.sequence).not.toContain('C');
  });

  it('never extends a reverse PBS into the previous assembly fragment or spacer', () => {
    const twoRegions: DesignRegion[] = [
      { ...regions[0], id: 'left', sequence: 'A'.repeat(40) },
      { ...regions[0], id: 'right', sequence: 'C'.repeat(40) },
    ];
    const primer: DesignPrimer = {
      id: 'right-reverse',
      name: 'right-reverse',
      sequence: 'G'.repeat(20),
      pbs: { start: 64, end: 84, sequence: 'G'.repeat(20) },
      overhang: { length: 0, sequence: '' },
      direction: 'reverse',
      fragmentIndex: 1,
      junctionIndex: null,
      tm: 40,
    };

    const updated = updatePrimerPbsLength(primer, 60, twoRegions, [
      { id: 'gap', junctionIndex: 0, sequence: 'TTTT' },
    ]);

    expect(updated.pbs).toMatchObject({ start: 44, end: 84, sequence: 'G'.repeat(40) });
  });

  it('recalculates Tm from the PBS only after a PBS edit', () => {
    const primer: DesignPrimer = {
      id: 'gg-forward',
      name: 'gg-forward',
      sequence: `TAIL${'A'.repeat(20)}`,
      pbs: { start: 0, end: 20, sequence: 'A'.repeat(20) },
      overhang: { length: 4, sequence: 'ACGT' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: 0,
      cognate4bpLength: 2,
      tm: 20,
    };
    const lengthCalculator = {
      estimate: (sequence: string) => sequence.length,
    } as Parameters<typeof updatePrimerPbsLength>[4];

    const updated = updatePrimerPbsLength(primer, 25, regions, [], lengthCalculator);

    expect(updated.pbs.sequence).toHaveLength(25);
    expect(updated.tm).toBe(25);
  });

  it('invalidates verified provenance when an exact PBS window changes', () => {
    const primer: DesignPrimer = {
      id: 'windowed',
      name: 'windowed',
      sequence: 'ATCGATCGATCGATCGATCG',
      pbs: { start: 0, end: 20, sequence: 'ATCGATCGATCGATCGATCG' },
      overhang: { length: 0, sequence: '' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: null,
      tm: 40,
      tmProvenance: { source: 'neb', verified: true },
    };

    const updated = updatePrimerPbsWindow(primer, 2, 22, regions);

    expect(updated.pbs).toMatchObject({ start: 2, end: 22 });
    expect(updated.tmProvenance).toBeUndefined();
  });
});

describe('calculateNewEncodingForOverhang', () => {
  it('updates onLeft for forward primer overhang', () => {
    const currentEncoding = { onLeft: 15, onRight: 15 };
    const newEncoding = calculateNewEncodingForOverhang(currentEncoding, 'forward', 20);

    expect(newEncoding.onLeft).toBe(20);
    expect(newEncoding.onRight).toBe(15);
  });

  it('updates onRight for reverse primer overhang', () => {
    const currentEncoding = { onLeft: 15, onRight: 15 };
    const newEncoding = calculateNewEncodingForOverhang(currentEncoding, 'reverse', 20);

    expect(newEncoding.onLeft).toBe(15);
    expect(newEncoding.onRight).toBe(20);
  });

  it('allows overhang length down to 0bp', () => {
    const currentEncoding = { onLeft: 15, onRight: 15 };
    const newEncoding = calculateNewEncodingForOverhang(currentEncoding, 'forward', 0);

    expect(newEncoding.onLeft).toBe(0);
  });

  it('clamps overhang length to maximum 60bp', () => {
    const currentEncoding = { onLeft: 15, onRight: 15 };
    const newEncoding = calculateNewEncodingForOverhang(currentEncoding, 'forward', 70);

    expect(newEncoding.onLeft).toBe(60);
  });
});

describe('primer overhang extraction', () => {
  it('forward primer overhang should NOT duplicate PBS sequence', () => {
    const region1: DesignRegion = {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Fragment 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence:
        'ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG',
      annotations: [],
    };

    const region2: DesignRegion = {
      id: 'r2',
      sourceSequenceId: 's2',
      sourceSequenceName: 'Fragment 2',
      sourceStart: 0,
      sourceEnd: 80,
      sequence: 'CCATATTGAATTTTCAAAAATTCTTACTTGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCT',
      annotations: [],
    };

    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      primerDesignConstraints: {
        targetPcrTm: estimateTm(region2.sequence.slice(0, 20)),
        overlapLength: 30,
      },
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);

    const frag2Forward = result.designPrimers[1].forward;

    const frag2Start = region2.sequence.slice(0, 20);
    expect(frag2Forward.pbs.sequence).toBe(frag2Start);

    const pbsPrefix = frag2Forward.pbs.sequence.slice(0, frag2Forward.overhang.length);
    expect(frag2Forward.overhang.sequence).not.toBe(pbsPrefix);

    const frag1ThreePrimeEnd = region1.sequence.slice(-frag2Forward.overhang.length);
    expect(frag2Forward.overhang.sequence).toBe(frag1ThreePrimeEnd);
  });

  it('overhang remains correct after adjustment at Junction 0', () => {
    const region1: DesignRegion = {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Fragment 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence:
        'ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG',
      annotations: [],
    };

    const region2: DesignRegion = {
      id: 'r2',
      sourceSequenceId: 's2',
      sourceSequenceName: 'Fragment 2',
      sourceStart: 0,
      sourceEnd: 80,
      sequence: 'TTATATTGAATTTTCAAAAATTCTTACTTGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCT',
      annotations: [],
    };

    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const composedSequence = region1.sequence + region2.sequence;

    const junction0Homology = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    const originalOverhangLength = junction0Homology.encoding.onLeft;

    const newEncoding = { ...junction0Homology.encoding, onLeft: originalOverhangLength - 2 };
    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0Homology, encoding: newEncoding },
      composedSequence
    );

    const frag2Forward = result.designPrimers[1].forward;
    const updatedPrimer = updatePrimerOverhangFromHomology(frag2Forward, updatedHomology);

    const pbsPrefix = updatedPrimer.pbs.sequence.slice(0, updatedPrimer.overhang.length);
    expect(updatedPrimer.overhang.sequence).not.toBe(pbsPrefix);

    const expectedOverhang = region1.sequence.slice(-(originalOverhangLength - 2));
    expect(updatedPrimer.overhang.sequence).toBe(expectedOverhang);
  });

  it('overhang remains correct after adjustment at Junction 1 (wrap-around)', () => {
    const region1: DesignRegion = {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Fragment 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence:
        'ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG',
      annotations: [],
    };

    const region2: DesignRegion = {
      id: 'r2',
      sourceSequenceId: 's2',
      sourceSequenceName: 'Fragment 2',
      sourceStart: 0,
      sourceEnd: 80,
      sequence: 'TTATATTGAATTTTCAAAAATTCTTACTTGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCT',
      annotations: [],
    };

    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      backboneSequenceId: region2.sourceSequenceId,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const composedSequence = region1.sequence + region2.sequence;

    const junction1Homology = result.homologyRegions.find((hr) => hr.junctionIndex === 1)!;
    expect(junction1Homology).toBeDefined();

    console.log('Junction 1 homology:', {
      junctionPosition: junction1Homology.junctionPosition,
      start: junction1Homology.start,
      end: junction1Homology.end,
      encoding: junction1Homology.encoding,
      sequence: junction1Homology.metadata?.sequence,
    });

    const originalOverhangLength = junction1Homology.encoding.onLeft;

    const newEncoding = { ...junction1Homology.encoding, onLeft: originalOverhangLength - 2 };
    const updatedHomology = recomputeHomologyMetadata(
      { ...junction1Homology, encoding: newEncoding },
      composedSequence
    );

    console.log('Updated homology:', {
      junctionPosition: updatedHomology.junctionPosition,
      start: updatedHomology.start,
      end: updatedHomology.end,
      encoding: updatedHomology.encoding,
      sequence: updatedHomology.metadata?.sequence,
    });

    const frag1Forward = result.designPrimers[0].forward;
    expect(frag1Forward.junctionIndex).toBe(1);

    console.log('Original frag1Forward:', {
      overhang: frag1Forward.overhang,
      pbs: frag1Forward.pbs.sequence,
    });

    const updatedPrimer = updatePrimerOverhangFromHomology(frag1Forward, updatedHomology);

    console.log('Updated primer:', {
      overhang: updatedPrimer.overhang,
      pbs: updatedPrimer.pbs.sequence,
    });

    const pbsPrefix = updatedPrimer.pbs.sequence.slice(1, updatedPrimer.overhang.length + 1);
    expect(updatedPrimer.overhang.sequence).not.toBe(pbsPrefix);

    const frag2ThreePrimeEnd = region2.sequence.slice(-(originalOverhangLength - 2));
    expect(updatedPrimer.overhang.sequence).toBe(frag2ThreePrimeEnd);
  });
});

describe('overhang adjustment flow - simulating store update', () => {
  it('reproduces exact user bug: overhang should NOT be PBS[1:10]', () => {
    const region1: DesignRegion = {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Fragment 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence:
        'AAAAAAAAAAAAAAAAAAAAGGGGGGGGGGGGGGGGGGGGCCCCCCCCCCCCCCCCCCCCTTTTTTTTTTTTTTTTTTTTAAAAAAAAAAAAAAAAGGGG',
      annotations: [],
    };

    const region2: DesignRegion = {
      id: 'r2',
      sourceSequenceId: 's2',
      sourceSequenceName: 'Fragment 2',
      sourceStart: 0,
      sourceEnd: 80,
      sequence: 'TTATATTGAATTTTCAAAAATTCTTACTTGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCT',
      annotations: [],
    };

    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const composedSequence = region1.sequence + region2.sequence;

    const frag2Forward = result.designPrimers[1].forward;
    expect(frag2Forward.fragmentIndex).toBe(1);
    expect(frag2Forward.junctionIndex).toBe(0);

    const junction0Homology = result.homologyRegions.find((hr) => hr.junctionIndex === 0)!;
    expect(junction0Homology).toBeDefined();

    console.log('=== INITIAL STATE ===');
    console.log('Junction 0 homology:', {
      junctionPosition: junction0Homology.junctionPosition,
      start: junction0Homology.start,
      end: junction0Homology.end,
      encoding: junction0Homology.encoding,
      sequence: junction0Homology.metadata?.sequence,
    });
    console.log('Fragment 2 forward primer:', {
      overhang: frag2Forward.overhang,
      pbsSequence: frag2Forward.pbs.sequence,
      pbsStart: frag2Forward.pbs.start,
      pbsEnd: frag2Forward.pbs.end,
    });

    expect(frag2Forward.overhang.sequence).not.toBe(frag2Forward.pbs.sequence.slice(1, 10));
    expect(frag2Forward.overhang.sequence).not.toBe('TATATTGAA');

    const expectedInitialOverhang = region1.sequence.slice(-frag2Forward.overhang.length);
    expect(frag2Forward.overhang.sequence).toBe(expectedInitialOverhang);

    const oldEncoding = junction0Homology.encoding;
    const newOverhangLength = oldEncoding.onLeft - 2;
    const newEncoding = calculateNewEncodingForOverhang(oldEncoding, 'forward', newOverhangLength);

    console.log('=== AFTER ENCODING CHANGE ===');
    console.log('Old encoding:', oldEncoding);
    console.log('New encoding:', newEncoding);

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction0Homology, encoding: newEncoding },
      composedSequence,
      oldEncoding
    );

    console.log('Updated homology:', {
      junctionPosition: updatedHomology.junctionPosition,
      start: updatedHomology.start,
      end: updatedHomology.end,
      encoding: updatedHomology.encoding,
      sequence: updatedHomology.metadata?.sequence,
    });

    const leftPortion = updatedHomology.metadata!.sequence!.slice(0, newEncoding.onLeft);
    console.log('Left portion of homology (forward overhang):', leftPortion);

    const region1Tail = region1.sequence.slice(-newEncoding.onLeft);
    console.log('Expected (region1 tail):', region1Tail);

    expect(leftPortion).toBe(region1Tail);
    expect(leftPortion).not.toBe(region2.sequence.slice(0, newEncoding.onLeft));
    expect(leftPortion).not.toBe(region2.sequence.slice(1, newEncoding.onLeft + 1));

    const updatedPrimer = updatePrimerOverhangFromHomology(frag2Forward, updatedHomology);

    console.log('=== FINAL PRIMER ===');
    console.log('Updated primer overhang:', updatedPrimer.overhang);
    console.log('PBS (should be unchanged):', updatedPrimer.pbs.sequence);

    expect(updatedPrimer.overhang.sequence).not.toBe('TATATTGAA');
    expect(updatedPrimer.overhang.sequence).not.toBe(
      updatedPrimer.pbs.sequence.slice(0, updatedPrimer.overhang.length)
    );
    expect(updatedPrimer.overhang.sequence).not.toBe(
      updatedPrimer.pbs.sequence.slice(1, updatedPrimer.overhang.length + 1)
    );

    const expectedOverhang = region1.sequence.slice(-newEncoding.onLeft);
    expect(updatedPrimer.overhang.sequence).toBe(expectedOverhang);
  });

  it('traces adjustment at Junction 1 with detailed logging', () => {
    const region1: DesignRegion = {
      id: 'r1',
      sourceSequenceId: 's1',
      sourceSequenceName: 'Fragment 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence:
        'ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG',
      annotations: [],
    };

    const region2: DesignRegion = {
      id: 'r2',
      sourceSequenceId: 's2',
      sourceSequenceName: 'Fragment 2',
      sourceStart: 0,
      sourceEnd: 80,
      sequence: 'TTATATTGAATTTTCAAAAATTCTTACTTGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCT',
      annotations: [],
    };

    const design: SequenceDesign = {
      id: 'd1',
      name: 'Test',
      topology: 'circular',
      regions: [region1, region2],
      spacers: [],
      status: 'draft',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      backboneSequenceId: region2.sourceSequenceId,
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const composedSequence = region1.sequence + region2.sequence;
    const totalLen = composedSequence.length;

    const frag1Forward = result.designPrimers[0].forward;
    expect(frag1Forward.fragmentIndex).toBe(0);
    expect(frag1Forward.junctionIndex).toBe(1);

    const junction1Homology = result.homologyRegions.find((hr) => hr.junctionIndex === 1)!;
    expect(junction1Homology).toBeDefined();

    console.log('=== JUNCTION 1 (WRAP-AROUND) TEST ===');
    console.log('Total sequence length:', totalLen);
    console.log('Junction 1 position:', junction1Homology.junctionPosition);
    console.log('Junction 1 homology sequence:', junction1Homology.metadata?.sequence);
    console.log('Region 2 last 10 chars:', region2.sequence.slice(-10));
    console.log('Region 1 first 10 chars:', region1.sequence.slice(0, 10));

    expect(junction1Homology.junctionPosition).toBe(180);

    const onLeft = junction1Homology.encoding.onLeft;
    const onRight = junction1Homology.encoding.onRight;

    const expectedLeftPortion = region2.sequence.slice(-onLeft);
    const actualLeftPortion = junction1Homology.metadata!.sequence!.slice(0, onLeft);
    console.log('Expected left portion (region2 tail):', expectedLeftPortion);
    console.log('Actual left portion:', actualLeftPortion);
    expect(actualLeftPortion).toBe(expectedLeftPortion);

    const expectedRightPortion = region1.sequence.slice(0, onRight);
    const actualRightPortion = junction1Homology.metadata!.sequence!.slice(onLeft);
    console.log('Expected right portion (region1 head):', expectedRightPortion);
    console.log('Actual right portion:', actualRightPortion);
    expect(actualRightPortion).toBe(expectedRightPortion);

    const oldEncoding = junction1Homology.encoding;
    const newEncoding = { ...oldEncoding, onLeft: oldEncoding.onLeft - 2 };

    const updatedHomology = recomputeHomologyMetadata(
      { ...junction1Homology, encoding: newEncoding },
      composedSequence,
      oldEncoding
    );

    console.log('After adjustment:', {
      start: updatedHomology.start,
      end: updatedHomology.end,
      sequence: updatedHomology.metadata?.sequence,
    });

    const newExpectedLeftPortion = region2.sequence.slice(-newEncoding.onLeft);
    const newActualLeftPortion = updatedHomology.metadata!.sequence!.slice(0, newEncoding.onLeft);
    console.log('New expected left portion:', newExpectedLeftPortion);
    console.log('New actual left portion:', newActualLeftPortion);
    expect(newActualLeftPortion).toBe(newExpectedLeftPortion);
  });
});

describe('recomputeHomologyMetadata', () => {
  it('updates sequence, Tm, and GC content based on new encoding', () => {
    const composedSequence = 'ATGCGATCGATCGATCGATCGATCGATCGATCGATCGATCG';

    const homologyRegion = {
      id: 'h1',
      junctionIndex: 0,
      junctionPosition: 20,
      start: 10,
      end: 30,
      encoding: { onLeft: 10, onRight: 10 },
      metadata: {
        sequence: '',
        tmEstimate: 0,
        gcContent: 0,
      },
    };

    const updated = recomputeHomologyMetadata(homologyRegion, composedSequence);

    expect(updated.metadata?.sequence?.length).toBe(20);
    expect(updated.metadata?.sequence).toBe('TCGATCGATCGATCGATCGA');

    expect(updated.start).toBe(10);
    expect(updated.end).toBe(30);

    expect(updated.metadata?.tmEstimate).toBeGreaterThan(0);
    expect(updated.metadata?.gcContent).toBeGreaterThan(0);
  });

  it('adjusts start position when onLeft changes (removes from far end)', () => {
    const composedSequence = 'ATGCGATCGATCGATCGATCGATCGATCGATCGATCGATCG';

    const newEncoding = { onLeft: 8, onRight: 10 };

    const homologyRegion = {
      id: 'h1',
      junctionIndex: 0,
      junctionPosition: 20,
      start: 10,
      end: 30,
      encoding: newEncoding,
      metadata: undefined,
    };

    const updated = recomputeHomologyMetadata(homologyRegion, composedSequence);

    expect(updated.start).toBe(12);
    expect(updated.end).toBe(30);

    expect(updated.metadata?.sequence?.length).toBe(18);
  });

  it('handles wraparound for circular sequences', () => {
    const composedSequence = 'ATGCGATCGA';

    const homologyRegion = {
      id: 'h1',
      junctionIndex: 0,
      junctionPosition: 10,
      start: 8,
      end: 4,
      encoding: { onLeft: 2, onRight: 4 },
      metadata: undefined,
    };

    const updated = recomputeHomologyMetadata(homologyRegion, composedSequence);

    expect(updated.metadata?.sequence?.length).toBe(6);
    expect(updated.metadata?.sequence).toBe('GAATGC');

    expect(updated.start).toBe(8);
    expect(updated.end).toBe(4);
  });
});

describe('computePbsSequence', () => {
  const composedSequence = 'ATCGATCGATCGATCGATCG';

  it('returns direct template for forward primer', () => {
    const result = computePbsSequence('forward', 0, 10, composedSequence);
    expect(result).toBe('ATCGATCGAT');
    expect(result).toBe(composedSequence.slice(0, 10));
  });

  it('returns reverse complement for reverse primer', () => {
    const result = computePbsSequence('reverse', 10, 20, composedSequence);
    const template = composedSequence.slice(10, 20);
    expect(result).toBe(reverseComplement(template));
  });

  it('handles middle positions correctly', () => {
    const result = computePbsSequence('forward', 5, 15, composedSequence);
    expect(result).toBe(composedSequence.slice(5, 15));
  });

  it('returns empty for zero-length PBS', () => {
    const result = computePbsSequence('forward', 10, 10, composedSequence);
    expect(result).toBe('');
  });
});

describe('computeOverhangSequence', () => {
  const homologyRegion: HomologyRegion = {
    id: 'h1',
    junctionIndex: 0,
    junctionPosition: 50,
    start: 45,
    end: 55,
    encoding: { onLeft: 5, onRight: 5 },
    metadata: {
      sequence: 'AAAAAGGGGG',
      tmEstimate: 30,
      gcContent: 50,
    },
  };

  it('returns left portion for forward primer (direct)', () => {
    const result = computeOverhangSequence('forward', homologyRegion);
    expect(result).toBe('AAAAA');
  });

  it('returns reverse complement of right portion for reverse primer', () => {
    const result = computeOverhangSequence('reverse', homologyRegion);
    expect(result).toBe('CCCCC');
  });

  it('returns empty when onLeft is 0 for forward primer', () => {
    const noLeftHomology: HomologyRegion = {
      ...homologyRegion,
      encoding: { onLeft: 0, onRight: 10 },
      metadata: { sequence: 'AAAAAGGGGG', tmEstimate: 30, gcContent: 50 },
    };
    const result = computeOverhangSequence('forward', noLeftHomology);
    expect(result).toBe('');
  });

  it('returns empty when onRight is 0 for reverse primer', () => {
    const noRightHomology: HomologyRegion = {
      ...homologyRegion,
      encoding: { onLeft: 10, onRight: 0 },
      metadata: { sequence: 'AAAAAGGGGG', tmEstimate: 30, gcContent: 50 },
    };
    const result = computeOverhangSequence('reverse', noRightHomology);
    expect(result).toBe('');
  });

  it('handles missing metadata gracefully', () => {
    const noMetadata: HomologyRegion = {
      ...homologyRegion,
      metadata: undefined,
    };
    const result = computeOverhangSequence('forward', noMetadata);
    expect(result).toBe('');
  });
});

describe('computePrimerDisplay', () => {
  const composedSequence = 'ATCGATCGATCGATCGATCGATCGATCGATCG';

  const homologyRegion: HomologyRegion = {
    id: 'h1',
    junctionIndex: 0,
    junctionPosition: 15,
    start: 10,
    end: 20,
    encoding: { onLeft: 5, onRight: 5 },
    metadata: {
      sequence: 'GATCGATCGA',
      tmEstimate: 30,
      gcContent: 50,
    },
  };

  it('computes forward primer display correctly', () => {
    const forwardPrimer: DesignPrimer = {
      id: 'fwd1',
      name: 'Test-fwd',
      sequence: '',
      pbs: { start: 15, end: 25, sequence: '' },
      overhang: { length: 5, sequence: '' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 0,
    };

    const display = computePrimerDisplay(forwardPrimer, homologyRegion, composedSequence);

    expect(display.overhangSequence).toBe('GATCG');

    expect(display.pbsSequence).toBe(composedSequence.slice(15, 25));

    expect(display.fullSequence).toBe(display.overhangSequence + display.pbsSequence);

    expect(display.tm).toBeGreaterThan(0);
  });

  it('computes reverse primer display correctly', () => {
    const reversePrimer: DesignPrimer = {
      id: 'rev1',
      name: 'Test-rev',
      sequence: '',
      pbs: { start: 5, end: 15, sequence: '' },
      overhang: { length: 5, sequence: '' },
      direction: 'reverse',
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 0,
    };

    const display = computePrimerDisplay(reversePrimer, homologyRegion, composedSequence);

    expect(display.overhangSequence).toBe(reverseComplement('ATCGA'));

    const template = composedSequence.slice(5, 15);
    expect(display.pbsSequence).toBe(reverseComplement(template));
  });

  it('handles null homologyRegion (no overhang)', () => {
    const primer: DesignPrimer = {
      id: 'fwd1',
      name: 'Test-fwd',
      sequence: '',
      pbs: { start: 0, end: 10, sequence: '' },
      overhang: { length: 0, sequence: '' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: null,
      tm: 0,
    };

    const display = computePrimerDisplay(primer, null, composedSequence);

    expect(display.overhangSequence).toBe('');
    expect(display.pbsSequence).toBe(composedSequence.slice(0, 10));
    expect(display.fullSequence).toBe(display.pbsSequence);
  });
});

describe('on-demand computation vs stored values', () => {
  it('computes correct sequences even if stored values are wrong', () => {
    const composedSequence = 'ATCGATCGATCGATCGATCG';

    const staleHomology: HomologyRegion = {
      id: 'h1',
      junctionIndex: 0,
      junctionPosition: 10,
      start: 5,
      end: 15,
      encoding: { onLeft: 5, onRight: 5 },
      metadata: {
        sequence: 'WRONGWRONG',
        tmEstimate: 999,
        gcContent: 999,
      },
    };

    const recomputed = recomputeHomologyMetadata(staleHomology, composedSequence);

    expect(recomputed.metadata?.sequence).toBe('TCGATCGATC');
    expect(recomputed.metadata?.sequence).not.toBe('WRONGWRONG');
  });

  it('computePbsSequence ignores stored pbs.sequence', () => {
    const composedSequence = 'ATCGATCGATCGATCGATCG';

    const primerWithStaleData: DesignPrimer = {
      id: 'fwd1',
      name: 'Test',
      sequence: 'WRONGSEQUENCE',
      pbs: {
        start: 0,
        end: 10,
        sequence: 'WRONGPBS!!',
      },
      overhang: { length: 0, sequence: '' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: null,
      tm: 0,
    };

    const correctPbs = computePbsSequence(
      primerWithStaleData.direction,
      primerWithStaleData.pbs.start,
      primerWithStaleData.pbs.end,
      composedSequence
    );

    expect(correctPbs).toBe('ATCGATCGAT');
    expect(correctPbs).not.toBe('WRONGPBS!!');
  });

  it('full display computation ignores all stored sequences', () => {
    const composedSequence = 'ATCGATCGATCGATCGATCGATCGATCGATCG';

    const freshHomology: HomologyRegion = {
      id: 'h1',
      junctionIndex: 0,
      junctionPosition: 15,
      start: 10,
      end: 20,
      encoding: { onLeft: 5, onRight: 5 },
      metadata: {
        sequence: composedSequence.slice(10, 20),
        tmEstimate: 30,
        gcContent: 50,
      },
    };

    const stalePrimer: DesignPrimer = {
      id: 'fwd1',
      name: 'Test',
      sequence: 'ALLWRONGFULLSEQUENCE',
      pbs: { start: 15, end: 25, sequence: 'WRONGPBS' },
      overhang: { length: 5, sequence: 'WRONG' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 999,
    };

    const display = computePrimerDisplay(stalePrimer, freshHomology, composedSequence);

    expect(display.overhangSequence).toBe('CGATC');
    expect(display.pbsSequence).toBe(composedSequence.slice(15, 25));
    expect(display.fullSequence).toBe('CGATC' + composedSequence.slice(15, 25));
    expect(display.tm).not.toBe(999);
  });
});

describe('hydration scenario - stale localStorage data', () => {
  it('recomputeHomologyMetadata fixes stale homology from old storage', () => {
    const composedSequence = 'AAAAATTTTTGGGGGCCCCC';

    const staleHomologyFromStorage: HomologyRegion = {
      id: 'h1',
      junctionIndex: 0,
      junctionPosition: 10,
      start: 5,
      end: 15,
      encoding: { onLeft: 5, onRight: 5 },
      metadata: {
        sequence: 'OLDOLDOLDO',
        tmEstimate: 0,
        gcContent: 0,
      },
    };

    const hydrated = recomputeHomologyMetadata(staleHomologyFromStorage, composedSequence);

    expect(hydrated.metadata?.sequence).toBe('TTTTTGGGGG');
    expect(hydrated.metadata?.sequence).not.toBe('OLDOLDOLDO');

    expect(hydrated.metadata?.tmEstimate).toBeGreaterThan(0);
    expect(hydrated.metadata?.gcContent).toBe(50);
  });

  it('on-demand display fixes stale primer sequences without modifying store', () => {
    const composedSequence = 'AAAAATTTTTGGGGGCCCCCAAAAATTTTT';

    const freshHomology: HomologyRegion = {
      id: 'h1',
      junctionIndex: 0,
      junctionPosition: 15,
      start: 10,
      end: 20,
      encoding: { onLeft: 5, onRight: 5 },
      metadata: {
        sequence: 'GGGGGCCCCC',
        tmEstimate: 50,
        gcContent: 100,
      },
    };

    const stalePrimer: DesignPrimer = {
      id: 'fwd1',
      name: 'Test-fwd',
      sequence: 'STALEOLDBADDATA',
      pbs: { start: 15, end: 25, sequence: 'STALESTALE' },
      overhang: { length: 5, sequence: 'STALE' },
      direction: 'forward',
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 0,
    };

    const display = computePrimerDisplay(stalePrimer, freshHomology, composedSequence);

    expect(display.overhangSequence).toBe('GGGGG');

    expect(display.pbsSequence).toBe('CCCCCAAAAA');

    expect(display.fullSequence).toBe('GGGGGCCCCCAAAAA');
  });
});
