#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const BUILD_HEAP_OPTION = '--max-old-space-size=4096';

function buildHeapNodeOptions(existing) {
  return [BUILD_HEAP_OPTION, existing?.trim()].filter(Boolean).join(' ');
}

function runWithBuildHeap(command, { env = process.env, spawn = spawnSync } = {}) {
  if (command.length === 0) throw new Error('with-build-heap needs a command to run');
  const result = spawn(command.join(' '), {
    stdio: 'inherit',
    shell: true,
    env: { ...env, NODE_OPTIONS: buildHeapNodeOptions(env.NODE_OPTIONS) },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

module.exports = { BUILD_HEAP_OPTION, buildHeapNodeOptions, runWithBuildHeap };

if (require.main === module) {
  process.exitCode = runWithBuildHeap(process.argv.slice(2));
}
