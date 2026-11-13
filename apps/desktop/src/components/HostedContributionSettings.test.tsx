import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedContributionSettings } from './HostedContributionSettings';
import { useHostedContributionStore } from '../stores/hosted-contribution-store';
import { hostedPolicy } from '../test/hosted-contribution-fixtures';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  auth: {
    hydrated: true,
    state: {
      status: 'signed-in',
      session: { accountId: 'account-a', desktopSessionId: 'session-a' },
    },
  },
}));
vi.mock('../features/ai/hosted-contribution-client', () => ({
  getHostedContributionSettings: (...args: unknown[]) => mocks.load(...args),
}));
vi.mock('../stores/auth-store', () => ({ useAuthStore: () => mocks.auth }));

describe('inline research contribution setting', () => {
  beforeEach(() => {
    useHostedContributionStore.getState().setSession(null);
    localStorage.clear();
    mocks.auth = {
      hydrated: true,
      state: {
        status: 'signed-in',
        session: { accountId: 'account-a', desktopSessionId: 'session-a' },
      },
    };
    mocks.load.mockReset().mockResolvedValue({ ok: true, policy: hostedPolicy() });
  });
  it('loads the default-on setting without recording a choice or opening a dialog', async () => {
    render(<HostedContributionSettings />);
    const checkbox = screen.getByRole('checkbox', { name: /Contribute AI workflows/ });
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(checkbox).toBeChecked();
    expect(mocks.load.mock.calls).toEqual([[]]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/agent remains available when this is off/)).toBeInTheDocument();
  });
  it('records first withdrawal without an automatic Join and persists off after remount', async () => {
    const withdrawn = {
      ...hostedPolicy(true),
      account_plan_setting: 'never_corpus',
      plan_authority_basis: 'signin_default',
      contribution_choice: 'withdrawn',
    };
    mocks.load
      .mockResolvedValueOnce({ ok: true, policy: hostedPolicy() })
      .mockResolvedValue({ ok: true, policy: withdrawn });
    const view = render(<HostedContributionSettings />);
    const checkbox = screen.getByRole('checkbox', { name: /Contribute AI workflows/ });
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    view.unmount();
    render(<HostedContributionSettings />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(mocks.load.mock.calls).toEqual([[], ['withdrawn'], []]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mocks.load.mockResolvedValueOnce({ ok: true, policy: hostedPolicy(true) });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    expect(mocks.load.mock.calls[3]).toEqual(['joined']);
  });
  it('responds immediately while the save is still pending, without status text', async () => {
    let resolve!: (value: unknown) => void;
    mocks.load.mockResolvedValueOnce({ ok: true, policy: hostedPolicy() }).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<HostedContributionSettings />);
    const checkbox = screen.getByRole('checkbox');
    await waitFor(() => expect(checkbox).toBeEnabled());
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.queryByText(/Saving or loading settings/)).not.toBeInTheDocument();
    await act(async () =>
      resolve({
        ok: true,
        policy: {
          ...hostedPolicy(true),
          account_plan_setting: 'never_corpus',
          plan_authority_basis: 'signin_default',
          contribution_choice: 'withdrawn',
        },
      })
    );
  });
  it('does not render saving or loading text during a delayed first read', () => {
    mocks.load.mockReturnValueOnce(new Promise(() => {}));
    render(<HostedContributionSettings />);
    expect(screen.queryByText(/Saving or loading settings/)).not.toBeInTheDocument();
  });
  it('renders the known setting synchronously when Privacy is reopened', async () => {
    const view = render(<HostedContributionSettings />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
    view.unmount();
    mocks.load.mockReturnValueOnce(new Promise(() => {}));
    render(<HostedContributionSettings />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });
  it('keeps a managed plan visible but prevents unsupported edits', async () => {
    mocks.load.mockResolvedValue({
      ok: true,
      policy: { ...hostedPolicy(false), choice_offered: false, plan_authority_basis: 'plan' },
    });
    render(<HostedContributionSettings />);
    await screen.findByText('Your account plan manages this setting.');
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });
  it('shows a failed save without pretending the setting changed, then supports retry', async () => {
    mocks.load
      .mockResolvedValueOnce({ ok: true, policy: hostedPolicy() })
      .mockResolvedValueOnce({ ok: false, error: 'Service unavailable.' })
      .mockResolvedValueOnce({
        ok: true,
        policy: {
          ...hostedPolicy(true),
          account_plan_setting: 'never_corpus',
          plan_authority_basis: 'signin_default',
          contribution_choice: 'withdrawn',
        },
      });
    render(<HostedContributionSettings />);
    const checkbox = screen.getByRole('checkbox');
    await waitFor(() => expect(checkbox).toBeEnabled());
    fireEvent.click(checkbox);
    await screen.findByRole('alert');
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mocks.load.mock.calls).toEqual([[], ['withdrawn'], ['withdrawn']]);
    expect(checkbox).not.toBeChecked();
  });
  it('ignores a late response after the account changes', async () => {
    let resolve!: (value: unknown) => void;
    mocks.load.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const view = render(<HostedContributionSettings />);
    mocks.auth.state.session.accountId = 'account-b';
    view.rerender(<HostedContributionSettings />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
    await act(async () => {
      resolve({ ok: true, policy: hostedPolicy(false) });
    });
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
