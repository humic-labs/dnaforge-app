/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoStructurePlaceholder } from './NoStructurePlaceholder';

afterEach(cleanup);

describe('NoStructurePlaceholder', () => {
  it('offers a structure prediction for a protein when a handler is given', () => {
    const onPredictStructure = vi.fn();
    render(<NoStructurePlaceholder onPredictStructure={onPredictStructure} />);
    fireEvent.click(screen.getByTestId('no-structure-predict'));
    expect(onPredictStructure).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('no-structure-placeholder').textContent).not.toContain(
      'future release'
    );
  });

  it('shows no prediction button without a handler or for nucleic acids', () => {
    const { rerender } = render(<NoStructurePlaceholder />);
    expect(screen.queryByTestId('no-structure-predict')).toBeNull();
    rerender(<NoStructurePlaceholder moleculeType="dna" onPredictStructure={vi.fn()} />);
    expect(screen.queryByTestId('no-structure-predict')).toBeNull();
  });
});
