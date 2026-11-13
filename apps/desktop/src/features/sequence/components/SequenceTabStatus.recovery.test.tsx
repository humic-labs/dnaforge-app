import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SequenceTabStatus } from './SequenceTabStatus';

describe('sequence load error recovery details', () => {
  const showError = (error: string) =>
    render(
      <SequenceTabStatus
        isLoading={false}
        error={error}
        sequence={null}
        displaySequence={null}
        parsedPlasmid={null}
        ready={() => <div>ready</div>}
      />
    );

  it('shows the exact invalid character and source position needed for recovery', () => {
    showError(
      'This file could not be read as a sequence. Line 4: Invalid sequence character "`" at column 18'
    );
    expect(screen.getByTestId('sequence-error')).toHaveTextContent(
      'Line 4: Invalid sequence character "`" at column 18'
    );
    expect(screen.getByTestId('sequence-error')).not.toHaveTextContent('genome tracks');
  });

  it('keeps internal filesystem diagnostics out of the sequence error surface', () => {
    showError('TypeError: electronAPI.fs.readFile(/private/internal/path)');
    expect(screen.getByTestId('sequence-error')).toHaveTextContent(
      'We couldn’t open this sequence file.'
    );
    expect(screen.getByTestId('sequence-error')).not.toHaveTextContent('electronAPI');
    expect(screen.getByTestId('sequence-error')).not.toHaveTextContent('/private');
    expect(screen.getByTestId('sequence-error')).not.toHaveTextContent('genome tracks');
  });
});
