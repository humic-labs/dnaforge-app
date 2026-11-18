import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { NativeAgentAuthority } from './agent-grant-authority';
import { getApiUrl } from './config';
import { createSidecarFetch } from './sidecar-request-auth';
import { nativeDocumentCommandEnv, sidecarSessionAuthority } from './sidecar-session-runtime';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_REQUEST_MS = 5000;
const canonicalWhitespace =
  /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
const identifier = z.string().refine((value) => {
  const length = [...value].length;
  return length >= 1 && length <= 512 && !value.includes('\0') && !canonicalWhitespace.test(value);
});
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const targetSchema = z
  .object({
    kind: z.literal('organization-inventory'),
    orgId: uuid,
    inventoryId: uuid,
  })
  .strict();
const purposeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('observe'),
      operation: z.enum(['snapshot', 'cancel-preview', 'attempt', 'inspect']),
    })
    .strict(),
  z.object({ kind: z.literal('preview-use') }).strict(),
  z
    .object({
      kind: z.literal('send'),
      mode: z.enum(['submit', 'retry-exact', 'confirm-unsent']),
      operationId: identifier,
      requestSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
]);
const requestSchema = z
  .object({
    schema: z.literal('dnaforge.organization-inventory-agent-lease.v1'),
    delegationId: identifier,
    delegationIncarnation: identifier,
    accountId: uuid,
    desktopSessionId: uuid,
    target: targetSchema,
    flightId: identifier,
    purpose: purposeSchema,
  })
  .strict();
export const organizationInventoryAgentLeaseRequestSchema = requestSchema;
const bindingSchema = requestSchema
  .extend({
    agentIdentityId: identifier,
    nativeOwnerInstanceId: identifier,
  })
  .strict();
const messageSchema = z.string().refine((value) => {
  const length = [...value].length;
  return length >= 1 && length <= 2000;
});
const deniedSchema = z
  .object({
    kind: z.literal('denied'),
    code: identifier,
    message: messageSchema,
  })
  .strict();
const unavailableSchema = z
  .object({
    kind: z.literal('unavailable'),
    code: identifier,
    message: messageSchema,
  })
  .strict();
const policySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('policy'),
      agentIdentityId: identifier,
      nativeOwnerInstanceId: identifier,
      policy: z
        .object({
          protocolVersion: z.literal(1),
          state: z.enum(['live', 'denying', 'complete']),
          maxLeaseMs: z.literal(5000),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  deniedSchema,
  unavailableSchema,
]);
const leaseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('granted'),
      binding: bindingSchema,
      validForMs: z.number().int().min(1).max(5000),
    })
    .strict(),
  deniedSchema,
  unavailableSchema,
]);

export type OrganizationInventoryAgentLeaseRequest = z.infer<typeof requestSchema>;
export type OrganizationInventoryAgentLeaseBinding = z.infer<typeof bindingSchema>;
export type OrganizationInventoryAgentPolicyRead = z.infer<typeof policySchema>;
type ClaimFailure = z.infer<typeof deniedSchema> | z.infer<typeof unavailableSchema>;

export interface NativeOrganizationInventoryAgentLease {
  readonly binding: OrganizationInventoryAgentLeaseBinding;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  assertUsable(): void;
  toJSON(): never;
}

export type NativeOrganizationInventoryAgentLeaseRead =
  | { readonly kind: 'granted'; readonly lease: NativeOrganizationInventoryAgentLease }
  | ClaimFailure;

export interface OrganizationInventoryAgentConnection {
  readonly baseUrl: string;
  readonly commandUrl: string;
  readonly nativeOwnerInstanceId: string;
  assertCurrent(): void;
  sessionToken(): string;
  nativeDocumentToken(): string;
}

function exactLoopbackOrigin(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  return Boolean(match && Number(match[1]) <= 65535);
}

export function captureOrganizationInventoryAgentConnection(): OrganizationInventoryAgentConnection {
  const snapshot = sidecarSessionAuthority.snapshot();
  const authority = sidecarSessionAuthority.nativeDocumentAuthority(snapshot);
  const baseUrl = getApiUrl();
  const commandUrl = nativeDocumentCommandEnv(snapshot).DNAFORGE_NATIVE_DOCUMENT_URL;
  if (
    snapshot.owner !== 'electron' ||
    snapshot.state !== 'ready' ||
    !authority ||
    !exactLoopbackOrigin(baseUrl) ||
    !commandUrl ||
    !exactLoopbackOrigin(commandUrl)
  )
    throw new Error('ORGANIZATION_CLAIM_CONNECTION_UNAVAILABLE');
  const assertCurrent = (): void => {
    if (!sidecarSessionAuthority.isCurrent(snapshot) || getApiUrl() !== baseUrl) {
      throw new Error('ORGANIZATION_CLAIM_CONNECTION_CHANGED');
    }
    const current = sidecarSessionAuthority.nativeDocumentAuthority(snapshot);
    if (
      current?.ownerInstanceId !== authority.ownerInstanceId ||
      current.token !== authority.token ||
      nativeDocumentCommandEnv(snapshot).DNAFORGE_NATIVE_DOCUMENT_URL !== commandUrl
    )
      throw new Error('ORGANIZATION_CLAIM_CONNECTION_CHANGED');
  };
  assertCurrent();
  return Object.freeze({
    baseUrl,
    commandUrl,
    nativeOwnerInstanceId: authority.ownerInstanceId,
    assertCurrent,
    sessionToken: () => {
      assertCurrent();
      return snapshot.token;
    },
    nativeDocumentToken: () => {
      assertCurrent();
      return authority.token;
    },
  });
}

interface ClaimClientOptions {
  readonly agent: NativeAgentAuthority;
  readonly assertCurrent: () => void;
  readonly captureConnection?: () => OrganizationInventoryAgentConnection;
  readonly monotonicMs?: () => number;
  readonly assertClockSupported?: () => void;
  readonly fetchImpl?: typeof fetch;
}

function unavailable(code: string): z.infer<typeof unavailableSchema> {
  return {
    kind: 'unavailable',
    code,
    message: 'Current organization inventory claim admission is unavailable.',
  };
}

function freezeBinding(
  binding: OrganizationInventoryAgentLeaseBinding
): OrganizationInventoryAgentLeaseBinding {
  Object.freeze(binding.target);
  Object.freeze(binding.purpose);
  return Object.freeze(binding);
}

export function createOrganizationInventoryAgentClaimsClient(options: ClaimClientOptions) {
  const agentIdentityId = identifier.parse(options.agent.identityId);
  const captureConnection =
    options.captureConnection ?? captureOrganizationInventoryAgentConnection;
  const monotonicMs = options.monotonicMs ?? (() => performance.now());
  const assertClockSupported =
    options.assertClockSupported ??
    (() => {
      throw new Error('ORGANIZATION_CLAIM_CLOCK_UNAVAILABLE');
    });
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = `/agent-grants/${encodeURIComponent(agentIdentityId)}/organization-inventory`;

  async function flight<T>(
    endpoint: 'claim-policy' | 'lease',
    method: 'GET' | 'POST',
    body: string | undefined,
    decode: (
      value: unknown,
      connection: OrganizationInventoryAgentConnection,
      startedAtMs: number,
      assertFlightCurrent: () => void
    ) => T
  ): Promise<T | ClaimFailure> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    let timedOut = false;
    try {
      if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        return unavailable('ORGANIZATION_CLAIM_INVALID_REQUEST');
      }
      options.assertCurrent();
      const connection = captureConnection();
      if (
        !exactLoopbackOrigin(connection.baseUrl) ||
        !exactLoopbackOrigin(connection.commandUrl) ||
        !identifier.safeParse(connection.nativeOwnerInstanceId).success
      ) {
        return unavailable('ORGANIZATION_CLAIM_CONNECTION_UNAVAILABLE');
      }
      const assertFlightCurrent = (): void => {
        if (timedOut) throw new Error('ORGANIZATION_CLAIM_TIMEOUT');
        options.assertCurrent();
        connection.assertCurrent();
      };
      const sidecarFetch = createSidecarFetch({
        getBaseUrl: () => {
          assertFlightCurrent();
          return connection.baseUrl;
        },
        getCurrentToken: () => {
          assertFlightCurrent();
          return connection.sessionToken();
        },
        getNativeDocumentToken: () => {
          assertFlightCurrent();
          return connection.nativeDocumentToken();
        },
        fetchImpl: async (input, init) => {
          const response = await fetchImpl(input, { ...init, redirect: 'error' });
          assertFlightCurrent();
          if (response.status >= 300 && response.status < 400) {
            throw new Error('ORGANIZATION_CLAIM_REDIRECT_REFUSED');
          }
          return response;
        },
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('ORGANIZATION_CLAIM_TIMEOUT'));
        }, MAX_REQUEST_MS);
      });
      const awaited = async <V>(promise: Promise<V>): Promise<V> => {
        const value = await Promise.race([promise, timeout]);
        assertFlightCurrent();
        return value;
      };
      assertFlightCurrent();
      const startedAtMs = endpoint === 'lease' ? monotonicMs() : 0;
      if (!Number.isFinite(startedAtMs) || startedAtMs < 0) {
        return unavailable('ORGANIZATION_CLAIM_CLOCK_UNAVAILABLE');
      }
      const response = await awaited(
        sidecarFetch(`${path}/${endpoint}`, {
          method,
          headers: {
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body,
          signal: controller.signal,
        })
      );
      const expectedUrl = `${connection.baseUrl}${path}/${endpoint}`;
      if (
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== expectedUrl) ||
        !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
          response.headers.get('content-type') ?? ''
        ) ||
        !response.body
      )
        throw new Error('ORGANIZATION_CLAIM_INVALID_RESPONSE');
      const contentLength = response.headers.get('content-length');
      if (
        contentLength !== null &&
        (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
      ) {
        throw new Error('ORGANIZATION_CLAIM_INVALID_RESPONSE');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const part = await awaited(reader.read());
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw new Error('ORGANIZATION_CLAIM_INVALID_RESPONSE');
        chunks.push(part.value);
      }
      const complete = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        complete.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete));
      assertFlightCurrent();
      return decode(value, connection, startedAtMs, assertFlightCurrent);
    } catch {
      return unavailable(
        timedOut ? 'ORGANIZATION_CLAIM_TIMEOUT' : 'ORGANIZATION_CLAIM_UNAVAILABLE'
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => undefined);
    }
  }

  const policyFlight = (method: 'GET' | 'POST'): Promise<OrganizationInventoryAgentPolicyRead> =>
    flight('claim-policy', method, method === 'POST' ? '{}' : undefined, (value, connection) => {
      const policy = policySchema.parse(value);
      if (
        policy.kind === 'policy' &&
        (policy.agentIdentityId !== agentIdentityId ||
          policy.nativeOwnerInstanceId !== connection.nativeOwnerInstanceId)
      ) {
        throw new Error('ORGANIZATION_CLAIM_BINDING_MISMATCH');
      }
      return policy;
    });

  return Object.freeze({
    enrollPolicy: () => policyFlight('POST'),
    policyStatus: () => policyFlight('GET'),
    async acquireLease(
      request: OrganizationInventoryAgentLeaseRequest
    ): Promise<NativeOrganizationInventoryAgentLeaseRead> {
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) return unavailable('ORGANIZATION_CLAIM_INVALID_REQUEST');
      const original = parsed.data;
      return flight(
        'lease',
        'POST',
        JSON.stringify(original),
        (value, connection, startedAtMs, assertFlightCurrent) => {
          const result = leaseSchema.parse(value);
          if (result.kind !== 'granted') return result;
          const expected = {
            ...original,
            agentIdentityId,
            nativeOwnerInstanceId: connection.nativeOwnerInstanceId,
          };
          if (JSON.stringify(result.binding) !== JSON.stringify(expected)) {
            throw new Error('ORGANIZATION_CLAIM_BINDING_MISMATCH');
          }
          assertClockSupported();
          const expiresAtMs = startedAtMs + result.validForMs;
          let lastObservedMs = startedAtMs;
          let failure: Error | undefined;
          const assertUsable = (): void => {
            if (failure) throw failure;
            try {
              assertFlightCurrent();
              assertClockSupported();
              const now = monotonicMs();
              if (
                !Number.isFinite(now) ||
                now < lastObservedMs ||
                !Number.isFinite(expiresAtMs) ||
                expiresAtMs <= startedAtMs ||
                now >= expiresAtMs
              ) {
                throw new Error('ORGANIZATION_CLAIM_LEASE_EXPIRED');
              }
              lastObservedMs = now;
            } catch {
              failure = new Error('ORGANIZATION_CLAIM_LEASE_INVALID');
              throw failure;
            }
          };
          assertUsable();
          const lease: NativeOrganizationInventoryAgentLease = Object.freeze({
            binding: freezeBinding(result.binding),
            startedAtMs,
            expiresAtMs,
            assertUsable,
            toJSON(): never {
              throw new Error('Native claim leases cannot be serialized.');
            },
          });
          return { kind: 'granted' as const, lease };
        }
      );
    },
  });
}
