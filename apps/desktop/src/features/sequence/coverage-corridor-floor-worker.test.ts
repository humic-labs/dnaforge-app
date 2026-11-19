// @vitest-environment node

import { expect, it, vi } from 'vitest';
import type {
  CoverageCorridorFloorWorkerRequest,
  CoverageCorridorFloorWorkerResponse,
} from './coverage-corridor-floor-worker-protocol';

vi.mock('../../services/sidecar-session', () => {
  throw new Error('The coverage worker imported the renderer session.');
});

vi.mock('@waypoint/genome-data', () => {
  throw new Error('The coverage worker imported the full genome data library.');
});

it('validates a payload in the worker without loading renderer services or the full data library', async () => {
  vi.stubGlobal('onmessage', null);
  try {
    const reply = new Promise<CoverageCorridorFloorWorkerResponse>((resolve) => {
      vi.stubGlobal('postMessage', resolve);
    });
    await import('./coverage-corridor-floor-worker');
    const onmessage: (event: MessageEvent<CoverageCorridorFloorWorkerRequest>) => void =
      globalThis.onmessage!;
    onmessage(
      new MessageEvent<CoverageCorridorFloorWorkerRequest>('message', {
        data: {
          id: 1,
          type: 'prepare',
          input: {
            baseUrl: 'http://sidecar.test',
            source: { bamPath: 'reads.bam' },
            assembly: { id: 'empty', displayName: 'Empty', chromosomes: [], totalLengthBp: 0 },
          },
          payload: { bytes: new ArrayBuffer(0), contractHeader: null, sourceHeader: null },
        },
      })
    );
    await expect(reply).resolves.toMatchObject({
      id: 1,
      type: 'error',
      error: {
        name: 'CoverageCorridorFloorContractError',
        message: 'corridor floor payload is shorter than its header prefix',
      },
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
