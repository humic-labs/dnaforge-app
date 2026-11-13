import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DnaforgeAgentHostRow } from './DnaforgeAgentHostRow';

vi.mock('../../stores/auth-store', () => ({
  useAuthStore: () => ({ state: { status: 'signed-out' }, hydrated: true }),
}));
vi.mock('../../components/HostedContributionSettings', () => ({
  HostedContributionSettings: () => <div data-testid="hosted-contribution-settings" />,
}));

describe('DNAForge agent settings', () => {
  it('shows Mode immediately and selects a tier through the shared Settings picker', async () => {
    const onUse = vi.fn().mockResolvedValue(undefined);
    render(
      <DnaforgeAgentHostRow
        readiness="ready"
        activeTier={null}
        onUse={onUse}
        onSignIn={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.queryByRole('button', { name: 'Options' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('hosted-contribution-settings')).not.toBeInTheDocument();
    const mode = screen.getByRole('combobox', { name: 'DNAForge agent mode' });
    expect(mode).toBeVisible();
    expect(mode).toHaveAttribute('data-settings-control', 'select');
    expect(document.querySelector('select')).toBeNull();
    fireEvent.click(mode);
    fireEvent.click(screen.getByRole('option', { name: 'Deep' }));
    expect(mode).toHaveTextContent('Deep');
    fireEvent.click(screen.getByRole('button', { name: 'Set as default', exact: true }));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith('deep'));
  });

  it('changes an active tier and reports a failed save without losing the current value', async () => {
    const onUse = vi.fn().mockRejectedValue(new Error('Mode could not be saved'));
    render(
      <DnaforgeAgentHostRow
        readiness="ready"
        activeTier="deep"
        onUse={onUse}
        onSignIn={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByTestId('dnaforge-agent-default')).toBeDisabled();
    expect(screen.getByTestId('dnaforge-agent-default')).toHaveAttribute('aria-pressed', 'true');
    const mode = screen.getByRole('combobox', { name: 'DNAForge agent mode' });
    fireEvent.click(mode);
    fireEvent.click(screen.getByRole('option', { name: 'Auto' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        userMessage('failure.could-not-change-mode')
      )
    );
    expect(onUse).toHaveBeenCalledWith('auto');
    expect(mode).toHaveTextContent('Deep');
    expect(mode).toBeEnabled();
  });
});
