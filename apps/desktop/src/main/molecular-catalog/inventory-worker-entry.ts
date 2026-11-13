import { preferCurrentThread } from '../thread-scheduling.cjs';
import { parentPort } from 'node:worker_threads';
import { parseCoordinateInventory, type CoordinateInventoryRequest } from './coordinate-inventory';

preferCurrentThread('userInitiated');

if (!parentPort) throw new Error('Coordinate inventory worker has no parent port.');
parentPort.once('message', (request: CoordinateInventoryRequest) => {
  void parseCoordinateInventory(request).then(
    (result) => parentPort?.postMessage({ type: 'result', result }),
    (error: unknown) =>
      parentPort?.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
  );
});
