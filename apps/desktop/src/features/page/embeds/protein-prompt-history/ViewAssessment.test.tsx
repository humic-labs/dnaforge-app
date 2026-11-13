/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const append = vi.hoisted(() => vi.fn());
vi.mock('../../../../db/molecular-prompt-trials', () => ({
  appendMolecularPromptTrialFeedback: append,
}));

import { ProteinViewAssessment } from './ViewAssessment';

describe('saved protein output assessment', () => {
  beforeEach(() => append.mockReset());

  it('requires an explicit judgment and explanation linked to the selected output', async () => {
    append.mockResolvedValue({ id: 'note-1' });
    render(
      <ProteinViewAssessment
        resultId="result-1"
        viewReferenceId="postfusion"
        viewLabel="Postfusion F"
      />
    );
    fireEvent.click(screen.getByText('Assess selected output'));
    expect(screen.getByText('Reviewing: Postfusion F')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Record assessment' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Saved output judgment' }), {
      target: { value: 'needs-work' },
    });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Saved output review note' }), {
      target: { value: 'This conformation hides the comparison.' },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(append).toHaveBeenCalledWith(
        'result-1',
        'postfusion',
        'This conformation hides the comparison.',
        'needs-work'
      )
    );
    expect(await screen.findByText('Assessment recorded for this saved output.')).toBeTruthy();
  });
});
