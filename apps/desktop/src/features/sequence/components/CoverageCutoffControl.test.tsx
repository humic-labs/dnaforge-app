import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CoverageCutoffControl } from './CoverageCutoffControl';

function PairedCoverage() {
  const [rna, setRna] = useState(10);
  const [dna, setDna] = useState(20);
  return (
    <>
      <CoverageCutoffControl trackId="rna" label="RNA" value={rna} onChange={setRna} />
      <CoverageCutoffControl trackId="dna" label="DNA" value={dna} onChange={setDna} />
    </>
  );
}

function commitDepth(label: string, value: string) {
  const input = screen.getByRole('spinbutton', { name: `Exact coverage cutoff for ${label}` });
  input.focus();
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('CoverageCutoffControl exact depth', () => {
  it('sets paired RNA and DNA tracks to the same absolute cutoff without changing the other track', () => {
    render(<PairedCoverage />);
    commitDepth('RNA', '40');
    expect(screen.getByRole('slider', { name: 'Coverage cutoff for RNA' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Manual cutoff 40×')
    );
    expect(screen.getByRole('spinbutton', { name: 'Exact coverage cutoff for DNA' })).toHaveValue(
      20
    );
    commitDepth('DNA', '40');
    expect(screen.getByRole('slider', { name: 'Coverage cutoff for DNA' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Manual cutoff 40×')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use automatic coverage cutoff for RNA' }));
    expect(
      screen.getByRole('button', { name: 'Use automatic coverage cutoff for RNA' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('spinbutton', { name: 'Exact coverage cutoff for DNA' })).toHaveValue(
      40
    );
  });

  it('commits an exact high-depth cutoff beyond the initial source range on blur', () => {
    render(<PairedCoverage />);
    const input = screen.getByRole('spinbutton', { name: 'Exact coverage cutoff for RNA' });
    fireEvent.change(input, { target: { value: '250000' } });
    fireEvent.blur(input);
    expect(screen.getByRole('slider', { name: 'Coverage cutoff for RNA' })).toHaveAttribute(
      'aria-valuetext',
      'Manual cutoff 250,000×; range 1× to 250,000×'
    );
  });

  it.each(['', '0', '-1', '1.5', '1000000001'])(
    'restores the committed cutoff for invalid input %s',
    (draft) => {
      render(<PairedCoverage />);
      commitDepth('RNA', draft);
      expect(screen.getByRole('spinbutton', { name: 'Exact coverage cutoff for RNA' })).toHaveValue(
        10
      );
      expect(screen.getByRole('slider', { name: 'Coverage cutoff for RNA' })).toHaveAttribute(
        'aria-valuetext',
        expect.stringContaining('Manual cutoff 10×')
      );
    }
  );

  it('cancels an uncommitted cutoff on Escape without committing through blur', () => {
    render(<PairedCoverage />);
    const input = screen.getByRole('spinbutton', { name: 'Exact coverage cutoff for RNA' });
    input.focus();
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue(10);
    expect(input).not.toHaveFocus();
    expect(screen.getByRole('slider', { name: 'Coverage cutoff for RNA' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Manual cutoff 10×')
    );
  });
});
