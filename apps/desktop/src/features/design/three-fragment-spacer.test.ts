// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeDraftAssembly, reverseComplement } from './algorithms/draft-assembly';
import { getComposedSequence } from './types';
import type { SequenceDesign } from './types';

describe('3-Fragment Assembly with Spacer', () => {
  it('verifies junction positions account for spacer length', () => {
    const design: SequenceDesign = {
      id: 'design-1',
      name: 'Test Design',
      regions: [
        {
          id: 'region-0',
          sourceSequenceId: 'source-0',
          sourceSequenceName: 'Fragment 1',
          sourceStart: 0,
          sourceEnd: 40,
          sequence: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          annotations: [],
        },
        {
          id: 'region-1',
          sourceSequenceId: 'source-1',
          sourceSequenceName: 'Fragment 2',
          sourceStart: 0,
          sourceEnd: 40,
          sequence: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
          annotations: [],
        },
        {
          id: 'region-2',
          sourceSequenceId: 'source-2',
          sourceSequenceName: 'Fragment 3',
          sourceStart: 0,
          sourceEnd: 40,
          sequence: 'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
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
          sequence: 'TTTTTTTTTT',
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

    console.log('\n' + '='.repeat(80));
    console.log('3-FRAGMENT ASSEMBLY WITH SPACER BETWEEN F1 AND F2');
    console.log('='.repeat(80));

    console.log('\n--- COMPOSED SEQUENCE ---');
    console.log('Length:', composed.length, 'bp');
    console.log('Expected: 40 + 10 + 40 + 40 = 130 bp');
    console.log('');
    console.log('F1 (0-39):      ', composed.slice(0, 40), "(40bp A's)");
    console.log('Spacer (40-49): ', composed.slice(40, 50), "(10bp T's)");
    console.log('F2 (50-89):     ', composed.slice(50, 90), "(40bp C's)");
    console.log('F3 (90-129):    ', composed.slice(90, 130), "(40bp G's)");

    console.log('\n--- EXPECTED JUNCTION POSITIONS ---');
    console.log('Junction 0 (F1|spacer|F2): position 50 (end of spacer, start of F2)');
    console.log('Junction 1 (F2|F3): position 90 (end of F2, start of F3)');

    console.log('\n--- ACTUAL HOMOLOGY REGIONS ---');
    for (const hr of result.homologyRegions) {
      console.log(`Junction ${hr.junctionIndex}:`);
      console.log(`  Junction position: ${hr.junctionPosition}`);
      console.log(`  Homology start-end: ${hr.start} - ${hr.end}`);
      console.log(`  onLeft: ${hr.encoding?.onLeft}, onRight: ${hr.encoding?.onRight}`);
      console.log(`  Sequence: ${hr.metadata?.sequence}`);
    }

    const junction0 = result.homologyRegions.find((hr) => hr.junctionIndex === 0);
    const junction1 = result.homologyRegions.find((hr) => hr.junctionIndex === 1);

    console.log('\n--- JUNCTION POSITION VERIFICATION ---');

    console.log('\nJunction 0:');
    console.log('  Expected position: 50');
    console.log('  Actual position:', junction0?.junctionPosition);
    expect(junction0?.junctionPosition).toBe(50);

    console.log('\nJunction 1:');
    console.log('  Expected position: 90');
    console.log('  Actual position:', junction1?.junctionPosition);
    expect(junction1?.junctionPosition).toBe(90);

    console.log('\n--- PRIMERS AT JUNCTION 1 (F2|F3) ---');
    const f2Pair = result.designPrimers.find((p) => p.fragmentIndex === 1)!;
    const f3Pair = result.designPrimers.find((p) => p.fragmentIndex === 2)!;

    console.log('\nF2-rev (should have overhang for junction 1):');
    console.log('  Junction index:', f2Pair.reverse.junctionIndex);
    console.log('  PBS start-end:', f2Pair.reverse.pbs.start, '-', f2Pair.reverse.pbs.end);
    console.log('  PBS sequence:', f2Pair.reverse.pbs.sequence);
    console.log('  Overhang:', f2Pair.reverse.overhang.sequence);

    console.log('\nF3-fwd (should have overhang for junction 1):');
    console.log('  Junction index:', f3Pair.forward.junctionIndex);
    console.log('  PBS start-end:', f3Pair.forward.pbs.start, '-', f3Pair.forward.pbs.end);
    console.log('  PBS sequence:', f3Pair.forward.pbs.sequence);
    console.log('  Overhang:', f3Pair.forward.overhang.sequence);

    console.log('\n--- PBS POSITION VERIFICATION ---');

    console.log('\nF2-rev PBS:');
    console.log('  Expected: positions ~70-90 (end of F2)');
    console.log('  Actual: positions', f2Pair.reverse.pbs.start, '-', f2Pair.reverse.pbs.end);
    expect(f2Pair.reverse.pbs.end).toBe(90);

    console.log('\nF3-fwd PBS:');
    console.log('  Expected: positions 90-110 (start of F3)');
    console.log('  Actual: positions', f3Pair.forward.pbs.start, '-', f3Pair.forward.pbs.end);
    expect(f3Pair.forward.pbs.start).toBe(90);

    console.log('\n--- PBS SEQUENCE VERIFICATION ---');

    const f2RevPbsExpected = reverseComplement(
      composed.slice(f2Pair.reverse.pbs.start, f2Pair.reverse.pbs.end)
    );
    console.log('F2-rev PBS from composed:', f2RevPbsExpected);
    console.log('F2-rev PBS actual:', f2Pair.reverse.pbs.sequence);
    expect(f2Pair.reverse.pbs.sequence).toBe(f2RevPbsExpected);

    const f3FwdPbsExpected = composed.slice(f3Pair.forward.pbs.start, f3Pair.forward.pbs.end);
    console.log('F3-fwd PBS from composed:', f3FwdPbsExpected);
    console.log('F3-fwd PBS actual:', f3Pair.forward.pbs.sequence);
    expect(f3Pair.forward.pbs.sequence).toBe(f3FwdPbsExpected);

    console.log('\n' + '='.repeat(80));
  });
});
