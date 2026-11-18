import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const root = process.env.DNAFORGE_RECORDING_SUBJECT_ROOT ?? repository;
const subject = await import(
  pathToFileURL(path.join(root, 'apps/desktop/scripts/lib/native-journey-recording.mjs')).href
).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const operation = () => {
  assert.equal(typeof subject.finalizeJourneyRecording, 'function', 'Missing recording finalizer');
  return subject.finalizeJourneyRecording;
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dnaforge-recording-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'frames'));
  const frames = [10, 10.25, 11].map((timestamp, index) => {
    const file = `frames/${String(index).padStart(6, '0')}.jpg`;
    copyFileSync(
      path.join(repository, 'test-fixtures/images/sample.jpg'),
      path.join(directory, file)
    );
    return { file, timestamp };
  });
  const receipt = {
    status: 'passed',
    error: null,
    sourceCommit: '1'.repeat(40),
    startedAt: '2026-11-16T12:00:00Z',
    steps: [{ name: 'functional acceptance' }],
    frames,
  };
  const originals = new Map(
    frames.map(({ file }) => [file, digest(readFileSync(path.join(directory, file)))])
  );
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(
      existsSync(path.join(directory, 'receipt.json')),
      false,
      'Receipt was published before encoding'
    );
    const destination = path.resolve(options.cwd ?? directory, args.at(-1));
    writeFileSync(
      destination,
      Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
    );
    return { status: 0, stdout: '', stderr: '' };
  };
  return { directory, receipt, frames, originals, calls, execute };
}

function preserved(f) {
  for (const [file, hash] of f.originals)
    assert.equal(
      digest(readFileSync(path.join(f.directory, file))),
      hash,
      `Original frame changed: ${file}`
    );
}

function persisted(f, receipt) {
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(f.directory, 'receipt.json'), 'utf8')),
    JSON.parse(JSON.stringify(receipt))
  );
  assert.ok(Number.isFinite(Date.parse(receipt.finishedAt)), 'Final timestamp is missing');
}

test('valid captured frames encode with current FFmpeg timing and padding before receipt publication', async (t) => {
  const finalize = operation();
  const f = fixture(t);
  const receipt = await finalize(f.directory, f.receipt, { execute: f.execute });
  assert.equal(receipt.status, 'passed');
  assert.equal(f.calls.length, 1);
  const { command, args, options } = f.calls[0];
  assert.equal(command, 'ffmpeg');
  assert.equal(args.includes('-vsync'), false);
  assert.equal(args[args.indexOf('-fps_mode') + 1], 'vfr');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.match(args[args.indexOf('-vf') + 1], /pad=ceil\(iw\/2\)\*2:ceil\(ih\/2\)\*2/u);
  const manifestPath = path.resolve(options.cwd ?? f.directory, args[args.indexOf('-i') + 1]);
  const manifest = readFileSync(manifestPath, 'utf8');
  for (const { file } of f.frames)
    assert.ok(manifest.includes(file), `Missing original frame ${file}`);
  const durations = [...manifest.matchAll(/^duration ([0-9.]+)$/gmu)].map((match) =>
    Number(match[1])
  );
  assert.deepEqual(durations.slice(0, 2), [0.25, 0.75]);
  assert.ok(durations.every((value) => Number.isFinite(value) && value > 0));
  assert.equal(path.basename(args.at(-1)), 'workflow.mp4');
  assert.equal(existsSync(path.join(f.directory, 'workflow.mp4')), true);
  preserved(f);
  persisted(f, receipt);
});

test('the chat output filename is selected without changing frame timing or source evidence', async (t) => {
  const finalize = operation();
  const f = fixture(t);
  await finalize(f.directory, f.receipt, { video: 'journey.mp4', execute: f.execute });
  assert.equal(path.basename(f.calls[0].args.at(-1)), 'journey.mp4');
  assert.equal(existsSync(path.join(f.directory, 'journey.mp4')), true);
  preserved(f);
});

for (const [name, mutate] of [
  [
    'empty capture',
    (f) => {
      f.receipt.frames = [];
    },
  ],
  [
    'single frame',
    (f) => {
      f.receipt.frames = [f.frames[0]];
    },
  ],
  [
    'missing frame file',
    (f) => {
      f.receipt.frames[1].file = 'frames/absent.jpg';
    },
  ],
  [
    'empty frame file',
    (f) => {
      const file = 'frames/empty.jpg';
      writeFileSync(path.join(f.directory, file), '');
      f.receipt.frames[1] = { file, timestamp: 10.25 };
    },
  ],
  [
    'missing timestamp',
    (f) => {
      delete f.receipt.frames[1].timestamp;
    },
  ],
  [
    'non-finite timestamp',
    (f) => {
      f.receipt.frames[1].timestamp = Number.NaN;
    },
  ],
])
  test(`${name} cannot produce a passing recording`, async (t) => {
    const finalize = operation();
    const f = fixture(t);
    mutate(f);
    const receipt = await finalize(f.directory, f.receipt, { execute: f.execute });
    assert.equal(receipt.status, 'failed');
    assert.ok(typeof receipt.mediaError === 'string' && receipt.mediaError.length > 0);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(f.directory, 'workflow.mp4')), false);
    preserved(f);
    persisted(f, receipt);
  });

for (const [name, execute] of [
  ['failed encoder', () => ({ status: 1, stderr: 'encoder rejected option' })],
  [
    'encoder could not start',
    () => ({ status: null, error: new Error('encoder ENOENT'), stderr: '' }),
  ],
  [
    'encoder threw',
    () => {
      throw new Error('encoder process failed');
    },
  ],
  ['zero exit without output', () => ({ status: 0, stderr: '' })],
])
  test(`${name} is retained as a failed media result`, async (t) => {
    const finalize = operation();
    const f = fixture(t);
    const receipt = await finalize(f.directory, f.receipt, { execute });
    assert.equal(receipt.status, 'failed');
    assert.ok(typeof receipt.mediaError === 'string' && receipt.mediaError.length > 0);
    preserved(f);
    persisted(f, receipt);
  });

test('successful recording preserves the original functional failure', async (t) => {
  const finalize = operation();
  const f = fixture(t);
  f.receipt.status = 'failed';
  f.receipt.error = 'Original functional assertion failed';
  const receipt = await finalize(f.directory, f.receipt, { execute: f.execute });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error, 'Original functional assertion failed');
  assert.deepEqual(receipt.steps, [{ name: 'functional acceptance' }]);
  preserved(f);
  persisted(f, receipt);
});

test('zero exit with non-MP4 bytes cannot qualify recording evidence', async (t) => {
  const finalize = operation();
  const f = fixture(t);
  const receipt = await finalize(f.directory, f.receipt, {
    execute: (_command, args, options) => {
      writeFileSync(path.resolve(options.cwd ?? f.directory, args.at(-1)), 'not an MP4');
      return { status: 0, stderr: '' };
    },
  });
  assert.equal(receipt.status, 'failed');
  assert.ok(typeof receipt.mediaError === 'string' && receipt.mediaError.length > 0);
  preserved(f);
  persisted(f, receipt);
});

test('encoding failure adds media evidence without replacing the functional error', async (t) => {
  const finalize = operation();
  const f = fixture(t);
  f.receipt.status = 'failed';
  f.receipt.error = 'Original functional assertion failed';
  const receipt = await finalize(f.directory, f.receipt, {
    execute: () => ({ status: 1, stderr: 'independent media failure' }),
  });
  assert.equal(receipt.error, 'Original functional assertion failed');
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.mediaError, /independent media failure/u);
  preserved(f);
  persisted(f, receipt);
});

test('chat boolean success normalizes to a passing status only after encoding', async (t) => {
  const finalize = operation();
  const f = fixture(t);
  delete f.receipt.status;
  f.receipt.passed = true;
  const receipt = await finalize(f.directory, f.receipt, { execute: f.execute });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.passed, true);
  persisted(f, receipt);
});

test('chat media failure clears boolean success and preserves its original failure field', async (t) => {
  const finalize = operation();
  const f = fixture(t);
  delete f.receipt.status;
  f.receipt.passed = true;
  f.receipt.failure = 'Original chat diagnostic';
  const receipt = await finalize(f.directory, f.receipt, {
    execute: () => ({ status: 1, stderr: 'chat encoder failed' }),
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.passed, false);
  assert.equal(receipt.failure, 'Original chat diagnostic');
  assert.match(receipt.mediaError, /chat encoder failed/u);
  preserved(f);
  persisted(f, receipt);
});
