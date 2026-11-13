import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostedPolicy } from '../test/hosted-contribution-fixtures';
import { useHostedContributionStore as store } from './hosted-contribution-store';
import type { HostedContributionSettingsResult } from '../features/ai/hosted-contribution-client';

const request = vi.hoisted(() => vi.fn());
vi.mock('../features/ai/hosted-contribution-client', () => ({
  getHostedContributionSettings: (...args: unknown[]) => request(...args),
}));
const session = { accountId: 'account-a', desktopSessionId: 'session-a' };
const withdrawn = {
  ...hostedPolicy(true),
  account_plan_setting: 'never_corpus' as const,
  plan_authority_basis: 'signin_default' as const,
  contribution_choice: 'withdrawn' as const,
};
function pending() {
  let resolve!: (value: HostedContributionSettingsResult) => void;
  const promise = new Promise<HostedContributionSettingsResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function hydrate() {
  store.getState().setSession(session);
  await store.getState().refresh();
}

describe('account research preference display and saves', () => {
  beforeEach(() => {
    store.getState().setSession(null);
    localStorage.clear();
    request.mockReset().mockResolvedValue({ ok: true, policy: hostedPolicy() });
  });
  it('hydrates on sign-in and reuses confirmed state during a background refresh', async () => {
    await hydrate();
    request.mockReturnValueOnce(pending().promise);
    void store.getState().refresh();
    expect(store.getState()).toMatchObject({ enabled: true, saving: false, error: null });
  });
  it('loads a confirmed cold-start snapshot only for the matching account', () => {
    localStorage.setItem(
      'dnaforge.hosted-research-preference.v1',
      JSON.stringify({ accountId: session.accountId, policy: withdrawn })
    );
    request.mockReturnValue(pending().promise);
    store.getState().setSession(session);
    expect(store.getState().enabled).toBe(false);
    store.getState().setSession({ accountId: 'account-b', desktopSessionId: 'session-b' });
    expect(store.getState().policy).toBeNull();
    expect(store.getState().enabled).toBeNull();
  });
  it('keeps the latest rapid click and serializes saves without disabling the UI', async () => {
    await hydrate();
    const first = pending();
    const second = pending();
    request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    store.getState().setEnabled(false);
    store.getState().setEnabled(true);
    expect(store.getState()).toMatchObject({ enabled: true, saving: true });
    expect(request.mock.calls).toEqual([[], ['withdrawn']]);
    first.resolve({ ok: true, policy: withdrawn });
    await vi.waitFor(() => expect(request.mock.calls).toEqual([[], ['withdrawn'], ['joined']]));
    expect(store.getState().enabled).toBe(true);
    let finished = false;
    const waiting = store
      .getState()
      .waitForSave()
      .then(() => {
        finished = true;
      });
    await Promise.resolve();
    expect(finished).toBe(false);
    second.resolve({ ok: true, policy: hostedPolicy(true) });
    await waiting;
    expect(store.getState()).toMatchObject({ enabled: true, saving: false });
  });
  it('coalesces off/on/off while preserving the first opt-out request', async () => {
    await hydrate();
    const save = pending();
    request.mockReturnValueOnce(save.promise);
    store.getState().setEnabled(false);
    store.getState().setEnabled(true);
    store.getState().setEnabled(false);
    expect(store.getState().enabled).toBe(false);
    save.resolve({ ok: true, policy: withdrawn });
    await store.getState().waitForSave();
    expect(request.mock.calls).toEqual([[], ['withdrawn']]);
  });
  it('rolls back a failed save and retries the requested change instead of just reading', async () => {
    await hydrate();
    request.mockResolvedValueOnce({ ok: false, error: 'Save failed.' });
    store.getState().setEnabled(false);
    expect(await store.getState().waitForSave()).toBe('Save failed.');
    expect(store.getState()).toMatchObject({ enabled: true, failedEnabled: false });
    await store.getState().refresh();
    expect(store.getState().error).toBe('Save failed.');
    request.mockResolvedValueOnce({ ok: true, policy: withdrawn });
    store.getState().retry();
    expect(await store.getState().waitForSave()).toBeNull();
    expect(request.mock.calls).toEqual([[], ['withdrawn'], [], ['withdrawn']]);
    expect(store.getState().enabled).toBe(false);
  });
  it('ignores a background response started before a local edit', async () => {
    await hydrate();
    const read = pending();
    request.mockReturnValueOnce(read.promise);
    const refreshing = store.getState().refresh();
    request.mockResolvedValueOnce({ ok: true, policy: withdrawn });
    store.getState().setEnabled(false);
    await store.getState().waitForSave();
    read.resolve({ ok: true, policy: hostedPolicy() });
    await refreshing;
    expect(store.getState().enabled).toBe(false);
    expect(store.getState().policy).toEqual(withdrawn);
  });
  it('ignores a late save after the account/session changes', async () => {
    await hydrate();
    const save = pending();
    request.mockReturnValueOnce(save.promise);
    store.getState().setEnabled(false);
    store.getState().setSession({ accountId: 'account-b', desktopSessionId: 'session-b' });
    await store.getState().refresh();
    save.resolve({ ok: true, policy: withdrawn });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState()).toMatchObject({ sessionKey: 'account-b:session-b', enabled: true });
  });
  it('ignores a malformed snapshot and clears account data on sign-out', async () => {
    localStorage.setItem(
      'dnaforge.hosted-research-preference.v1',
      JSON.stringify({
        accountId: session.accountId,
        policy: { account_plan_setting: 'research_contribution' },
      })
    );
    const read = pending();
    request.mockReturnValueOnce(read.promise);
    store.getState().setSession(session);
    expect(store.getState().enabled).toBeNull();
    read.resolve({ ok: true, policy: hostedPolicy() });
    await store.getState().refresh();
    store.getState().setSession(null);
    expect(localStorage.getItem('dnaforge.hosted-research-preference.v1')).toBeNull();
    expect(store.getState().policy).toBeNull();
  });
});
