// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResidueBox } from './ResidueBox';

function renderBox(props: Partial<React.ComponentProps<typeof ResidueBox>> = {}) {
  const defaults = {
    residue: { position: 1, name: 'M', name3: 'MET' },
    chainId: 'A',
    colorMode: 'chain' as const,
    isHovered: false,
    isSelected: false,
    onHover: vi.fn(),
    onSelect: vi.fn(),
  };
  return render(<ResidueBox {...defaults} {...props} />);
}

describe('ResidueBox monomer width', () => {
  it('draws an amino acid in exactly the historical 7px box', () => {
    renderBox({ residue: { position: 1, name: 'M', name3: 'MET' } });
    const box = screen.getByTestId('residue-A-1');
    expect(box.style.width).toBe('7px');
    expect(box).toHaveClass('rounded-none');
    expect(box).not.toHaveClass('px-1');
    expect(box.style.backgroundColor).toBe('transparent');
    expect(box.getAttribute('data-comp-id')).toBeNull();
  });

  it('gives a deoxynucleotide room for both of its characters', () => {
    renderBox({
      residue: { position: 5, name: 'A', displayLabel: 'dA', name3: 'DA' },
    });
    const box = screen.getByTestId('residue-A-5');
    expect(box.style.width).toBe('13px');
    expect(box).toHaveTextContent('dA');
  });

  it('draws the display label while keeping the one-letter sequence code intact', () => {
    renderBox({
      residue: { position: 5, name: 'A', displayLabel: 'dA', name3: 'DA' },
    });
    const box = screen.getByTestId('residue-A-5');
    expect(box).toHaveTextContent('dA');
    expect(box.getAttribute('data-residue-name')).toBe('A');
    expect(box.getAttribute('data-residue-name3')).toBe('DA');
  });

  it('keeps a two-character ligand id as a ligand', () => {
    renderBox({
      entryKind: 'ligand',
      residue: { position: 301, name: 'ZN', name3: 'ZN' },
      chainColor: '#1f77ff',
    });
    const box = screen.getByTestId('residue-A-301');
    expect(box.getAttribute('data-comp-id')).toBe('ZN');
    expect(box).toHaveClass('rounded-sm');
    expect(box).toHaveClass('px-1');
    expect(box.style.backgroundColor).not.toBe('transparent');
  });

  it('leaves the ligand branch content-sized, with no width and no min-width', () => {
    renderBox({
      entryKind: 'ligand',
      residue: { position: 401, name: 'HEM', name3: 'HEM' },
    });
    const box = screen.getByTestId('residue-A-401');
    expect(box.style.width).toBe('');
    expect(box.style.minWidth).toBe('');
  });

  it('still treats a three-character label as a polymer unless the caller says otherwise', () => {
    renderBox({ residue: { position: 7, name: 'X', displayLabel: 'XYZ', name3: 'XYZ' } });
    const box = screen.getByTestId('residue-A-7');
    expect(box.getAttribute('data-comp-id')).toBeNull();
    expect(box).toHaveClass('rounded-none');
    expect(box.style.width).toBe('19px');
  });

  it('sizes from the glyph actually drawn, not from the residue name', () => {
    renderBox({
      residue: { position: 9, name: 'A', displayLabel: 'dA', name3: 'DA' },
      displayOneLetterCode: 'A',
    });
    const box = screen.getByTestId('residue-A-9');
    expect(box).toHaveTextContent('A');
    expect(box.style.width).toBe('7px');
  });
});
