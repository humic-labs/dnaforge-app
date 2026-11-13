import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { AnnotationsDrawerContent } from './annotations-drawer';

const annotations = [
  { name: 'alpha', type: 'CDS', start: 10, end: 60, direction: 1 as const, color: '#888' },
  { name: 'beta', type: 'CDS', start: 100, end: 160, direction: 1 as const, color: '#888' },
  {
    name: 'gamma',
    type: 'misc_feature',
    start: 200,
    end: 260,
    direction: 1 as const,
    color: '#888',
  },
];

const base = {
  filePath: '/t.gb',
  annotations,
  circular: true,
  sequenceLength: 3000,
  onAnnotationClick: vi.fn(),
  onAnnotationSave: vi.fn(),
  onAnnotationDelete: vi.fn(),
  plannotateStatus: 'idle' as const,
  sequenceVersion: 0,
  activeTab: 'annotations' as const,
};

function openEditor(index: number): void {
  fireEvent.click(screen.getByTestId(`edit-icon-${index}`));
}

describe('AnnotationsDrawerContent — an abandoned edit names its row', () => {
  it('reports the row the user actually left, not the one now open', () => {
    const onAnnotationEditCancel = vi.fn();
    render(<AnnotationsDrawerContent {...base} onAnnotationEditCancel={onAnnotationEditCancel} />);

    openEditor(0);
    expect(onAnnotationEditCancel).not.toHaveBeenCalled();

    openEditor(1);
    expect(onAnnotationEditCancel).toHaveBeenCalledTimes(1);
    expect(onAnnotationEditCancel).toHaveBeenCalledWith(0);
  });

  it('does not fire at all when the first editor opens', () => {
    const onAnnotationEditCancel = vi.fn();
    render(<AnnotationsDrawerContent {...base} onAnnotationEditCancel={onAnnotationEditCancel} />);
    openEditor(1);
    expect(onAnnotationEditCancel).not.toHaveBeenCalled();
  });

  it('names the row when an edit is cancelled outright', () => {
    const onAnnotationEditCancel = vi.fn();
    render(<AnnotationsDrawerContent {...base} onAnnotationEditCancel={onAnnotationEditCancel} />);
    openEditor(2);
    const cancel = screen.getByLabelText('Cancel annotation edit');
    fireEvent.click(cancel);
    expect(onAnnotationEditCancel).toHaveBeenCalledWith(2);
  });
});
