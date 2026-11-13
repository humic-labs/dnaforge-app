import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComputeConnectResult, ComputeProviderSummary } from '../../shared/compute-ipc';

const SECRET = 'tmr-live-SECRETVALUE-123456';

const bridge = vi.hoisted(() => ({
  providers: [] as ComputeProviderSummary[],
  listProviders: vi.fn(async () => bridge.providers),
  listJobs: vi.fn(async () => []),
  connect: vi.fn(
    async (_id: string, _secret: string): Promise<ComputeConnectResult> => ({
      ok: true,
      providerId: 'tamarind',
      toolCount: 7,
      verifiedAt: '2026-09-09T20:00:00.000Z',
    })
  ),
  test: vi.fn(
    async (): Promise<ComputeConnectResult> => ({
      ok: true,
      providerId: 'tamarind',
      toolCount: 7,
      verifiedAt: '2026-09-09T20:05:00.000Z',
    })
  ),
  disconnect: vi.fn(async (providerId: string) => ({
    ok: true as const,
    providerId,
    removed: true,
  })),
  installManifest: vi.fn(async (manifestJson: string) => {
    const manifest = JSON.parse(manifestJson) as { id: string; displayName: string };
    bridge.providers = [
      ...bridge.providers,
      provider({
        id: manifest.id,
        displayName: manifest.displayName,
        transport: 'rest',
        driver: 'http-job',
        custom: true,
      }),
    ];
    return { ok: true as const, providerId: manifest.id, displayName: manifest.displayName };
  }),
  removeCustomProvider: vi.fn(async (providerId: string) => {
    bridge.providers = bridge.providers.filter((candidate) => candidate.id !== providerId);
    return { ok: true as const, providerId, removedCredential: false };
  }),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    compute: {
      listProviders: bridge.listProviders,
      connect: bridge.connect,
      test: bridge.test,
      disconnect: bridge.disconnect,
      installManifest: bridge.installManifest,
      removeCustomProvider: bridge.removeCustomProvider,
      listJobs: bridge.listJobs,
      listJobsSnapshot: async () => ({
        jobs: [],
        jobCount: 0,
        activeCount: 0,
        terminalCount: 0,
        activeComplete: true,
        historyComplete: true,
        historyLimit: 200,
      }),
    },
  }),
}));

import { ComputeIntegrationsSection } from './ComputeIntegrationsSection';
import { ConnectComputeProviderChip } from './ConnectComputeProviderChip';
import { ConnectComputeProviderDialog } from './ConnectComputeProviderDialog';
import { useComputeStore } from './store';

function provider(overrides: Partial<ComputeProviderSummary> = {}): ComputeProviderSummary {
  return {
    id: 'tamarind',
    displayName: 'Tamarind Bio',
    summary: 'Protein and molecular modeling tools.',
    transport: 'mcp',
    driver: 'mcp-tool-map',
    custom: false,
    authScheme: 'header',
    endpointUrl: 'https://mcp.tamarind.bio/mcp',
    verifyTarget: 'listModalities',
    credentialHeader: 'x-api-key',
    catalog: 'dynamic',
    jobModel: 'queue',
    cost: 'estimate',
    disclosure:
      'This sends your sequences to Tamarind Bio under your own account. Tamarind bills that account.',
    retentionNote: 'Import results promptly.',
    cancellationMode: 'provider',
    cancellationNote: 'Queued or running work can be canceled through Tamarind.',
    docsUrl: 'https://app.tamarind.bio/api-docs',
    keyPageUrl: 'https://app.tamarind.bio/api-docs/api-key',
    termsUrl: 'https://app.tamarind.bio/terms-of-service',
    privacyUrl: 'https://app.tamarind.bio/privacy-policy',
    hasBinding: true,
    connected: false,
    lastVerifiedAt: null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  bridge.providers = [
    provider(),
    provider({ id: 'subseq', displayName: 'subseq.bio', hasBinding: false }),
  ];
  bridge.listProviders.mockClear();
  bridge.connect.mockClear();
  bridge.test.mockClear();
  bridge.disconnect.mockClear();
  bridge.installManifest.mockClear();
  bridge.removeCustomProvider.mockClear();
  useComputeStore.setState({
    providers: [],
    loading: false,
    loadError: null,
    pendingConnectProviderId: null,
    connectDialog: { open: false, providerId: null },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ComputeIntegrationsSection', () => {
  it('shows no provider summary and keeps provider details collapsed until requested', async () => {
    render(<ComputeIntegrationsSection />);
    await flush();
    const card = screen.getByTestId('compute-provider-card-tamarind');
    expect(within(card).queryByText('Protein and molecular modeling tools.')).toBeNull();
    expect(within(card).queryByText(/Key stored|last verified never/i)).toBeNull();
    const disclosure = within(card).getByText(bridge.providers[0].disclosure);
    expect(disclosure).not.toBeVisible();
    fireEvent.click(within(card).getByText('Details'));
    expect(disclosure).toBeVisible();
    expect(within(card).getByText('Provider MCP server')).toBeVisible();
    expect(within(card).getByText('API key')).toBeVisible();
    expect(within(card).getByRole('link', { name: 'Documentation' })).toHaveAttribute(
      'href',
      bridge.providers[0].docsUrl
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }));
    expect(useComputeStore.getState().connectDialog).toEqual({
      open: true,
      providerId: 'tamarind',
    });
  });

  it('lists providers from main and marks binding-less ones as coming soon', async () => {
    render(<ComputeIntegrationsSection />);
    await flush();
    const tamarind = screen.getByTestId('compute-provider-card-tamarind');
    expect(within(tamarind).getByTestId('compute-provider-status')).toHaveTextContent(
      'Not connected'
    );
    expect(within(tamarind).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    const subseq = screen.getByTestId('compute-provider-card-subseq');
    expect(within(subseq).getByTestId('compute-provider-status')).toHaveTextContent('Coming soon');
    expect(within(subseq).queryByRole('button')).toBeNull();
  });

  it('groups the section and counts only what a user can actually connect', async () => {
    bridge.providers = [
      provider({ id: 'tamarind', connected: true }),
      provider({ id: 'boltz', connected: false }),
      provider({ id: 'nvidia-nim', connected: false }),
      provider({ id: 'subseq', connected: false, hasBinding: false }),
    ];
    render(<ComputeIntegrationsSection />);
    await flush();

    expect(screen.getByTestId('compute-connected-count')).toHaveTextContent('1 of 3 connected');
    const providerHeading = screen.getByRole('heading', { name: 'Compute providers' });
    const jobsHeading = screen.getByRole('heading', { name: 'Compute jobs' });
    expect(providerHeading).toHaveClass('text-xl', 'font-semibold', 'tracking-tight');
    expect(jobsHeading).toHaveClass('text-xl', 'font-semibold', 'tracking-tight');
    expect(providerHeading).not.toHaveClass('text-sm');
    expect(jobsHeading).not.toHaveClass('text-sm');
    expect(screen.queryByText(/Services you connect with your own account and key/)).toBeNull();
    expect(screen.queryByText(/Settings → AI/)).toBeNull();
  });

  it('offers test, replace, and disconnect once connected, and disconnect removes the key', async () => {
    bridge.providers = [provider({ connected: true, lastVerifiedAt: '2026-09-09T20:00:00.000Z' })];
    render(<ComputeIntegrationsSection />);
    await flush();
    const card = screen.getByTestId('compute-provider-card-tamarind');
    expect(within(card).getByTestId('compute-provider-status')).toHaveTextContent('Connected');
    fireEvent.click(within(card).getByRole('button', { name: 'Test connection' }));
    await waitFor(() =>
      expect(within(card).getByTestId('compute-provider-notice')).toHaveTextContent(
        '7 tools available'
      )
    );
    expect(bridge.test).toHaveBeenCalledWith('tamarind');

    bridge.providers = [provider({ connected: false })];
    fireEvent.click(within(card).getByText('Manage connection'));
    expect(within(card).getByRole('button', { name: 'Replace key' })).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(bridge.disconnect).toHaveBeenCalledWith('tamarind'));
    await waitFor(() =>
      expect(screen.getByTestId('compute-provider-status')).toHaveTextContent('Not connected')
    );
  });

  it('renders a test failure in plain language without the provider error text', async () => {
    bridge.providers = [provider({ connected: true })];
    bridge.test.mockResolvedValueOnce({
      ok: false,
      kind: 'bad_credential',
      message: 'tamarind: rejected credential (401)',
    });
    render(<ComputeIntegrationsSection />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    const notice = await screen.findByTestId('compute-provider-notice');
    expect(notice).toHaveTextContent('Tamarind Bio rejected this key');
    expect(notice).not.toHaveTextContent('401');
  });

  it('shows the load error when main cannot reach the sidecar', async () => {
    bridge.listProviders.mockRejectedValueOnce(
      new Error('compute providers unavailable: sidecar_unavailable')
    );
    render(<ComputeIntegrationsSection />);
    await flush();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes(userMessage('service.unavailable')))).toBe(
      true
    );
    expect(alerts.some((el) => el.textContent?.includes('sidecar_unavailable'))).toBe(false);
  });

  it.each(['test', 'disconnect'] as const)(
    'keeps the connection and allows retry after a %s transport failure',
    async (operation) => {
      bridge.providers = [provider({ connected: true })];
      bridge[operation].mockRejectedValueOnce(new Error('IPC unavailable'));
      render(<ComputeIntegrationsSection />);
      await flush();
      if (operation === 'disconnect') fireEvent.click(screen.getByText('Manage connection'));
      const button = screen.getByRole('button', {
        name: operation === 'test' ? 'Test connection' : 'Disconnect',
      });
      fireEvent.click(button);
      expect(await screen.findByTestId('compute-provider-notice')).toHaveTextContent(
        operation === 'test'
          ? 'Could not test this connection. Try again.'
          : 'Could not disconnect. Try again.'
      );
      expect(button).toBeEnabled();
      expect(screen.getByTestId('compute-provider-status')).toHaveTextContent('Connected');
    }
  );

  it('adds a Runpod endpoint and immediately opens its key connection journey', async () => {
    render(<ComputeIntegrationsSection />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    expect(screen.getByRole('dialog', { name: 'Add compute endpoint' })).toBeInTheDocument();
    expect(screen.getByText(/not live-qualified/)).toBeInTheDocument();
    expect(screen.getByText(/do not need a Runpod account/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Endpoint name'), {
      target: { value: 'Protein Lab GPU' },
    });
    fireEvent.change(screen.getByLabelText('Runpod endpoint ID'), {
      target: { value: 'abc123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install endpoint' }));

    await waitFor(() => expect(bridge.installManifest).toHaveBeenCalledTimes(1));
    const installed = JSON.parse(bridge.installManifest.mock.calls[0][0]) as Record<
      string,
      unknown
    >;
    expect(installed).toMatchObject({
      schemaVersion: 2,
      id: 'runpod-abc123',
      displayName: 'Protein Lab GPU',
      baseUrl: 'https://api.runpod.ai/v2/abc123',
      driver: { kind: 'http-job' },
      auth: { scheme: 'header', headerName: 'authorization' },
      summary: expect.stringContaining('not yet live-qualified'),
    });
    await waitFor(() =>
      expect(useComputeStore.getState().connectDialog).toEqual({
        open: true,
        providerId: 'runpod-abc123',
      })
    );
    expect(await screen.findByTestId('compute-provider-card-runpod-abc123')).toBeInTheDocument();
  });

  it('requires an explicit second click before removing a custom endpoint', async () => {
    bridge.providers = [
      provider({
        id: 'runpod-abc123',
        displayName: 'Protein Lab GPU',
        transport: 'rest',
        driver: 'http-job',
        custom: true,
      }),
    ];
    render(<ComputeIntegrationsSection />);
    await flush();
    const card = screen.getByTestId('compute-provider-card-runpod-abc123');
    fireEvent.click(within(card).getByText('Details'));
    fireEvent.click(within(card).getByRole('button', { name: 'Remove endpoint' }));
    expect(bridge.removeCustomProvider).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(bridge.removeCustomProvider).toHaveBeenCalledWith('runpod-abc123'));
    await waitFor(() =>
      expect(screen.queryByTestId('compute-provider-card-runpod-abc123')).toBeNull()
    );
  });
});

describe('ConnectComputeProviderDialog', () => {
  it('shows disclosure, verifies-then-saves the key once, and never renders the key back', async () => {
    render(<ConnectComputeProviderDialog />);
    act(() => useComputeStore.getState().openConnectDialog('tamarind'));
    await flush();
    const disclosure = screen.getByTestId('connect-compute-disclosure');
    expect(disclosure).toHaveTextContent('Tamarind bills that account');
    expect(within(disclosure).getByTestId('compute-endpoint-url')).toHaveTextContent(
      'https://mcp.tamarind.bio/mcp'
    );
    expect(within(disclosure).getByTestId('compute-verify-target')).toHaveTextContent(
      'listModalities'
    );
    expect(within(disclosure).getByTestId('compute-credential-header')).toHaveTextContent(
      'x-api-key'
    );
    expect(within(disclosure).getByRole('link', { name: 'Terms' })).toHaveAttribute(
      'href',
      'https://app.tamarind.bio/terms-of-service'
    );
    expect(screen.getByRole('link', { name: 'Get a key' })).toHaveAttribute(
      'href',
      'https://app.tamarind.bio/api-docs/api-key'
    );

    const input = screen.getByTestId('connect-compute-key-input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(screen.getByTestId('connect-compute-submit')).toBeDisabled();
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(screen.getByTestId('connect-compute-submit'));

    await screen.findByTestId('connect-compute-success');
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(bridge.connect).toHaveBeenCalledWith('tamarind', SECRET);
    expect(screen.getByTestId('connect-compute-success')).toHaveTextContent('7 available tools');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(bridge.listProviders).toHaveBeenCalled();
  });

  it('keeps the dialog open and explains a rejected key; nothing is saved', async () => {
    bridge.connect.mockResolvedValueOnce({
      ok: false,
      kind: 'bad_credential',
      message: 'tamarind: rejected credential (401)',
    });
    render(<ConnectComputeProviderDialog />);
    act(() => useComputeStore.getState().openConnectDialog('tamarind'));
    await flush();
    fireEvent.change(screen.getByTestId('connect-compute-key-input'), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByTestId('connect-compute-submit'));
    const failure = await screen.findByTestId('connect-compute-failure');
    expect(failure).toHaveTextContent('Tamarind Bio rejected this key');
    expect(failure).not.toHaveTextContent('401');
    expect(failure).not.toHaveTextContent(userMessage('operation.failed'));
    expect(screen.queryByTestId('connect-compute-success')).toBeNull();
    expect(screen.getByTestId('connect-compute-key-input')).toBeInTheDocument();
  });

  it('opens as a picker when no provider is named and lists only providers with a binding', async () => {
    render(<ConnectComputeProviderDialog />);
    act(() => useComputeStore.getState().openConnectDialog(null));
    await flush();
    const picker = screen.getByTestId('connect-compute-picker');
    expect(within(picker).getByTestId('connect-compute-pick-tamarind')).toBeInTheDocument();
    expect(within(picker).queryByTestId('connect-compute-pick-subseq')).toBeNull();
    fireEvent.click(within(picker).getByTestId('connect-compute-pick-tamarind'));
    expect(await screen.findByTestId('connect-compute-key-input')).toBeInTheDocument();
  });

  it('explains that sign-in is not available for oauth providers and offers no key field', async () => {
    bridge.providers = [provider({ authScheme: 'oauth', keyPageUrl: null })];
    render(<ConnectComputeProviderDialog />);
    act(() => useComputeStore.getState().openConnectDialog('tamarind'));
    await flush();
    expect(
      await screen.findByText(/Sign-in for Tamarind Bio is not available yet/)
    ).toBeInTheDocument();
    expect(screen.queryByTestId('connect-compute-key-input')).toBeNull();
  });
});

describe('ConnectComputeProviderChip', () => {
  it('is hidden until a tool requests a provider, then opens the dialog for that provider', async () => {
    render(<ConnectComputeProviderChip />);
    expect(screen.queryByTestId('connect-compute-chip')).toBeNull();
    act(() => {
      useComputeStore.setState({ providers: bridge.providers });
      useComputeStore.getState().requestConnect('tamarind');
    });
    const chip = screen.getByTestId('connect-compute-chip');
    expect(chip).toHaveTextContent('Connect Tamarind Bio');
    act(() => {
      fireEvent.click(chip);
    });
    expect(useComputeStore.getState().connectDialog).toEqual({
      open: true,
      providerId: 'tamarind',
    });
  });

  it('falls back to a generic label and the picker when no provider is named', () => {
    render(<ConnectComputeProviderChip />);
    act(() => useComputeStore.getState().requestConnect(null));
    const chip = screen.getByTestId('connect-compute-chip');
    expect(chip).toHaveTextContent('Connect a compute provider');
    act(() => {
      fireEvent.click(chip);
    });
    expect(useComputeStore.getState().connectDialog).toEqual({ open: true, providerId: null });
  });

  it('clears after a successful connect', async () => {
    act(() => useComputeStore.getState().requestConnect('tamarind'));
    await act(async () => {
      await useComputeStore.getState().connect('tamarind', SECRET);
    });
    expect(useComputeStore.getState().pendingConnectProviderId).toBeNull();
  });
});
