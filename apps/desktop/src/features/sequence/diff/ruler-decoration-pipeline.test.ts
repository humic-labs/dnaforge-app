// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { computeSequenceDiff } from './sequence-diff';
import { diffToDecorations } from './diff-decorations';
import type { RulerDecoration } from '@waypoint/workspace-editor';

async function pipeline(headSequence: string, currentSequence: string): Promise<RulerDecoration[]> {
  const diff = await computeSequenceDiff(headSequence, currentSequence);
  return diffToDecorations(diff);
}

function expectDecoration(
  decorations: RulerDecoration[],
  start: number,
  end: number,
  style: string,
  layer = 'git-diff'
) {
  const match = decorations.find(
    (d) => d.start === start && d.end === end && d.style === style && d.layer === layer
  );
  expect(
    match,
    `Expected ${style} decoration at ${start}-${end}, got: ${JSON.stringify(decorations)}`
  ).toBeTruthy();
}

describe('Ruler Decoration Pipeline', () => {
  describe('Level 1: Single operations', () => {
    it('identical sequences → no decorations', async () => {
      const decos = await pipeline('ATCGATCG', 'ATCGATCG');
      expect(decos).toHaveLength(0);
    });

    it('single insertion → green solid at insertion site', async () => {
      const decos = await pipeline('ATCGATCG', 'ATCGCCATCG');
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 4, 5, 'solid');
      expect(decos[0].color).toContain('152');
    });

    it('single deletion → red caret at deletion site', async () => {
      const decos = await pipeline('ATCGATCG', 'ATCGCG');
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 4, 4, 'caret');
      expect(decos[0].color).toContain('0');
    });

    it('single mutation → yellow solid at mutation site', async () => {
      const decos = await pipeline('ATCGATCG', 'ATCGGTCG');
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 4, 4, 'solid');
      expect(decos[0].color).toContain('42');
    });
  });

  describe('Level 2: Case sensitivity', () => {
    it('case change → detected as mutation', async () => {
      const decos = await pipeline('atcgatcg', 'ATCGATCG');
      expect(decos.length).toBeGreaterThan(0);
    });

    it('same case same content → no decorations', async () => {
      const decos = await pipeline('atcgatcg', 'atcgatcg');
      expect(decos).toHaveLength(0);
    });

    it('insertion preserving surrounding case', async () => {
      const decos = await pipeline('atcgatcg', 'atcgCCatcg');
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 4, 5, 'solid');
    });

    it('mixed case HEAD vs mixed case current → case changes detected', async () => {
      const decos = await pipeline('atcgATCG', 'ATCGatcg');
      expect(decos.length).toBeGreaterThan(0);
    });
  });

  describe('Level 3: Multiple scattered edits', () => {
    it('two insertions at different locations → two separate green bars', async () => {
      const decos = await pipeline('AAAAABBBBBCCCCC', 'AAAAAXBBBBBYCCCCC');
      expect(decos).toHaveLength(2);
      expectDecoration(decos, 5, 5, 'solid');
      expectDecoration(decos, 11, 11, 'solid');
    });

    it('insertion + deletion at different locations → green + red', async () => {
      const decos = await pipeline('AAAAAXBBBBBCCCCC', 'AAAAABBBBBYCCCCC');
      expect(decos).toHaveLength(2);
      const del = decos.find((d) => d.style === 'caret');
      expect(del).toBeTruthy();
      const ins = decos.find((d) => d.style === 'solid');
      expect(ins).toBeTruthy();
    });

    it('three insertions → three separate green bars', async () => {
      const decos = await pipeline('AAABBBCCC', 'AAAXBBBYCCCZ');
      expect(decos).toHaveLength(3);
    });
  });

  describe('Level 4: Post-save scenarios', () => {
    it('saved file with insertion vs HEAD → decoration persists', async () => {
      const head = 'ATCGATCGATCGATCGATCG';
      const saved = 'ATCGATCGATNNNCGATCGATCG';
      const decos = await pipeline(head, saved);
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 10, 12, 'solid');
    });

    it('two saved edits at different locations', async () => {
      const head = 'ATCGATCGATCGATCGATCG';
      const saved = 'ATCGNNATCGATCGAANNTCG';
      const decos = await pipeline(head, saved);
      expect(decos.length).toBeGreaterThanOrEqual(2);
      const totalMarkedBases = decos.reduce((sum, d) => sum + (d.end - d.start + 1), 0);
      expect(totalMarkedBases).toBeLessThan(15);
    });

    it('saved substitution → yellow mark', async () => {
      const head = 'ATCGATCG';
      const saved = 'ATCGGTCG';
      const decos = await pipeline(head, saved);
      expect(decos).toHaveLength(1);
      expect(decos[0].color).toContain('42');
    });
  });

  describe('Level 5: Edge cases', () => {
    it('insertion at very start of sequence', async () => {
      const decos = await pipeline('ATCG', 'NNATCG');
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 0, 1, 'solid');
    });

    it('insertion at very end of sequence', async () => {
      const decos = await pipeline('ATCG', 'ATCGNN');
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 4, 5, 'solid');
    });

    it('empty HEAD → entire sequence is insertion', async () => {
      const decos = await pipeline('', 'ATCG');
      expect(decos).toHaveLength(1);
      expect(decos[0].start).toBe(0);
      expect(decos[0].end).toBe(3);
    });

    it('large sequence with small edit → only edit marked', async () => {
      const head = 'A'.repeat(10000);
      const current = 'A'.repeat(5000) + 'NNN' + 'A'.repeat(5000);
      const decos = await pipeline(head, current);
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 5000, 5002, 'solid');
    });

    it('real-world: 78k sequence with 3-base insertion', async () => {
      const head = 'a'.repeat(78339);
      const current = 'a'.repeat(50) + 'nnn' + 'a'.repeat(78289);
      const decos = await pipeline(head, current);
      expect(decos).toHaveLength(1);
      expectDecoration(decos, 50, 52, 'solid');
    });
  });
});
