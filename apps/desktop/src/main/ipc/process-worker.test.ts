import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ProcessWorkerV1 } from './process-worker';

const dir = mkdtempSync(join(tmpdir(), 'process-worker-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function entry(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

describe('ProcessWorkerV1', () => {
  it('exchanges structured-clone messages and passes its environment', async () => {
    const worker = new ProcessWorkerV1(
      entry(
        'echo.cjs',
        `process.on('message', (m) => process.send({ echo: m, env: process.env.PW_TEST, map: new Map([[1, 2]]) }));`
      ),
      { PW_TEST: 'yes' }
    );
    const reply = await new Promise<{
      echo: { value: Uint8Array };
      env: string;
      map: Map<number, number>;
    }>((resolve) => {
      worker.on('message', resolve);
      worker.postMessage({ value: new Uint8Array([1, 2, 3]) });
    });
    expect(ArrayBuffer.isView(reply.echo.value)).toBe(true);
    expect(Array.from(reply.echo.value)).toEqual([1, 2, 3]);
    expect(reply.env).toBe('yes');
    expect(reply.map.get(1)).toBe(2);
    await worker.terminate();
  });

  it('reports a crashed child as a non-zero exit', async () => {
    const worker = new ProcessWorkerV1(entry('crash.cjs', `process.exit(3);`));
    const code = await new Promise<number>((resolve) => worker.on('exit', resolve));
    expect(code).toBe(3);
    await worker.terminate();
  });
});
