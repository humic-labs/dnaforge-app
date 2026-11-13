// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { WindowZoomResult } from '../shared/window-zoom';
const ports = vi.hoisted(() => ({
  read: vi.fn<(key: string) => Promise<string | null>>(),
  write: vi.fn<(key: string, value: string) => Promise<void>>(),
  apply: vi.fn<(factor: number) => Promise<WindowZoomResult>>(),
  capture: vi.fn<(event: string, properties: Record<string, unknown>) => boolean>(() => true),
  browser: false,
}));
vi.mock('../db', () => ({ getSetting: ports.read, setSetting: ports.write }));
vi.mock('../platform', () => ({ platform: () => ({ window: { setZoomLevel: ports.apply } }) }));
vi.mock('../utils/environment', () => ({ isDesktopRuntime: () => !ports.browser }));
vi.mock('./analytics', () => ({
  trackRendererEvent: ports.capture,
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
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  ports.browser = false;
  ports.capture.mockReset().mockReturnValue(true);
  ports.read.mockReset().mockResolvedValue('1');
  ports.write.mockReset().mockResolvedValue(undefined);
  ports.apply.mockReset().mockImplementation(async (factor) => ({ status: 'applied', factor }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('display owner actual native application and durable write flow', () => {
  it('rejects a held old startup read after a newer accepted choice and shares ownership on reopen', async () => {
    const old = held<string | null>();
    ports.read.mockReturnValueOnce(old.promise);
    const owner = await import('./applyZoomLevel');
    const startup = owner.applyZoomLevel();
    await owner.setDisplayZoom(1.25);
    old.resolve('2');
    await startup;
    expect(owner.useDisplayZoomStore.getState()).toMatchObject({
      selectedFactor: 1.25,
      factor: 1.25,
      phase: 'saved',
    });
    expect(ports.apply.mock.calls).toEqual([[1.25]]);
    await owner.applyZoomLevel();
    expect(ports.read).toHaveBeenCalledTimes(1);
    ports.read.mockResolvedValue('1.2');
    await owner.applyZoomLevel(true);
    expect(owner.useDisplayZoomStore.getState()).toMatchObject({
      selectedFactor: 1.2,
      factor: 1.2,
      phase: 'saved',
    });
  });

  it('keeps actual applied scale selected after save rejection, preserves durable value and deliberately retries', async () => {
    let actual = 1;
    let durable = '1';
    ports.apply.mockImplementation(async (factor) => {
      actual = factor;
      return { status: 'applied', factor };
    });
    ports.write
      .mockRejectedValueOnce(new Error('SQLITE private preference sentinel'))
      .mockImplementation(async (_key, value) => {
        durable = value;
      });
    const owner = await import('./applyZoomLevel');
    await owner.setDisplayZoom(1.25);
    expect(actual).toBe(1.25);
    expect(durable).toBe('1');
    expect(owner.useDisplayZoomStore.getState()).toMatchObject({
      selectedFactor: 1.25,
      factor: 1.25,
      phase: 'unsaved',
    });
    await owner.applyZoomLevel(true);
    expect(ports.read).not.toHaveBeenCalled();
    await owner.setDisplayZoom(1.25);
    expect(ports.write).toHaveBeenCalledTimes(1);
    await owner.retryDisplayZoom();
    expect(actual).toBe(1.25);
    expect(durable).toBe('1.25');
    expect(ports.apply.mock.calls).toEqual([[1.25], [1.25]]);
    expect(owner.useDisplayZoomStore.getState().phase).toBe('saved');
    expect(JSON.stringify(ports.capture.mock.calls)).not.toContain('SQLITE private');
    expect(
      ports.capture.mock.calls.some(([, p]) => p.outcome_kind === 'preference_recovered')
    ).toBe(true);
  });

  it.each(['success', 'failure'] as const)(
    'serializes an old held save (%s) before the new revision without stale rollback',
    async (result) => {
      const old = held<void>();
      ports.write.mockReturnValueOnce(old.promise);
      const owner = await import('./applyZoomLevel');
      const first = owner.setDisplayZoom(1.25);
      await waitFor(() => expect(ports.write).toHaveBeenCalledTimes(1));
      const second = owner.setDisplayZoom(1.5);
      expect(owner.useDisplayZoomStore.getState().selectedFactor).toBe(1.5);
      expect(ports.apply).toHaveBeenCalledTimes(1);
      if (result === 'success') old.resolve(undefined);
      else old.reject(new Error('old failure'));
      await Promise.all([first, second]);
      expect(ports.apply.mock.calls).toEqual([[1.25], [1.5]]);
      expect(ports.write.mock.calls).toEqual([
        ['display_zoom', '1.25'],
        ['display_zoom', '1.5'],
      ]);
      expect(owner.useDisplayZoomStore.getState()).toMatchObject({
        selectedFactor: 1.5,
        factor: 1.5,
        phase: 'saved',
      });
    }
  );

  it('does not persist an old native acknowledgement after a newer accepted intent', async () => {
    const old = held<WindowZoomResult>();
    ports.apply.mockReturnValueOnce(old.promise);
    const owner = await import('./applyZoomLevel');
    const first = owner.setDisplayZoom(1.25);
    await waitFor(() => expect(ports.apply).toHaveBeenCalledTimes(1));
    const second = owner.setDisplayZoom(1.5);
    old.resolve({ status: 'applied', factor: 1.25 });
    await Promise.all([first, second]);
    expect(ports.write.mock.calls).toEqual([['display_zoom', '1.5']]);
    expect(owner.useDisplayZoomStore.getState().selectedFactor).toBe(1.5);
  });

  it('retains stale A actual readback when newer B owns selection but B native application refuses', async () => {
    const old = held<WindowZoomResult>();
    ports.apply
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ status: 'refused', reason: 'window_unavailable' });
    const owner = await import('./applyZoomLevel');
    const first = owner.setDisplayZoom(1.25);
    await waitFor(() => expect(ports.apply).toHaveBeenCalledTimes(1));
    const second = owner.setDisplayZoom(1.5);
    old.resolve({ status: 'applied', factor: 1.25 });
    await Promise.all([first, second]);
    expect(owner.useDisplayZoomStore.getState()).toMatchObject({
      factor: 1.25,
      selectedFactor: 1.5,
      phase: 'apply_failed',
    });
    expect(ports.write).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'refused', reason: 'window_unavailable' },
    { status: 'unavailable' },
    { status: 'failed', reason: 'apply_failed', factor: 1.1 },
    { status: 'applied', factor: 1.1 },
  ] satisfies WindowZoomResult[])('never saves an unconfirmed native result %j', async (result) => {
    ports.apply.mockResolvedValue(result);
    const owner = await import('./applyZoomLevel');
    await owner.setDisplayZoom(1.25);
    expect(ports.write).not.toHaveBeenCalled();
    expect(owner.useDisplayZoomStore.getState().phase).toBe('apply_failed');
  });

  it('contains read failure, supports deliberate reload and refuses unsupported stored factors without prefix parsing', async () => {
    const owner = await import('./applyZoomLevel');
    ports.read.mockRejectedValueOnce(new Error('private DB error'));
    await owner.applyZoomLevel();
    expect(owner.useDisplayZoomStore.getState().phase).toBe('read_failed');
    ports.read.mockResolvedValue('1.2');
    await owner.retryDisplayZoom();
    expect(owner.useDisplayZoomStore.getState().factor).toBe(1.2);
    const { parseWindowZoomFactor } = await import('../shared/window-zoom');
    for (const value of ['1.25junk', 'NaN', 'Infinity', '-1', '0', '9', ''])
      expect(parseWindowZoomFactor(value)).toBeNull();
    expect(parseWindowZoomFactor('0.25')).toBe(0.25);
    expect(parseWindowZoomFactor('5')).toBe(5);
  });

  it('keeps 4K default system-owned and browser/native-unavailable behavior distinct', async () => {
    vi.stubGlobal('screen', { height: 2160 });
    vi.stubGlobal('devicePixelRatio', 1);
    ports.read.mockResolvedValue(null);
    const owner = await import('./applyZoomLevel');
    await owner.applyZoomLevel();
    expect(ports.apply).toHaveBeenCalledWith(2);
    expect(ports.write).toHaveBeenCalledWith('display_zoom', '2');
    expect(
      ports.capture.mock.calls.some(
        ([, p]) => p.workflow_origin === 'projection' && p.workflow === 'appearance_display'
      )
    ).toBe(true);
    ports.browser = true;
    ports.apply.mockClear();
    ports.write.mockClear();
    await owner.setDisplayZoom(1.5);
    expect(ports.apply).not.toHaveBeenCalled();
    expect(ports.write).not.toHaveBeenCalled();
    expect(owner.useDisplayZoomStore.getState().phase).toBe('apply_failed');
  });
});
