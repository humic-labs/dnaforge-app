import { preferCurrentThread } from '../thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';

import {
  encodeBroadRasterShardV1,
  type BroadRasterShardJobV1,
} from './compiled-broad-raster-shards';

preferCurrentThread('userInitiated');

if (!parentPort) {
  throw new Error('Broad raster shard worker started without a parent port.');
}
const port = parentPort;

port.on('message', (request: { id: number; job: BroadRasterShardJobV1 }) => {
  encodeBroadRasterShardV1(request.job).then(
    (result) => port.postMessage({ id: request.id, result }),
    (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      port.postMessage({
        id: request.id,
        error: { name: normalized.name, message: normalized.message },
      });
    }
  );
});
