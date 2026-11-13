import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { admitPortablePreparedReferenceSceneInDedicatedWorkerV1 } from './portable-prepared-reference-scene-admission-worker-client';
import {
  portablePreparedReferenceSceneAdmissionWorkerContractV1,
  type PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  type PortablePreparedReferenceSceneAdmissionWorkerResultV1,
} from './portable-prepared-reference-scene-admission-worker-job';

const PAYLOAD = new Uint8Array([1, 2, 3, 4]);
const PAYLOAD_SHA256 = 'a'.repeat(64);
const PROJECTION_CONTRACT_SHA256 = 'c'.repeat(64);
const PROJECTION_DATASET = {
  datasetId: 'installed-dataset',
  datasetVersion: 'v1',
  sourceSha256: 'd'.repeat(64),
};
const JOB = {
  contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
  payloadPath: '/authorized/interaction-scene.bin',
  authorizedPayloadRealPath: '/authorized/interaction-scene.bin',
  manifest: { byteLength: PAYLOAD.byteLength },
  expectedPayloadSha256: PAYLOAD_SHA256,
} as Exclude<
  PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  { projection: 'admit-persisted-compiled-broad-interaction' }
>;
const RESULT: PortablePreparedReferenceSceneAdmissionWorkerResultV1 = {
  contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
  byteCount: PAYLOAD.byteLength,
  payloadSha256: PAYLOAD_SHA256,
  validatedPayload: PAYLOAD,
};

class FakeWorker extends EventEmitter {
  readonly messages: unknown[] = [];
  terminateCount = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): Promise<number> {
    this.terminateCount += 1;
    return new Promise(() => undefined);
  }
}

describe('portable prepared-reference scene admission worker client', () => {
  it('publishes a validated result without waiting for worker teardown', async () => {
    const worker = new FakeWorker();
    const pending = admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
      JOB,
      () => worker as unknown as Worker
    );

    await Promise.resolve();
    worker.emit('message', { type: 'result', result: RESULT });

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('validated result remained teardown-blocked')), 25)
        ),
      ])
    ).resolves.toEqual(RESULT);
    expect(worker.messages).toEqual([JOB]);
    expect(worker.terminateCount).toBe(1);
  });

  it('accepts a compact projection only when it is bound to the exact parent scene', async () => {
    const compactPayload = new Uint8Array([9, 8]);
    const compactSha256 = 'b'.repeat(64);
    const compactJob = {
      ...JOB,
      projection: 'compiled-broad-interaction' as const,
      projectionDatasetContract: PROJECTION_DATASET,
      expectedProjectionContractSha256: PROJECTION_CONTRACT_SHA256,
    };
    const compactResult = {
      contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
      projection: 'compiled-broad-interaction' as const,
      sourceByteCount: PAYLOAD.byteLength,
      sourcePayloadSha256: PAYLOAD_SHA256,
      byteCount: compactPayload.byteLength,
      payloadSha256: compactSha256,
      manifest: {
        byteLength: compactPayload.byteLength,
        integrity: { payloadSha256: compactSha256 },
        sourceScene: {
          byteLength: PAYLOAD.byteLength,
          payloadSha256: PAYLOAD_SHA256,
          contractSha256: PROJECTION_CONTRACT_SHA256,
        },
        datasetContract: PROJECTION_DATASET,
      },
      validatedPayload: compactPayload,
    } as PortablePreparedReferenceSceneAdmissionWorkerResultV1;
    const worker = new FakeWorker();
    const pending = admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
      compactJob,
      () => worker as unknown as Worker
    );
    await Promise.resolve();
    worker.emit('message', { type: 'result', result: compactResult });
    await expect(pending).resolves.toEqual(compactResult);

    const mismatchedWorker = new FakeWorker();
    const mismatched = admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
      compactJob,
      () => mismatchedWorker as unknown as Worker
    );
    await Promise.resolve();
    mismatchedWorker.emit('message', {
      type: 'result',
      result: { ...compactResult, sourcePayloadSha256: 'd'.repeat(64) },
    });
    await expect(mismatched).rejects.toThrow('invalid result');
  });

  it('accepts a metadata-only range catalog only for the exact installed parent', async () => {
    const rangeJob = {
      ...JOB,
      projection: 'range-catalog' as const,
      projectionDatasetContract: PROJECTION_DATASET,
      expectedProjectionContractSha256: PROJECTION_CONTRACT_SHA256,
    };
    const rangeResult = {
      contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
      projection: 'range-catalog' as const,
      sourceByteCount: PAYLOAD.byteLength,
      sourcePayloadSha256: PAYLOAD_SHA256,
      sourceContractSha256: PROJECTION_CONTRACT_SHA256,
      rangeCatalog: {
        schema: 'partitioned-transcript-scene-range-catalog.v1',
        sourceScene: {
          byteLength: PAYLOAD.byteLength,
          payloadSha256: PAYLOAD_SHA256,
          contractSha256: PROJECTION_CONTRACT_SHA256,
        },
      },
    } as PortablePreparedReferenceSceneAdmissionWorkerResultV1;
    const worker = new FakeWorker();
    const pending = admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
      rangeJob as PortablePreparedReferenceSceneAdmissionWorkerJobV1,
      () => worker as unknown as Worker
    );
    await Promise.resolve();
    worker.emit('message', { type: 'result', result: rangeResult });
    await expect(pending).resolves.toEqual(rangeResult);

    const mismatchedWorker = new FakeWorker();
    const mismatched = admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
      rangeJob as PortablePreparedReferenceSceneAdmissionWorkerJobV1,
      () => mismatchedWorker as unknown as Worker
    );
    await Promise.resolve();
    mismatchedWorker.emit('message', {
      type: 'result',
      result: { ...rangeResult, sourceContractSha256: 'f'.repeat(64) },
    });
    await expect(mismatched).rejects.toThrow('invalid result');
  });

  it('accepts a persisted compact admission only for the exact compact and parent identities', async () => {
    const compactManifest = {
      byteLength: PAYLOAD.byteLength,
      integrity: { payloadSha256: PAYLOAD_SHA256 },
      sourceScene: {
        payloadSha256: 'b'.repeat(64),
        contractSha256: PROJECTION_CONTRACT_SHA256,
      },
    };
    const compactJob = {
      ...JOB,
      projection: 'admit-persisted-compiled-broad-interaction' as const,
      manifest: compactManifest,
    } as PortablePreparedReferenceSceneAdmissionWorkerJobV1;
    const compactResult = {
      contract: portablePreparedReferenceSceneAdmissionWorkerContractV1(),
      projection: 'persisted-compiled-broad-interaction' as const,
      byteCount: PAYLOAD.byteLength,
      payloadSha256: PAYLOAD_SHA256,
      manifest: compactManifest,
      validatedPayload: PAYLOAD,
    } as PortablePreparedReferenceSceneAdmissionWorkerResultV1;
    const worker = new FakeWorker();
    const pending = admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
      compactJob,
      () => worker as unknown as Worker
    );
    await Promise.resolve();
    worker.emit('message', { type: 'result', result: compactResult });
    await expect(pending).resolves.toEqual(compactResult);

    const mismatchedWorker = new FakeWorker();
    const mismatched = admitPortablePreparedReferenceSceneInDedicatedWorkerV1(
      compactJob,
      () => mismatchedWorker as unknown as Worker
    );
    await Promise.resolve();
    mismatchedWorker.emit('message', {
      type: 'result',
      result: {
        ...compactResult,
        manifest: {
          ...compactManifest,
          sourceScene: { ...compactManifest.sourceScene, payloadSha256: 'f'.repeat(64) },
        },
      },
    });
    await expect(mismatched).rejects.toThrow('invalid result');
  });
});
