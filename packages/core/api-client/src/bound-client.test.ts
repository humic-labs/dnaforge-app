import { afterEach, expect, it, vi } from 'vitest';
import { healthCheck } from './generated/api';
import {
  configureApiClient,
  createApiClient,
  resetApiClientConfigurationForTests,
} from './fetcher';

afterEach(resetApiClientConfigurationForTests);

it('keeps generated calls bound across asynchronous headers and default-client changes', async () => {
  let release!: () => void;
  const headersReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = vi.fn(
    async (_url: string | URL, _options?: RequestInit) =>
      new Response(JSON.stringify({ status: 'healthy' }), {
        headers: { 'Content-Type': 'application/json' },
      })
  );
  const configuration = {
    baseUrl: 'http://127.0.0.1:8101/',
    headers: async () => {
      await headersReady;
      return { 'X-Request-Owner': 'first' };
    },
    fetch: transport,
  };
  const first = createApiClient(configuration);
  const second = createApiClient({ baseUrl: 'http://127.0.0.1:8102', fetch: transport });
  configuration.baseUrl = 'http://127.0.0.1:8199';
  configureApiClient({ baseUrl: 'http://127.0.0.1:8188' });
  const controller = new AbortController();
  const pending = healthCheck(first.options({ signal: controller.signal }));
  await healthCheck(second.options());
  release();
  await pending;

  expect(transport.mock.calls.map(([url]) => url)).toEqual([
    'http://127.0.0.1:8102/health',
    'http://127.0.0.1:8101/health',
  ]);
  const request = transport.mock.calls[1][1]!;
  expect(request.signal).toBe(controller.signal);
  expect(new Headers(request.headers).get('X-Request-Owner')).toBe('first');
  expect(request).not.toHaveProperty('apiClient');
  expect(Object.isFrozen(first)).toBe(true);
});
