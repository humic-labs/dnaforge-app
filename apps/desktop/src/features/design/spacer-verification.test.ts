// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeDraftAssembly, reverseComplement } from './algorithms/draft-assembly';
import { getComposedSequence } from './types';
import type { SequenceDesign } from './types';

function getWatsonSequence(composed: string, start: number, end: number): string {
  const len = composed.length;
  let seq = '';
  for (let i = start; i < end; i++) {
    const pos = ((i % len) + len) % len;
    seq += composed[pos];
  }
  return seq;
}

describe('Gibson Assembly Primer Verification', () => {
  it('verifies primer sequences match composed sequence positions', () => {
    const design: SequenceDesign = {
      id: 'design-1',
      name: 'Test Design',
      regions: [
        {
          id: 'region-0',
          sourceSequenceId: 'source-0',
          sourceSequenceName: 'Fragment 1',
          sourceStart: 0,
          sourceEnd: 32,
          sequence: 'ATGCATGCATGCATGCATGCATGCATGCATGC',
          annotations: [],
        },
        {
          id: 'region-1',
          sourceSequenceId: 'source-1',
          sourceSequenceName: 'Fragment 2',
          sourceStart: 0,
          sourceEnd: 32,
          sequence: 'GCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA',
          annotations: [],
        },
      ],
      topology: 'linear',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 20,
      spacers: [
        {
          id: 'spacer-0',
          junctionIndex: 0,
          sequence: 'AAAAAAAAAA',
        },
      ],
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

    console.log('\n=== HOMOLOGY REGIONS ===');
    for (const hr of result.homologyRegions) {
      console.log(`Junction ${hr.junctionIndex}:`);
      console.log('  Position:', hr.junctionPosition);
      console.log('  Start-End:', hr.start, '-', hr.end);
      console.log('  onLeft:', hr.encoding?.onLeft, 'onRight:', hr.encoding?.onRight);
      console.log('  Sequence:', hr.metadata?.sequence);
      console.log('  Total length:', hr.metadata?.sequence?.length);
    }

    console.log('\n=== COMPOSED SEQUENCE ===');
    console.log('Length:', composed.length);
    console.log('F1 (0-31):', composed.slice(0, 32));
    console.log('Spacer (32-41):', composed.slice(32, 42));
    console.log('F2 (42-73):', composed.slice(42, 74));

    const f1Pair = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    const f2Pair = result.designPrimers.find((p) => p.fragmentIndex === 1)!;

    const f1Rev = f1Pair.reverse;
    const f2Fwd = f2Pair.forward;

    console.log('\n=== PRIMERS AT JUNCTION 0 ===');
    console.log('F1-rev junction:', f1Rev.junctionIndex);
    console.log('F2-fwd junction:', f2Fwd.junctionIndex);

    expect(f1Rev.junctionIndex).toBe(0);
    expect(f2Fwd.junctionIndex).toBe(0);

    console.log('\n=== F1-REV PRIMER VERIFICATION ===');
    console.log('Full sequence:', f1Rev.sequence);
    console.log('PBS start-end:', f1Rev.pbs.start, '-', f1Rev.pbs.end);
    console.log('PBS sequence:', f1Rev.pbs.sequence);
    console.log('Overhang sequence:', f1Rev.overhang.sequence);
    console.log('Overhang length:', f1Rev.overhang.length);
    console.log('Spacer in overhang:', f1Rev.overhang.spacerSequence ?? 'NONE');

    const f1RevPbsTemplate = getWatsonSequence(composed, f1Rev.pbs.start, f1Rev.pbs.end);
    const expectedF1RevPbs = reverseComplement(f1RevPbsTemplate);
    console.log('Expected PBS (RC of template):', expectedF1RevPbs);
    console.log('Actual PBS:', f1Rev.pbs.sequence);
    expect(f1Rev.pbs.sequence).toBe(expectedF1RevPbs);

    const f1RevOhStart = f1Rev.pbs.end;
    const f1RevOhEnd = f1RevOhStart + f1Rev.overhang.length;
    const f1RevOhTemplate = getWatsonSequence(composed, f1RevOhStart, f1RevOhEnd);
    const expectedF1RevOh = reverseComplement(f1RevOhTemplate);
    console.log('Overhang template positions:', f1RevOhStart, '-', f1RevOhEnd);
    console.log('Overhang template (Watson):', f1RevOhTemplate);
    console.log('Expected overhang (RC):', expectedF1RevOh);
    console.log('Actual overhang:', f1Rev.overhang.sequence);

    const spacerSeq = design.spacers![0].sequence;
    const spacerInTemplate = f1RevOhTemplate.includes(spacerSeq);
    console.log('Spacer in overhang template?', spacerInTemplate);

    expect(f1Rev.overhang.sequence).toBe(expectedF1RevOh);

    console.log('\n=== F2-FWD PRIMER VERIFICATION ===');
    console.log('Full sequence:', f2Fwd.sequence);
    console.log('PBS start-end:', f2Fwd.pbs.start, '-', f2Fwd.pbs.end);
    console.log('PBS sequence:', f2Fwd.pbs.sequence);
    console.log('Overhang sequence:', f2Fwd.overhang.sequence);
    console.log('Overhang length:', f2Fwd.overhang.length);
    console.log('Spacer in overhang:', f2Fwd.overhang.spacerSequence ?? 'NONE');

    const f2FwdPbsTemplate = getWatsonSequence(composed, f2Fwd.pbs.start, f2Fwd.pbs.end);
    console.log('Expected PBS (Watson direct):', f2FwdPbsTemplate);
    console.log('Actual PBS:', f2Fwd.pbs.sequence);
    expect(f2Fwd.pbs.sequence).toBe(f2FwdPbsTemplate);

    const f2FwdOhEnd = f2Fwd.pbs.start;
    const f2FwdOhStart = f2FwdOhEnd - f2Fwd.overhang.length;
    const expectedF2FwdOh = getWatsonSequence(composed, f2FwdOhStart, f2FwdOhEnd);
    console.log('Overhang positions:', f2FwdOhStart, '-', f2FwdOhEnd);
    console.log('Expected overhang (Watson):', expectedF2FwdOh);
    console.log('Actual overhang:', f2Fwd.overhang.sequence);

    const spacerInFwdOh = expectedF2FwdOh.includes(spacerSeq);
    console.log('Spacer in overhang?', spacerInFwdOh);

    expect(f2Fwd.overhang.sequence).toBe(expectedF2FwdOh);

    console.log('\n=== JUNCTION COMPLEMENTARITY ===');
    console.log('');
    console.log('IMPORTANT: The overhangs do NOT need to be reverse complements of each other!');
    console.log('They represent DIFFERENT portions of the homology region:');
    console.log('  F1-rev overhang: RC of positions 32-53 (spacer + onRight)');
    console.log('  F2-fwd overhang: positions 31-41 (onLeft = 1bp F1 end + spacer)');
    console.log('');
    console.log('F1-rev overhang:', f1Rev.overhang.sequence, '(' + f1Rev.overhang.length + 'bp)');
    console.log('F2-fwd overhang:', f2Fwd.overhang.sequence, '(' + f2Fwd.overhang.length + 'bp)');

    const f1RevSpacerPortion = f1Rev.overhang.spacerSequence;
    const f2FwdSpacerPortion = f2Fwd.overhang.spacerSequence;

    console.log('');
    console.log('Spacer portion in F1-rev overhang:', f1RevSpacerPortion);
    console.log('Spacer portion in F2-fwd overhang:', f2FwdSpacerPortion);
    console.log(
      'Are spacer portions complementary?',
      f1RevSpacerPortion === reverseComplement(f2FwdSpacerPortion ?? '')
    );

    expect(f1RevSpacerPortion).toBe(reverseComplement(spacerSeq));
    expect(f2FwdSpacerPortion).toBe(spacerSeq);
  });

  it('verifies spacer is included in BOTH primers at junction', () => {
    const design: SequenceDesign = {
      id: 'design-1',
      name: 'Test Design',
      regions: [
        {
          id: 'region-0',
          sourceSequenceId: 'source-0',
          sourceSequenceName: 'Fragment 1',
          sourceStart: 0,
          sourceEnd: 32,
          sequence: 'ATGCATGCATGCATGCATGCATGCATGCATGC',
          annotations: [],
        },
        {
          id: 'region-1',
          sourceSequenceId: 'source-1',
          sourceSequenceName: 'Fragment 2',
          sourceStart: 0,
          sourceEnd: 32,
          sequence: 'GCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA',
          annotations: [],
        },
      ],
      topology: 'linear',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 20,
      spacers: [
        {
          id: 'spacer-0',
          junctionIndex: 0,
          sequence: 'AAAAAAAAAA',
        },
      ],
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = computeDraftAssembly(design);
    const spacerSeq = design.spacers![0].sequence;
    const spacerRC = reverseComplement(spacerSeq);

    const f1Rev = result.designPrimers.find((p) => p.fragmentIndex === 0)!.reverse;
    const f2Fwd = result.designPrimers.find((p) => p.fragmentIndex === 1)!.forward;

    console.log('\n=== SPACER IN BOTH PRIMERS ===');
    console.log('Spacer sequence:', spacerSeq);
    console.log('Spacer RC:', spacerRC);
    console.log('F1-rev full:', f1Rev.sequence);
    console.log('F2-fwd full:', f2Fwd.sequence);
    console.log('F1-rev contains spacer RC?', f1Rev.sequence.includes(spacerRC));
    console.log('F2-fwd contains spacer?', f2Fwd.sequence.includes(spacerSeq));

    expect(f1Rev.sequence).toContain(spacerRC);

    expect(f2Fwd.sequence).toContain(spacerSeq);
  });
});
