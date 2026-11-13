import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function registerDevProcessFreshnessTests(test) {
  const require = createRequire(import.meta.url);
  const guard = require('../dev-single-instance-guard.cjs');

  function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'dna4154-process-freshness-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  function writeSource(root, name, value) {
    const file = join(root, name, 'src/main/index.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
    return file;
  }

  async function startOwnedChild(t, cwd) {
    const parentBeforeSpawnAtMs = Date.now();
    const child = spawn(
      process.execPath,
      ['-e', 'process.send({ childStartedAtMs: Date.now() }); setInterval(() => {}, 1000);'],
      {
        cwd,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      }
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    });
    const born = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('owned process did not report its actual startup clock')),
        2000
      );
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { child, parentBeforeSpawnAtMs, ...born };
  }

  function observe(sourceFile, owned, index, phase) {
    const observedAtMs = Date.now();
    const newestSource = guard.newestRuntimeSourceMtime([dirname(sourceFile)]);
    const freshness = guard.evaluateRuntimeSourceFreshness({
      debugPids: [owned.child.pid],
      newestSource,
    });
    const rawPsLstart = execFileSync('ps', ['-p', String(owned.child.pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
      killSignal: 'SIGKILL',
    }).trim();
    const record = {
      phase,
      index,
      pid: owned.child.pid,
      platform: process.platform,
      parentBeforeSpawnAtMs: owned.parentBeforeSpawnAtMs,
      childStartedAtMs: owned.childStartedAtMs,
      sourceMtimeMs: statSync(sourceFile).mtimeMs,
      observedAtMs,
      observedAfterMs: Date.now(),
      rawPsLstart,
      freshness,
    };
    console.log(`DNA4154_PROCESS_FRESHNESS_SAMPLE ${JSON.stringify(record)}`);
    return record;
  }

  test(
    'owned fresh processes never become stale for source written before actual spawn',
    { timeout: 10000 },
    async (t) => {
      const root = fixture(t);
      const samples = [];
      for (let index = 0; index < 12; index++) {
        const source = writeSource(root, `sample-${index}`, `export const sample = ${index};\n`);
        const owned = await startOwnedChild(t, dirname(source));
        const record = observe(source, owned, index, 'before-spawn-source');
        samples.push(record);
        const exited = once(owned.child, 'exit');
        owned.child.kill('SIGTERM');
        await exited;
        await delay(75);
      }
      for (const sample of samples) {
        assert.ok(
          Math.floor(sample.sourceMtimeMs) <= sample.parentBeforeSpawnAtMs,
          JSON.stringify(sample)
        );
        assert.ok(sample.parentBeforeSpawnAtMs <= sample.childStartedAtMs, JSON.stringify(sample));
        assert.ok(
          Number.isFinite(sample.freshness.oldestProcessStart?.startMs),
          JSON.stringify(sample)
        );
        assert.equal(
          sample.freshness.stale,
          false,
          `pre-existing source falsely marks a fresh owned process stale:\n${JSON.stringify(sample, null, 2)}`
        );
      }
    }
  );

  test(
    'an actual source edit after a running owned process remains stale',
    { timeout: 6000 },
    async (t) => {
      const root = fixture(t);
      const source = writeSource(root, 'later-edit', 'export const version = 1;\n');
      const owned = await startOwnedChild(t, dirname(source));
      await delay(1100);
      writeFileSync(source, 'export const version = 2;\n');
      const record = observe(source, owned, 0, 'after-running-source-edit');
      assert.ok(record.sourceMtimeMs > owned.childStartedAtMs + 1000, JSON.stringify(record));
      assert.equal(
        record.freshness.stale,
        true,
        `a real later source edit must retain stale-runtime detection:\n${JSON.stringify(record, null, 2)}`
      );
    }
  );
}
