import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireReferenceAssetWriterLock,
  type ReferenceAssetLockHelper,
} from './reference-asset-writer-lock';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('reference asset writer lock process boundary', () => {
  it('rejects a helper that never completes its startup handshake', async () => {
    const root = await temporaryRoot();
    const startedAt = Date.now();

    await expect(
      acquireReferenceAssetWriterLock(root, nodeHelper('setInterval(() => undefined, 1_000);', 100))
    ).rejects.toThrow('startup exceeded the 100 ms response deadline');

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('rejects a helper that stops responding after it owns the lock', async () => {
    const root = await temporaryRoot();
    const lease = await acquireStartedHelper(
      root,
      nodeHelper(
        `
          process.stdout.write('{"event":"locked"}\\n');
          process.stdin.resume();
          setInterval(() => undefined, 1_000);
        `,
        100
      )
    );
    const startedAt = Date.now();

    await expect(lease.release()).rejects.toThrow('release exceeded the 100 ms response deadline');

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('bounds a command write when the helper never drains its stdin pipe', async () => {
    const root = await temporaryRoot();
    const lease = await acquireStartedHelper(
      root,
      nodeHelper(
        `
          process.stdout.write('{"event":"locked"}\\n');
          setInterval(() => undefined, 1_000);
        `,
        100
      )
    );
    const startedAt = Date.now();

    await expect(
      lease.commitPointer('x'.repeat(4 * 1024 * 1024), join(root, 'pointer.json'))
    ).rejects.toThrow('pointer commit command write exceeded the 100 ms response deadline');

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('retains the successful lock and release protocol', async () => {
    const root = await temporaryRoot();
    const lease = await acquireStartedHelper(
      root,
      nodeHelper(
        `
          const readline = require('node:readline');
          process.stdout.write('{"event":"locked"}\\n');
          readline.createInterface({ input: process.stdin }).on('line', (line) => {
            const command = JSON.parse(line);
            if (command.command === 'release') {
              process.stdout.write('{"event":"released"}\\n', () => process.exit(0));
            }
          });
        `,
        1_000
      )
    );

    await expect(lease.assertOwned()).resolves.toBeUndefined();
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('allows exact pointer reconciliation after a lost commit acknowledgement', async () => {
    const root = await temporaryRoot();
    const temporaryPointer = join(root, 'pointer.tmp');
    const pointer = join(root, 'pointer.json');
    await writeFile(temporaryPointer, '{"publication":"exact"}\n');
    const lease = await acquireStartedHelper(
      root,
      nodeHelper(
        `
          const fs = require('node:fs');
          const readline = require('node:readline');
          process.stdout.write('{"event":"locked"}\\n');
          readline.createInterface({ input: process.stdin }).on('line', (line) => {
            const command = JSON.parse(line);
            if (command.command === 'commit-pointer') {
              fs.renameSync(command.temporary_path, command.pointer_path);
            }
          });
          setInterval(() => undefined, 1_000);
        `,
        100
      )
    );

    await expect(lease.commitPointer(temporaryPointer, pointer)).rejects.toThrow(
      'pointer commit exceeded the 100 ms response deadline'
    );
    await expect(readFile(pointer, 'utf8')).resolves.toBe('{"publication":"exact"}\n');
    await expect(lease.acceptReconciledCommit()).resolves.toBeUndefined();
    await expect(lease.release()).resolves.toBeUndefined();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'reference-asset-writer-lock-'));
  temporaryRoots.push(root);
  return root;
}

async function acquireStartedHelper(root: string, helper: ReferenceAssetLockHelper) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    return await acquireReferenceAssetWriterLock(root, helper);
  } finally {
    vi.useRealTimers();
  }
}

function nodeHelper(source: string, responseTimeoutMs: number): ReferenceAssetLockHelper {
  return {
    executable: process.execPath,
    argsPrefix: [
      '-e',
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);\n${source}`,
    ],
    responseTimeoutMs,
  };
}
