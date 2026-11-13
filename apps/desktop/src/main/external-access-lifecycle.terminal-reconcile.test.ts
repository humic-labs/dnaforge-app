import { afterEach, expect, it, vi } from 'vitest';
import { bindExternalAccessObservationSink } from './external-access-observation';
import { startExternalMcpRegistration } from './external-mcp-registration';

let stop = () => {};

afterEach(() => {
  stop();
  bindExternalAccessObservationSink(null);
  vi.useRealTimers();
});

it(' bounds one hour of packaged lifecycle registration to five checks and sixty observations', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  const sink = vi.fn(() => true);
  const detectClaudeCode = vi.fn(async () => ({ cli: 'missing' as const, path: null }));
  const detectCodex = vi.fn(async () => ({ cli: 'missing' as const, path: null }));
  const detectGrok = vi.fn(async () => ({ cli: 'missing' as const, path: null }));
  const registerDesktopClients = vi.fn(async () => []);
  bindExternalAccessObservationSink(sink);
  stop = startExternalMcpRegistration({
    isPackaged: true,
    resourcesPath: '/fixture/resources',
    detectClaudeCode,
    detectCodex,
    detectGrok,
    registerDesktopClients,
    run: vi.fn(async () => ({ ok: false, stdout: '' })),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(detectClaudeCode).toHaveBeenCalledTimes(1);
  expect(registerDesktopClients).toHaveBeenCalledTimes(1);
  expect(sink).toHaveBeenCalledTimes(3);

  await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

  expect
    .soft(detectClaudeCode.mock.calls.length, 'Claude registration checks')
    .toBeLessThanOrEqual(5);
  expect.soft(detectCodex.mock.calls.length, 'Codex registration checks').toBeLessThanOrEqual(5);
  expect.soft(detectGrok.mock.calls.length, 'Grok registration checks').toBeLessThanOrEqual(5);
  expect
    .soft(registerDesktopClients.mock.calls.length, 'desktop registration checks')
    .toBeLessThanOrEqual(5);
  expect
    .soft(sink.mock.calls.length, 'external_access_lifecycle_observed emissions')
    .toBeLessThanOrEqual(60);

  stop();
  const checksAtStop = registerDesktopClients.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
  expect(registerDesktopClients).toHaveBeenCalledTimes(checksAtStop);
});
