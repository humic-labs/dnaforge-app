import { describe, expect, it } from 'vitest';
import { applySequenceStrandOverrides } from './sequence-strand-display';
import {
  assemblyScaffoldRulerTicks,
  assemblyScaffoldSelectionLength,
  createAssemblyScaffoldLayout,
  type AssemblyScaffold,
} from './assembly-scaffold';

const scaffold: AssemblyScaffold = {
  slotId: 'cds',
  slotIndex: 1,
  label: 'CDS',
  incomingOverhang: 'TATG',
  outgoingOverhang: 'ATCC',
};

describe('assembly display columns', () => {
  it.each([false, true])(
    'shows each empty-to-empty schema junction once (circular=%s)',
    (circular) => {
      const overhangs = ['TACT', 'AATG', 'AGGT', 'GCTT', 'GGAG'];
      const segments = overhangs.map((outgoingOverhang, slotIndex) => ({
        start: 0,
        end: 0,
        scaffold: {
          slotId: `slot-${slotIndex}`,
          slotIndex,
          label: `Part ${slotIndex + 1}`,
          incomingOverhang: slotIndex > 0 ? overhangs[slotIndex - 1] : circular ? 'GGAG' : null,
          outgoingOverhang,
        },
      }));
      const layout = createAssemblyScaffoldLayout(0, segments, circular);
      const display = layout.displaySequence('');
      const expected = segments
        .map(
          (segment, i) =>
            `${i > 0 || circular ? segment.scaffold.incomingOverhang : ''}.......... Part ${i + 1} ..........`
        )
        .join('');
      expect(
        applySequenceStrandOverrides(display, 0, display.length, layout.strandOverrides, 'forward')
      ).toBe(expected);
      expect(layout.junctions).toHaveLength(circular ? 5 : 4);
      expect(layout.junctions.map((junction) => junction.overhang)).toEqual(
        circular ? ['GGAG', 'TACT', 'AATG', 'AGGT', 'GCTT'] : ['TACT', 'AATG', 'AGGT', 'GCTT']
      );
      const bottom = applySequenceStrandOverrides(
        display,
        0,
        display.length,
        layout.strandOverrides,
        'reverse'
      );
      expect(bottom).toContain('ATGA.......... Part 2');
      expect(bottom).toContain('TTAC.......... Part 3');
      expect(display).toBe('.'.repeat(layout.displayLength));
      expect(
        assemblyScaffoldSelectionLength(display.length, layout.gaps, {
          start: 0,
          end: display.length - 1,
        })
      ).toBe(0);
    }
  );

  it('puts ten dots on both sides of the readable schema label on both strands', () => {
    const layout = createAssemblyScaffoldLayout(100, [{ start: 40, end: 40, scaffold }]);
    const text = '.......... CDS ..........';
    const source = 'A'.repeat(40) + 'C'.repeat(60);
    const display = layout.displaySequence(source);
    expect(layout.gaps[0]).toMatchObject({ start: 40, end: 40 + text.length });
    for (const strand of ['forward', 'reverse'] as const) {
      expect(
        applySequenceStrandOverrides(
          display,
          0,
          display.length,
          layout.strandOverrides,
          strand
        ).slice(40, 40 + text.length)
      ).toBe(text);
    }
    expect(display.replace(/\./g, '')).toBe(source);
    expect(display).not.toContain('CDS');
  });

  it('keeps exposed digest bases outside the ten-dot flanks and message', () => {
    const layout = createAssemblyScaffoldLayout(100, [
      {
        start: 40,
        end: 40,
        scaffold: {
          ...scaffold,
          exposedDigestEnds: { preceding: { overhang: 'TATG' }, following: { overhang: 'ATCC' } },
        },
      },
    ]);
    const display = layout.displaySequence('A'.repeat(40) + 'ATCC' + 'C'.repeat(56));
    const gap = layout.gaps[0];
    expect(
      applySequenceStrandOverrides(
        display,
        0,
        display.length,
        layout.strandOverrides,
        'forward'
      ).slice(gap.start, gap.end)
    ).toBe('    .......... CDS ..........');
    expect(
      applySequenceStrandOverrides(
        display,
        0,
        display.length,
        layout.strandOverrides,
        'reverse'
      ).slice(gap.start, gap.end + 4)
    ).toBe('ATAC.......... CDS ..........    ');
  });

  it('replaces an expected boundary with the physical digest end when its neighbor is filled', () => {
    const slots = [
      { start: 0, end: 0, scaffold: { ...scaffold, slotId: 'left', slotIndex: 0 } },
      { start: 0, end: 0, scaffold },
    ];
    expect(createAssemblyScaffoldLayout(0, slots).junctions).toMatchObject([
      { kind: 'schema', overhang: 'TATG' },
    ]);
    const filled = createAssemblyScaffoldLayout(30, [
      { start: 0, end: 30 },
      {
        start: 30,
        end: 30,
        scaffold: { ...scaffold, exposedDigestEnds: { preceding: { overhang: 'GCTT' } } },
      },
    ]);
    expect(filled.junctions).toMatchObject([{ kind: 'digest', overhang: 'GCTT' }]);
    expect(filled.strandOverrides.find((override) => override.kind !== 'label')).toEqual({
      start: 30,
      forward: '    ',
      reverse: 'CGAA',
    });
    const separated = createAssemblyScaffoldLayout(4, [
      slots[0],
      { start: 0, end: 4 },
      { ...slots[1], start: 4, end: 4 },
    ]);
    expect(separated.junctions).toEqual([]);
  });
  it('counts DNA across, within, and around circular scaffold gaps', () => {
    const gaps = [{ start: 2, end: 8 }];
    expect(assemblyScaffoldSelectionLength(10, gaps, { start: 0, end: 9 })).toBe(4);
    expect(assemblyScaffoldSelectionLength(10, gaps, { start: 3, end: 5 })).toBe(0);
    expect(assemblyScaffoldSelectionLength(10, gaps, { start: 9, end: 3, wraps: true })).toBe(3);
    expect(assemblyScaffoldSelectionLength(10, [{ start: 8, end: 2 }], { start: 0, end: 9 })).toBe(
      6
    );
  });
  it('does not label placeholders as base pairs on either ruler', () => {
    const segments = [{ start: 40, end: 64, scaffold }];
    expect(assemblyScaffoldRulerTicks(124, segments, 20)).toEqual([
      { position: 0, label: 0 },
      { position: 20, label: 20 },
      { position: 64, label: 40 },
      { position: 84, label: 60 },
      { position: 104, label: 80 },
    ]);
    expect(assemblyScaffoldRulerTicks(24, [{ start: 0, end: 24, scaffold }], 10)).toEqual([]);
  });
  it('inserts dots without replacing DNA and shifts every downstream coordinate', () => {
    const layout = createAssemblyScaffoldLayout(100, [{ start: 40, end: 40, scaffold }]);
    const width = layout.gaps[0].end - layout.gaps[0].start;
    expect(width).toBeGreaterThan(0);
    expect(layout.displaySequence('A'.repeat(40) + 'C'.repeat(60))).toBe(
      'A'.repeat(40) + '.'.repeat(width) + 'C'.repeat(60)
    );
    expect(layout.sourceToDisplay(39)).toBe(39);
    expect(layout.sourceToDisplay(40)).toBe(40 + width);
    expect(layout.sourceToDisplay(99)).toBe(99 + width);
    expect(layout.displayToSource(40 + width)).toBe(40);
    expect(layout.gapAt(45)?.scaffold.slotId).toBe('cds');
    expect(layout.gapAt(40 + width)).toBeUndefined();
  });

  it('keeps adjacent empty slots distinct even at the same biological boundary', () => {
    const layout = createAssemblyScaffoldLayout(
      0,
      [0, 1, 2].map((i) => ({
        start: 0,
        end: 0,
        scaffold: { ...scaffold, slotIndex: i, slotId: `slot-${i}` },
      }))
    );
    expect(layout.displaySequence('')).toBe('.'.repeat(layout.displayLength));
    expect(layout.gaps).toHaveLength(3);
    expect(layout.gaps[1].start).toBe(layout.gaps[0].end);
    expect(layout.gaps[2].start).toBe(layout.gaps[1].end);
  });

  it('keeps the message compact regardless of construct length and round trips every real base', () => {
    for (const length of [4, 100, 100000]) {
      const anchor = Math.floor(length / 2);
      const layout = createAssemblyScaffoldLayout(length, [
        { start: anchor, end: anchor, scaffold },
      ]);
      expect(layout.displayLength - length).toBe('.......... CDS ..........'.length);
      for (const i of [0, anchor - 1, anchor, length - 1]) {
        expect(layout.displayToSource(layout.sourceToDisplay(i))).toBe(i);
      }
    }
  });

  it('shifts downstream coordinates by each adjacent label’s own width', () => {
    const layout = createAssemblyScaffoldLayout(100, [
      { start: 40, end: 40, scaffold },
      {
        start: 40,
        end: 40,
        scaffold: { ...scaffold, slotId: 'long', slotIndex: 2, label: 'Long coding sequence' },
      },
    ]);
    const width =
      '.......... CDS ..........'.length + 4 + '.......... Long coding sequence ..........'.length;
    expect(layout.sourceToDisplay(40)).toBe(40 + width);
    expect(layout.displayToSource(40 + width)).toBe(40);
    expect(layout.gaps[1].start).toBe(layout.gaps[0].end);
  });
});
