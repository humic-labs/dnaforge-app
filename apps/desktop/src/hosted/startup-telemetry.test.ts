// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { HostedStartupTrace } from './startup-telemetry';
import {
  parseHostedStartupObservation,
  type HostedStartupObservation,
} from '../shared/hosted-startup-telemetry';

describe('hosted startup observations', () => {
  it('preserves a failed step and its original diagnostic without sending its text', async () => {
    let now = 100;
    const emit = vi.fn<(observation: HostedStartupObservation) => void>();
    const trace = new HostedStartupTrace(emit, () => now, '11111111-1111-4111-8111-111111111111');
    await trace.run('platform_init', async () => {
      now = 120;
    });
    const error = Object.assign(
      new Error('private project path /hosted/secret and developer details'),
      { status: 503 }
    );
    await expect(
      trace.run('workspace_session', async () => {
        now = 160;
        throw error;
      })
    ).rejects.toBe(error);
    trace.report('failed', error);
    trace.report('failed', error);

    expect(emit).toHaveBeenCalledExactlyOnceWith({
      attemptId: '11111111-1111-4111-8111-111111111111',
      step: 'workspace_session',
      result: 'failed',
      errorClass: 'http_server',
      durationMs: 60,
      stepDurationMs: 40,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('secret');
    expect(parseHostedStartupObservation(emit.mock.calls[0][0])).toEqual(emit.mock.calls[0][0]);
  });

  it('does not call an expected sign-in a startup failure', async () => {
    const emit = vi.fn<(observation: HostedStartupObservation) => void>();
    const trace = new HostedStartupTrace(emit);
    await trace.run('workspace_session', () => undefined);
    trace.report('sign_in_required');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'sign_in_required', errorClass: 'none' })
    );
  });

  it('rejects raw diagnostics even beside a valid observation', () => {
    const observation = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      step: 'platform_init',
      result: 'failed',
      errorClass: 'unknown',
      durationMs: 10,
      stepDurationMs: 10,
    };
    expect(parseHostedStartupObservation(observation)).not.toBeNull();
    expect(parseHostedStartupObservation({ ...observation, message: 'VITE_API_URL' })).toBeNull();
    expect(
      parseHostedStartupObservation({ ...observation, step: 'internal arbitrary step' })
    ).toBeNull();
  });

  it('keeps telemetry recording failure from replacing the startup result', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const trace = new HostedStartupTrace(() => {
      throw new Error('telemetry unavailable');
    });
    expect(() => trace.report('failed', new Error('original startup failure'))).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
