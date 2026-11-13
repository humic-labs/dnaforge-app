// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAuthResultShape, AgentSdkDetectionShape } from '../../platform';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    agentSdk: {
      authenticate: vi.fn(),
      detect: vi.fn(),
      onAuthEvent: vi.fn(() => () => undefined),
    },
  },
}));

vi.mock('../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));
vi.mock('../../db', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/analytics', () => ({ trackRendererEvent: vi.fn(() => true) }));
vi.mock('./modelDiscovery', () => ({
  fetchProviderModels: vi.fn().mockResolvedValue({ models: [], error: null }),
}));
vi.mock('./hosted-gateway', () => ({
  getHostedRouteReadiness: vi.fn().mockResolvedValue('gateway-unavailable'),
}));

import { useAgentCliAuthFlow } from './hooks/useAgentCliAuthFlow';
import { useAISettingsStore } from './settings';

function detection(auth: 'authenticated' | 'unauthenticated'): AgentSdkDetectionShape {
  return {
    claudeCode: {
      cli: 'installed',
      path: '/fixture/bin/claude',
      auth,
      defaultModel: 'sonnet',
      keychainEntryPresent: null,
      credentialsFilePresent: auth === 'authenticated',
    },
    codex: {
      cli: 'missing',
      path: null,
      auth: 'unauthenticated',
      defaultModel: null,
      authMode: null,
      authFilePresent: false,
    },
    grok: {
      cli: 'missing',
      path: null,
      auth: 'unauthenticated',
      defaultModel: null,
    },
  };
}

function successfulAuth(): AgentAuthResultShape {
  return {
    authId: crypto.randomUUID(),
    transport: 'claude-agent-sdk',
    ok: true,
    status: 'completed',
    command: ['claude', 'auth', 'login', '--claudeai'],
    output: 'Signed in',
    durationMs: 20,
    detection: detection('authenticated'),
  };
}

describe(' native authentication publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.agentSdk.authenticate.mockResolvedValue(successfulAuth());
    useAISettingsStore.setState({
      agentDetection: detection('unauthenticated'),
      agentDetectError: null,
    });
  });

  it('publishes native sign-in and resolves the UI attempt before model discovery settles', async () => {
    let resolveDetection!: (value: AgentSdkDetectionShape) => void;
    mockPlatform.agentSdk.detect.mockReturnValue(
      new Promise<AgentSdkDetectionShape>((resolve) => {
        resolveDetection = resolve;
      })
    );
    const { result } = renderHook(() =>
      useAgentCliAuthFlow({
        refreshAgentDetection: useAISettingsStore.getState().refreshAgentDetection,
      })
    );
    let attempt!: Promise<AgentAuthResultShape>;
    let completed = false;
    act(() => {
      attempt = result.current.runAgentAuth('claude-agent-sdk');
      void attempt.then(() => {
        completed = true;
      });
    });
    try {
      await waitFor(() => {
        expect(useAISettingsStore.getState().agentDetection?.claudeCode.auth).toBe('authenticated');
        expect(completed).toBe(true);
        expect(result.current.authenticatingTransport).toBeNull();
      });
      expect(mockPlatform.agentSdk.authenticate).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        resolveDetection(detection('authenticated'));
        await attempt;
      });
    }
  });

  it('retains confirmed sign-in if later model enrichment fails', async () => {
    mockPlatform.agentSdk.detect.mockRejectedValue(new Error('Model catalog unavailable'));
    const { result } = renderHook(() =>
      useAgentCliAuthFlow({
        refreshAgentDetection: useAISettingsStore.getState().refreshAgentDetection,
      })
    );
    await act(async () => {
      await result.current.runAgentAuth('claude-agent-sdk');
    });
    expect(result.current.authResult?.ok).toBe(true);
    expect(useAISettingsStore.getState().agentDetection?.claudeCode.auth).toBe('authenticated');
    expect(useAISettingsStore.getState().agentDetectError).toBe('Model catalog unavailable');
  });
});
