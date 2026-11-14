#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const configIndex = Number(process.env.GIT_CONFIG_COUNT ?? 0);
fixtureEnvironment.GIT_CONFIG_COUNT = String(configIndex + 1);
fixtureEnvironment[`GIT_CONFIG_KEY_${configIndex}`] = 'commit.gpgsign';
fixtureEnvironment[`GIT_CONFIG_VALUE_${configIndex}`] = 'false';
const run = (command, args, cwd = root) =>
  spawnSync(command, args, { cwd, encoding: 'utf8', env: fixtureEnvironment });
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
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination, { recursive: false });
  const prepared = doctor();
  writeFileSync(
    join(destination, 'doctor.log'),
    `${prepared.stdout ?? ''}${prepared.stderr ?? ''}`
  );
  if (prepared.status !== 0) throw new Error('SQLite doctor failed; see doctor.log.');
  const sources = [
    'apps/desktop/src/main/workspace-sync-queue.ts',
    'apps/desktop/src/main/workspace-sync-upload-worker.ts',
    'apps/desktop/src/main/workspace-sync-actions.ts',
    'apps/desktop/src/main/workspace-sync-conflicts.ts',
    'apps/desktop/src/main/workspace-sync-runtime.ts',
    'apps/desktop/src/main/workspace-sync-reconcile-runtime.ts',
    'apps/desktop/src/main/workspace-sync-access-record.ts',
    'apps/desktop/src/main/workspace-sync-delete.ts',
    'apps/desktop/src/main/workspace-sync-projects.ts',
    'apps/desktop/src/main/__tests__/workspace-sync-queue.test.ts',
    'apps/desktop/src/main/__tests__/workspace-sync-upload-worker.test.ts',
    'apps/desktop/src/main/__tests__/workspace-sync-actions.test.ts',
    'apps/desktop/src/main/__tests__/workspace-sync-conflicts.test.ts',
    'apps/desktop/src/main/__tests__/workspace-sync-runtime.test.ts',
    'skills/verify-sync-transitions/scripts/file-databases.ts',
    'skills/verify-sync-transitions/scripts/vitest.config.ts',
  ];
  const args = [
    'exec',
    'vitest',
    'run',
    '--config',
    '../../skills/verify-sync-transitions/scripts/vitest.config.ts',
    'src/main/__tests__/workspace-sync-queue.test.ts',
    'src/main/__tests__/workspace-sync-upload-worker.test.ts',
    'src/main/__tests__/workspace-sync-actions.test.ts',
    'src/main/__tests__/workspace-sync-conflicts.test.ts',
    'src/main/__tests__/workspace-sync-runtime.test.ts',
    '-t',
    'retains native accepted identity|refuses a failure callback from the previously accepted|recovers stale running locks|pauses jobs for the wrong active account|does not overwrite a terminal state|reactivates only a sync-disabled upload|does not let a newer upload overtake|commits native upload acceptance before|rejects an older native upload acknowledgement|does not acknowledge a response after another worker|backs off retryable failures durably|rolls back upload acknowledgement|supersedes an older failed upload|disables sync by canceling pending uploads|keep_local rebases the pending upload|use_remote preserves the active workspace identity|keeps the old conflict binding if the atomic replacement|rolls back conflict cancellation when replacement enqueue fails|persists a retryable failure when listing remote workspaces|settles an old recovery quarantine|keeps a failed package recovery quarantined|unblocks account-paused durable work',
    '--reporter=default',
    '--reporter=json',
  ];
  args.push(`--outputFile.json=${join(destination, 'results.json')}`);
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
