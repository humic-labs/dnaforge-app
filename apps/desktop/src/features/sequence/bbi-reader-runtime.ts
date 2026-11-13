import { BbiReaderWorkerClient } from './bbi-reader-worker-client';
import BbiReaderWorker from './bbi-reader-worker?worker&inline';

let sharedClient: BbiReaderWorkerClient | null = null;

export function getBbiReaderWorkerClient(): BbiReaderWorkerClient {
  if (sharedClient?.hasFailed()) {
    sharedClient.dispose();
    sharedClient = null;
  }
  if (sharedClient) return sharedClient;
  const worker = new BbiReaderWorker();
  sharedClient = new BbiReaderWorkerClient(worker);
  return sharedClient;
}

export function disposeBbiReaderWorkerClient(): void {
  sharedClient?.dispose();
  sharedClient = null;
}
