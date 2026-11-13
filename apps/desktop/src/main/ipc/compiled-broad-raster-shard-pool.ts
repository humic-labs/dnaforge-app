import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type {
  BroadRasterShardJobV1,
  BroadRasterShardResultV1,
  RunBroadRasterShardV1,
} from './compiled-broad-raster-shards';

type ShardResponse =
  | { id: number; result: BroadRasterShardResultV1 }
  | { id: number; error: { name: string; message: string } };

export interface BroadRasterShardPoolV1 {
  readonly shardCount: number;
  readonly runShard: RunBroadRasterShardV1;
  close(): Promise<void>;
}

export function defaultBroadRasterShardCount(): number {
  return Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
}

export async function createBroadRasterShardPoolV1(
  entryPath: string,
  shardCount = defaultBroadRasterShardCount()
): Promise<BroadRasterShardPoolV1> {
  const workers: Worker[] = Array.from({ length: shardCount }, () => new Worker(entryPath));
  const pending = new Map<
    number,
    { resolve: (result: BroadRasterShardResultV1) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  let failure: Error | null = null;
  const failAll = (error: Error) => {
    failure ??= error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  for (const worker of workers) {
    worker.on('message', (response: ShardResponse) => {
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      if ('error' in response) {
        const error = new Error(response.error.message);
        error.name = response.error.name;
        waiter.reject(error);
      } else {
        waiter.resolve(response.result);
      }
    });
    worker.on('error', failAll);
    worker.on('exit', (code) => {
      if (code !== 0) failAll(new Error(`Broad raster shard worker exited with code ${code}.`));
    });
  }
  return {
    shardCount,
    runShard: (job: BroadRasterShardJobV1) => {
      if (failure) return Promise.reject(failure);
      const id = nextId++;
      return new Promise<BroadRasterShardResultV1>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        workers[job.shardIndex % workers.length].postMessage({ id, job });
      });
    },
    close: async () => {
      failure ??= new Error('Broad raster shard pool is closed.');
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}
