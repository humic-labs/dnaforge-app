import { preferCurrentThread } from '../thread-scheduling.cjs';
import { realpath } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';

import type {
  AssemblyCompiledBroadRasterWorkerRequestV1,
  AssemblyCompiledBroadRasterWorkerResponseV1,
} from './assembly-compiled-broad-raster-worker-client';
import {
  createAuthorizedCompiledBroadRasterScenePathGuard,
  prepareAssemblyCompiledBroadRasterWorkerJobV1,
} from './assembly-compiled-broad-raster-worker-job';

preferCurrentThread('userInitiated');

if (!parentPort) {
  throw new Error('Compiled broad raster worker started without a parent port.');
}

parentPort.once('message', (request: AssemblyCompiledBroadRasterWorkerRequestV1) => {
  void handleRequest(request);
});

async function handleRequest(request: AssemblyCompiledBroadRasterWorkerRequestV1): Promise<void> {
  try {
    if (request?.type !== 'prepare') {
      throw new Error('Compiled broad raster worker received an invalid request.');
    }
    const result = await prepareAssemblyCompiledBroadRasterWorkerJobV1(request.job, {
      assertAuthorizedScenePath: createAuthorizedCompiledBroadRasterScenePathGuard(
        request.job.scenePath,
        request.job.authorizedSceneRealPath,
        realpath
      ),
    });
    post({ type: 'result', result });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    post({
      type: 'error',
      error: { name: normalized.name, message: normalized.message },
    });
  }
}

function post(response: AssemblyCompiledBroadRasterWorkerResponseV1): void {
  parentPort?.postMessage(response);
}
