// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { resolveCurrentAgentCaller } from './agent-caller';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('settles Stop while the sidecar address request is still pending', async () => {
  let resolveUrl: (url: string) => void = () => undefined;
  const getApiUrl = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveUrl = resolve;
      })
  );
  const fetch = vi.fn();
  vi.stubGlobal('electronAPI', { config: { getApiUrl } });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const result = resolveCurrentAgentCaller(controller.signal);
  const stopped = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(getApiUrl).toHaveBeenCalledOnce();
  controller.abort();
  await stopped;
  expect(fetch).not.toHaveBeenCalled();
  resolveUrl('http://127.0.0.1:8123');
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
});

it('bounds a stalled sidecar address lookup with the authority timeout', async () => {
  const timeout = new AbortController();
  const clock = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  vi.stubGlobal('electronAPI', { config: { getApiUrl: () => new Promise(() => undefined) } });
  const result = resolveCurrentAgentCaller();
  const failed = expect(result).rejects.toMatchObject({
    code: 'AGENT_AUTHORITY_UNAVAILABLE',
    retriable: true,
  });
  expect(clock).toHaveBeenCalledWith(10_000);
  timeout.abort(new DOMException('Authority timed out', 'TimeoutError'));
  await failed;
});
