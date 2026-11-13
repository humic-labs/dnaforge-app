import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../ipc/database', () => ({
  getDb: () => {
    throw new Error('no db in egress test');
  },
}));

async function startCaptureServer(
  received: string[]
): Promise<{ host: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') {
        try {
          buf = gunzipSync(buf);
        } catch {}
      }
      received.push(buf.toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe('main analytics — real posthog-node egress ', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    const analytics = await import('../analytics');
    await analytics.shutdownAnalytics().catch(() => {});
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.resetModules();
  });

  it('POSTs a captured event to the configured PostHog host with our key', async () => {
    const received: string[] = [];
    let host: string;
    ({ host, server } = await startCaptureServer(received));

    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(
      { POSTHOG_API_KEY: 'phc_test_egress_key', POSTHOG_HOST: host },
      { consent: 'true', version: '3', basis: 'explicit' }
    );
    analytics.syncAnalyticsIdentityContext({
      distinctId: '550e8400-e29b-41d4-a716-446655440001',
      sessionId: '550e8400-e29b-41d4-a716-446655440002',
      kind: 'anonymous',
      generation: 1,
    });

    analytics.trackMainProcessError('uncaught_exception');
    await analytics.shutdownAnalytics();

    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const body = received.join('\n');
    expect(received.length).toBeGreaterThan(0);
    expect(body).toContain('phc_test_egress_key');
    expect(body).toContain('desktop_main_error_captured');
    expect(body).toContain('550e8400-e29b-41d4-a716-446655440001');
    expect(body).toContain('550e8400-e29b-41d4-a716-446655440002');
  }, 20000);

  it('sends NOTHING when the user has explicitly opted out (consent=false)', async () => {
    const received: string[] = [];
    let host: string;
    ({ host, server } = await startCaptureServer(received));

    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(
      { POSTHOG_API_KEY: 'phc_test_egress_key', POSTHOG_HOST: host },
      { consent: 'false', version: '3' }
    );

    analytics.trackMainProcessError('uncaught_exception');
    await analytics.shutdownAnalytics();

    await new Promise((r) => setTimeout(r, 500));
    expect(received.length).toBe(0);
  }, 20000);
});
