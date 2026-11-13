import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import type { Entry, ZipFile } from 'yauzl';

import { iterateZip } from './native-export-archive';

class FakeZip extends EventEmitter {
  reads = 0;
  readEntry(): void {
    this.reads += 1;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('iterateZip failure settlement', () => {
  it('waits for an in-flight entry read before rejecting, and never starts that entry', async () => {
    const zip = new FakeZip();
    const started: number[] = [];
    let failFirst: (error: Error) => void = () => {};
    const iteration = iterateZip(
      zip as unknown as ZipFile,
      'walk',
      (_entry, ordinal) => {
        started.push(ordinal);
        return new Promise<void>((_resolve, reject) => {
          if (ordinal === 0) failFirst = reject;
        });
      },
      2
    );
    let settled = false;
    const outcome = iteration.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    void outcome.then(() => {
      settled = true;
    });

    zip.emit('entry', {} as Entry);
    expect(zip.reads).toBe(2);

    failFirst(new Error('durable write failed'));
    await flush();
    expect(settled).toBe(false);

    zip.emit('entry', {} as Entry);
    expect(await outcome).toBe('durable write failed');
    expect(started).toEqual([0]);
  });

  it('keeps a ZIP error after settlement from becoming an uncaught exception', async () => {
    const zip = new FakeZip();
    const iteration = iterateZip(zip as unknown as ZipFile, 'walk', async () => {}, 1);
    zip.emit('end');
    await iteration;
    expect(() => zip.emit('error', new Error('EBADF: bad file descriptor, read'))).not.toThrow();
  });
});
