// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: () => true,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => null,
  subscribeAnalyticsCaptureReady: () => () => {},
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
}));
const key = 'waypoint-assembly-color-scheme';
const originalSet = Storage.prototype.setItem;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('shared palette actual storage owner', () => {
  it('keeps active palette applied after quota failure, preserves durable bytes and deliberately retries', async () => {
    const prior = JSON.stringify({ state: { assemblyColorScheme: 'tailwind' }, version: 2 });
    localStorage.setItem(key, prior);
    const owner = await import('./color-scheme-store');
    let fail = true;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      name: string,
      value: string
    ) {
      if (fail && this === localStorage && name === key) {
        fail = false;
        throw new Error('private quota error');
      }
      originalSet.call(this, name, value);
    });
    owner.useAssemblyColorSchemeStore.getState().setAssemblyColorScheme('carbon');
    expect(owner.getActiveAssemblyColorScheme()).toBe('carbon');
    expect(localStorage.getItem(key)).toBe(prior);
    expect(owner.useAssemblyColorSchemeStore.getState().phase).toBe('unsaved');
    owner.useAssemblyColorSchemeStore.getState().hydrate(true);
    expect(owner.getActiveAssemblyColorScheme()).toBe('carbon');
    owner.useAssemblyColorSchemeStore.getState().setAssemblyColorScheme('carbon');
    expect(localStorage.getItem(key)).toBe(prior);
    owner.useAssemblyColorSchemeStore.getState().retryPersistence();
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toEqual({
      state: { assemblyColorScheme: 'carbon' },
      version: 2,
    });
    expect(owner.useAssemblyColorSchemeStore.getState().phase).toBe('saved');
    vi.resetModules();
    const reopened = await import('./color-scheme-store');
    expect(reopened.getActiveAssemblyColorScheme()).toBe('carbon');
  });
  it('retains versioned legacy migration and permits a fresh durable read after healthy publication', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ state: { assemblyColorScheme: 'tableau' }, version: 1 })
    );
    const owner = await import('./color-scheme-store');
    expect(owner.getActiveAssemblyColorScheme()).toBe('category10');
    localStorage.setItem(
      key,
      JSON.stringify({ state: { assemblyColorScheme: 'radix' }, version: 2 })
    );
    owner.useAssemblyColorSchemeStore.getState().hydrate(true);
    expect(owner.getActiveAssemblyColorScheme()).toBe('radix');
  });
  it('contains corrupt/unavailable storage while retaining a usable palette and explicit recovery', async () => {
    localStorage.setItem(key, 'not JSON');
    const owner = await import('./color-scheme-store');
    expect(owner.getActiveAssemblyColorScheme()).toBe('tailwind');
    expect(owner.useAssemblyColorSchemeStore.getState().phase).toBe('read_failed');
    localStorage.setItem(
      key,
      JSON.stringify({ state: { assemblyColorScheme: 'carbon' }, version: 2 })
    );
    owner.useAssemblyColorSchemeStore.getState().retryPersistence();
    expect(owner.getActiveAssemblyColorScheme()).toBe('carbon');
  });
  it('labels missing storage as session-only, rather than persisting to a memory substitute', async () => {
    vi.stubGlobal('localStorage', undefined);
    const owner = await import('./color-scheme-store');
    owner.useAssemblyColorSchemeStore.getState().setAssemblyColorScheme('carbon');
    expect(owner.getActiveAssemblyColorScheme()).toBe('carbon');
    expect(owner.useAssemblyColorSchemeStore.getState().phase).toBe('temporary');
  });
  it('does not call a malformed stored envelope a restored durable selection', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ state: { assemblyColorScheme: 'invalid sentinel' }, version: 2 })
    );
    const owner = await import('./color-scheme-store');
    expect(owner.getActiveAssemblyColorScheme()).toBe('tailwind');
    expect(owner.useAssemblyColorSchemeStore.getState().phase).toBe('idle');
  });
});
