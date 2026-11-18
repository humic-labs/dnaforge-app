import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureOrganizationInventoryAgentConnection,
  createOrganizationInventoryAgentClaimsClient,
  type OrganizationInventoryAgentConnection,
  type OrganizationInventoryAgentLeaseRequest,
} from './organization-inventory-agent-claims';
import { nativeDocumentCommandEnv, sidecarSessionAuthority } from './sidecar-session-runtime';

vi.mock('./config', () => ({ getApiUrl: () => 'http://127.0.0.1:8012' }));
vi.mock('./sidecar-session-runtime', () => ({
  sidecarSessionAuthority: {
    snapshot: vi.fn(() => ({ owner: 'electron', state: 'ready', generation: 1, token: 'session' })),
    isCurrent: vi.fn(() => true),
    nativeDocumentAuthority: vi.fn(() => ({ token: 'native', ownerInstanceId: 'native-owner' })),
  },
  nativeDocumentCommandEnv: vi.fn(() => ({
    DNAFORGE_NATIVE_DOCUMENT_URL: 'http://127.0.0.1:8013',
  })),
}));

const request: OrganizationInventoryAgentLeaseRequest = {
  schema: 'dnaforge.organization-inventory-agent-lease.v1',
  delegationId: 'delegation-one',
  delegationIncarnation: 'incarnation-one',
  accountId: '11111111-1111-1111-1111-111111111111',
  desktopSessionId: '22222222-2222-2222-2222-222222222222',
  target: {
    kind: 'organization-inventory',
    orgId: '33333333-3333-3333-3333-333333333333',
    inventoryId: '44444444-4444-4444-4444-444444444444',
  },
  flightId: 'flight-one',
  purpose: { kind: 'observe', operation: 'snapshot' },
};
const policy = {
  kind: 'policy',
  agentIdentityId: 'agent one',
  nativeOwnerInstanceId: 'native-owner',
  policy: null,
};
const denied = { kind: 'denied', code: 'ORGANIZATION_CLAIM_NOT_LIVE', message: 'Not enrolled.' };
const granted = (body: OrganizationInventoryAgentLeaseRequest = request, validForMs = 5000) => ({
  kind: 'granted',
  binding: { ...body, agentIdentityId: 'agent one', nativeOwnerInstanceId: 'native-owner' },
  validForMs,
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function fixture(
  options: { response?: unknown; fetchImpl?: typeof fetch; clockQualified?: boolean } = {}
) {
  let current = true;
  let now = 100;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error('Caller changed.');
  });
  const connection: OrganizationInventoryAgentConnection = {
    baseUrl: 'http://127.0.0.1:8012',
    commandUrl: 'http://127.0.0.1:8013',
    nativeOwnerInstanceId: 'native-owner',
    assertCurrent,
    sessionToken: () => 'session',
    nativeDocumentToken: () => 'native',
  };
  const fetchImpl = vi.fn(options.fetchImpl ?? (async () => json(options.response ?? policy)));
  const client = createOrganizationInventoryAgentClaimsClient({
    agent: { identityId: 'agent one', capabilities: ['read-organization-inventory'] },
    assertCurrent,
    captureConnection: () => connection,
    monotonicMs: () => now,
    ...(options.clockQualified === false ? {} : { assertClockSupported: () => undefined }),
    fetchImpl,
  });
  return {
    client,
    fetchImpl,
    connection,
    invalidate: () => {
      current = false;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('organization inventory private connection capture', () => {
  it('captures one ready managed pair without serializing its private tokens', () => {
    const captured = captureOrganizationInventoryAgentConnection();
    expect(captured.sessionToken()).toBe('session');
    expect(captured.nativeDocumentToken()).toBe('native');
    expect(captured.nativeOwnerInstanceId).toBe('native-owner');
    expect(JSON.stringify(captured)).not.toMatch(/session|nativeDocumentToken|"native"/);
    vi.mocked(sidecarSessionAuthority.isCurrent).mockReturnValueOnce(false);
    expect(() => captured.assertCurrent()).toThrow('CONNECTION_CHANGED');
  });

  it('rejects unregistered command endpoints and starting generations', () => {
    vi.mocked(nativeDocumentCommandEnv).mockReturnValueOnce({});
    expect(() => captureOrganizationInventoryAgentConnection()).toThrow('CONNECTION_UNAVAILABLE');
    vi.mocked(sidecarSessionAuthority.snapshot).mockReturnValueOnce({
      owner: 'electron',
      state: 'starting',
      generation: 1,
      token: 'session',
    });
    expect(() => captureOrganizationInventoryAgentConnection()).toThrow('CONNECTION_UNAVAILABLE');
  });

  it('invalidates an existing capture when its command endpoint changes', () => {
    const captured = captureOrganizationInventoryAgentConnection();
    vi.mocked(nativeDocumentCommandEnv).mockReturnValueOnce({
      DNAFORGE_NATIVE_DOCUMENT_URL: 'http://127.0.0.1:8014',
    });
    expect(() => captured.nativeDocumentToken()).toThrow('CONNECTION_CHANGED');
  });
});

describe('organization inventory agent claims client', () => {
  it('uses the trusted encoded identity and paired private transport without enrollment', async () => {
    const f = fixture();
    expect(await f.client.policyStatus()).toEqual(policy);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetchImpl.mock.calls[0];
    expect(url).toBe(
      'http://127.0.0.1:8012/agent-grants/agent%20one/organization-inventory/claim-policy'
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-DNAForge-Session')).toBe('session');
    expect(headers.get('X-DNAForge-Native-Document-Authority')).toBe('native');
    expect(headers.has('X-DNAForge-Operation-Authority')).toBe(false);
  });

  it('enrolls only on the explicit method with an empty strict object', async () => {
    const f = fixture();
    await f.client.enrollPolicy();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('preserves unenrolled denial and authority unavailable without requiring a qualified grant clock', async () => {
    for (const response of [
      denied,
      { kind: 'unavailable', code: 'GRANT_AUTHORITY_UNAVAILABLE', message: 'Unavailable.' },
    ]) {
      const f = fixture({ response, clockQualified: false });
      expect(await f.client.acquireLease(request)).toEqual(response);
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.fetchImpl.mock.calls[0][1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify(request),
      });
    }
  });

  it('refuses a granted response with an unsupported production clock', async () => {
    const f = fixture({ response: granted(), clockQualified: false });
    expect(await f.client.acquireLease(request)).toMatchObject({ kind: 'unavailable' });
  });

  it('keeps policy status independent of clock qualification', async () => {
    const f = fixture({ clockQualified: false });
    f.setNow(NaN);
    expect(await f.client.policyStatus()).toEqual(policy);
  });

  it('expires at request start plus TTL and returns an immutable nonserializable Native proof', async () => {
    const f = fixture({
      fetchImpl: async () => {
        f.setNow(900);
        return json(granted(request, 1000));
      },
    });
    const result = await f.client.acquireLease(request);
    expect(result.kind).toBe('granted');
    if (result.kind !== 'granted') throw new Error('Expected proof.');
    expect(result.lease.startedAtMs).toBe(100);
    expect(result.lease.expiresAtMs).toBe(1100);
    expect(Object.isFrozen(result.lease.binding.target)).toBe(true);
    expect(Object.isFrozen(result.lease.binding.purpose)).toBe(true);
    expect(() => JSON.stringify(result.lease)).toThrow('cannot be serialized');
    result.lease.assertUsable();
    f.setNow(1100);
    expect(() => result.lease.assertUsable()).toThrow('LEASE_INVALID');
    f.setNow(1000);
    expect(() => result.lease.assertUsable()).toThrow('LEASE_INVALID');
  });

  it.each([99, 1100, NaN, Infinity])(
    'refuses late or invalid clock observation %s',
    async (now) => {
      const f = fixture({
        fetchImpl: async () => {
          f.setNow(now);
          return json(granted(request, 1000));
        },
      });
      expect(await f.client.acquireLease(request)).toMatchObject({ kind: 'unavailable' });
    }
  );

  it('invalidates a granted proof when its original caller changes or its clock goes backwards', async () => {
    const f = fixture({ response: granted() });
    const result = await f.client.acquireLease(request);
    if (result.kind !== 'granted') throw new Error('Expected proof.');
    f.setNow(200);
    result.lease.assertUsable();
    f.setNow(199);
    expect(() => result.lease.assertUsable()).toThrow('LEASE_INVALID');
    f.setNow(201);
    expect(() => result.lease.assertUsable()).toThrow('LEASE_INVALID');
    const other = fixture({ response: granted() });
    const second = await other.client.acquireLease(request);
    if (second.kind !== 'granted') throw new Error('Expected proof.');
    other.invalidate();
    expect(() => second.lease.assertUsable()).toThrow('LEASE_INVALID');
  });

  it('rejects changed caller state after fetch and after a streamed body boundary', async () => {
    const fetched = fixture({
      fetchImpl: async () => {
        fetched.invalidate();
        return json(policy);
      },
    });
    expect(await fetched.client.policyStatus()).toMatchObject({ kind: 'unavailable' });
    let pulls = 0;
    const streamed = fixture({
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0)
                controller.enqueue(new TextEncoder().encode(JSON.stringify(policy)));
              else {
                streamed.invalidate();
                controller.close();
              }
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        ),
    });
    expect(await streamed.client.policyStatus()).toMatchObject({ kind: 'unavailable' });
  });

  it.each([
    { ...policy, nativeOwnerInstanceId: 'other-owner' },
    { ...policy, agentIdentityId: 'other-agent' },
    { ...policy, extra: true },
    { ...policy, policy: { state: 'live', maxLeaseMs: 5000 } },
    { ...policy, policy: { protocolVersion: 1, state: 'live', maxLeaseMs: 5001 } },
    { kind: 'denied', code: 'bad ', message: 'Denied.' },
  ])('rejects malformed or uncorrelated policy %j', async (response) => {
    expect(await fixture({ response }).client.policyStatus()).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('correlates every lease binding field, including the exact send purpose', async () => {
    const sending: OrganizationInventoryAgentLeaseRequest = {
      ...request,
      purpose: {
        kind: 'send',
        mode: 'retry-exact',
        operationId: 'operation-one',
        requestSha256: `sha256:${'a'.repeat(64)}`,
      },
    };
    const substitutions = {
      schema: 'other',
      delegationId: 'other',
      delegationIncarnation: 'other',
      accountId: request.desktopSessionId,
      desktopSessionId: request.accountId,
      target: { ...request.target, orgId: request.accountId },
      flightId: 'other',
      purpose: { ...sending.purpose, mode: 'submit' },
      agentIdentityId: 'other',
      nativeOwnerInstanceId: 'other',
    };
    for (const [key, value] of Object.entries(substitutions)) {
      const response = granted(sending);
      Object.assign(response.binding, { [key]: value });
      expect(await fixture({ response }).client.acquireLease(sending)).toMatchObject({
        kind: 'unavailable',
      });
    }
    expect(
      await fixture({ response: granted(sending) }).client.acquireLease(sending)
    ).toMatchObject({ kind: 'granted' });
  });

  it('rejects extra request fields, noncanonical identifiers and wrong purpose fields before network', async () => {
    const bad = [
      { ...request, agentIdentityId: 'caller-chosen' },
      { ...request, delegationId: '\u0085invalid' },
      { ...request, delegationIncarnation: 'invalid\0' },
      { ...request, accountId: 'ABCDEFAB-1111-1111-1111-111111111111' },
      { ...request, purpose: { kind: 'preview-use', operation: 'snapshot' } },
    ];
    for (const body of bad) {
      const f = fixture();
      expect(
        await f.client.acquireLease(body as OrganizationInventoryAgentLeaseRequest)
      ).toMatchObject({ kind: 'unavailable' });
      expect(f.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects redirect, wrong status, wrong content type, malformed JSON and invalid UTF-8 without retry', async () => {
    const responses = [
      new Response(null, { status: 307, headers: { location: '/health' } }),
      new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } }),
      new Response(JSON.stringify(policy), { headers: { 'Content-Type': 'text/plain' } }),
      new Response('{', { headers: { 'Content-Type': 'application/json' } }),
      new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    ];
    for (const response of responses) {
      const f = fixture({ fetchImpl: async () => response });
      expect(await f.client.policyStatus()).toMatchObject({ kind: 'unavailable' });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds declared and streamed response bytes to 64KiB', async () => {
    for (const response of [
      new Response('{}', {
        headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' },
      }),
      new Response(' '.repeat(65537), { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      expect(
        await fixture({ fetchImpl: async () => response }).client.policyStatus()
      ).toMatchObject({ kind: 'unavailable' });
    }
  });

  it('bounds the complete streamed request at five seconds and aborts without retry', async () => {
    vi.useFakeTimers();
    const f = fixture({
      fetchImpl: async (_url, init) => {
        expect(init?.signal?.aborted).toBe(false);
        return new Response(new ReadableStream({ start() {} }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const pending = f.client.policyStatus();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({
      kind: 'unavailable',
      code: 'ORGANIZATION_CLAIM_TIMEOUT',
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
