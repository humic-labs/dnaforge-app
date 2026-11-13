// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
const ports = vi.hoisted(() => ({
  read: vi.fn<(key: string) => Promise<string | null>>(),
  write: vi.fn<(key: string, value: string) => Promise<void>>(),
  capture: vi.fn(() => true),
  desktop: true,
}));
vi.mock('../../db', () => ({ getSetting: ports.read, setSetting: ports.write }));
vi.mock('../../utils/environment', () => ({ isDesktopRuntime: () => ports.desktop }));
vi.mock('../../lib/analytics', () => ({
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
  ports.desktop = true;
  ports.read.mockReset().mockResolvedValue('auto');
  ports.write.mockReset().mockResolvedValue(undefined);
  ports.capture.mockClear();
});
afterEach(() => {
  cleanup();
});
describe('WebGL owner read/publication/write order through its real viewer hook', () => {
  it('keeps new policy when held initial read returns, and across viewer remount while unsaved', async () => {
    const old = held<string | null>();
    ports.read.mockReturnValueOnce(old.promise);
    const owner = await import('./webgl-performance-preference');
    function Viewer() {
      return <output>{owner.useWebGLPerformancePreference()}</output>;
    }
    const view = render(<Viewer />);
    expect(screen.getByText('auto')).toBeInTheDocument();
    ports.write.mockRejectedValueOnce(new Error('save refused'));
    await act(async () => {
      await owner.setWebGLPerformancePreference('quality');
    });
    expect(screen.getByText('quality')).toBeInTheDocument();
    await act(async () => {
      old.resolve('auto');
    });
    expect(screen.getByText('quality')).toBeInTheDocument();
    expect(owner.useWebGLPreferenceStore.getState().phase).toBe('unsaved');
    view.unmount();
    render(<Viewer />);
    expect(screen.getByText('quality')).toBeInTheDocument();
    expect(ports.read).toHaveBeenCalledTimes(1);
    await act(async () => {
      await owner.retryWebGLPerformancePreference();
    });
    expect(owner.useWebGLPreferenceStore.getState().phase).toBe('saved');
  });

  it.each(['success', 'failure'] as const)(
    'serializes old save %s and never republishes its old choice after the new one',
    async (result) => {
      const owner = await import('./webgl-performance-preference');
      const old = held<void>();
      ports.write.mockReturnValueOnce(old.promise);
      const events: unknown[] = [];
      const listener = (event: Event) => {
        if (event instanceof CustomEvent) events.push(event.detail.value);
      };
      window.addEventListener(owner.WEBGL_PERFORMANCE_SETTING_EVENT, listener);
      try {
        const first = owner.setWebGLPerformancePreference('quality');
        await waitFor(() => expect(ports.write).toHaveBeenCalledTimes(1));
        const second = owner.setWebGLPerformancePreference('stability');
        expect(events).toEqual(['quality', 'stability']);
        expect(ports.write).toHaveBeenCalledTimes(1);
        if (result === 'success') old.resolve(undefined);
        else old.reject(new Error('old failure'));
        await Promise.all([first, second]);
        expect(events).toEqual(['quality', 'stability']);
        expect(owner.useWebGLPreferenceStore.getState()).toMatchObject({
          value: 'stability',
          phase: 'saved',
        });
        expect(ports.write.mock.calls.map(([, value]) => value)).toEqual(['quality', 'stability']);
      } finally {
        window.removeEventListener(owner.WEBGL_PERFORMANCE_SETTING_EVENT, listener);
      }
    }
  );

  it('publishes an applied-but-unsaved policy immediately and retries storage without duplicate display publication', async () => {
    const owner = await import('./webgl-performance-preference');
    let durable = 'auto';
    ports.write
      .mockRejectedValueOnce(new Error('private DB refusal'))
      .mockImplementation(async (_key, value) => {
        durable = value;
      });
    const event = vi.fn();
    window.addEventListener(owner.WEBGL_PERFORMANCE_SETTING_EVENT, event);
    try {
      await owner.setWebGLPerformancePreference('quality');
      expect(owner.useWebGLPreferenceStore.getState()).toMatchObject({
        value: 'quality',
        phase: 'unsaved',
      });
      expect(durable).toBe('auto');
      await owner.setWebGLPerformancePreference('quality');
      expect(ports.write).toHaveBeenCalledTimes(1);
      await owner.retryWebGLPerformancePreference();
      expect(durable).toBe('quality');
      expect(event).toHaveBeenCalledTimes(1);
      ports.read.mockResolvedValue('stability');
      await owner.hydrateWebGLPerformancePreference(true);
      expect(owner.useWebGLPreferenceStore.getState()).toMatchObject({
        value: 'stability',
        phase: 'saved',
      });
    } finally {
      window.removeEventListener(owner.WEBGL_PERFORMANCE_SETTING_EVENT, event);
    }
  });

  it('contains failed/invalid initial reads and refuses invalid/no-op changes without a write', async () => {
    ports.read.mockRejectedValueOnce(new Error('private load failure'));
    const owner = await import('./webgl-performance-preference');
    await owner.hydrateWebGLPerformancePreference();
    expect(owner.useWebGLPreferenceStore.getState()).toMatchObject({
      value: 'auto',
      phase: 'read_failed',
    });
    await owner.setWebGLPerformancePreference('auto');
    await owner.setWebGLPerformancePreference('unrecognized sentinel');
    expect(ports.write).not.toHaveBeenCalled();
    ports.read.mockResolvedValue('unrecognized stored sentinel');
    await owner.retryWebGLPerformancePreference();
    expect(owner.useWebGLPreferenceStore.getState()).toMatchObject({
      value: 'auto',
      phase: 'idle',
    });
  });

  it('retries a failed display publication before saving, while successful unsaved retries need no second publication', async () => {
    const owner = await import('./webgl-performance-preference');
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementationOnce(() => {
      throw new Error('display publication refused');
    });
    try {
      await owner.setWebGLPerformancePreference('quality');
      expect(owner.useWebGLPreferenceStore.getState().phase).toBe('apply_failed');
      expect(ports.write).not.toHaveBeenCalled();
      await owner.retryWebGLPerformancePreference();
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(ports.write).toHaveBeenCalledTimes(1);
      expect(owner.useWebGLPreferenceStore.getState().phase).toBe('saved');
    } finally {
      dispatch.mockRestore();
    }
  });
  it('applies an external preference event to the store the viewer reads', async () => {
    const owner = await import('./webgl-performance-preference');
    function Viewer() {
      return <output>{owner.useWebGLPerformancePreference()}</output>;
    }
    render(<Viewer />);
    await waitFor(() => expect(ports.read).toHaveBeenCalled());
    expect(screen.getByText('auto')).toBeInTheDocument();
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(owner.WEBGL_PERFORMANCE_SETTING_EVENT, {
          detail: { value: 'stability' },
        })
      );
    });
    expect(screen.getByText('stability')).toBeInTheDocument();
    expect(owner.useWebGLPreferenceStore.getState()).toMatchObject({ value: 'stability' });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(owner.WEBGL_PERFORMANCE_SETTING_EVENT, {
          detail: { value: 'quality' },
        })
      );
    });
    expect(screen.getByText('quality')).toBeInTheDocument();
    expect(ports.write.mock.calls.map(([, value]) => value)).toEqual(['stability', 'quality']);
    const events: unknown[] = [];
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) events.push(event.detail);
    };
    window.addEventListener(owner.WEBGL_PERFORMANCE_SETTING_EVENT, listener);
    try {
      await act(async () => {
        await owner.setWebGLPerformancePreference('stability');
      });
      expect(events).toEqual([{ value: 'stability', revision: expect.any(Number) }]);
      expect(ports.write.mock.calls.map(([, value]) => value)).toEqual([
        'stability',
        'quality',
        'stability',
      ]);
    } finally {
      window.removeEventListener(owner.WEBGL_PERFORMANCE_SETTING_EVENT, listener);
    }
  });
  it('labels browser-memory preference storage temporary rather than durable or restored', async () => {
    ports.desktop = false;
    const owner = await import('./webgl-performance-preference');
    await owner.hydrateWebGLPerformancePreference();
    expect(owner.useWebGLPreferenceStore.getState().phase).toBe('temporary');
    await owner.setWebGLPerformancePreference('quality');
    expect(ports.write).toHaveBeenCalledWith(owner.WEBGL_PERFORMANCE_SETTING_KEY, 'quality');
    expect(owner.useWebGLPreferenceStore.getState()).toMatchObject({
      value: 'quality',
      phase: 'temporary',
    });
  });
});
