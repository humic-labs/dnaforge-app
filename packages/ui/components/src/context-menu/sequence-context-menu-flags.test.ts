import { describe, expect, it, vi } from 'vitest';
import { sequenceContextMenuFlags } from './sequence-context-menu-flags';

describe('sequenceContextMenuFlags', () => {
  it('treats an explicit hasSelection prop as selected even without sequence text', () => {
    const flags = sequenceContextMenuFlags({
      x: 0,
      y: 0,
      isOpen: true,
      onClose: vi.fn(),
      hasSelection: true,
      onAskAI: vi.fn(),
    });
    expect(flags.hasSelection).toBe(true);
    expect(flags.hasAskAiAction).toBe(true);
    expect(flags.showEmptyHint).toBe(false);
  });

  it('shows the empty hint when there is no selection and no other actions', () => {
    const flags = sequenceContextMenuFlags({
      x: 0,
      y: 0,
      isOpen: true,
      onClose: vi.fn(),
      hasSelection: false,
    });
    expect(flags.showEmptyHint).toBe(true);
    expect(flags.hasAskAiAction).toBe(false);
  });

  it('hides Add ORF as CDS in alignment mode', () => {
    const flags = sequenceContextMenuFlags({
      x: 0,
      y: 0,
      isOpen: true,
      onClose: vi.fn(),
      clickedORF: { start: 1, end: 30, strand: '+', frame: 0, length: 30 },
      onSaveORFAsAnnotation: vi.fn(),
      inAlignmentMode: true,
    });
    expect(flags.hasSaveOrfAction).toBe(false);
  });
});
