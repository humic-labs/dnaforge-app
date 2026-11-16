import { randomBytes } from 'node:crypto';

import {
  ASSEMBLY_ANNOTATION_SCENE_RESOURCE_HOST,
  ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME,
  type AssemblyAnnotationSceneResourceCapability,
} from '../../shared/indexed-genome';

const DEFAULT_TTL_MS = 30_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES = 1024 * 1024;

export interface AssemblyAnnotationSceneTransportAudit {
  maxEnqueuedChunkBytes: number;
  released: boolean;
  releaseReason: 'complete' | 'cancel' | 'error' | null;
}

export interface AssemblyAnnotationSceneResourceInput {
  validatedPayload: Uint8Array;
  byteCount: number;
  payloadSha256: string;
  fingerprint: string;
  sourceBuildFingerprint: string;
  ownerId: number;
}

interface AssemblyAnnotationSceneResourceLease extends AssemblyAnnotationSceneResourceInput {
  readonly token: string;
  readonly expiresAtMs: number;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface RegistryOptions {
  ttlMs?: number;
  now?: () => number;
  tokenFactory?: () => string;
  scheduleExpiry?: (callback: () => void, delayMs: number) => TimeoutHandle;
  cancelExpiry?: (handle: TimeoutHandle) => void;
}

function resourceUrl(token: string): string {
  return `${ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME}://${ASSEMBLY_ANNOTATION_SCENE_RESOURCE_HOST}/${token}`;
}

function tokenFromResourceUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (
      url.protocol !== `${ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME}:` ||
      url.hostname !== ASSEMBLY_ANNOTATION_SCENE_RESOURCE_HOST ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.startsWith('/') ||
      url.pathname.indexOf('/', 1) !== -1
    ) {
      return null;
    }
    const token = url.pathname.slice(1);
    return TOKEN_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export class AssemblyAnnotationSceneResourceTicketRegistry {
  private readonly entries = new Map<
    string,
    { lease: AssemblyAnnotationSceneResourceLease; timer: TimeoutHandle }
  >();
  private readonly ownerTokens = new Map<number, Set<string>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly scheduleExpiry: (callback: () => void, delayMs: number) => TimeoutHandle;
  private readonly cancelExpiry: (handle: TimeoutHandle) => void;

  constructor(options: RegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Annotation scene resource TTL must be a positive safe integer');
    }
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    this.scheduleExpiry = options.scheduleExpiry ?? setTimeout;
    this.cancelExpiry = options.cancelExpiry ?? clearTimeout;
  }

  get size(): number {
    return this.entries.size;
  }

  issue(input: AssemblyAnnotationSceneResourceInput): AssemblyAnnotationSceneResourceCapability {
    if (
      !ArrayBuffer.isView(input.validatedPayload) ||
      !Number.isSafeInteger(input.byteCount) ||
      input.byteCount < 0 ||
      input.validatedPayload.byteLength !== input.byteCount ||
      !SHA256_PATTERN.test(input.payloadSha256) ||
      !/^[0-9a-f]{24}$/.test(input.fingerprint) ||
      !SHA256_PATTERN.test(input.sourceBuildFingerprint) ||
      !Number.isSafeInteger(input.ownerId) ||
      input.ownerId < 0
    ) {
      throw new Error('Invalid annotation scene resource descriptor');
    }
    let token = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = this.tokenFactory();
      if (TOKEN_PATTERN.test(candidate) && !this.entries.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (!token) throw new Error('Unable to allocate annotation scene resource capability');

    const issuedAtMs = this.now();
    const expiresAtMs = issuedAtMs + this.ttlMs;
    const lease: AssemblyAnnotationSceneResourceLease = Object.freeze({
      ...input,
      token,
      expiresAtMs,
    });
    const timer = this.scheduleExpiry(() => this.release(token), this.ttlMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
    this.entries.set(token, { lease, timer });
    const owned = this.ownerTokens.get(input.ownerId) ?? new Set<string>();
    owned.add(token);
    this.ownerTokens.set(input.ownerId, owned);
    if (process.env.WAYPOINT_HOSTED_REFERENCE_E2E === '1') {
      console.log(
        '[annotation-resource-lifecycle]',
        JSON.stringify({
          phase: 'issued',
          fingerprint: input.fingerprint,
          byteCount: input.byteCount,
          ownerId: input.ownerId,
          issuedAtMs,
          expiresAtMs,
          pendingResourceCount: this.entries.size,
        })
      );
    }
    return Object.freeze({
      url: resourceUrl(token),
      expiresAtMs,
      byteCount: input.byteCount,
      payloadSha256: input.payloadSha256,
    });
  }

  consume(url: string): AssemblyAnnotationSceneResourceLease | null {
    const token = tokenFromResourceUrl(url);
    if (!token) return null;
    const entry = this.entries.get(token);
    if (!entry) return null;
    this.release(token);
    const consumedAtMs = this.now();
    if (process.env.WAYPOINT_HOSTED_REFERENCE_E2E === '1') {
      console.log(
        '[annotation-resource-lifecycle]',
        JSON.stringify({
          phase: 'consumed',
          fingerprint: entry.lease.fingerprint,
          byteCount: entry.lease.byteCount,
          ownerId: entry.lease.ownerId,
          consumedAtMs,
          expiresAtMs: entry.lease.expiresAtMs,
          expired: consumedAtMs >= entry.lease.expiresAtMs,
          pendingResourceCount: this.entries.size,
        })
      );
    }
    return consumedAtMs < entry.lease.expiresAtMs ? entry.lease : null;
  }

  releaseOwner(ownerId: number): void {
    for (const token of [...(this.ownerTokens.get(ownerId) ?? [])]) this.release(token);
  }

  dispose(): void {
    for (const token of [...this.entries.keys()]) this.release(token);
  }

  private release(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.cancelExpiry(entry.timer);
    const owned = this.ownerTokens.get(entry.lease.ownerId);
    owned?.delete(token);
    if (owned?.size === 0) this.ownerTokens.delete(entry.lease.ownerId);
  }
}

function protocolError(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function createBoundedAnnotationSceneResourceStream(validatedPayload: Uint8Array): {
  body: ReadableStream<Uint8Array>;
  audit: AssemblyAnnotationSceneTransportAudit;
} {
  if (!(validatedPayload instanceof Uint8Array)) {
    throw new Error('Annotation scene resource payload must be a Uint8Array');
  }
  let source: Uint8Array | null = validatedPayload;
  let offset = 0;
  const audit: AssemblyAnnotationSceneTransportAudit = {
    maxEnqueuedChunkBytes: 0,
    released: false,
    releaseReason: null,
  };
  const release = (reason: NonNullable<AssemblyAnnotationSceneTransportAudit['releaseReason']>) => {
    if (audit.released) return;
    source = null;
    audit.released = true;
    audit.releaseReason = reason;
  };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const current = source;
        if (!current) return;
        if (offset >= current.byteLength) {
          controller.close();
          release('complete');
          return;
        }
        const end = Math.min(
          current.byteLength,
          offset + ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES
        );
        const chunk = current.subarray(offset, end);
        offset = end;
        audit.maxEnqueuedChunkBytes = Math.max(audit.maxEnqueuedChunkBytes, chunk.byteLength);
        controller.enqueue(chunk);
        if (offset === current.byteLength) {
          controller.close();
          release('complete');
        }
      } catch (error) {
        release('error');
        controller.error(error);
      }
    },
    cancel() {
      release('cancel');
    },
  });
  return { body, audit };
}

export function createAssemblyAnnotationSceneProtocolHandler(
  registry: AssemblyAnnotationSceneResourceTicketRegistry
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') return protocolError(405);
    const lease = registry.consume(request.url);
    if (!lease) return protocolError(404);
    try {
      const headers = new Headers();
      headers.set('content-type', 'application/octet-stream');
      headers.set('content-length', String(lease.byteCount));
      headers.set('cache-control', 'no-store');
      headers.set('access-control-allow-origin', '*');
      headers.set('cross-origin-resource-policy', 'cross-origin');
      headers.set('x-waypoint-scene-sha256', lease.payloadSha256);
      headers.set('x-waypoint-scene-fingerprint', lease.fingerprint);
      headers.set('x-waypoint-scene-compiler-fingerprint', lease.sourceBuildFingerprint);
      const { body } = createBoundedAnnotationSceneResourceStream(lease.validatedPayload);
      return new Response(body, { status: 200, headers });
    } catch {
      return protocolError(410);
    }
  };
}

interface ProtocolRegistrationApi {
  handle(scheme: string, handler: (request: Request) => Promise<Response>): void;
}

export async function installAssemblyAnnotationSceneProtocol(
  protocolApi: Pick<ProtocolRegistrationApi, 'handle'>,
  registry: AssemblyAnnotationSceneResourceTicketRegistry
): Promise<void> {
  await protocolApi.handle(
    ASSEMBLY_ANNOTATION_SCENE_RESOURCE_SCHEME,
    createAssemblyAnnotationSceneProtocolHandler(registry)
  );
}

export const assemblyAnnotationSceneResourceRegistry =
  new AssemblyAnnotationSceneResourceTicketRegistry();
