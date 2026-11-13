import { describe, it, expect } from 'vitest';

function buildCircularDragSelection(
  anchor: number,
  position: number,
  cumulativeDelta: number
): { start: number; end: number; wraps?: boolean } {
  if (cumulativeDelta >= 0) {
    if (position >= anchor) {
      return { start: anchor, end: position };
    } else {
      return { start: anchor, end: position, wraps: true };
    }
  } else {
    const adjustedAnchor = position !== anchor && anchor > 0 ? anchor - 1 : anchor;
    if (position <= anchor) {
      if (position > adjustedAnchor) {
        return { start: adjustedAnchor, end: adjustedAnchor };
      }
      return { start: position, end: adjustedAnchor };
    } else {
      return { start: position, end: adjustedAnchor, wraps: true };
    }
  }
}

import { handleShiftClickNucleotide, handleOptionShiftClickNucleotide } from '../selection-model';

describe('Drag Selection Behavior - User Reported Issues', () => {
  describe('ISSUE: Backward drag should NOT include nucleotide at click position', () => {
    it('Click at 100, drag left to 90 - selection should be [90, 99] NOT [90, 100]', () => {
      const anchor = 100;
      const position = 90;
      const cumulativeDelta = -10;

      const result = buildCircularDragSelection(anchor, position, cumulativeDelta);
      console.log('Backward drag 100→90:', result);

      expect(result.start).toBe(90);
      expect(result.end).toBe(99);
    });

    it('Click at 100, drag left to 99 (minimal backward drag)', () => {
      const anchor = 100;
      const position = 99;
      const cumulativeDelta = -1;

      const result = buildCircularDragSelection(anchor, position, cumulativeDelta);
      console.log('Minimal backward drag 100→99:', result);

      expect(result.start).toBe(99);
      expect(result.end).toBe(99);
    });

    it('Forward drag still works: Click at 100, drag right to 110', () => {
      const anchor = 100;
      const position = 110;
      const cumulativeDelta = 10;

      const result = buildCircularDragSelection(anchor, position, cumulativeDelta);
      console.log('Forward drag 100→110:', result);

      expect(result.start).toBe(100);
      expect(result.end).toBe(110);
    });
  });

  describe('ISSUE: Circular wrapping from cursor - shift-click LEFT should wrap', () => {
    const SEQ_LEN = 10000;

    it('Cursor at 100, shift-click at 90 on CIRCULAR should create WRAPPING selection', () => {
      const result = handleShiftClickNucleotide(null, 90, 100, SEQ_LEN, true);
      console.log('Shift-click LEFT on circular (cursor 100 → click 90):', result);

      expect(result.start).toBe(100);
      expect(result.end).toBe(90);
      expect(result.wraps).toBe(true);
    });

    it('Cursor at 100, shift-click at 110 on CIRCULAR should NOT wrap', () => {
      const result = handleShiftClickNucleotide(null, 110, 100, SEQ_LEN, true);
      console.log('Shift-click RIGHT on circular (cursor 100 → click 110):', result);

      expect(result.start).toBe(100);
      expect(result.end).toBe(110);
      expect(result.wraps).toBeUndefined();
    });

    it('Cursor at 100, option+shift-click at 110 on CIRCULAR should create WRAPPING upstream selection', () => {
      const result = handleOptionShiftClickNucleotide(null, 110, 100, SEQ_LEN, true);
      console.log('Option+shift-click RIGHT on circular (cursor 100 → click 110):', result);

      expect(result.start).toBe(110);
      expect(result.end).toBe(100);
      expect(result.wraps).toBe(true);
    });
  });
});
