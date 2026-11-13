import { prepareAuthenticatedCoverageCorridorFloorPayload } from './coverage-corridor-floor';
import type {
  CoverageCorridorFloorWorkerRequest,
  CoverageCorridorFloorWorkerResponse,
} from './coverage-corridor-floor-worker-protocol';

interface CoverageCorridorFloorWorkerScope {
  onmessage: ((event: MessageEvent<CoverageCorridorFloorWorkerRequest>) => void) | null;
  postMessage(message: CoverageCorridorFloorWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as typeof globalThis & CoverageCorridorFloorWorkerScope;
const activeRequests = new Map<number, AbortController>();

scope.onmessage = (event) => {
  void handleRequest(event.data);
};

async function handleRequest(request: CoverageCorridorFloorWorkerRequest): Promise<void> {
  if (request.type === 'cancel') {
    activeRequests.get(request.targetId)?.abort();
    return;
  }
  const controller = new AbortController();
  activeRequests.set(request.id, controller);
  try {
    const result = await prepareAuthenticatedCoverageCorridorFloorPayload(
      { ...request.input, signal: controller.signal },
      request.payload
    );
    const transfer: Transferable[] = [];
    if (result) {
      for (const layer of result.floor.layers.values()) transfer.push(layer.bins.buffer);
      transfer.push(result.atlas.data.buffer);
    }
    scope.postMessage({ id: request.id, type: 'result', result }, transfer);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({
      id: request.id,
      type: 'error',
      error: { name: normalized.name, message: normalized.message },
    });
  } finally {
    activeRequests.delete(request.id);
  }
}
