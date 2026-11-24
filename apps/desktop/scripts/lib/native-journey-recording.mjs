import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function finalizeJourneyRecording(
  directory,
  receipt,
  { video = 'workflow.mp4', execute = spawnSync } = {}
) {
  receipt.status ??= receipt.passed === true ? 'passed' : 'failed';
  try {
    assert.match(video, /^[a-zA-Z0-9_-]+\.mp4$/u, 'Invalid recording filename');
    assert.ok(!existsSync(join(directory, video)), 'Recording output already exists');
    assert.ok(
      Array.isArray(receipt.frames) && receipt.frames.length > 1,
      'Recording needs multiple frames'
    );
    for (const frame of receipt.frames) {
      assert.match(
        frame.file,
        /^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u,
        'Invalid frame filename'
      );
      const file = lstatSync(join(directory, frame.file));
      assert.ok(file.isFile() && file.size > 0, `Frame is empty or not a file: ${frame.file}`);
      assert.ok(Number.isFinite(frame.timestamp), 'Frame timestamp is missing or invalid');
    }
    const frames = [...receipt.frames].sort((left, right) => left.timestamp - right.timestamp);
    const manifest = [];
    for (const [index, frame] of frames.entries()) {
      const next = frames[index + 1];
      const duration = next ? Math.max(0.01, next.timestamp - frame.timestamp) : 0.25;
      manifest.push(`file '${frame.file}'`, 'option framerate 1000', `duration ${duration}`);
    }
    manifest.push(`file '${frames.at(-1).file}'`, 'option framerate 1000');
    writeFileSync(join(directory, 'frames.txt'), `${manifest.join('\n')}\n`);
    const result = execute(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-n',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'frames.txt',
        '-fps_mode',
        'vfr',
        '-enc_time_base',
        '1:1000',
        '-bf',
        '0',
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-pix_fmt',
        'yuv420p',
        video,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 120000 }
    );
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `Recording encoder failed: ${result.stderr || result.signal || result.status}`
    );
    const output = join(directory, video);
    const info = lstatSync(output);
    assert.ok(info.isFile() && info.size >= 12, 'Recording output is empty or not a file');
    const header = Buffer.alloc(12);
    const descriptor = openSync(output, 'r');
    try {
      readSync(descriptor, header, 0, header.length, 0);
    } finally {
      closeSync(descriptor);
    }
    assert.equal(header.toString('ascii', 4, 8), 'ftyp', 'Recording output is not MP4');
  } catch (error) {
    receipt.status = 'failed';
    receipt.mediaError = error.stack ?? String(error);
    if ('passed' in receipt) receipt.passed = false;
  }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
