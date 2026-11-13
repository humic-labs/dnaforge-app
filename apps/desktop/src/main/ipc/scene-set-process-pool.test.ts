import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import type {
  ExpandedAnnotationSceneWorkerJob,
  ExpandedAnnotationSceneWorkerSetJob,
} from './assembly-expanded-annotation-scene-compiler';
import type { ExpandedAnnotationSceneWorkerRequest } from './assembly-expanded-annotation-scene-worker-client';
import { compileSceneSetOnProcessPoolV1 } from './scene-set-process-pool';

function job(trackType: string): ExpandedAnnotationSceneWorkerJob {
  return { request: { artifact: { trackType } } } as unknown as ExpandedAnnotationSceneWorkerJob;
}

class FakeJobProcess extends EventEmitter {
  readonly slices: string[] = [];
  parseSets: string[][] = [];
  terminated = false;
  constructor(private readonly failOn?: string) {
    super();
  }
  postMessage(request: ExpandedAnnotationSceneWorkerRequest): void {
    if (request.type !== 'compile-set') throw new Error('unexpected request');
    const trackType = request.job.jobs[0].request.artifact.trackType;
    this.slices.push(trackType);
    this.parseSets.push([...(request.job.parseTrackTypes ?? [])]);
    setImmediate(() => {
      if (trackType === this.failOn) {
        this.emit('message', {
          type: 'error',
          error: { name: 'Error', message: `boom ${trackType}` },
        });
      } else {
        this.emit('message', {
          type: 'set-result',
          result: {
            results: [
              {
                status: 'committed',
                featureCount: trackType.length,
                droppedCount: 0,
                primitiveCount: 0,
                byteCount: 0,
              },
            ],
          },
        });
      }
    });
  }
  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

const SET: ExpandedAnnotationSceneWorkerSetJob = {
  jobs: ['gene', 'mRNA', 'ncRNA', 'transcript', 'tRNA'].map(job),
};

describe('compileSceneSetOnProcessPoolV1', () => {
  it('returns results in set order and dispatches heavy tracks first', async () => {
    const processes: FakeJobProcess[] = [];
    const result = await compileSceneSetOnProcessPoolV1(SET, {
      processCount: 2,
      createProcess: () => {
        const process = new FakeJobProcess();
        processes.push(process);
        return process;
      },
    });
    expect(result.results.map((entry) => entry.featureCount)).toEqual([4, 4, 5, 10, 4]);
    expect(processes.map((process) => process.slices[0]).sort()).toEqual(['mRNA', 'transcript']);
    expect(processes.every((process) => process.terminated)).toBe(true);
    const heavy = processes.find((process) => process.slices[0] === 'mRNA')!;
    const other = processes.find((process) => process.slices[0] === 'transcript')!;
    expect(heavy.parseSets[0]).toEqual(['mRNA']);
    expect(other.parseSets[0]).toEqual(['gene', 'mRNA', 'ncRNA', 'transcript', 'tRNA']);
  });

  it('fails the set when a slice fails and still terminates every process', async () => {
    const processes: FakeJobProcess[] = [];
    await expect(
      compileSceneSetOnProcessPoolV1(SET, {
        processCount: 2,
        createProcess: () => {
          const process = new FakeJobProcess('ncRNA');
          processes.push(process);
          return process;
        },
      })
    ).rejects.toThrow('boom ncRNA');
    expect(processes.every((process) => process.terminated)).toBe(true);
  });

  it('fails the set when a job process exits mid-slice', async () => {
    const crashing = new FakeJobProcess();
    crashing.postMessage = () => setImmediate(() => crashing.emit('exit', 1));
    await expect(
      compileSceneSetOnProcessPoolV1(SET, { processCount: 1, createProcess: () => crashing })
    ).rejects.toThrow('exited before completion');
    expect(crashing.terminated).toBe(true);
  });
});
