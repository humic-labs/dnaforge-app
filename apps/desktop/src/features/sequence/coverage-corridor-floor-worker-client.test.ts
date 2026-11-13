// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { Assembly } from '@waypoint/genome-renderer';

import { CoverageCorridorFloorWorkerClient } from './coverage-corridor-floor-worker-client';
import type {
  CoverageCorridorFloorWorkerInput,
  CoverageCorridorFloorWorkerLike,
  CoverageCorridorFloorWorkerRequest,
  CoverageCorridorFloorWorkerResponse,
} from './coverage-corridor-floor-worker-protocol';
import type {
  AuthenticatedCoverageCorridorFloorPayload,
  PreparedCoverageCorridorFloor,
} from './coverage-corridor-floor';

class FakeWorker implements CoverageCorridorFloorWorkerLike {
  readonly requests: CoverageCorridorFloorWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminateCount = 0;
  private readonly messageListeners = new Set<
    (event: MessageEvent<CoverageCorridorFloorWorkerResponse>) => void
  >();
  private readonly failureListeners = new Map<
    'error' | 'messageerror',
    Set<(event: Event) => void>
  >([
    ['error', new Set()],
    ['messageerror', new Set()],
  ]);

  postMessage(message: CoverageCorridorFloorWorkerRequest, transfer: Transferable[] = []): void {
    this.requests.push(message);
    this.transfers.push(transfer);
  }

  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener:
      | ((event: MessageEvent<CoverageCorridorFloorWorkerResponse>) => void)
      | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.add(
        listener as (event: MessageEvent<CoverageCorridorFloorWorkerResponse>) => void
      );
      return;
    }
    this.failureListeners.get(type)?.add(listener as (event: Event) => void);
  }

  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener:
      | ((event: MessageEvent<CoverageCorridorFloorWorkerResponse>) => void)
      | ((event: Event) => void)
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(
        listener as (event: MessageEvent<CoverageCorridorFloorWorkerResponse>) => void
      );
      return;
    }
    this.failureListeners.get(type)?.delete(listener as (event: Event) => void);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  respond(response: CoverageCorridorFloorWorkerResponse): void {
    for (const listener of this.messageListeners) {
      listener({ data: response } as MessageEvent<CoverageCorridorFloorWorkerResponse>);
    }
  }
}

function authenticatedPayload(): AuthenticatedCoverageCorridorFloorPayload {
  return {
    bytes: new ArrayBuffer(8),
    contractHeader: 'coverage-corridor-floor.v1',
    sourceHeader: 'source',
  };
}

function workerInput(): CoverageCorridorFloorWorkerInput {
  return {
    baseUrl: 'http://sidecar',
    source: { bamPath: '/data/HG002.bam' },
    assembly: {} as Assembly,
  };
}

describe('CoverageCorridorFloorWorkerClient', () => {
  it('publishes one prepared pair and terminates the one-shot worker', async () => {
    const worker = new FakeWorker();
    const client = new CoverageCorridorFloorWorkerClient(worker);
    const prepared = {
      floor: { layers: new Map() },
      atlas: { data: new Float32Array([1]) },
    } as unknown as PreparedCoverageCorridorFloor;

    const payload = authenticatedPayload();
    const pending = client.prepare(workerInput(), payload);
    expect(worker.requests).toEqual([{ id: 1, type: 'prepare', input: workerInput(), payload }]);
    expect(worker.transfers[0]).toEqual([payload.bytes]);
    worker.respond({ id: 1, type: 'result', result: prepared });

    await expect(pending).resolves.toBe(prepared);
    expect(worker.terminateCount).toBe(1);
  });

  it('cancels the exact preparation and terminates its worker on driver abort', async () => {
    const worker = new FakeWorker();
    const client = new CoverageCorridorFloorWorkerClient(worker);
    const controller = new AbortController();

    const payload = authenticatedPayload();
    const pending = client.prepare(workerInput(), payload, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.requests).toEqual([
      { id: 1, type: 'prepare', input: workerInput(), payload },
      { id: 2, type: 'cancel', targetId: 1 },
    ]);
    expect(worker.terminateCount).toBe(1);
  });
});
