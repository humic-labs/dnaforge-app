/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentAuthResultShape, AgentTransport } from '../../../platform';
import { useAgentCliAuthFlow } from './useAgentCliAuthFlow';

const { authenticate, onAuthEvent, trackRendererEvent } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  onAuthEvent: vi.fn(),
  trackRendererEvent: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({ agentSdk: { authenticate, onAuthEvent } }),
}));
vi.mock('../../../lib/analytics', () => ({ trackRendererEvent }));

beforeEach(() => {
  vi.clearAllMocks();
  onAuthEvent.mockReturnValue(() => {});
  authenticate.mockImplementation(
    async (
      transport: AgentTransport,
      { authId }: { authId: string }
    ): Promise<AgentAuthResultShape> => ({
      authId,
      transport,
      ok: true,
      status: 'succeeded',
      command: [],
      output: '',
      durationMs: 1,
    })
  );
});
afterEach(cleanup);

it.each([
  ['authenticated', 'succeeded', 'none'],
  ['unauthenticated', 'failed', 'auth_not_detected'],
])(
  'observes the actual %s renderer publication separately from callback acceptance',
  async (auth, outcome, reason) => {
    const refreshAgentDetection = vi.fn().mockResolvedValue({ claudeCode: { auth } });
    const { result } = renderHook(() => useAgentCliAuthFlow({ refreshAgentDetection }));

    await act(async () => {
      await result.current.runAgentAuth('claude-agent-sdk');
    });

    expect(trackRendererEvent.mock.calls).toMatchObject([
      ['agent_auth_state_observed', { auth_stage: 'renderer_accepted', auth_outcome: 'started' }],
      [
        'agent_auth_state_observed',
        { auth_stage: 'renderer_published', auth_outcome: outcome, auth_reason: reason },
      ],
    ]);
    const operationId = trackRendererEvent.mock.calls[0][1].operation_id;
    expect(operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(trackRendererEvent.mock.calls[1][1].operation_id).toBe(operationId);
    expect(authenticate.mock.calls[0][1].authId).toBe(operationId);
  }
);
