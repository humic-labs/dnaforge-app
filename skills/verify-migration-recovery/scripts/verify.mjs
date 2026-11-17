#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, encoding: 'utf8' });
const doctor = () =>
  run(process.execPath, [
    '-e',
    `require('./apps/desktop/scripts/install-test-sqlite.cjs').installTestSqlite();
require('dugite').exec(['--version'], process.cwd()).then(result => {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}).catch(error => { console.error(error); process.exitCode = 1; });`,
  ]);
const [mode, destination] = process.argv.slice(2);

if (mode === 'doctor') {
  const result = doctor();
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exitCode = result.status ?? 1;
} else if (mode === 'drive' && destination && isAbsolute(destination)) {
  const location = relative(root, destination);
  if (!location.startsWith('..') || location === '')
    throw new Error('Evidence must be outside the checkout.');
  mkdirSync(destination, { recursive: false });
  const prepared = doctor();
  writeFileSync(
    join(destination, 'doctor.log'),
    `${prepared.stdout ?? ''}${prepared.stderr ?? ''}`
  );
  if (prepared.status !== 0) throw new Error('SQLite doctor failed; see doctor.log.');
  const sources = [
    'apps/desktop/src/main/benchling-migration/state-machine.ts',
    'apps/desktop/src/main/benchling-migration/store.ts',
    'apps/desktop/src/main/benchling-migration/coordinator.ts',
    'apps/desktop/src/main/benchling-migration/staging-workspace.ts',
    'apps/desktop/src/main/benchling-migration/recovery.integration.test.ts',
    'apps/desktop/src/main/benchling-migration/staging-workspace.test.ts',
  ];
  const args = [
    'exec',
    'vitest',
    'run',
    'src/main/benchling-migration/recovery.integration.test.ts',
    'src/main/benchling-migration/staging-workspace.test.ts',
    '-t',
    'migration recovery authority|rolls back a post-Git COMMIT failure',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${join(destination, 'results.json')}`,
  ];
  const startedAt = new Date().toISOString();
  const result = run('pnpm', args, join(root, 'apps/desktop'));
  writeFileSync(join(destination, 'run.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  writeFileSync(join(destination, 'source.diff'), run('git', ['diff', 'HEAD']).stdout ?? '');
  writeFileSync(
    join(destination, 'receipt.json'),
    `${JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        commit: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
        status: run('git', ['status', '--short']).stdout,
        sourceSha256: Object.fromEntries(
          sources.map((source) => [
            source,
            createHash('sha256')
              .update(readFileSync(join(root, source)))
              .digest('hex'),
          ])
        ),
        command: ['pnpm', ...args],
        cwd: join(root, 'apps/desktop'),
        exitStatus: result.status,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exitCode = result.status ?? 1;
} else {
  throw new Error('Usage: verify.mjs doctor | drive /absolute/external/evidence-directory');
}
