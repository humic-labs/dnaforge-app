import { describe, expect, it } from 'vitest';
import { projectExternalAccessObservation } from './external-access-telemetry';

const created = {
  feature_area: 'tool_usage',
  operation_id: '418196a7-503b-4ec1-94c2-46503d0ee066',
  occurred_at_ms: 1_792_000_000_123,
  access_stage: 'grant_create',
  access_result: 'created',
  access_client: 'script',
  access_transport: 'http',
  access_scope_class: 'read',
  access_expiry_class: 'none',
  access_authority: 'committed_grant',
  access_execution: 'not_observed',
  access_usefulness: 'not_attested',
};

describe('external access observation privacy and authority', () => {
  it('retains the original domain clock and independent observation correlation', () => {
    expect(projectExternalAccessObservation(created)).toEqual(created);
  });
  it.each([
    'api_key',
    'key_hash',
    'grant_id',
    'client_name',
    'workspace',
    'url',
    'arguments',
    'result',
  ])('refuses an extra %s before touching its sensitive getter', (key) => {
    let reads = 0;
    const value = Object.defineProperty({ ...created }, key, {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('private getter');
      },
    });
    expect(projectExternalAccessObservation(value)).toBeNull();
    expect(reads).toBe(0);
  });
  it('rejects a getter even in a permitted field', () => {
    let reads = 0;
    const value = Object.defineProperty({ ...created }, 'access_client', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'private client';
      },
    });
    expect(projectExternalAccessObservation(value)).toBeNull();
    expect(reads).toBe(0);
  });
  it.each([
    { operation_id: 'agent_http_private_identity' },
    { operation_id: '418196a7-503b-7ec1-94c2-46503d0ee066' },
    { access_client: 'private caller label' },
    { access_usefulness: 'scientifically_successful' },
    { access_execution: 'completed' },
    { access_result: 'allowed' },
    { access_authority: 'committed_revoke' },
    { occurred_at_ms: NaN },
  ])('refuses identity substitution or unsupported authority: %j', (changes) => {
    expect(projectExternalAccessObservation({ ...created, ...changes })).toBeNull();
  });
  it('keeps admission distinct from an authorization result and execution', () => {
    const admitted = {
      ...created,
      access_stage: 'request_admitted',
      access_result: 'admitted',
      access_authority: 'admitted_job',
      access_execution: 'queued',
    };
    expect(projectExternalAccessObservation(admitted)).toEqual(admitted);
    expect(projectExternalAccessObservation({ ...admitted, access_result: 'allowed' })).toBeNull();
    expect(
      projectExternalAccessObservation({ ...admitted, access_execution: 'completed' })
    ).toBeNull();
  });
});
