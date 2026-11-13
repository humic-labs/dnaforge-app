import { preferCurrentThread } from '../thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import {
  runPortablePreparedReferenceSceneAdmissionWorkerJobV1,
  type PortablePreparedReferenceSceneAdmissionWorkerJobV1,
  type PortablePreparedReferenceSceneAdmissionWorkerResultV1,
} from './portable-prepared-reference-scene-admission-worker-job';

preferCurrentThread('userInitiated');

if (!parentPort) {
  throw new Error('Portable scene admission worker started without a parent port.');
}

parentPort.once('message', (job: PortablePreparedReferenceSceneAdmissionWorkerJobV1) => {
  void handleJob(job);
});

async function handleJob(job: PortablePreparedReferenceSceneAdmissionWorkerJobV1): Promise<void> {
  try {
    const admitted = await runPortablePreparedReferenceSceneAdmissionWorkerJobV1(job);
    if ('projection' in admitted && admitted.projection === 'range-catalog') {
      parentPort?.postMessage({ type: 'result', result: admitted });
      return;
    }
    const result = transferableResult(admitted);
    parentPort?.postMessage({ type: 'result', result }, [result.validatedPayload.buffer]);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    parentPort?.postMessage({
      type: 'error',
      error: { name: normalized.name, message: normalized.message },
    });
  }
}

function transferableResult(
  result: Exclude<
    PortablePreparedReferenceSceneAdmissionWorkerResultV1,
    { projection: 'range-catalog' }
  >
): Exclude<
  PortablePreparedReferenceSceneAdmissionWorkerResultV1,
  { projection: 'range-catalog' }
> & {
  validatedPayload: Uint8Array<ArrayBuffer>;
} {
  const payload =
    result.validatedPayload.buffer instanceof ArrayBuffer &&
    result.validatedPayload.byteOffset === 0 &&
    result.validatedPayload.byteLength === result.validatedPayload.buffer.byteLength
      ? (result.validatedPayload as Uint8Array<ArrayBuffer>)
      : Uint8Array.from(result.validatedPayload);
  return Object.freeze({ ...result, validatedPayload: payload });
}
