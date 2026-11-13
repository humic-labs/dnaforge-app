// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { DesktopAuthState } from '../shared/auth-types';
import {
  RendererAnalyticsIdentityCoordinator,
  type RendererAnalyticsIdentitySdk,
} from './analytics-identity';

vi.mock('@waypoint/analytics-policy', async (importOriginal) => {
  const policy = await importOriginal<typeof import('@waypoint/analytics-policy')>();
  const digests = new Map([
    [policy.internalOperatorEmailDigest('operator-b@example.invalid'), 'operator_b' as const],
  ]);
  return {
    ...policy,
    classifyInternalOperator: (value: unknown) =>
      policy.classifyInternalOperatorWithDigests(value, digests),
  };
});

const ACCOUNT_A = '550e8400-e29b-41d4-a716-446655440001';
const ACCOUNT_B = '550e8400-e29b-41d4-a716-446655440002';
const ANON_A = '550e8400-e29b-41d4-a716-446655440010';
const ANON_B = '550e8400-e29b-41d4-a716-446655440011';
const ANON_C = '550e8400-e29b-41d4-a716-446655440012';
const SESSION_A = '550e8400-e29b-41d4-a716-446655440020';
const SESSION_B = '550e8400-e29b-41d4-a716-446655440021';
const SESSION_C = '550e8400-e29b-41d4-a716-446655440022';
const RENDERER_INSTANCE = '550e8400-e29b-41d4-a716-446655440030';

function signedIn(accountId: string): DesktopAuthState {
  return {
    status: 'signed-in',
    session: {
      accountId,
      desktopSessionId: 'desktop-session',
      email: 'DNA1598_EMAIL@example.com',
      displayName: 'DNA1598_PRIVATE_NAME',
      channel: 'stable',
      accessTokenExpiresAt: '2026-07-22T00:00:00.000Z',
    },
  };
}

function createSdk(): RendererAnalyticsIdentitySdk & {
  setIds(distinctId: string, sessionId: string): void;
} {
  let distinctId = ANON_A;
  let sessionId = SESSION_A;
  let resetCount = 0;
  return {
    getDistinctId: vi.fn(() => distinctId),
    getSessionId: vi.fn(() => sessionId),
    identify: vi.fn((accountId: string) => {
      distinctId = accountId;
    }),
    reset: vi.fn(() => {
      resetCount += 1;
      distinctId = resetCount === 1 ? ANON_B : ANON_C;
      sessionId = resetCount === 1 ? SESSION_B : SESSION_C;
    }),
    optIn: vi.fn(),
    setIds(nextDistinctId, nextSessionId) {
      distinctId = nextDistinctId;
      sessionId = nextSessionId;
    },
  };
}

describe('renderer analytics identity coordinator', () => {
  it.each([
    { email: 'DNA1598_EMAIL@example.com', operator: undefined },
    { email: 'operator-b@example.invalid', operator: 'operator_b' },
  ])(
    'identifies only the account UUID and bounded operator label: $operator',
    async ({ email, operator }) => {
      const state = signedIn(ACCOUNT_A);
      if (state.status !== 'signed-in') throw new Error('Expected the signed-in test fixture.');
      const sdk = createSdk();
      const syncContext = vi.fn().mockResolvedValue({ accepted: true });
      const coordinator = new RendererAnalyticsIdentityCoordinator({
        sdk,
        syncContext,
        rendererInstanceId: RENDERER_INSTANCE,
      });

      await expect(
        coordinator.applyAuthState({
          ...state,
          session: { ...state.session, email, displayName: 'PRIVATE_PERSON_NAME_1452' },
        })
      ).resolves.toBe(true);

      expect(sdk.identify).toHaveBeenCalledExactlyOnceWith(
        ACCOUNT_A,
        operator ? { internal_operator: operator } : {}
      );
      expect(syncContext).toHaveBeenCalledExactlyOnceWith({
        distinctId: ACCOUNT_A,
        sessionId: SESSION_A,
        kind: 'identified',
        generation: 1,
        rendererInstanceId: RENDERER_INSTANCE,
      });
    }
  );

  it('waits for authoritative auth hydration before the first main context sync', async () => {
    const sdk = createSdk();
    const syncContext = vi.fn().mockResolvedValue({ accepted: true });
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
    });

    await coordinator.applyAuthState({ status: 'starting' });
    expect(syncContext).not.toHaveBeenCalled();

    await coordinator.applyAuthState({ status: 'signed-out' });
    expect(syncContext).toHaveBeenCalledWith({
      distinctId: ANON_A,
      sessionId: SESSION_A,
      kind: 'anonymous',
      generation: 1,
      rendererInstanceId: RENDERER_INSTANCE,
    });
  });

  it('does not publish identified until PostHog distinct_id equals the account UUID', async () => {
    let distinctId = ANON_A;
    const sdk: RendererAnalyticsIdentitySdk & { bind(): void } = {
      getDistinctId: vi.fn(() => distinctId),
      getSessionId: vi.fn(() => SESSION_A),
      identify: vi.fn(),
      reset: vi.fn(),
      optIn: vi.fn(),
      bind() {
        distinctId = ACCOUNT_A;
      },
    };
    const syncContext = vi.fn().mockResolvedValue({ accepted: true });
    const onAccountIdentified = vi.fn();
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
      onAccountIdentified,
      wait: async () => {
        sdk.bind();
      },
    });

    const accepted = await coordinator.applyAuthState(signedIn(ACCOUNT_A));

    expect(accepted).toBe(true);
    expect(sdk.identify).toHaveBeenCalledWith(ACCOUNT_A, {});
    expect(onAccountIdentified).toHaveBeenCalledWith(ACCOUNT_A);
    expect(syncContext).toHaveBeenCalledTimes(1);
    expect(syncContext).toHaveBeenCalledWith({
      distinctId: ACCOUNT_A,
      sessionId: SESSION_A,
      kind: 'identified',
      generation: 1,
      rendererInstanceId: RENDERER_INSTANCE,
    });
  });

  it('refuses to publish identified when PostHog never binds the account UUID', async () => {
    let clock = 0;
    const sdk = createSdk();
    sdk.identify = vi.fn();
    const syncContext = vi.fn().mockResolvedValue({ accepted: true });
    const onAccountIdentified = vi.fn();
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
      onAccountIdentified,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    });

    const accepted = await coordinator.applyAuthState(signedIn(ACCOUNT_A));

    expect(accepted).toBe(false);
    expect(sdk.identify).toHaveBeenCalledWith(ACCOUNT_A, {});
    expect(onAccountIdentified).not.toHaveBeenCalled();
    expect(syncContext).not.toHaveBeenCalled();
  });

  it('identifies with only the canonical account UUID before synchronizing main', async () => {
    const sdk = createSdk();
    const syncContext = vi.fn().mockResolvedValue({ accepted: true });
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
    });

    await coordinator.applyAuthState(signedIn(ACCOUNT_A));

    expect(sdk.identify).toHaveBeenCalledWith(ACCOUNT_A, {});
    expect(syncContext).toHaveBeenCalledWith({
      distinctId: ACCOUNT_A,
      sessionId: SESSION_A,
      kind: 'identified',
      generation: 1,
      rendererInstanceId: RENDERER_INSTANCE,
    });
    expect(JSON.stringify(syncContext.mock.calls)).not.toContain('DNA1598_EMAIL');
    expect(JSON.stringify(syncContext.mock.calls)).not.toContain('DNA1598_PRIVATE_NAME');
  });

  it('rotates device and session IDs on logout and reapplies app-owned consent', async () => {
    const sdk = createSdk();
    const syncContext = vi.fn().mockResolvedValue({ accepted: true });
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
    });

    await coordinator.applyAuthState(signedIn(ACCOUNT_A));
    await coordinator.applyAuthState({ status: 'signed-out' });

    expect(sdk.reset).toHaveBeenCalledWith(true);
    expect(sdk.optIn).toHaveBeenCalledTimes(1);
    expect(syncContext).toHaveBeenLastCalledWith({
      distinctId: ANON_B,
      sessionId: SESSION_B,
      kind: 'anonymous',
      generation: 2,
      rendererInstanceId: RENDERER_INSTANCE,
    });
  });

  it('keeps two accounts on one device in separate identity domains', async () => {
    const sdk = createSdk();
    const contexts: unknown[] = [];
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      rendererInstanceId: RENDERER_INSTANCE,
      syncContext: async (context) => {
        contexts.push(context);
        return { accepted: true };
      },
    });

    await coordinator.applyAuthState({ status: 'signed-out' });
    await coordinator.applyAuthState(signedIn(ACCOUNT_A));
    await coordinator.applyAuthState({ status: 'signed-out' });
    await coordinator.applyAuthState(signedIn(ACCOUNT_B));

    expect(contexts).toEqual([
      {
        distinctId: ANON_A,
        sessionId: SESSION_A,
        kind: 'anonymous',
        generation: 1,
        rendererInstanceId: RENDERER_INSTANCE,
      },
      {
        distinctId: ACCOUNT_A,
        sessionId: SESSION_A,
        kind: 'identified',
        generation: 2,
        rendererInstanceId: RENDERER_INSTANCE,
      },
      {
        distinctId: ANON_B,
        sessionId: SESSION_B,
        kind: 'anonymous',
        generation: 3,
        rendererInstanceId: RENDERER_INSTANCE,
      },
      {
        distinctId: ACCOUNT_B,
        sessionId: SESSION_B,
        kind: 'identified',
        generation: 4,
        rendererInstanceId: RENDERER_INSTANCE,
      },
    ]);
  });

  it('rejects a stale async transition before it can overwrite a newer auth state', async () => {
    const sdk = createSdk();
    let releaseFirst: (() => void) | undefined;
    const firstSyncBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const contexts: unknown[] = [];
    const syncContext = vi.fn(async (context) => {
      if (contexts.length === 0) await firstSyncBlocked;
      contexts.push(context);
      return { accepted: true };
    });
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
    });

    const first = coordinator.applyAuthState(signedIn(ACCOUNT_A));
    const second = coordinator.applyAuthState({ status: 'signed-out' });
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(contexts.at(-1)).toEqual({
      distinctId: ANON_B,
      sessionId: SESSION_B,
      kind: 'anonymous',
      generation: 2,
      rendererInstanceId: RENDERER_INSTANCE,
    });
  });

  it('fails closed for non-UUID identifiers and does not send a malformed context', async () => {
    const sdk = createSdk();
    const syncContext = vi.fn().mockResolvedValue({ accepted: true });
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
    });

    await coordinator.applyAuthState(signedIn('supabase-user-or-email'));
    sdk.setIds('not-a-uuid', SESSION_A);
    await coordinator.applyAuthState({ status: 'signed-out' });

    expect(syncContext).not.toHaveBeenCalled();
  });

  it('rotates a persisted identified account after reload before publishing signed-out state', async () => {
    const sdk = createSdk();
    sdk.setIds(ACCOUNT_A, SESSION_A);
    const syncContext = vi.fn().mockResolvedValue({ accepted: true });
    const onIdentityCleared = vi.fn();
    const coordinator = new RendererAnalyticsIdentityCoordinator({
      sdk,
      syncContext,
      rendererInstanceId: RENDERER_INSTANCE,
      initialAccountId: ACCOUNT_A,
      onIdentityCleared,
    });

    await expect(coordinator.applyAuthState({ status: 'signed-out' })).resolves.toBe(true);

    expect(sdk.reset).toHaveBeenCalledWith(true);
    expect(onIdentityCleared).toHaveBeenCalledOnce();
    expect(syncContext).toHaveBeenCalledWith({
      distinctId: ANON_B,
      sessionId: SESSION_B,
      kind: 'anonymous',
      generation: 1,
      rendererInstanceId: RENDERER_INSTANCE,
    });
  });
});
