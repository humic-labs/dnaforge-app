import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SequenceContextMenu } from '@waypoint/ui-components';

const baseProps = {
  x: 100,
  y: 100,
  isOpen: true,
  onClose: vi.fn(),
  clickedORF: {
    start: 100,
    end: 400,
    strand: '+' as const,
    frame: 1,
    length: 301,
  },
};

describe('SequenceContextMenu — alignment-mode ORF disable', () => {
  it('shows "Add ORF as CDS" when not in alignment mode', () => {
    render(
      <SequenceContextMenu {...baseProps} onSaveORFAsAnnotation={vi.fn()} inAlignmentMode={false} />
    );
    expect(screen.queryByText(/add orf as cds/i)).not.toBeNull();
  });

  it('hides "Add ORF as CDS" when in alignment mode', () => {
    render(
      <SequenceContextMenu {...baseProps} onSaveORFAsAnnotation={vi.fn()} inAlignmentMode={true} />
    );
    expect(screen.queryByText(/add orf as cds/i)).toBeNull();
  });

  it('falls back to "Select sequence first" hint when ORF is the only target in alignment mode', () => {
    render(
      <SequenceContextMenu {...baseProps} onSaveORFAsAnnotation={vi.fn()} inAlignmentMode={true} />
    );
    expect(screen.getByText(/select sequence first/i)).toBeDefined();
  });
});
