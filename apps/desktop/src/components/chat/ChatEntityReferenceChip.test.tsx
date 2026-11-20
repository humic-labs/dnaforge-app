import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatEntityReferenceChip } from './ChatEntityReferenceChip';

describe('chat reference card presentation', () => {
  it.each(['folder', 'directory', 'file', 'sequence', 'notebook', 'protein', 'annotation'])(
    'uses the committed card presentation for %s',
    (entityType) => {
      render(
        <>
          <ChatEntityReferenceChip
            entityType="file"
            label="Saved artifact"
            attachmentPhase="sent"
            testId="committed-card"
          />
          <ChatEntityReferenceChip entityType={entityType} label="Example" testId="embedded-card" />
        </>
      );
      const embedded = screen.getByTestId('embedded-card');
      expect(embedded.className).toBe(screen.getByTestId('committed-card').className);
      expect(embedded).toHaveClass('entity-reference-chip--sent');
      expect(embedded).toHaveAttribute('data-entity-type', entityType);
      expect(embedded.textContent).toBe('Example');
      expect(embedded.firstElementChild).toHaveClass('entity-reference-chip__icon');
    }
  );

  it('preserves the explicit draft presentation', () => {
    render(<ChatEntityReferenceChip entityType="folder" label="Results" attachmentPhase="draft" />);
    const chip = screen.getByTestId('entity-reference-chip');
    expect(chip).toHaveClass('entity-reference-chip--draft');
    expect(chip).not.toHaveClass('entity-reference-chip--sent');
  });

  it('keeps the folder identity, accessible label and reveal activation', () => {
    const reveal = vi.fn();
    render(
      <ChatEntityReferenceChip
        entityType="folder"
        label="Results"
        onReveal={reveal}
        primaryAction="reveal"
      />
    );
    const chip = screen.getByRole('link', { name: 'Results, Folder' });
    expect(chip).toHaveAttribute('data-entity-type', 'folder');
    fireEvent.click(chip);
    fireEvent.keyDown(chip, { key: 'Enter' });
    fireEvent.keyDown(chip, { key: ' ' });
    expect(reveal).toHaveBeenCalledTimes(3);
  });

  it.each([{ unavailable: true }, { busy: true }])(
    'preserves unavailable and busy interaction states %j',
    (state) => {
      const open = vi.fn();
      render(<ChatEntityReferenceChip entityType="file" label="Result" onOpen={open} {...state} />);
      const chip = screen.getByRole('link', { name: 'Result, File' });
      if ('unavailable' in state) expect(chip).toHaveAttribute('aria-disabled', 'true');
      if ('busy' in state) expect(chip).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(chip);
      fireEvent.keyDown(chip, { key: 'Enter' });
      expect(open).not.toHaveBeenCalled();
    }
  );
});
