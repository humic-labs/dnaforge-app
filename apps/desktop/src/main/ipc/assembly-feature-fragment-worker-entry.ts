import { preferCurrentThread } from '../thread-scheduling.cjs';
import { realpath } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';

import {
  buildFeatureCacheFragmentsV1,
  createAuthorizedExpandedAnnotationSourcePathGuard,
  type ExpandedAnnotationSceneWorkerJob,
} from './assembly-expanded-annotation-scene-compiler';

preferCurrentThread('userInitiated');

if (!parentPort) {
  throw new Error('Feature fragment worker started without a parent port.');
}
const port = parentPort;

port.once(
  'message',
  (request: { job: ExpandedAnnotationSceneWorkerJob; indexes: readonly number[] }) => {
    buildFeatureCacheFragmentsV1(request.job, request.indexes, {
      assertSafePath: createAuthorizedExpandedAnnotationSourcePathGuard(
        request.job.authorizedSourceRealPaths,
        realpath
      ),
    }).then(
      (result) => port.postMessage({ result }),
      (error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        port.postMessage({ error: { name: normalized.name, message: normalized.message } });
      }
    );
  }
);
