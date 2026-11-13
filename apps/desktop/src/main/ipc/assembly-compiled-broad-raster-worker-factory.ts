import createAssemblyCompiledBroadRasterWorker from './assembly-compiled-broad-raster-worker-entry?nodeWorker';
import { runAssemblyCompiledBroadRasterWorkerV1 } from './assembly-compiled-broad-raster-worker-client';
import type {
  AssemblyCompiledBroadRasterWorkerJobV1,
  AssemblyCompiledBroadRasterWorkerResultV1,
} from './assembly-compiled-broad-raster-worker-job';

export function prepareAssemblyCompiledBroadRasterInDedicatedWorkerV1(
  job: AssemblyCompiledBroadRasterWorkerJobV1,
  options?: { signal?: AbortSignal }
): Promise<AssemblyCompiledBroadRasterWorkerResultV1> {
  return runAssemblyCompiledBroadRasterWorkerV1(job, {
    createWorker: () => createAssemblyCompiledBroadRasterWorker({}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}
