/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { SequenceContextMenu } from '@waypoint/ui-components';
import { describe, expect, it, vi } from 'vitest';

describe('SequenceContextMenu assembly paste target', () => {
  it('names the copied fragment without making the action label verbose', () => {
    const onPaste = vi.fn();

    render(
      <SequenceContextMenu
        x={0}
        y={0}
        isOpen
        onClose={() => {}}
        onPaste={onPaste}
        pasteTargetLabel="PCR · pUC19 PCR fragment · 380 bp"
      />
    );

    const paste = screen.getByRole('menuitem', {
      name: 'Paste (PCR · pUC19 PCR fragment · 380 bp)',
    });
    expect(paste).toHaveTextContent('Paste');
    expect(paste).toHaveTextContent('PCR · pUC19 PCR fragment · 380 bp');

    fireEvent.mouseDown(paste);
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it('keeps a short generic action when rich clipboard metadata is unavailable', () => {
    render(<SequenceContextMenu x={0} y={0} isOpen onClose={() => {}} onPaste={vi.fn()} />);

    expect(screen.getByRole('menuitem', { name: 'Paste' })).toBeInTheDocument();
    expect(screen.queryByText('Paste Region')).not.toBeInTheDocument();
  });
});
