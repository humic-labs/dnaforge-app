'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  BUILD_HEAP_OPTION,
  buildHeapNodeOptions,
  runWithBuildHeap,
} = require('./with-build-heap.cjs');

const SCRIPT = path.join(__dirname, 'with-build-heap.cjs');

describe('with-build-heap', () => {
  it('puts the 4 GB default first so a larger value from the caller wins', () => {
    assert.equal(buildHeapNodeOptions(undefined), BUILD_HEAP_OPTION);
    assert.equal(buildHeapNodeOptions('  '), BUILD_HEAP_OPTION);
    assert.equal(
      buildHeapNodeOptions('--max-old-space-size=8192 --trace-warnings'),
      `${BUILD_HEAP_OPTION} --max-old-space-size=8192 --trace-warnings`
    );
  });

  it('runs the command through the platform shell with the heap set and returns its exit code', () => {
    const calls = [];
    const status = runWithBuildHeap(['electron-vite', 'build'], {
      env: { PATH: '/bin' },
      spawn: (command, options) => {
        calls.push({ command, options });
        return { status: 3 };
      },
    });
    assert.equal(status, 3);
    assert.equal(calls[0].command, 'electron-vite build');
    assert.equal(calls[0].options.shell, true);
    assert.equal(calls[0].options.env.NODE_OPTIONS, BUILD_HEAP_OPTION);
    assert.equal(calls[0].options.env.PATH, '/bin');
    assert.throws(() => runWithBuildHeap([]), /needs a command/u);
  });

  it('gives a real child process the larger heap', () => {
    const probe = 'node -e "process.exit(require(\'v8\').getHeapStatistics().heap_size_limit > 3.5e9 ? 0 : 7)"';
    const result = spawnSync(process.execPath, [SCRIPT, probe], {
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });
});
