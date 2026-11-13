import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState, mockGetState, mockSetAssistantRoute } = vi.hoisted(() => {
  const installedCli = {
    cli: 'installed' as const,
    path: '/x/claude',
    auth: 'authenticated' as const,
    defaultModel: null,
    keychainEntryPresent: null,
    credentialsFilePresent: null,
  };
  const setAssistantRoute = vi.fn().mockResolvedValue(undefined);
  const state = {
    providerStatuses: {
      anthropic: { isConfigured: false },
      openai: { isConfigured: false },
      google: { isConfigured: false },
      xai: { isConfigured: false },
      deepseek: { isConfigured: false },
    },
    providerModels: {},
    agentDetection: { claudeCode: { ...installedCli }, codex: { ...installedCli } },
    setApiKey: vi.fn().mockResolvedValue(undefined),
    fetchModels: vi.fn().mockResolvedValue(undefined),
    setAssistantRoute,
    refreshAgentDetection: vi.fn().mockResolvedValue(null),
  };
  return {
    mockState: state,
    mockGetState: vi.fn(() => state),
    mockSetAssistantRoute: setAssistantRoute,
  };
});

vi.mock('../../features/ai/settings', () => {
  const useAISettingsStore = vi.fn(() => mockState);
  (useAISettingsStore as unknown as { getState: unknown }).getState = mockGetState;
  return { useAISettingsStore };
});

vi.mock('../../features/ai/hooks/useAgentCliAuthFlow', () => ({
  useAgentCliAuthFlow: () => ({
    authenticatingTransport: null,
    authResult: null,
    runAgentAuth: vi.fn().mockResolvedValue({ ok: true, status: 'completed' }),
  }),
}));

vi.mock('../../features/ai/modelDiscovery', () => ({
  fetchProviderModels: vi.fn().mockResolvedValue({ models: ['gpt-4o'], error: null }),
}));

import { ConnectAiModal } from './ConnectAiModal';

function hostedOption(over: Record<string, unknown> = {}) {
  return {
    id: 'dnaforge-hosted-auto',
    hostId: 'dnaforge-hosted-auto',
    selection: { kind: 'hosted', tier: 'auto' },
    category: 'hosted',
    label: 'Auto',
    detail: userMessage('copy.assistant-connection-options'),
    sourceLabel: 'DNAForge Hosted',
    settingLabel: '',
    configured: true,
    active: false,
    readiness: 'ready',
    readinessLabel: null,
    ...over,
  } as never;
}

describe('ConnectAiModal — DNAForge-hosted lane (Slice 2)', () => {
  beforeEach(() => {
    mockSetAssistantRoute.mockClear();
    mockGetState.mockReturnValue(mockState);
  });

  describe('this build (dev): no hosted route in the registry', () => {
    it('renders NO hosted section — the honest negative, not a disabled tile', () => {
      render(<ConnectAiModal open onClose={() => {}} />);

      expect(screen.queryByTestId('connect-ai-hosted-section')).not.toBeInTheDocument();
      expect(screen.queryByText('Use DNAForge AI')).not.toBeInTheDocument();
    });

    it('still renders BOTH bring-your-own lanes (no regression to the shipped surface)', () => {
      render(<ConnectAiModal open onClose={() => {}} />);

      expect(screen.getByText('Use a subscription')).toBeInTheDocument();
      expect(screen.getByText('Use an API key')).toBeInTheDocument();
      expect(screen.getByTestId('connect-ai-cli-claude-agent-sdk')).toBeInTheDocument();
      expect(screen.getByTestId('connect-ai-provider-anthropic')).toBeInTheDocument();
    });

    it('hides desktop subscription and API lanes in the hosted browser', () => {
      render(<ConnectAiModal open onClose={() => {}} hostedBrowserOnly />);

      expect(screen.queryByText('Use a subscription')).not.toBeInTheDocument();
      expect(screen.queryByText('Use an API key')).not.toBeInTheDocument();
      expect(screen.queryByTestId('connect-ai-cli-claude-agent-sdk')).not.toBeInTheDocument();
      expect(screen.queryByTestId('connect-ai-provider-anthropic')).not.toBeInTheDocument();
    });
  });

  describe('post-: the registry exposes hosted routes', () => {
    it('renders one tile per hosted tier, labelled from the registry', () => {
      render(
        <ConnectAiModal
          open
          onClose={() => {}}
          hostedRouteOptions={[
            hostedOption(),
            hostedOption({
              id: 'dnaforge-hosted-deep',
              label: 'Deep',
              detail: 'Slower, harder problems',
              selection: { kind: 'hosted', tier: 'deep' },
            }),
          ]}
        />
      );

      expect(screen.getByTestId('connect-ai-hosted-section')).toBeInTheDocument();
      expect(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto')).toHaveTextContent(
        'Auto'
      );
      expect(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-deep')).toHaveTextContent(
        'Deep'
      );
      expect(
        screen.getByText(userMessage('copy.assistant-connection-options'))
      ).toBeInTheDocument();
    });

    it('presents the hosted lane FIRST — it is the no-key, no-CLI default path', () => {
      const { container } = render(
        <ConnectAiModal open onClose={() => {}} hostedRouteOptions={[hostedOption()]} />
      );

      const sections = Array.from(container.querySelectorAll('section'));
      const hosted = screen.getByTestId('connect-ai-hosted-section');
      expect(sections.indexOf(hosted as HTMLElement)).toBe(0);
    });

    it('activating a tier hands back the registry’s OWN selection object, then closes', async () => {
      const onClose = vi.fn();
      const option = hostedOption();
      render(<ConnectAiModal open onClose={onClose} hostedRouteOptions={[option]} />);

      fireEvent.click(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto'));

      await waitFor(() => expect(mockSetAssistantRoute).toHaveBeenCalledTimes(1));
      expect(mockSetAssistantRoute.mock.calls[0]?.[0]).toBe(
        (option as unknown as { selection: unknown }).selection
      );
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it('a NOT-ready tier is disabled, explains the fix, and cannot be activated', () => {
      render(
        <ConnectAiModal
          open
          onClose={() => {}}
          hostedRouteOptions={[
            hostedOption({ readiness: 'needs-login', readinessLabel: 'Sign in required' }),
          ]}
        />
      );

      const tile = screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto');
      expect(tile).toBeDisabled();
      expect(tile).toHaveTextContent('Sign in required');

      fireEvent.click(tile);
      expect(mockSetAssistantRoute).not.toHaveBeenCalled();
      expect(screen.getByTestId('connect-ai-hosted-signin-hint')).toHaveTextContent(/sign in/i);
    });

    it('does NOT tell an allowance-exhausted user to sign in', () => {
      render(
        <ConnectAiModal
          open
          onClose={() => {}}
          hostedRouteOptions={[
            hostedOption({
              readiness: 'allowance-exhausted',
              readinessLabel: userMessage('account.monthlyAllowanceUsed'),
            }),
          ]}
        />
      );

      const tile = screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto');
      expect(tile).toBeDisabled();
      expect(tile).toHaveTextContent(userMessage('account.monthlyAllowanceUsed'));
      expect(screen.queryByTestId('connect-ai-hosted-signin-hint')).not.toBeInTheDocument();
    });

    it.each(['gateway-unavailable', 'needs-acceptance', 'checking'])(
      'does not offer sign-in for readiness=%s either',
      (readiness) => {
        render(
          <ConnectAiModal
            open
            onClose={() => {}}
            hostedRouteOptions={[hostedOption({ readiness, readinessLabel: 'Unavailable' })]}
          />
        );

        expect(screen.queryByTestId('connect-ai-hosted-signin-hint')).not.toBeInTheDocument();
      }
    );

    it('an unknown future readiness fails closed (disabled), not open', () => {
      render(
        <ConnectAiModal
          open
          onClose={() => {}}
          hostedRouteOptions={[hostedOption({ readiness: 'quota-exhausted' })]}
        />
      );

      expect(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto')).toBeDisabled();
    });

    it('SURFACES a failed activation instead of failing silently', async () => {
      mockSetAssistantRoute.mockRejectedValueOnce(new Error('gateway unreachable'));
      render(<ConnectAiModal open onClose={() => {}} hostedRouteOptions={[hostedOption()]} />);

      fireEvent.click(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto'));

      await waitFor(() =>
        expect(screen.getByTestId('connect-ai-error')).toHaveTextContent('Could not connect.')
      );
      expect(screen.getAllByTestId('connect-ai-error')).toHaveLength(1);
    });

    it('re-enables the tier after a failed activation (not stuck disabled)', async () => {
      mockSetAssistantRoute.mockRejectedValueOnce(new Error('nope'));
      render(<ConnectAiModal open onClose={() => {}} hostedRouteOptions={[hostedOption()]} />);

      const tile = screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto');
      fireEvent.click(tile);

      await waitFor(() => expect(screen.getByTestId('connect-ai-error')).toBeInTheDocument());
      expect(tile).toBeEnabled();
    });

    it('does not leak a hosted error into another lane’s step', async () => {
      mockSetAssistantRoute.mockRejectedValueOnce(new Error('gateway unreachable'));
      render(<ConnectAiModal open onClose={() => {}} hostedRouteOptions={[hostedOption()]} />);

      fireEvent.click(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto'));
      await waitFor(() => expect(screen.getByTestId('connect-ai-error')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('connect-ai-provider-openai'));

      expect(screen.getByTestId('connect-ai-key-input')).toBeInTheDocument();
      expect(screen.queryByTestId('connect-ai-error')).not.toBeInTheDocument();
    });

    it('marks the currently active hosted tier', () => {
      render(
        <ConnectAiModal
          open
          onClose={() => {}}
          hostedRouteOptions={[hostedOption({ active: true })]}
        />
      );

      expect(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto')).toHaveAttribute(
        'aria-current',
        'true'
      );
    });

    it('an activation resolving AFTER dismissal does not close the modal again', async () => {
      let resolveRoute: () => void = () => {};
      mockSetAssistantRoute.mockImplementationOnce(
        () =>
          new Promise<void>((res) => {
            resolveRoute = res;
          })
      );
      const onClose = vi.fn();
      const { rerender } = render(
        <ConnectAiModal open onClose={onClose} hostedRouteOptions={[hostedOption()]} />
      );

      fireEvent.click(screen.getByTestId('connect-ai-hosted-dnaforge-hosted-auto'));
      rerender(
        <ConnectAiModal open={false} onClose={onClose} hostedRouteOptions={[hostedOption()]} />
      );
      resolveRoute();
      await Promise.resolve();
      await Promise.resolve();

      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
