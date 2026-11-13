// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  authenticateAnnotationViewportDetailPayloadV1,
  createAnnotationViewportDetailAuthenticatorV1,
} from './annotation-viewport-detail-auth-worker-runtime';

function deferredDigest(): {
  readonly promise: Promise<ArrayBuffer>;
  readonly resolve: (value: ArrayBuffer) => void;
} {
  let resolve!: (value: ArrayBuffer) => void;
  const promise = new Promise<ArrayBuffer>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('authenticateAnnotationViewportDetailPayloadV1', () => {
  it('authenticates the owned bytes without changing their identity', async () => {
    const payload = new Uint8Array([0x61, 0x62, 0x63]);

    await expect(authenticateAnnotationViewportDetailPayloadV1(payload)).resolves.toEqual({
      payload,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });

  it('fails before hashing an already-cancelled payload', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      authenticateAnnotationViewportDetailPayloadV1(new Uint8Array([1]), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a view that would retain unrelated bytes from a larger backing buffer', async () => {
    const digest = vi.fn<(payload: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>>();
    const authenticator = createAnnotationViewportDetailAuthenticatorV1({ digest });
    const sharedAllocation = new Uint8Array([10, 20, 30, 40]);
    const packetView = sharedAllocation.subarray(1, 3);

    await expect(authenticator.authenticate(packetView)).rejects.toThrow('owned ArrayBuffer');
    expect(digest).not.toHaveBeenCalled();
    expect(authenticator.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      started: 0,
      settled: 0,
    });
  });

  it('keeps an aborted physical digest admitted until it actually settles', async () => {
    const firstDigest = deferredDigest();
    const secondDigest = deferredDigest();
    const digest = vi
      .fn<(payload: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>>()
      .mockReturnValueOnce(firstDigest.promise)
      .mockReturnValueOnce(secondDigest.promise);
    const authenticator = createAnnotationViewportDetailAuthenticatorV1({
      digest,
      maxActive: 1,
      maxTotal: 2,
    });
    const firstController = new AbortController();
    const first = authenticator.authenticate(new Uint8Array([1]), firstController.signal);
    const second = authenticator.authenticate(new Uint8Array([2]));

    await Promise.resolve();
    expect(digest).toHaveBeenCalledTimes(1);
    expect(authenticator.snapshot()).toEqual({
      active: 1,
      queued: 1,
      started: 1,
      settled: 0,
      peakActive: 1,
      peakQueued: 1,
      maxActive: 1,
      maxTotal: 2,
    });

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(digest).toHaveBeenCalledTimes(1);
    expect(authenticator.snapshot()).toMatchObject({
      active: 1,
      queued: 1,
      started: 1,
      settled: 0,
    });

    firstDigest.resolve(new ArrayBuffer(32));
    await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(2));
    expect(authenticator.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      started: 2,
      settled: 1,
    });

    secondDigest.resolve(new ArrayBuffer(32));
    await expect(second).resolves.toMatchObject({ payload: new Uint8Array([2]) });
    await vi.waitFor(() => expect(authenticator.snapshot().active).toBe(0));
    expect(authenticator.snapshot()).toMatchObject({ started: 2, settled: 2, peakActive: 1 });
  });

  it('removes a cancelled queued payload immediately', async () => {
    const activeDigest = deferredDigest();
    const authenticator = createAnnotationViewportDetailAuthenticatorV1({
      digest: () => activeDigest.promise,
      maxActive: 1,
      maxTotal: 2,
    });
    const active = authenticator.authenticate(new Uint8Array([1]));
    const queuedController = new AbortController();
    const queued = authenticator.authenticate(new Uint8Array([2]), queuedController.signal);

    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(authenticator.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      started: 1,
      settled: 0,
      peakActive: 1,
      peakQueued: 1,
    });

    activeDigest.resolve(new ArrayBuffer(32));
    await active;
  });

  it('fails closed instead of retaining more payloads than the total cap', async () => {
    const firstDigest = deferredDigest();
    const secondDigest = deferredDigest();
    const digest = vi
      .fn<(payload: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>>()
      .mockReturnValueOnce(firstDigest.promise)
      .mockReturnValueOnce(secondDigest.promise);
    const authenticator = createAnnotationViewportDetailAuthenticatorV1({
      digest,
      maxActive: 1,
      maxTotal: 2,
    });
    const active = authenticator.authenticate(new Uint8Array([1]));
    const queued = authenticator.authenticate(new Uint8Array([2]));

    await expect(authenticator.authenticate(new Uint8Array([3]))).rejects.toMatchObject({
      name: 'AnnotationViewportDetailAuthCapacityError',
    });
    expect(authenticator.snapshot()).toMatchObject({
      active: 1,
      queued: 1,
      started: 1,
      settled: 0,
      peakActive: 1,
      peakQueued: 1,
    });

    firstDigest.resolve(new ArrayBuffer(32));
    await active;
    await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(2));
    secondDigest.resolve(new ArrayBuffer(32));
    await queued;
  });
});
