// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeDraftAssembly, reverseComplement } from './algorithms/draft-assembly';
import { getComposedSequence } from './types';
import type { SequenceDesign } from './types';

describe('All Primers with Spacer', () => {
  it('shows all four primers for a 2-fragment assembly with spacer', () => {
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

    console.log('\n' + '='.repeat(80));
    console.log('ALL PRIMERS WITH 10bp SPACER');
    console.log('='.repeat(80));

    console.log('\n--- COMPOSED SEQUENCE ---');
    console.log('Length:', composed.length, 'bp');
    console.log('F1 (0-31):', composed.slice(0, 32));
    console.log('Spacer (32-41):', composed.slice(32, 42));
    console.log('F2 (42-73):', composed.slice(42, 74));

    console.log('\n--- HOMOLOGY REGION ---');
    const hr = result.homologyRegions[0];
    console.log('Junction position:', hr.junctionPosition);
    console.log('Homology start-end:', hr.start, '-', hr.end);
    console.log('onLeft:', hr.encoding?.onLeft, 'onRight:', hr.encoding?.onRight);
    console.log('Sequence:', hr.metadata?.sequence);

    console.log('\n--- ALL PRIMERS ---');

    for (const pair of result.designPrimers) {
      const frag = pair.fragmentIndex + 1;
      const fwd = pair.forward;
      const rev = pair.reverse;

      console.log(`\nFragment ${frag}:`);

      console.log(`  F${frag}-fwd:`);
      console.log(`    Full: ${fwd.sequence}`);
      console.log(`    PBS:  ${fwd.pbs.sequence} (pos ${fwd.pbs.start}-${fwd.pbs.end})`);
      console.log(`    OH:   ${fwd.overhang.sequence || '(none)'} (${fwd.overhang.length}bp)`);
      console.log(`    Spacer in OH: ${fwd.overhang.spacerSequence || '(none)'}`);
      console.log(`    Junction: ${fwd.junctionIndex ?? 'null'}`);

      console.log(`  F${frag}-rev:`);
      console.log(`    Full: ${rev.sequence}`);
      console.log(`    PBS:  ${rev.pbs.sequence} (pos ${rev.pbs.start}-${rev.pbs.end})`);
      console.log(`    OH:   ${rev.overhang.sequence || '(none)'} (${rev.overhang.length}bp)`);
      console.log(`    Spacer in OH: ${rev.overhang.spacerSequence || '(none)'}`);
      console.log(`    Junction: ${rev.junctionIndex ?? 'null'}`);
    }

    const f1 = result.designPrimers.find((p) => p.fragmentIndex === 0)!;
    console.log('\n--- VERIFICATION ---');

    console.log('\nF1-fwd: No junction (first fragment in linear)');
    expect(f1.forward.junctionIndex).toBeNull();
    expect(f1.forward.overhang.sequence).toBe('');

    console.log('F1-rev: Junction 0 with spacer');
    expect(f1.reverse.junctionIndex).toBe(0);
    expect(f1.reverse.overhang.sequence.length).toBeGreaterThan(0);
    const spacerRC = reverseComplement('AAAAAAAAAA');
    expect(f1.reverse.overhang.sequence).toContain(spacerRC);
    expect(f1.reverse.overhang.spacerSequence).toBe(spacerRC);
    console.log(`  ✓ Overhang contains spacer RC: ${spacerRC}`);

    const f2 = result.designPrimers.find((p) => p.fragmentIndex === 1)!;

    console.log('\nF2-fwd: Junction 0 with spacer');
    expect(f2.forward.junctionIndex).toBe(0);
    expect(f2.forward.overhang.sequence.length).toBeGreaterThan(0);
    expect(f2.forward.overhang.sequence).toContain('AAAAAAAAAA');
    expect(f2.forward.overhang.spacerSequence).toBe('AAAAAAAAAA');
    console.log(`  ✓ Overhang contains spacer: AAAAAAAAAA`);

    console.log('\nF2-rev: No junction (last fragment in linear)');
    expect(f2.reverse.junctionIndex).toBeNull();
    expect(f2.reverse.overhang.sequence).toBe('');

    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY: All primers computed correctly!');
    console.log('- F1-fwd: No overhang (first fragment)');
    console.log('- F1-rev: Overhang with spacer RC + onRight RC');
    console.log('- F2-fwd: Overhang with onLeft (includes spacer)');
    console.log('- F2-rev: No overhang (last fragment)');
    console.log('='.repeat(80));
  });
});
