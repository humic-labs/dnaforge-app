import { CoverageCorridorFloorWorkerClient } from './coverage-corridor-floor-worker-client';
import CoverageCorridorFloorWorker from './coverage-corridor-floor-worker?worker&inline';
import {
  fetchAuthenticatedCoverageCorridorFloorPayload,
  type PreparedCoverageCorridorFloor,
} from './coverage-corridor-floor';
import type { CoverageCorridorFloorWorkerInput } from './coverage-corridor-floor-worker-protocol';

export async function loadPreparedCoverageCorridorFloorInWorker(
  input: CoverageCorridorFloorWorkerInput,
  signal?: AbortSignal
): Promise<PreparedCoverageCorridorFloor | null> {
  const payload = await fetchAuthenticatedCoverageCorridorFloorPayload({
    ...input,
    signal,
  });
  const client = new CoverageCorridorFloorWorkerClient(new CoverageCorridorFloorWorker());
  return client.prepare(input, payload, signal);
}
