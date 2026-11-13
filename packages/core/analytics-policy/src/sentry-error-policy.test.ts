import { describe, expect, it } from 'vitest';
import { createSentryErrorPolicy, operationalFailureContext } from './sentry-error-policy';

describe('Sentry error admission', () => {
  it('drops ordinary messages at every nonfatal severity', () => {
    const policy = createSentryErrorPolicy();
    for (const level of ['debug', 'info', 'warning', 'error']) {
      expect(policy({ message: 'sidecar_ready', level })).toBeNull();
    }
    expect(policy({ type: 'default', message: 'sidecar_ready', level: 'info' })).toBeNull();
    expect(policy({ type: 'error', message: 'sidecar_ready', level: 'error' })).toBeNull();
    expect(policy({ type: 'default', logentry: { message: 'sidecar_ready' } })).toBeNull();
  });

  it('preserves every unknown exception and native crash during repeated failures', () => {
    const policy = createSentryErrorPolicy();
    const exception = {
      message: 'unexpected failure',
      exception: { values: [{ type: 'Error', value: 'failure', mechanism: { handled: true } }] },
    };
    const unhandled = {
      exception: { values: [{ mechanism: { handled: false } }] },
      ...operationalFailureContext('sidecar.start_failed'),
    };
    const native = { level: 'fatal', platform: 'native', message: 'renderer crashed' };
    for (let count = 0; count < 100; count += 1) {
      expect(policy(exception)).toBe(exception);
      expect(policy(unhandled)).toBe(unhandled);
      expect(policy(native)).toBe(native);
    }
  });

  it('preserves first and distinct operational failures and reports suppressed repeats', () => {
    let time = 1_000;
    const policy = createSentryErrorPolicy({ now: () => time, repeatWindowMs: 1_000 });
    const failure = () => ({
      message: 'sidecar_start_failed',
      release: '1.0.0',
      environment: 'closed_beta',
      contexts: { sidecar: { event_class: 'start_failed' } },
      ...operationalFailureContext('sidecar.start_failed'),
    });
    expect(policy(failure())).not.toBeNull();
    expect(policy(failure())).toBeNull();
    expect(policy(failure())).toBeNull();
    expect(policy({ ...failure(), release: '1.0.1' })).not.toBeNull();
    expect(
      policy({ ...failure(), ...operationalFailureContext('sidecar.health_timeout') })
    ).not.toBeNull();
    time += 1_000;
    expect(policy(failure())).toMatchObject({
      contexts: {
        sidecar: { event_class: 'start_failed' },
        error_reporting: { suppressed_repeats: 2, repeat_window_ms: 1_000 },
      },
    });
    time += 1_000;
    expect(policy(failure())).not.toHaveProperty('contexts.error_reporting');
  });

  it('bounds retained operation keys without suppressing a new failure', () => {
    const policy = createSentryErrorPolicy({ maxTrackedKeys: 2 });
    const failure = (operation: string) => ({
      message: operation,
      ...operationalFailureContext(operation),
    });
    expect(policy(failure('first'))).not.toBeNull();
    expect(policy(failure('second'))).not.toBeNull();
    expect(policy(failure('third'))).not.toBeNull();
    expect(policy(failure('third'))).toBeNull();
    expect(policy(failure('first'))).not.toBeNull();
  });

  it('limits default-typed operational messages and expires inactive counters', () => {
    let time = 1_000;
    const policy = createSentryErrorPolicy({ now: () => time });
    const failure = (operation: string) => ({
      type: 'default',
      message: operation,
      ...operationalFailureContext(operation),
    });
    expect(policy(failure('auth.session_decryption_unavailable'))).not.toBeNull();
    expect(policy(failure('auth.session_decryption_unavailable'))).toBeNull();
    time += 60 * 60 * 1000;
    expect(policy(failure('sidecar.start_failed'))).not.toBeNull();
    expect(policy(failure('auth.session_decryption_unavailable'))).not.toHaveProperty(
      'contexts.error_reporting.suppressed_repeats'
    );
  });

  it('allows the next failure when the clock moves backward', () => {
    let time = 1_000;
    const policy = createSentryErrorPolicy({ now: () => time });
    const failure = { message: 'failure', ...operationalFailureContext('sidecar.start_failed') };
    expect(policy(failure)).not.toBeNull();
    time -= 1;
    expect(policy(failure)).not.toBeNull();
  });

  it('preserves a newly opened incident after recovery inside the repetition window', () => {
    const policy = createSentryErrorPolicy();
    const failure = (incidentId: string) => ({
      message: 'database maintenance failed',
      ...operationalFailureContext('maintenance:database'),
      tags: {
        ...operationalFailureContext('maintenance:database').tags,
        error_incident_id: incidentId,
      },
    });
    expect(policy(failure('first'))).not.toBeNull();
    expect(policy(failure('first'))).toBeNull();
    expect(policy(failure('after-recovery'))).not.toBeNull();
  });
});
