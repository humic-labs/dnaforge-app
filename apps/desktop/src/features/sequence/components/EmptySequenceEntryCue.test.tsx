import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptySequenceEntryCue } from './EmptySequenceEntryCue';

describe('EmptySequenceEntryCue', () => {
  it('renders only the insertion caret for the restrained default', () => {
    render(<EmptySequenceEntryCue variant="caret" marginLeft={4} rowHeight={20} />);

    expect(screen.getByTestId('empty-sequence-entry-cue')).toHaveAttribute('data-variant', 'caret');
    expect(screen.getByTestId('empty-sequence-entry-caret')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-sequence-entry-rows')).not.toBeInTheDocument();
    expect(screen.queryByTestId('empty-sequence-entry-hint')).not.toBeInTheDocument();
  });

  it('renders active and secondary sequence bands for the two-row comparison', () => {
    render(<EmptySequenceEntryCue variant="rows" marginLeft={4} rowHeight={20} />);

    const rows = screen.getByTestId('empty-sequence-entry-rows');
    expect(rows.querySelector('[data-row="active"]')).not.toBeNull();
    expect(rows.querySelector('[data-row="secondary"]')).not.toBeNull();
    expect(screen.getByTestId('empty-sequence-entry-caret')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-sequence-entry-hint')).not.toBeInTheDocument();
  });

  it('renders one short instruction beside the caret for the hint comparison', () => {
    render(<EmptySequenceEntryCue variant="hint" marginLeft={4} rowHeight={20} />);

    expect(screen.getByTestId('empty-sequence-entry-hint')).toHaveTextContent('Start typing');
    expect(screen.getByTestId('empty-sequence-entry-caret')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-sequence-entry-rows')).not.toBeInTheDocument();
  });
});
