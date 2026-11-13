import { TextIntervalReaderWorkerClient } from './text-interval-reader-worker-client';
import TextIntervalReaderWorker from './text-interval-reader-worker?worker&inline';

let sharedClient: TextIntervalReaderWorkerClient | null = null;

export function getTextIntervalReaderWorkerClient(): TextIntervalReaderWorkerClient {
  if (sharedClient) return sharedClient;
  const worker = new TextIntervalReaderWorker();
  sharedClient = new TextIntervalReaderWorkerClient(worker);
  return sharedClient;
}

export function disposeTextIntervalReaderWorkerClient(): void {
  sharedClient?.dispose();
  sharedClient = null;
}
