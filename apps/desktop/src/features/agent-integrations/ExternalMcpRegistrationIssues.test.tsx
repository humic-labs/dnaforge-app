import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalMcpRegistrationIssues } from './ExternalMcpRegistrationIssues';
import type { ExternalMcpRegistrationSnapshot } from '../../shared/external-mcp-registration';

const getExternalMcpRegistration = vi.fn<() => Promise<ExternalMcpRegistrationSnapshot>>();
const refreshExternalMcpRegistration = vi.fn<() => Promise<ExternalMcpRegistrationSnapshot>>();
vi.mock('../../platform', () => ({
  platform: () => ({ agentSdk: { getExternalMcpRegistration, refreshExternalMcpRegistration } }),
}));

describe('external access in Settings', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(['development-build', 'pending', 'complete'] as const)(
    'has no setup or status prose in %s',
    async (state) => {
      getExternalMcpRegistration.mockResolvedValue({
        state,
        launcher: null,
        clients: [{ client: 'Grok Build', status: 'registered' }],
      });
      const { container, unmount } = render(<ExternalMcpRegistrationIssues />);
      await waitFor(() => expect(getExternalMcpRegistration).toHaveBeenCalledOnce());
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  );

  it('reports a real failure inline and removes it after successful retry', async () => {
    getExternalMcpRegistration.mockResolvedValue({
      state: 'complete',
      launcher: null,
      clients: [{ client: 'Grok Build', status: 'failed' }],
    });
    refreshExternalMcpRegistration.mockResolvedValue({
      state: 'complete',
      launcher: null,
      clients: [{ client: 'Grok Build', status: 'registered' }],
    });
    render(<ExternalMcpRegistrationIssues />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Could not add DNAForge tools to Grok Build.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('settles a rejected status read without an endless Loading message', async () => {
    getExternalMcpRegistration.mockRejectedValue(new Error('IPC failed'));
    render(<ExternalMcpRegistrationIssues />);
    expect(await screen.findByRole('status')).toHaveTextContent('Could not check access');
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
  });

  it('identifies a preserved name conflict without inventing a connection', async () => {
    getExternalMcpRegistration.mockResolvedValue({
      state: 'complete',
      launcher: null,
      clients: [{ client: 'Cursor', status: 'name-conflict' }],
    });
    render(<ExternalMcpRegistrationIssues />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Cursor already has a different tool server'
    );
    expect(screen.queryByText(/Ready|Connected/)).not.toBeInTheDocument();
  });
});

describe('bounded registration read and explicit retry ownership', () => {
  const complete: ExternalMcpRegistrationSnapshot = {
    state: 'complete',
    launcher: null,
    clients: [],
  };
  const pending: ExternalMcpRegistrationSnapshot = {
    state: 'pending',
    launcher: null,
    clients: [],
  };
  const failed: ExternalMcpRegistrationSnapshot = { state: 'failed', launcher: null, clients: [] };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };
  const advance = async (milliseconds: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  };
  function heldSnapshot() {
    let resolve!: (snapshot: ExternalMcpRegistrationSnapshot) => void;
    const promise = new Promise<ExternalMcpRegistrationSnapshot>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  }

  it('recovers an initial refused read on the settled cadence, then follows pending cadence without spinning', async () => {
    getExternalMcpRegistration
      .mockRejectedValueOnce(new Error('NONFUNCTIONAL_READ_REFUSAL'))
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(complete);
    const view = render(<ExternalMcpRegistrationIssues />);
    try {
      await settle();
      expect(screen.getByRole('status')).toHaveTextContent('Could not check access');
      await advance(14_999);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await advance(999);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(2);
      await advance(1);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(refreshExternalMcpRegistration).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
    await advance(60_000);
    expect(getExternalMcpRegistration).toHaveBeenCalledTimes(3);
  });

  it('restarts one polling chain after an explicit refresh returns pending', async () => {
    getExternalMcpRegistration
      .mockRejectedValueOnce(new Error('initial read'))
      .mockResolvedValue(complete);
    refreshExternalMcpRegistration.mockResolvedValue(pending);
    const view = render(<ExternalMcpRegistrationIssues />);
    try {
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
      await settle();
      expect(refreshExternalMcpRegistration).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await advance(999);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(2);
      await advance(15_000);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
    }
  });

  it('keeps explicit retry authoritative over a held older poll and refuses duplicate refresh clicks', async () => {
    const old = heldSnapshot();
    const latest = heldSnapshot();
    getExternalMcpRegistration
      .mockRejectedValueOnce(new Error('initial read'))
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue(complete);
    refreshExternalMcpRegistration.mockImplementation(() => latest.promise);
    const view = render(<ExternalMcpRegistrationIssues />);
    try {
      await settle();
      await advance(15_000);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(2);
      const retry = screen.getByRole('button', { name: 'Retry connection' });
      fireEvent.click(retry);
      expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Retrying…' }));
      expect(refreshExternalMcpRegistration).toHaveBeenCalledTimes(1);
      await advance(15_000);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(2);
      await act(async () => {
        latest.resolve(complete);
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await act(async () => {
        old.resolve(failed);
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await advance(14_999);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(2);
      await advance(1);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(3);
      expect(refreshExternalMcpRegistration).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
    }
  });

  it('does not let a refresh resolved after unmount schedule another read or mutate a remount', async () => {
    const old = heldSnapshot();
    getExternalMcpRegistration
      .mockRejectedValueOnce(new Error('initial read'))
      .mockResolvedValue(complete);
    refreshExternalMcpRegistration.mockImplementation(() => old.promise);
    const first = render(<ExternalMcpRegistrationIssues />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    first.unmount();
    const second = render(<ExternalMcpRegistrationIssues />);
    try {
      await settle();
      await act(async () => {
        old.resolve(failed);
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      await advance(15_000);
      expect(getExternalMcpRegistration).toHaveBeenCalledTimes(3);
      expect(refreshExternalMcpRegistration).toHaveBeenCalledTimes(1);
    } finally {
      second.unmount();
    }
    await advance(60_000);
    expect(getExternalMcpRegistration).toHaveBeenCalledTimes(3);
  });
});
