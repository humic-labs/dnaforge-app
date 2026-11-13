// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  selectionToHighlightGroup,
  HIGHLIGHT_PALETTE,
  resolveHighlightGroupColor,
} from './highlightUtils';
import type { ResidueLocation, HighlightGroup } from '../types';

describe('highlightUtils', () => {
  describe('selectionToHighlightGroup', () => {
    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    });

    it('should return null for empty selection', () => {
      expect(selectionToHighlightGroup([], 'Test')).toBeNull();
    });

    it('should create highlight group from single residue', () => {
      const selected: ResidueLocation[] = [{ chain: 'A', position: 10 }];
      const result = selectionToHighlightGroup(selected, 'Active Site');

      expect(result).toEqual({
        id: 'highlight-1234567890',
        label: 'Active Site',
        selections: [{ chain: 'A', ranges: [[10, 10]] }],
        color: '#22c55e',
        visible: false,
      });
    });

    it('should merge consecutive residues into range', () => {
      const selected: ResidueLocation[] = [
        { chain: 'A', position: 10 },
        { chain: 'A', position: 11 },
        { chain: 'A', position: 12 },
      ];
      const result = selectionToHighlightGroup(selected, 'Helix');

      expect(result?.selections).toEqual([{ chain: 'A', ranges: [[10, 12]] }]);
    });

    it('should handle non-consecutive residues', () => {
      const selected: ResidueLocation[] = [
        { chain: 'A', position: 10 },
        { chain: 'A', position: 12 },
        { chain: 'A', position: 15 },
      ];
      const result = selectionToHighlightGroup(selected, 'Scattered');

      expect(result?.selections).toEqual([
        {
          chain: 'A',
          ranges: [
            [10, 10],
            [12, 12],
            [15, 15],
          ],
        },
      ]);
    });

    it('should group by chain for multi-chain selections', () => {
      const selected: ResidueLocation[] = [
        { chain: 'A', position: 10 },
        { chain: 'B', position: 20 },
        { chain: 'A', position: 11 },
        { chain: 'B', position: 21 },
      ];
      const result = selectionToHighlightGroup(selected, 'Interface');

      expect(result?.selections).toHaveLength(2);

      const chainA = result?.selections.find((s) => s.chain === 'A');
      const chainB = result?.selections.find((s) => s.chain === 'B');

      expect(chainA?.ranges).toEqual([[10, 11]]);
      expect(chainB?.ranges).toEqual([[20, 21]]);
    });

    it('uses one canonical green for saved selections regardless of existing groups', () => {
      const selected: ResidueLocation[] = [{ chain: 'A', position: 10 }];

      const result1 = selectionToHighlightGroup(selected, 'First');
      expect(result1?.color).toBe('#22c55e');

      const existing1: HighlightGroup[] = [
        { id: '1', label: 'Existing', selections: [], color: '#000', visible: true },
      ];
      const result2 = selectionToHighlightGroup(selected, 'Second', existing1);
      expect(result2?.color).toBe('#22c55e');

      const existingFull: HighlightGroup[] = HIGHLIGHT_PALETTE.map((_, i) => ({
        id: String(i),
        label: `Group ${i}`,
        selections: [],
        color: HIGHLIGHT_PALETTE[i],
        visible: false,
      }));
      const resultWrap = selectionToHighlightGroup(selected, 'Wrap', existingFull);
      expect(resultWrap?.color).toBe('#22c55e');
    });

    it('should default to visible: false', () => {
      const selected: ResidueLocation[] = [{ chain: 'A', position: 10 }];
      const result = selectionToHighlightGroup(selected, 'Test');
      expect(result?.visible).toBe(false);
    });

    it('should generate unique ID from timestamp', () => {
      const selected: ResidueLocation[] = [{ chain: 'A', position: 10 }];
      const result = selectionToHighlightGroup(selected, 'Test');
      expect(result?.id).toBe('highlight-1234567890');
    });
  });

  describe('HIGHLIGHT_PALETTE', () => {
    it('should export color palette', () => {
      expect(HIGHLIGHT_PALETTE).toBeDefined();
      expect(HIGHLIGHT_PALETTE.length).toBeGreaterThan(0);
    });

    it('should contain valid hex colors', () => {
      for (const color of HIGHLIGHT_PALETTE) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
  });

  describe('resolveHighlightGroupColor', () => {
    it('uses one deterministic non-gray color for legacy groups without a color', () => {
      const legacy: HighlightGroup = {
        id: 'agent-highlight:turn-42',
        label: 'Returned by the agent',
        selections: [{ chain: 'A', ranges: [[86, 109]] }],
      };

      const first = resolveHighlightGroupColor(legacy);
      const second = resolveHighlightGroupColor({ ...legacy });

      expect(first).toBe(second);
      expect(HIGHLIGHT_PALETTE).toContain(first);
      expect(first.toLowerCase()).not.toBe('#888888');
    });

    it('preserves a valid explicit color', () => {
      expect(
        resolveHighlightGroupColor({
          id: 'selection-1',
          label: 'Explicit',
          selections: [],
          color: '#12AbEf',
        })
      ).toBe('#12abef');
    });
  });
});
