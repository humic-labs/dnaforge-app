#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { helperExecutableName } from '../../apps/desktop/scripts/lib/verify-package-helpers.cjs';
import { NATIVE_JOURNEY_COMMAND_TIMEOUT_MS } from '../../apps/desktop/scripts/lib/native-journey-readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = 'apps/desktop/scripts/dev-single-instance-guard.cjs';

export const NATIVE_JOURNEYS = Object.freeze({
  workspace: {
    script: 'apps/desktop/scripts/check-workspace-session.mjs',
    phases: [
      { name: 'transitions', steps: 4, video: 'workflow.mp4' },
      { name: 'restored', steps: 1, video: 'workflow.mp4', restart: true },
    ],
  },
  track: {
    script: 'apps/desktop/scripts/check-track-view-session.mjs',
    phases: [{ name: 'transitions', steps: 6, video: 'workflow.mp4' }],
  },
  genome: {
    script: 'apps/desktop/scripts/check-genome-session.mjs',
    phases: [{ steps: 3, video: 'workflow.mp4' }],
  },
  canvas: {
    script: 'skills/verify-canvas-document-types/scripts/drive-native.mjs',
    phases: [{ steps: 5, video: 'workflow.mp4' }],
  },
  chat: {
    script: 'skills/verify-chat-execution/scripts/native.mjs',
    phases: [{ steps: 4, video: 'journey.mp4' }],
  },
  palettes: {
    script: 'apps/desktop/scripts/palette-enzyme-journey.mjs',
    phases: [{ observations: 7 }],
  },
});

export function selectNativeJourneys(value = Object.keys(NATIVE_JOURNEYS).join(',')) {
  const names = value.split(',');
  assert.ok(
    names.length > 0 && names.every((name) => Object.hasOwn(NATIVE_JOURNEYS, name)),
    'Unknown or empty native journey selection'
  );
  assert.equal(new Set(names).size, names.length, 'Duplicate native journeys are not coverage');
  return names;
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export function sourceIdentity(root, expectedSha) {
  assert.equal(
    realpathSync(git(root, 'rev-parse', '--show-toplevel')),
    realpathSync(root),
    'The product root must be the Git checkout root'
  );
  const sourceSha = git(root, 'rev-parse', 'HEAD');
  assert.match(expectedSha, /^[a-f0-9]{40}$/u, 'An exact source SHA is required');
  assert.equal(sourceSha, expectedSha, 'The checkout changed from the requested source');
  const helperOutputs = new Set(
    ['dna-indexer', 'dna-coverage', 'dna-process-guardian'].map(
      (helper) =>
        `apps/desktop/resources/helpers/${helperExecutableName(helper, process.platform, process.arch)}`
    )
  );
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter(Boolean);
  assert.deepEqual(
    untracked.filter((file) => !helperOutputs.has(file)),
    [],
    'Untracked source is outside the requested commit'
  );
  const changed = git(root, 'diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
  assert.deepEqual(
    changed.filter(
      (file) => file !== 'apps/desktop/resources/helpers/coverage-build-provenance.json'
    ),
    [],
    'Tracked source changed after checkout'
  );
  return {
    sourceSha,
    sourceTree: git(root, 'rev-parse', 'HEAD^{tree}'),
    generatedOutputs: [...changed, ...untracked].sort().map((file) => ({
      file,
      sha256: createHash('sha256')
        .update(readFileSync(evidenceFile(root, file)))
        .digest('hex'),
    })),
  };
}

function evidenceFile(directory, name) {
  assert.equal(typeof name, 'string');
  const file = resolve(directory, name);
  const rel = relative(directory, file);
  assert.ok(
    rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`),
    'Receipt media escaped its evidence directory'
  );
  assert.ok(
    !lstatSync(file).isSymbolicLink() && lstatSync(file).isFile(),
    'Receipt media must be an original file'
  );
  const canonicalRelative = relative(realpathSync(directory), realpathSync(file));
  assert.ok(
    canonicalRelative &&
      !isAbsolute(canonicalRelative) &&
      canonicalRelative !== '..' &&
      !canonicalRelative.startsWith(`..${sep}`),
    'Receipt media escaped its evidence directory through a link'
  );
  return file;
}

export function validateJourneyReceipt(directory, phase, sourceSha) {
  const file = evidenceFile(directory, 'receipt.json');
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(
    receipt.sourceCommit ?? receipt.commit,
    sourceSha,
    'Native receipt belongs to another source'
  );
  assert.ok(
    receipt.status === 'passed' || receipt.verdict === 'passed' || receipt.passed === true,
    'Native receipt did not pass'
  );
  assert.ok(!receipt.error && !receipt.failure, 'Native receipt retains a failure');
  for (const key of ['pageErrors', 'failedResponses', 'errors']) {
    if (receipt[key] !== undefined) assert.deepEqual(receipt[key], [], `Native receipt has ${key}`);
  }
  if (phase.steps) {
    assert.equal(receipt.steps?.length, phase.steps, 'Native journey did not complete every step');
    for (const step of receipt.steps) {
      const image = readFileSync(evidenceFile(directory, step.screenshot ?? step.file));
      assert.ok(
        image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        'Native step has no PNG capture'
      );
    }
  }
  if (phase.observations) {
    assert.equal(
      receipt.observations?.length,
      phase.observations,
      'Native journey did not complete every observation'
    );
    for (const observation of receipt.observations.filter((entry) => entry.name !== 'runtime')) {
      const image = readFileSync(evidenceFile(directory, `${observation.name}.png`));
      assert.ok(
        image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        'Native observation has no PNG capture'
      );
    }
  }
  if (phase.video) {
    assert.ok(receipt.frames?.length > 1, 'Native interaction has no original frame sequence');
    for (const frame of receipt.frames) {
      const image = readFileSync(evidenceFile(directory, frame.file));
      assert.equal(image.readUInt16BE(0), 0xffd8, 'Native frame is not JPEG');
    }
    const video = readFileSync(evidenceFile(directory, phase.video));
    assert.equal(video.toString('ascii', 4, 8), 'ftyp', 'Native interaction has no MP4 capture');
  }
  return {
    path: file,
    steps: receipt.steps?.length ?? receipt.observations.length,
    originalFrames: receipt.frames?.length ?? 0,
  };
}

export function createAutomationContext(root, temporaryRoot = tmpdir()) {
  const owned = realpathSync(mkdtempSync(join(temporaryRoot, 'dnaforge-native-')));
  for (const name of ['profile', 'tmp']) mkdirSync(join(owned, name), { mode: 0o700 });
  const context = {
    schemaVersion: 1,
    purpose: 'agent-automation',
    id: randomUUID(),
    root: owned,
    workspace: realpathSync(root),
    profile: join(owned, 'profile'),
  };
  const file = join(owned, 'context.json');
  writeFileSync(file, JSON.stringify(context), { mode: 0o600, flag: 'wx' });
  return { ...context, file };
}

async function allocatePorts() {
  const servers = [];
  try {
    for (let index = 0; index < 4; index++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
      });
    }
    const [renderer, hmr, api, debug] = servers.map((server) => server.address().port);
    return { renderer, hmr, api, debug };
  } finally {
    await Promise.all(servers.map((server) => new Promise((closed) => server.close(closed))));
  }
}

export function journeyEnvironment(environment, ports, context, journey) {
  const result = { ...environment };
  for (const key of [
    'DESKTOP_DEV_PORT',
    'DESKTOP_HMR_PORT',
    'API_PORT',
    'VITE_API_URL',
    'DESKTOP_DEBUG_PORT',
    'DEV_PORT',
    'WEB_DEV_PORT',
    'WAYPOINT_WEB_BASE_URL',
    'VITE_CLIENT_LOG_PATH',
    'ALLOW_FOREIGN_DESKTOP_DEV_PORT',
  ])
    delete result[key];
  Object.assign(result, {
    DESKTOP_DEV_PORT: String(ports.renderer),
    DESKTOP_HMR_PORT: String(ports.hmr),
    API_PORT: String(ports.api),
    DESKTOP_DEBUG_PORT: String(ports.debug),
    VITE_API_URL: `http://127.0.0.1:${ports.api}`,
    DNAFORGE_AUTOMATION_CONTEXT: context.file,
    DNAFORGE_DATA_CONFINEMENT_REQUIRED: '1',
    DNAFORGE_ALLOW_SCENARIO_MUTATION: '1',
    DNAFORGE_BACKGROUND_WINDOW: '1',
  });
  if (journey === 'chat')
    Object.assign(result, {
      VITE_DNAFORGE_ENABLE_DEV_AI_ENV_KEYS: '1',
      WAYPOINT_DEV_ANTHROPIC_API_KEY: 'verification-fixture',
    });
  return result;
}

async function runCommand(root, env, args, logfile, timeoutMs = NATIVE_JOURNEY_COMMAND_TIMEOUT_MS) {
  const output = openSync(logfile, 'wx');
  try {
    await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env,
        stdio: ['ignore', output, output],
      });
      let timedOut = false;
      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (code === 0 && !timedOut) done();
        else
          reject(
            new Error(
              `Command ${timedOut ? 'timed out' : 'failed'} (${code ?? signal}): ${args[0]}; see ${logfile}`
            )
          );
      });
    });
  } finally {
    closeSync(output);
  }
}

async function waitForRuntime(root, ports, context, child, deadline) {
  const { chromium } = await import('playwright');
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'Owned launcher exited before readiness');
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${ports.debug}`, {
        timeout: 1000,
      });
      try {
        const page = browser
          .contexts()
          .flatMap((item) => item.pages())
          .find((item) => new URL(item.url()).port === String(ports.renderer));
        if (page) {
          const runtime = await page.evaluate(async () => ({
            startup: await window.electronAPI?.startup?.getState?.(),
            profile: window.electronAPI?.runtime?.getProfile?.(),
            provenance: await window.electronAPI?.runtime?.getProvenance?.(),
          }));
          if (runtime.startup?.pageLoaded && runtime.startup?.shellReady) {
            assert.equal(
              runtime.profile?.kind,
              'scenario-e2e',
              'The native app is not an isolated scenario profile'
            );
            assert.equal(
              realpathSync(runtime.provenance?.projectRoot),
              realpathSync(root),
              'The native app belongs to another checkout'
            );
            assert.equal(
              realpathSync(runtime.provenance?.userDataPath),
              context.profile,
              'The native app belongs to another profile'
            );
            assert.equal(runtime.provenance?.desktopDevPort, String(ports.renderer));
            const health = await fetch(`http://127.0.0.1:${ports.api}/health`, {
              signal: AbortSignal.timeout(2000),
            });
            if (health.status === 200) return runtime;
          }
        }
      } finally {
        await browser.close();
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`Native readiness timed out for owned renderer ${ports.renderer}`);
}

export async function runNativeJourneys({
  root = ROOT,
  out,
  journey,
  sourceSha,
  environment = process.env,
}) {
  assert.equal(
    process.platform,
    'darwin',
    'These public native journeys are qualified for macOS only'
  );
  assert.ok(isAbsolute(out), 'Evidence needs an absolute path');
  root = realpathSync(root);
  out = join(realpathSync(dirname(resolve(out))), basename(resolve(out)));
  assert.ok(
    isAbsolute(out) &&
      out !== root &&
      !out.startsWith(`${root}${sep}`) &&
      out !== ROOT &&
      !out.startsWith(`${ROOT}${sep}`),
    'Evidence must be outside the product and control checkouts'
  );
  const selected = selectNativeJourneys(journey);
  assert.equal(selected.length, 1, 'Run exactly one native journey per qualification job');
  const identity = sourceIdentity(root, sourceSha);
  mkdirSync(out, { recursive: false });
  const settings = join(root, 'apps/desktop/.env.local');
  const original = existsSync(settings)
    ? { bytes: readFileSync(settings), mode: lstatSync(settings).mode }
    : null;
  if (original)
    assert.ok(
      lstatSync(settings).isFile() && !lstatSync(settings).isSymbolicLink(),
      'Do not replace a shared or linked settings file'
    );
  const report = {
    version: 1,
    kind: 'native',
    journey: selected[0],
    ...identity,
    controlSha: git(ROOT, 'rev-parse', 'HEAD'),
    platform: process.platform,
    runId: environment.GITHUB_RUN_ID ?? null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    workflowSha: environment.GITHUB_WORKFLOW_SHA ?? null,
    startedAt: new Date().toISOString(),
    journeys: [],
    status: 'failed',
  };
  let settingsOwned = false;
  let cleanupComplete = true;
  try {
    if (original) {
      const observed = spawnSync(process.execPath, [GUARD, '--status'], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
      });
      assert.equal(observed.status, 0, 'Could not inspect the existing app');
      assert.match(
        observed.stdout,
        /^ELECTRON_DEV_NOT_RUNNING$/mu,
        'Refusing to attach to an existing app'
      );
    }
    for (const name of selected) {
      const definition = NATIVE_JOURNEYS[name];
      const directory = join(out, name);
      mkdirSync(directory);
      const context = createAutomationContext(root);
      const ports = await allocatePorts();
      const env = journeyEnvironment(environment, ports, context, name);
      env.DNAFORGE_VERIFY_ROOT = root;
      const content = `DESKTOP_DEV_PORT=${ports.renderer}\nDESKTOP_HMR_PORT=${ports.hmr}\nAPI_PORT=${ports.api}\nDESKTOP_DEBUG_PORT=${ports.debug}\nVITE_API_URL=http://127.0.0.1:${ports.api}\n`;
      writeFileSync(settings, content, { mode: 0o600 });
      settingsOwned = true;
      const result = { name, context, ports, phases: [], status: 'failed' };
      report.journeys.push(result);
      let child;
      let output;
      let generation = 0;
      let launchStartedAt;
      const stop = async () => {
        if (!child) return;
        try {
          await runCommand(
            root,
            env,
            [GUARD, '--stop'],
            join(directory, `stop-${generation}.log`),
            120_000
          );
          const status = spawnSync(process.execPath, [GUARD, '--status'], {
            cwd: root,
            env,
            encoding: 'utf8',
          });
          assert.equal(status.status, 0, 'Could not verify native cleanup');
          assert.match(
            status.stdout,
            /^ELECTRON_DEV_NOT_RUNNING$/mu,
            'Native cleanup left an app running'
          );
          result.cleanup = { status: 'stopped', output: status.stdout };
        } catch (error) {
          cleanupComplete = false;
          throw error;
        } finally {
          if (child.exitCode === null) child.kill('SIGTERM');
          closeSync(output);
          child = null;
        }
      };
      const start = async () => {
        generation += 1;
        launchStartedAt = Date.now();
        output = openSync(join(directory, `launch-${generation}.log`), 'wx');
        child = spawn(process.execPath, [GUARD], {
          cwd: root,
          env,
          stdio: ['ignore', output, output],
        });
        child.on('error', () => {});
        assert.ok(child.pid, 'The owned native launcher did not start');
        result.runtime = await waitForRuntime(root, ports, context, child, Date.now() + 600_000);
      };
      let journeyFailure;
      try {
        await start();
        for (const phase of definition.phases) {
          if (phase.restart) {
            await stop();
            await start();
          }
          const driverOut = join(directory, 'evidence');
          await runCommand(
            root,
            env,
            [
              join(ROOT, definition.script),
              '--out',
              driverOut,
              ...(phase.name ? ['--phase', phase.name] : []),
            ],
            join(directory, `drive-${phase.name ?? 'main'}.log`)
          );
          result.phases.push(
            validateJourneyReceipt(
              phase.name ? join(driverOut, phase.name) : driverOut,
              phase,
              sourceSha
            )
          );
        }
        result.status = 'passed';
      } catch (error) {
        journeyFailure = error;
        result.failure = error.stack ?? String(error);
        if (result.runtime?.provenance?.execPath) {
          try {
            const guard = createRequire(import.meta.url)(join(root, GUARD));
            const native = guard.currentNativeDiagnostics(
              launchStartedAt,
              resolve(dirname(result.runtime.provenance.execPath), '../..')
            );
            assert.ok(native, 'The current background launch has no owned native logs');
            const capture = join(directory, `native-${generation}`);
            mkdirSync(capture);
            copyFileSync(native.metadataPath, join(capture, 'launch.json'));
            copyFileSync(native.stdout, join(capture, 'stdout.log'));
            copyFileSync(native.stderr, join(capture, 'stderr.log'));
            result.nativeDiagnostics = { ...native, capture };
          } catch (captureError) {
            result.nativeDiagnosticsError = String(captureError);
          }
        }
        throw error;
      } finally {
        try {
          await stop();
        } catch (error) {
          result.cleanupFailure = error.stack ?? String(error);
          if (journeyFailure)
            throw new AggregateError([journeyFailure, error], 'Native journey and cleanup failed');
          throw error;
        }
      }
      report.generatedOutputs = sourceIdentity(root, sourceSha).generatedOutputs;
    }
    report.status = 'passed';
  } catch (error) {
    report.failure = error.stack ?? String(error);
    throw error;
  } finally {
    let settingsError;
    try {
      if (settingsOwned && cleanupComplete) {
        if (original) writeFileSync(settings, original.bytes, { mode: original.mode });
        else unlinkSync(settings);
      }
      report.settingsRestored = !settingsOwned || cleanupComplete;
    } catch (error) {
      settingsError = error;
      report.status = 'failed';
      report.settingsRestored = false;
      report.settingsFailure = error.stack ?? String(error);
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(out, 'native-journeys.json'), JSON.stringify(report, null, 2));
    if (settingsError) throw settingsError;
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: 'string' },
        out: { type: 'string' },
        journey: { type: 'string' },
        source: { type: 'string' },
      },
    });
    assert.ok(
      values.out && isAbsolute(values.out) && values.source && values.journey,
      'Usage: native-journeys.mjs --root PRODUCT_CHECKOUT --source SHA --journey NAME --out ABSOLUTE_DIRECTORY'
    );
    const result = await runNativeJourneys({
      root: realpathSync(values.root ?? ROOT),
      out: values.out,
      journey: values.journey,
      sourceSha: values.source,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
