import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteHostsPanel } from './RemoteHostsPanel';
import type { RemoteHostAccessV1, RemoteHostV1 } from '../../shared/remote-hosts';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  checkAccess: vi.fn(),
  signIn: vi.fn(),
  openTerminal: vi.fn(),
  endConnection: vi.fn(),
  rename: vi.fn(),
  forget: vi.fn(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ remoteHosts: api }) }));

describe('standalone Remote hosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([]);
  });
  it('saves a host without authenticating or choosing any file', async () => {
    const savedHost = {
      profile: {
        endpointId: 'host-1',
        displayName: 'Lab cluster',
        target: 'lab-hpc',
        lastConnectedAt: null,
        lastFailure: null,
        observedPlatform: null,
      },
      access: {
        target: 'lab-hpc',
        state: 'not-checked',
        checkedAt: null,
        lastFailure: null,
        connection: 'none',
        activeConsumers: 0,
      },
    };
    api.save.mockImplementation(async () => {
      api.list.mockResolvedValue([savedHost]);
      return savedHost;
    });
    render(<RemoteHostsPanel />);
    fireEvent.change(screen.getByLabelText('SSH host'), { target: { value: 'lab-hpc' } });
    fireEvent.change(screen.getByLabelText('Host name'), { target: { value: 'Lab cluster' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save host' }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({ target: 'lab-hpc', displayName: 'Lab cluster' })
    );
    expect(await screen.findByText('Lab cluster')).toBeVisible();
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.checkAccess).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/alignment|signal path/i)).toBeNull();
  });

  const host = (state: RemoteHostAccessV1['state']): RemoteHostV1 => ({
    profile: {
      endpointId: 'lab-host',
      displayName: 'Lab cluster',
      target: 'lab-hpc',
      lastConnectedAt: null,
      lastFailure: null,
      observedPlatform: null,
    },
    access: {
      target: 'lab-hpc',
      state,
      checkedAt: state === 'verified' ? 1_791_921_960_000 : null,
      connection: state === 'verified' ? 'dnaforge' : 'none',
      lastFailure: null,
      activeConsumers: 0,
    },
  });

  it('shows immediate progress while the native Terminal request is unresolved', async () => {
    const saved = host('not-checked');
    const signingIn = {
      ...saved.access,
      state: 'signing-in' as const,
      connection: 'dnaforge' as const,
    };
    api.list.mockResolvedValue([saved]);
    let finish!: (access: RemoteHostAccessV1) => void;
    api.signIn.mockReturnValue(
      new Promise<RemoteHostAccessV1>((resolve) => {
        finish = resolve;
      })
    );
    render(<RemoteHostsPanel />);
    await screen.findByText('Lab cluster');
    const card = within(screen.getByTestId('remote-host-card'));
    fireEvent.click(card.getByRole('button', { name: 'Sign in through Terminal', exact: true }));
    try {
      expect(card.getByRole('button', { name: 'Opening Terminal…' })).toBeDisabled();
      expect(card.getByRole('status')).toHaveTextContent('Opening Terminal');
    } finally {
      api.list.mockResolvedValue([{ ...saved, access: signingIn }]);
      await act(async () => {
        finish(signingIn);
      });
    }
    expect(await card.findByRole('status')).toHaveTextContent('Terminal');
    await waitFor(() => expect(card.getByRole('button', { name: 'Cancel sign in' })).toBeEnabled());
  });

  it('offers a real Terminal action for an already verified host', async () => {
    api.list.mockResolvedValue([host('verified')]);
    api.openTerminal.mockResolvedValue(undefined);
    render(<RemoteHostsPanel />);
    await screen.findByText('Lab cluster');
    const card = within(screen.getByTestId('remote-host-card'));
    expect(
      card.queryByRole('button', { name: 'Sign in through Terminal', exact: true })
    ).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Open Terminal', exact: true }));
    await waitFor(() => expect(api.openTerminal).toHaveBeenCalledExactlyOnceWith('lab-hpc'));
    expect(await card.findByRole('status')).toHaveTextContent('Terminal requested');
    expect(api.signIn).not.toHaveBeenCalled();
  });

  it('keeps a failed Terminal launch visible on the affected host', async () => {
    api.list.mockResolvedValue([host('not-checked')]);
    api.signIn.mockRejectedValue(new Error('Terminal could not be opened.'));
    render(<RemoteHostsPanel />);
    await screen.findByText('Lab cluster');
    const card = within(screen.getByTestId('remote-host-card'));
    fireEvent.click(card.getByRole('button', { name: 'Sign in through Terminal', exact: true }));
    expect(await card.findByRole('alert')).toHaveTextContent('Terminal could not be opened.');
    expect(
      card.getByRole('button', { name: 'Sign in through Terminal', exact: true })
    ).toBeEnabled();
  });

  it('opens host management beside the selected host instead of below the whole list', async () => {
    const selected = host('not-checked');
    const other = {
      ...selected,
      profile: {
        ...selected.profile,
        endpointId: 'other-host',
        displayName: 'Other host',
        target: 'other-hpc',
      },
    };
    api.list.mockResolvedValue([selected, other]);
    render(<RemoteHostsPanel />);
    await screen.findByText('Lab cluster');
    const selectedCard = within(screen.getAllByTestId('remote-host-card')[0]);
    const otherCard = within(screen.getAllByTestId('remote-host-card')[1]);
    fireEvent.click(selectedCard.getByRole('button', { name: 'Rename', exact: true }));
    expect(selectedCard.getByLabelText('New host name')).toBeVisible();
    expect(otherCard.queryByLabelText('New host name')).toBeNull();
    fireEvent.click(selectedCard.getByRole('button', { name: 'Cancel', exact: true }));
    fireEvent.click(selectedCard.getByRole('button', { name: 'Forget', exact: true }));
    expect(selectedCard.getByRole('button', { name: 'Forget saved host' })).toBeVisible();
    expect(otherCard.queryByRole('button', { name: 'Forget saved host' })).toBeNull();
  });
});
