import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SaturationLibraryPanel } from './SaturationLibraryPanel';

const reference = 'ACGTTGCAACGTTGCAACGT' + 'ATGGCTTGGCCG' + 'ACGTTGCAACGTTGCAACGT';

function enterBounds() {
  fireEvent.change(screen.getByLabelText('CDS start (1-based)'), { target: { value: '21' } });
  fireEvent.change(screen.getByLabelText('CDS end (inclusive)'), { target: { value: '32' } });
  fireEvent.change(screen.getByLabelText('Last residue'), { target: { value: '4' } });
}

describe('SaturationLibraryPanel', () => {
  it('generates and copies every pair, and replaces stale results after invalid edits', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<SaturationLibraryPanel referenceSequence={reference} />);
    expect(screen.queryByLabelText('Oligo table (TSV)')).toBeNull();
    enterBounds();
    expect(screen.getByText(/4 residues, 8 oligos/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Copy oligo table' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0].split('\n')).toHaveLength(9);
    expect(writeText.mock.calls[0][0]).toContain('M1_NNK_F');
    fireEvent.change(screen.getByLabelText('Degenerate codon'), { target: { value: 'NNS' } });
    expect(screen.getByLabelText('Oligo table (TSV)')).toHaveDisplayValue(/M1_NNS_F/);
    fireEvent.change(screen.getByLabelText('CDS end (inclusive)'), { target: { value: '33' } });
    expect(screen.getByRole('alert')).toHaveTextContent('multiple of three');
    expect(screen.queryByLabelText('Oligo table (TSV)')).toBeNull();
  });

  it('reports clipboard failure while retaining the manually copyable table', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    render(<SaturationLibraryPanel referenceSequence={reference} />);
    enterBounds();
    fireEvent.click(screen.getByRole('button', { name: 'Copy oligo table' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('copy it manually'));
    expect(screen.getByLabelText('Oligo table (TSV)')).toBeDefined();
  });
});
