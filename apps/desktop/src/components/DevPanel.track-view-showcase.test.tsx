import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { applyDevScenarioPresetMock, resolveApply } = vi.hoisted(() => {
  let resolveApply!: () => void;
  const applyDevScenarioPresetMock = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveApply = resolve;
      })
  );
  return {
    applyDevScenarioPresetMock,
    resolveApply: () => resolveApply(),
  };
});

vi.mock('../test/scenarios/apply-dev', () => ({
  applyDevScenarioPreset: applyDevScenarioPresetMock,
  getLastAppliedDevScenarioPresetId: () => null,
  resetToLiveState: vi.fn(),
}));

vi.mock('../dev/dev-fixtures-mount', () => ({
  useDevFixturesMounted: () => [true, vi.fn()],
}));

vi.mock('../platform', () => ({
  platform: () => ({ update: { simulate: vi.fn() } }),
}));

import { DevPanel } from './DevPanel';

describe('DevPanel Track View showcase', () => {
  it('describes fixture visibility without claiming that unmounting resets stored data', () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);
    const toggle = screen.getByTestId('dev-fixtures-toggle');
    expect(toggle).toHaveAttribute(
      'title',
      'Show or hide developer folders used for preview and import. This does not reset the database.'
    );
    expect(toggle).not.toHaveTextContent('fresh machine');
  });

  it('shows pending feedback and prevents duplicate clicks while the fixture loads', async () => {
    render(<DevPanel isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Filter scenarios'), {
      target: { value: 'Pownall Figure 4N' },
    });
    const preset = screen.getByTestId('devpanel-pownall-2023-figure-4n-klf17');
    fireEvent.click(preset);

    expect(preset).toBeDisabled();
    expect(preset).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading Pownall Figure 4N');
    fireEvent.click(preset);
    expect(applyDevScenarioPresetMock).toHaveBeenCalledTimes(1);

    resolveApply();
    await waitFor(() => expect(preset).toHaveAttribute('aria-pressed', 'true'));
    expect(preset).not.toBeDisabled();
  });
});
