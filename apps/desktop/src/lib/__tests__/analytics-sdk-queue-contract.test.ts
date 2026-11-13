// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

it('drops actual SDK batches at revocation and resumes only later captures', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  localStorage.clear();
  const sent: string[] = [];
  let failNextIngestion = false;
  function respond(target: string) {
    expect(new URL(target).hostname).toBe('127.0.0.1');
    sent.push(target);
    if (new URL(target).pathname === '/e/' && failNextIngestion) {
      failNextIngestion = false;
      return { status: 503, body: '{}' };
    }
    return { status: 200, body: JSON.stringify({ featureFlags: {}, sessionRecording: false }) };
  }
  const fetchBoundary = vi.fn(async function (this: unknown, url: string | URL | Request) {
    if (this !== undefined && this !== window && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    const reply = respond(String(url));
    return new Response(reply.body, { status: reply.status });
  });
  vi.stubGlobal('fetch', fetchBoundary);
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      withCredentials = false;
      readyState = 0;
      status = 0;
      responseText = '';
      onreadystatechange: (() => void) | null = null;
      private url = '';
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      send() {
        expect(this.withCredentials).toBe(false);
        const reply = respond(this.url);
        this.status = reply.status;
        this.responseText = reply.body;
        this.readyState = 4;
        queueMicrotask(() => this.onreadystatechange?.());
      }
    }
  );
  vi.stubGlobal('electronAPI', {
    analytics: {
      getRuntimeConfig: async () => ({
        apiKey: 'phc_test123',
        host: 'http://127.0.0.1:48123',
        appVersion: '1.0.0',
        platformFamily: 'macos',
        environment: 'test',
        releaseChannel: 'test',
        isSynthetic: true,
        telemetryActor: 'canary',
      }),
      setConsent: async () => {},
      persistConsent: async () => {},
      syncContext: async () => ({ accepted: true }),
    },
  });
  const analytics = await import('../analytics');
  try {
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
    expect(await analytics.initAnalyticsRenderer()).toBe(true);
    await analytics.optInAnalytics();
    await vi.advanceTimersByTimeAsync(4_000);
    sent.length = 0;

    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(true);
    expect(sent).toHaveLength(0);
    await analytics.optOutAnalytics();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(0);

    await analytics.optInAnalytics();
    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sent.some((url) => new URL(url).pathname === '/e/')).toBe(true);

    sent.length = 0;
    failNextIngestion = true;
    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'sequence',
      })
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(failNextIngestion).toBe(false);
    expect(sent.filter((url) => new URL(url).pathname === '/e/')).toHaveLength(1);
    await analytics.optOutAnalytics();
    sent.length = 0;
    await analytics.optInAnalytics();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toHaveLength(0);
    expect(fetchBoundary).not.toHaveBeenCalled();
  } finally {
    await analytics.optOutAnalytics();
    analytics.disposeAnalyticsPreidentityDiagnosticsForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});
