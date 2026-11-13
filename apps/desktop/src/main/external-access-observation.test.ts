import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindExternalAccessObservationSink,
  observeExternalAccess,
  observeExternalRegistration,
} from './external-access-observation';
import type { ExternalAccessObservation } from '../shared/external-access-telemetry';

afterEach(() => bindExternalAccessObservationSink(null));
describe('native external configuration observations', () => {
  it('records closed native outcomes with random observation IDs, not native config identities', () => {
    const sink = vi.fn<(observation: ExternalAccessObservation) => boolean>(() => true);
    bindExternalAccessObservationSink(sink);
    const before = Date.now();
    observeExternalRegistration('Grok Build', 'repaired');
    observeExternalRegistration('private client label', 'failed');
    expect(sink).toHaveBeenCalledTimes(2);
    const [first, second] = sink.mock.calls.map((args) => args[0]);
    expect(first).toMatchObject({
      access_client: 'grok_build',
      access_result: 'repaired',
      access_authority: 'native_configuration',
      access_scope_class: 'not_observed',
      access_expiry_class: 'not_observed',
      access_execution: 'not_observed',
      access_usefulness: 'not_attested',
    });
    expect(first.occurred_at_ms).toBeGreaterThanOrEqual(before);
    expect(first.operation_id).not.toBe(second.operation_id);
    expect(JSON.stringify(sink.mock.calls)).not.toContain('private client label');
  });
  it('does not replay observations after a sink is installed or propagate sink failure', () => {
    observeExternalRegistration('Codex', 'registered');
    const sink = vi.fn(() => {
      throw new Error('observation sink unavailable');
    });
    bindExternalAccessObservationSink(sink);
    expect(sink).not.toHaveBeenCalled();
    expect(() => observeExternalRegistration('Codex', 'registered')).not.toThrow();
    expect(observeExternalAccess({ apiKey: 'not-observation-data' })).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
