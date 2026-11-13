/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProteinResidueTrack } from './ProteinResidueTrack';

afterEach(cleanup);

const SEQ = 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG';

describe('ProteinResidueTrack', () => {
  it('renders every residue as its own interactive element with position labels every 10', () => {
    render(<ProteinResidueTrack bases={SEQ} onContextMenu={vi.fn()} />);
    for (let i = 1; i <= SEQ.length; i++) {
      expect(screen.getByTestId(`protein-residue-${i}`).textContent).toBe(SEQ[i - 1]);
    }
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('click selects a single residue, reported via right-click', () => {
    const onContextMenu = vi.fn();
    render(<ProteinResidueTrack bases={SEQ} onContextMenu={onContextMenu} />);
    fireEvent.mouseDown(screen.getByTestId('protein-residue-5'), { button: 0 });
    fireEvent.mouseUp(screen.getByTestId('protein-residue-5'));
    fireEvent.contextMenu(screen.getByTestId('protein-residue-5'));
    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { start: 5, end: 5 } })
    );
  });

  it('drag (mousedown + mouseenter across residues) extends a contiguous range', () => {
    const onContextMenu = vi.fn();
    render(<ProteinResidueTrack bases={SEQ} onContextMenu={onContextMenu} />);
    fireEvent.mouseDown(screen.getByTestId('protein-residue-3'), { button: 0 });
    fireEvent.mouseEnter(screen.getByTestId('protein-residue-4'));
    fireEvent.mouseEnter(screen.getByTestId('protein-residue-8'));
    fireEvent.mouseUp(screen.getByTestId('protein-residue-8'));
    fireEvent.contextMenu(screen.getByTestId('protein-residue-8'));
    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { start: 3, end: 8 } })
    );
  });

  it('shift-click extends the selection from the PRIOR anchor, not a fresh one', () => {
    const onContextMenu = vi.fn();
    render(<ProteinResidueTrack bases={SEQ} onContextMenu={onContextMenu} />);
    fireEvent.mouseDown(screen.getByTestId('protein-residue-10'), { button: 0 });
    fireEvent.mouseUp(screen.getByTestId('protein-residue-10'));
    fireEvent.mouseDown(screen.getByTestId('protein-residue-20'), { button: 0, shiftKey: true });
    fireEvent.mouseUp(screen.getByTestId('protein-residue-20'));
    fireEvent.contextMenu(screen.getByTestId('protein-residue-20'));
    expect(onContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { start: 10, end: 20 } })
    );
  });

  it('Escape clears the selection', () => {
    const onContextMenu = vi.fn();
    render(<ProteinResidueTrack bases={SEQ} onContextMenu={onContextMenu} />);
    fireEvent.mouseDown(screen.getByTestId('protein-residue-5'), { button: 0 });
    fireEvent.mouseUp(screen.getByTestId('protein-residue-5'));
    fireEvent.keyDown(screen.getByTestId('protein-residue-track'), { key: 'Escape' });
    fireEvent.contextMenu(screen.getByTestId('protein-residue-5'));
    expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ selection: null }));
  });

  it('right-clicking with no prior selection reports a null selection (whole-sequence scope)', () => {
    const onContextMenu = vi.fn();
    render(<ProteinResidueTrack bases={SEQ} onContextMenu={onContextMenu} />);
    fireEvent.contextMenu(screen.getByTestId('protein-residue-5'));
    expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ selection: null }));
  });
});
