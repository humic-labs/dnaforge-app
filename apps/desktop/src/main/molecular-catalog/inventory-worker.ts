import type { Worker } from 'node:worker_threads';
import { MOLECULAR_CATALOG_NORMALIZER_VERSION } from '../../shared/molecular-catalog';
import type { CoordinateInventoryRequest, CoordinateInventoryResult } from './coordinate-inventory';

export async function inventoryCoordinatesInWorker(
  request: CoordinateInventoryRequest
): Promise<CoordinateInventoryResult> {
  const module = await import('./inventory-worker-entry?nodeWorker');
  const worker: Worker = module.default({ resourceLimits: { maxOldGenerationSizeMb: 512 } });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, result?: CoordinateInventoryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.removeAllListeners();
      void worker.terminate().catch(() => undefined);
      if (error) reject(error);
      else resolve(result!);
    };
    const deadline = setTimeout(
      () => finish(new Error('Coordinate parsing exceeded its one-minute deadline.')),
      60_000
    );
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) =>
      finish(new Error(`Coordinate worker exited before returning an inventory (${code}).`))
    );
    worker.once(
      'message',
      (message: { type: string; result?: CoordinateInventoryResult; message?: string }) => {
        if (message.type === 'error')
          return finish(new Error(message.message ?? 'Coordinate parsing failed.'));
        const result = message.result;
        if (
          message.type !== 'result' ||
          !result ||
          result.inventory.version !== MOLECULAR_CATALOG_NORMALIZER_VERSION ||
          result.inventory.byteCount !== request.bytes.byteLength ||
          result.inventory.modelCount < 1 ||
          !Array.isArray(result.inventory.chains) ||
          !Array.isArray(result.mappings)
        )
          return finish(new Error('The coordinate worker returned an invalid inventory.'));
        finish(null, result);
      }
    );
    worker.postMessage(request);
  });
}
