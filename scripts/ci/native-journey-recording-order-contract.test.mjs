import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { finalizeJourneyRecording } from '../../apps/desktop/scripts/lib/native-journey-recording.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('frames arriving out of timestamp order encode chronologically without rewriting original evidence', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dnaforge-recording-order-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'frames'));
  const frames = [10, 11, 10.25].map((timestamp, index) => {
    const file = `frames/${String(index).padStart(6, '0')}.jpg`;
    copyFileSync(
      path.join(repository, 'test-fixtures/images/sample.jpg'),
      path.join(directory, file)
    );
    return { file, timestamp };
  });
  const originalFrames = structuredClone(frames);
  const originalBytes = new Map(
    frames.map(({ file }) => [file, digest(readFileSync(path.join(directory, file)))])
  );
  const receipt = { status: 'passed', frames, steps: [{ name: 'functional acceptance' }] };
  let calls = 0;
  const result = finalizeJourneyRecording(directory, receipt, {
    execute: (_command, args, options) => {
      calls += 1;
      const manifest = readFileSync(
        path.resolve(options.cwd, args[args.indexOf('-i') + 1]),
        'utf8'
      );
      const files = [...manifest.matchAll(/^file '([^']+)'$/gmu)].map((match) => match[1]);
      const durations = [...manifest.matchAll(/^duration ([0-9.]+)$/gmu)].map((match) =>
        Number(match[1])
      );
      assert.deepEqual(files.slice(0, 3), [frames[0].file, frames[2].file, frames[1].file]);
      assert.deepEqual(durations.slice(0, 2), [0.25, 0.75]);
      assert.deepEqual(receipt.frames, originalFrames);
      writeFileSync(
        path.resolve(options.cwd, args.at(-1)),
        Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
      );
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.status, 'passed', result.mediaError);
  assert.equal(calls, 1);
  assert.deepEqual(result.frames, originalFrames);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(directory, 'receipt.json'), 'utf8')).frames,
    originalFrames
  );
  for (const [file, hash] of originalBytes)
    assert.equal(digest(readFileSync(path.join(directory, file))), hash);
});
