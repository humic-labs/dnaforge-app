import { describe, expect, it } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES,
  AssemblyAnnotationSceneResourceTicketRegistry,
  createBoundedAnnotationSceneResourceStream,
  createAssemblyAnnotationSceneProtocolHandler,
} from './assembly-annotation-scene-resource';

const TOKEN = 'A'.repeat(43);
const VALIDATED_PAYLOAD = new Uint8Array([1, 2, 3, 4]);
const RESOURCE = {
  validatedPayload: VALIDATED_PAYLOAD,
  byteCount: 4,
  payloadSha256: 'a'.repeat(64),
  fingerprint: 'b'.repeat(24),
  sourceBuildFingerprint: 'c'.repeat(64),
  ownerId: 17,
};
function registry(now: { value: number }) {
  let tokenCounter = 0;
  return new AssemblyAnnotationSceneResourceTicketRegistry({
    ttlMs: 1_000,
    now: () => now.value,
    tokenFactory: () => `${String.fromCharCode(65 + tokenCounter++).repeat(43)}`,
  });
}

describe('assembly annotation-scene authenticated resource protocol', () => {
  it('issues metadata-only one-use capabilities and atomically rejects a second consume', async () => {
    const now = { value: 10_000 };
    const tickets = registry(now);
    const capability = await tickets.issue(RESOURCE);

    expect(capability).toEqual({
      url: `waypoint-annotation-scene://artifact/${TOKEN}`,
      expiresAtMs: 11_000,
      byteCount: 4,
      payloadSha256: 'a'.repeat(64),
    });
    expect(JSON.stringify(capability)).not.toContain('validatedPayload');
    expect(tickets.consume(capability.url)).toMatchObject({
      validatedPayload: VALIDATED_PAYLOAD,
    });
    expect(tickets.consume(capability.url)).toBeNull();
    expect(tickets.size).toBe(0);
    tickets.dispose();
  });

  it('fails closed for expired, malformed, query-mutated, and cross-path URLs', async () => {
    const now = { value: 10_000 };
    const tickets = registry(now);
    const expired = await tickets.issue(RESOURCE);
    now.value = expired.expiresAtMs;
    expect(tickets.consume(expired.url)).toBeNull();

    now.value = 20_000;
    const valid = await tickets.issue(RESOURCE);
    expect(tickets.consume(valid.url.replace('artifact', 'other-host'))).toBeNull();
    expect(tickets.consume(`${valid.url}?path=/etc/passwd`)).toBeNull();
    expect(tickets.consume(`${valid.url}/../other`)).toBeNull();
    expect(tickets.size).toBe(1);
    expect(tickets.consume(valid.url)).not.toBeNull();
    tickets.dispose();
  });

  it('releases unused capabilities when their owner is destroyed', async () => {
    const now = { value: 10_000 };
    const tickets = registry(now);
    await tickets.issue(RESOURCE);
    await tickets.issue({ ...RESOURCE, ownerId: 18 });
    expect(tickets.size).toBe(2);
    tickets.releaseOwner(17);
    expect(tickets.size).toBe(1);
    tickets.releaseOwner(18);
    expect(tickets.size).toBe(0);
    tickets.dispose();
  });

  it('serves only the registry-bound already-validated bytes and exposes integrity metadata', async () => {
    const now = { value: 10_000 };
    const tickets = registry(now);
    const capability = await tickets.issue(RESOURCE);
    const handle = createAssemblyAnnotationSceneProtocolHandler(tickets);

    const response = await handle(new Request(capability.url));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('x-waypoint-scene-sha256')).toBe(RESOURCE.payloadSha256);
    expect(response.headers.get('x-waypoint-scene-fingerprint')).toBe(RESOURCE.fingerprint);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);

    const second = await handle(new Request(capability.url));
    expect(second.status).toBe(404);
    tickets.dispose();
  });

  it('streams a large validated payload byte-exactly in bounded zero-copy subarrays', async () => {
    const now = { value: 10_000 };
    const tickets = registry(now);
    const byteCount = ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES * 2 + 17;
    const validatedPayload = new Uint8Array(byteCount);
    for (let index = 0; index < validatedPayload.length; index++) {
      validatedPayload[index] = index % 251;
    }
    const capability = await tickets.issue({
      ...RESOURCE,
      validatedPayload,
      byteCount,
    });
    const response = await createAssemblyAnnotationSceneProtocolHandler(tickets)(
      new Request(capability.url)
    );
    expect(response.headers.get('content-length')).toBe(String(byteCount));

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let maxChunkBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      maxChunkBytes = Math.max(maxChunkBytes, value.byteLength);
      expect(value.buffer).toBe(validatedPayload.buffer);
    }
    const materialized = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      materialized.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(offset).toBe(byteCount);
    expect(maxChunkBytes).toBeLessThanOrEqual(ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES);
    expect(
      Buffer.compare(Buffer.from(materialized.buffer), Buffer.from(validatedPayload.buffer))
    ).toBe(0);
    expect(tickets.size).toBe(0);
    tickets.dispose();
  });

  it('drops its source reference when transport is cancelled', async () => {
    const payload = new Uint8Array(ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES + 1);
    const { body, audit } = createBoundedAnnotationSceneResourceStream(payload);
    const reader = body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBe(ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES);
    expect(audit.released).toBe(false);

    await reader.cancel();
    expect(audit).toMatchObject({
      maxEnqueuedChunkBytes: ASSEMBLY_ANNOTATION_SCENE_TRANSPORT_CHUNK_BYTES,
      released: true,
      releaseReason: 'cancel',
    });
  });

  it('rejects byte-count mismatch before issuing a capability', () => {
    const now = { value: 10_000 };
    const tickets = registry(now);
    expect(() => tickets.issue({ ...RESOURCE, byteCount: RESOURCE.byteCount + 1 })).toThrow(
      'Invalid annotation scene resource descriptor'
    );
    expect(tickets.size).toBe(0);
    tickets.dispose();
  });
});
