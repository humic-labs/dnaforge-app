// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeDraftAssembly, reverseComplement } from './algorithms/draft-assembly';
import { getComposedSequence } from './types';
import type { SequenceDesign } from './types';

describe('Gibson Assembly - Understanding the Implementation', () => {
  it('traces through a simple 2-fragment linear assembly WITHOUT spacers', () => {
    const design: SequenceDesign = {
      id: 'design-1',
      name: 'Test Design',
      regions: [
        {
          id: 'f1',
          sourceSequenceId: 's1',
          sourceSequenceName: 'Fragment 1',
          sourceStart: 0,
          sourceEnd: 40,
          sequence: 'AAAAAAAAAAAAAAAAAAAAGGGGGGGGGGGGGGGGGGGG',
          annotations: [],
        },
        {
          id: 'f2',
          sourceSequenceId: 's2',
          sourceSequenceName: 'Fragment 2',
          sourceStart: 0,
          sourceEnd: 40,
          sequence: 'CCCCCCCCCCCCCCCCCCCCTTTTTTTTTTTTTTTTTTTT',
          annotations: [],
        },
      ],
      topology: 'linear',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 20,
      spacers: [],
      homologyRegions: [],
      designPrimers: [],
      selectedJunctionIndex: null,
      scrollToPosition: null,
      highlightRange: null,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const composed = getComposedSequence(design.regions);
    const result = computeDraftAssembly(design);

    console.log('\n' + '='.repeat(80));
    console.log('GIBSON ASSEMBLY - NO SPACERS - STEP BY STEP');
    console.log('='.repeat(80));

    console.log('\n--- STEP 1: COMPOSED SEQUENCE ---');
    console.log('Total length:', composed.length, 'bp');
    console.log('');
    console.log(
      'Position:  0         10        20        30        40        50        60        70'
    );
    console.log(
      '           |         |         |         |         |         |         |         |'
    );
    console.log('Sequence: ', composed);
    console.log('');
    console.log('Fragment 1: positions 0-39  (first 40bp)');
    console.log('Fragment 2: positions 40-79 (last 40bp)');
    console.log('Junction 0: at position 40 (between F1 end and F2 start)');

    console.log('\n--- STEP 2: HOMOLOGY REGION AT JUNCTION 0 ---');
    const hr = result.homologyRegions[0];
    console.log('Junction index:', hr.junctionIndex);
    console.log('Junction position:', hr.junctionPosition);
    console.log('Homology start:', hr.start);
    console.log('Homology end:', hr.end);
    console.log('onLeft:', hr.encoding?.onLeft, '(bases BEFORE junction in homology)');
    console.log('onRight:', hr.encoding?.onRight, '(bases AFTER junction in homology)');
    console.log('Total length:', hr.metadata?.sequence?.length);
    console.log('Homology sequence:', hr.metadata?.sequence);
    console.log('');
    console.log('Visual breakdown of homology region:');
    const onLeft = hr.encoding?.onLeft ?? 0;
    const onRight = hr.encoding?.onRight ?? 0;
    const hrSeq = hr.metadata?.sequence ?? '';
    console.log('  Left portion (onLeft=' + onLeft + '):', hrSeq.slice(0, onLeft));
    console.log('  Right portion (onRight=' + onRight + '):', hrSeq.slice(onLeft));
    console.log('');
    console.log('In composed sequence context:');
    console.log('  Positions', hr.start, 'to', hr.junctionPosition, '= left portion (from F1 end)');
    console.log(
      '  Positions',
      hr.junctionPosition,
      'to',
      hr.end,
      '= right portion (from F2 start)'
    );

    console.log('\n--- STEP 3: PRIMERS ---');
    const f1Primers = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    const f2Primers = result.designPrimers.find((p) => p.fragmentIndex === 1)!;

    console.log('\nFragment 1 primers:');
    console.log('  F1-fwd:');
    console.log('    Full sequence:', f1Primers.forward.sequence);
    console.log(
      '    Junction index:',
      f1Primers.forward.junctionIndex,
      '(null = no left junction for first fragment in linear)'
    );
    console.log('    Overhang:', f1Primers.forward.overhang.sequence || '(none)');
    console.log('    PBS positions:', f1Primers.forward.pbs.start, '-', f1Primers.forward.pbs.end);
    console.log('    PBS sequence:', f1Primers.forward.pbs.sequence);
    console.log('');
    console.log('  F1-rev:');
    console.log('    Full sequence:', f1Primers.reverse.sequence);
    console.log('    Junction index:', f1Primers.reverse.junctionIndex);
    console.log('    Overhang:', f1Primers.reverse.overhang.sequence);
    console.log('    Overhang length:', f1Primers.reverse.overhang.length);
    console.log('    PBS positions:', f1Primers.reverse.pbs.start, '-', f1Primers.reverse.pbs.end);
    console.log('    PBS sequence:', f1Primers.reverse.pbs.sequence);

    console.log('\nFragment 2 primers:');
    console.log('  F2-fwd:');
    console.log('    Full sequence:', f2Primers.forward.sequence);
    console.log('    Junction index:', f2Primers.forward.junctionIndex);
    console.log('    Overhang:', f2Primers.forward.overhang.sequence);
    console.log('    Overhang length:', f2Primers.forward.overhang.length);
    console.log('    PBS positions:', f2Primers.forward.pbs.start, '-', f2Primers.forward.pbs.end);
    console.log('    PBS sequence:', f2Primers.forward.pbs.sequence);
    console.log('');
    console.log('  F2-rev:');
    console.log('    Full sequence:', f2Primers.reverse.sequence);
    console.log(
      '    Junction index:',
      f2Primers.reverse.junctionIndex,
      '(null = no right junction for last fragment in linear)'
    );
    console.log('    Overhang:', f2Primers.reverse.overhang.sequence || '(none)');
    console.log('    PBS positions:', f2Primers.reverse.pbs.start, '-', f2Primers.reverse.pbs.end);
    console.log('    PBS sequence:', f2Primers.reverse.pbs.sequence);

    console.log('\n--- STEP 4: PCR PRODUCTS ---');
    console.log('\nHow primers work:');
    console.log("  Forward primer: 5'-[overhang][PBS]-3'");
    console.log('    - PBS binds to Crick strand (complement of Watson)');
    console.log('    - Extension goes rightward on Watson strand');
    console.log("    - Overhang becomes 5' end of new Watson strand");
    console.log('');
    console.log("  Reverse primer: 5'-[overhang][PBS]-3'");
    console.log('    - PBS binds to Watson strand');
    console.log('    - Extension goes leftward on Crick strand');
    console.log("    - Overhang becomes 5' end of new Crick strand");
    console.log('');

    console.log('Fragment 1 PCR product (Watson strand):');
    const f1FwdOH = f1Primers.forward.overhang.sequence || '';
    const f1Template = composed.slice(f1Primers.forward.pbs.start, f1Primers.reverse.pbs.end);
    const f1RevOH = f1Primers.reverse.overhang.sequence;
    const f1RevOH_onWatson = reverseComplement(f1RevOH);
    console.log(
      "  5'-[" +
        (f1FwdOH || 'no overhang') +
        '][template: ' +
        f1Template +
        '][' +
        f1RevOH_onWatson +
        "]-3'"
    );
    console.log('');
    console.log('  Breakdown:');
    console.log("    F1-fwd overhang at 5' end:", f1FwdOH || '(none)');
    console.log('    Template region (F1):', f1Template);
    console.log("    F1-rev overhang becomes RC at 3' end:", f1RevOH_onWatson);
    console.log('    F1-rev overhang (actual oligo):', f1RevOH);

    console.log('\nFragment 2 PCR product (Watson strand):');
    const f2FwdOH = f2Primers.forward.overhang.sequence;
    const f2Template = composed.slice(f2Primers.forward.pbs.start, f2Primers.reverse.pbs.end);
    const f2RevOH = f2Primers.reverse.overhang.sequence || '';
    const f2RevOH_onWatson = f2RevOH ? reverseComplement(f2RevOH) : '';
    console.log(
      "  5'-[" +
        f2FwdOH +
        '][template: ' +
        f2Template +
        '][' +
        (f2RevOH_onWatson || 'no overhang') +
        "]-3'"
    );
    console.log('');
    console.log('  Breakdown:');
    console.log("    F2-fwd overhang at 5' end:", f2FwdOH);
    console.log('    Template region (F2):', f2Template);
    console.log("    F2-rev overhang becomes RC at 3' end:", f2RevOH_onWatson || '(none)');

    console.log('\n--- STEP 5: GIBSON ASSEMBLY MECHANISM ---');
    console.log('');
    console.log('IMPORTANT: Overhangs do NOT need to be reverse complements of each other!');
    console.log('');
    console.log('F1-rev overhang (actual oligo):', f1RevOH);
    console.log('  - This represents RC of positions 40-47 (right part of homology)');
    console.log("  - It extends F1's Crick strand past the template");
    console.log('');
    console.log('F2-fwd overhang:', f2FwdOH);
    console.log('  - This represents positions 33-39 (left part of homology)');
    console.log("  - It extends F2's Watson strand before the template");
    console.log('');

    console.log("After T5 exonuclease chews 5' ends:");
    console.log('');

    const f1Exposed3Watson = composed.slice(hr.start, hr.junctionPosition);
    console.log("F1 Watson 3' exposed: ...", f1Exposed3Watson, "-3'");
    console.log(
      '  (positions ' + hr.start + '-' + (hr.junctionPosition - 1) + ', left part of homology)'
    );

    const f2Exposed3Crick = reverseComplement(f2FwdOH);
    console.log("F2 Crick 3' exposed:  3'-", f2Exposed3Crick, '...');
    console.log('  (complement of F2-fwd overhang)');
    console.log('');

    console.log('Are these COMPLEMENTARY (for annealing)?');
    const areComplementary = f1Exposed3Watson === reverseComplement(f2Exposed3Crick);
    console.log('  f1Exposed3Watson:', f1Exposed3Watson);
    console.log('  RC(f2Exposed3Crick):', reverseComplement(f2Exposed3Crick));
    console.log('  Match:', areComplementary ? 'YES!' : 'NO');
    console.log('');

    console.log('Gibson assembly works because:');
    console.log("  1. T5 exonuclease chews back 5' ends of both strands");
    console.log("  2. F1's Crick 5' (overhang) is chewed → exposes Watson 3'");
    console.log("  3. F2's Watson 5' (overhang) is chewed → exposes Crick 3'");
    console.log("  4. F1 Watson 3' (" + f1Exposed3Watson + ') anneals with');
    console.log("     F2 Crick 3' (" + f2Exposed3Crick + ') via G-C base pairing');
    console.log('  5. Polymerase fills gaps, ligase seals nicks');

    console.log('\n' + '='.repeat(80));
    console.log("KEY INSIGHT: The EXPOSED 3' ends after T5 chewing are complementary");
    console.log("F1 Watson 3' (last bases of F1) pairs with F2 Crick 3' (RC of overhang)");
    console.log('');
    console.log('The overhangs themselves are NOT reverse complements of each other:');
    console.log('  F1-rev OH: ' + f1RevOH + ' (RC of right homology portion)');
    console.log('  F2-fwd OH: ' + f2FwdOH + ' (left homology portion directly)');
    console.log('='.repeat(80));

    expect(f1Exposed3Watson).toBe(f2FwdOH);
    expect(areComplementary).toBe(true);
  });
});
