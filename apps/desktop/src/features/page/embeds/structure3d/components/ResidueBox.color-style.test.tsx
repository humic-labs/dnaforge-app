import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResidueBox } from './ResidueBox';

function renderBox(color: number, isSelected = false, isHovered = false) {
  return render(
    <ResidueBox
      residue={{ position: 1, name: 'M', name3: 'MET', coloration: { kind: 'uniform', color } }}
      chainId="A"
      colorMode="bfactor"
      isHovered={isHovered}
      isSelected={isSelected}
      onHover={vi.fn()}
      onSelect={vi.fn()}
    />
  );
}

describe('sequence residue color tiles ', () => {
  it('fills a square tile with the residue color and picks a contrasting letter', () => {
    const { unmount } = renderBox(0xf7f7f7);
    const tile = screen.getByTestId('residue-color-tile');
    expect(tile.style.backgroundColor).toBe('rgb(247, 247, 247)');
    expect(tile.style.borderRadius).toBe('0');
    expect(screen.getByTestId('residue-label').style.color).toBe('rgb(0, 0, 0)');
    unmount();
    renderBox(0x2166ac);
    expect(screen.getByTestId('residue-label').style.color).toBe('rgb(255, 255, 255)');
  });

  it('keeps the selection frame drawn above the tile', () => {
    renderBox(0xb2182b, true);
    const box = screen.getByTestId('residue-A-1');
    const children = Array.from(box.children);
    expect(children.indexOf(screen.getByTestId('residue-color-tile'))).toBeLessThan(
      children.indexOf(screen.getByTestId('residue-A-1-interaction-frame'))
    );
  });

  it('keeps a hovered selected tile showing its selection outline inside the hover outline', () => {
    renderBox(0xd62728, true, true);
    const selection = screen.getByTestId('residue-A-1-interaction-frame');
    const hover = screen.getByTestId('residue-A-1-hover-frame');
    expect(selection.style.borderTop).toBe('1px solid rgb(51, 255, 25)');
    expect([selection.style.top, selection.style.left, selection.style.right]).toEqual([
      '0px',
      '0px',
      '0px',
    ]);
    expect(hover.style.opacity).toBe('1');
    expect([hover.style.top, hover.style.bottom, hover.style.left, hover.style.right]).toEqual([
      '-1px',
      '-1px',
      '-1px',
      '-1px',
    ]);
  });

  it('leaves the hover outline on the residue edge when no tile is drawn', () => {
    render(
      <ResidueBox
        residue={{ position: 1, name: 'M', name3: 'MET' }}
        chainId="A"
        colorMode="chain"
        isHovered
        isSelected
        onHover={vi.fn()}
        onSelect={vi.fn()}
      />
    );
    expect(screen.queryByTestId('residue-color-tile')).toBeNull();
    expect(screen.getByTestId('residue-A-1-hover-frame').style.top).toBe('0px');
  });
});
