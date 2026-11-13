import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const electronBin = join(
  here,
  '../../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
);
const electronApp = join(here, '../../../node_modules/electron/dist/Electron.app');

const root = await mkdtemp(join(tmpdir(), 'dnaforge-quit-proof-'));
const bundle = join(root, 'main.js');
await esbuild.build({
  entryPoints: [join(here, 'quit-prompt-electron-proof.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['electron'],
  target: 'node20',
});

const packagedApp = join(root, 'DNAForgeQuitProof.app');
const copied = spawnSync('cp', ['-cR', electronApp, packagedApp], { stdio: 'inherit' });
if (copied.status !== 0) {
  throw new Error('Could not clone Electron.app for the packaged proof');
}
const packagedDir = join(packagedApp, 'Contents/Resources/app');
await mkdir(packagedDir, { recursive: true });
await writeFile(
  join(packagedDir, 'package.json'),
  JSON.stringify({ name: 'dnaforge-quit-proof', version: '1.0.0', main: 'main.js' })
);
await cp(bundle, join(packagedDir, 'main.js'));

const packagedExecutable = join(packagedApp, 'Contents/MacOS/DNAForgeQuitProof');
const renamed = spawnSync(
  'cp',
  ['-c', join(packagedApp, 'Contents/MacOS/Electron'), packagedExecutable],
  {
    stdio: 'inherit',
  }
);
if (renamed.status !== 0) {
  throw new Error('Could not rename the packaged Electron executable');
}
const plist = join(packagedApp, 'Contents/Info.plist');
for (const command of [
  'Set :CFBundleExecutable DNAForgeQuitProof',
  'Set :CFBundleName DNAForgeQuitProof',
  'Set :CFBundleDisplayName DNAForge Quit Proof',
]) {
  const edited = spawnSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { stdio: 'inherit' });
  if (edited.status !== 0) {
    throw new Error(`Could not set ${command}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResult(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function osascript(script) {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('');
    }, 3000);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });
}

function windowNames(pid) {
  return osascript(
    `tell application "System Events" to get name of every window of (first process whose unix id is ${pid})`
  );
}

function dismissDialog(pid) {
  return osascript(
    `tell application "System Events" to click button "Cancel" of window 1 of (first process whose unix id is ${pid})`
  );
}

function expectsLivePrompt(name) {
  return name.includes('fixed') || name.includes('packaged-test');
}

function isLegacy(name) {
  return name.includes('legacy');
}

function assertScenario(name, result, nativeWindows) {
  const problems = [];
  if (!result) problems.push('no result file');
  else if (expectsLivePrompt(name)) {
    if (result.phase !== 'finished') problems.push(`phase was ${result.phase}`);
    if (!result.dialogShown) problems.push('dialog did not open');
    if (!result.listenerReturned) problems.push('dialog opened before the quit listener returned');
    if (result.visible !== true) problems.push('window was not visible when the dialog opened');
    if (result.destroyed !== false)
      problems.push('window was already destroyed when the dialog opened');
    if (result.afterDestroyed !== false) problems.push('cancel destroyed the window');
    if (result.decision !== 'cancel') problems.push(`decision was ${result.decision}`);
    const nativeCount = nativeWindows.split(',').length;
    if (!nativeWindows.includes('DNAForge Quit Proof') || nativeCount < 2) {
      problems.push(`native windows while the dialog was up: ${nativeWindows || '(none)'}`);
    }
  }
  if (name === 'dev-fixed-quit' || name === 'dev-fixed-close' || name === 'dev-suppressed') {
    if (result?.packaged !== false) problems.push('dev run reported packaged');
  }
  if (name.startsWith('packaged')) {
    if (result?.packaged !== true) problems.push('packaged run reported unpackaged');
  }
  if (name === 'dev-suppressed') {
    if (result?.dialogShown) problems.push('unpackaged test mode still showed the dialog');
    if (result?.decision !== 'suppressed') problems.push(`decision was ${result?.decision}`);
  }
  if (name === 'packaged-test-quit') {
    if (result?.suppressed !== false) problems.push('packaged test mode suppressed the dialog');
  }
  if (isLegacy(name)) {
    const reproduced =
      result &&
      (result.listenerReturned === false || result.visible === false || result.destroyed === true);
    if (!reproduced) problems.push('legacy path did not reproduce the late dialog');
  }
  return {
    name,
    ok: problems.length === 0,
    problems,
    nativeWindows,
    result,
  };
}

async function runScenario(name, { packaged, mode, waypointTest }) {
  const resultPath = join(root, `${name}.json`);
  const command = packaged ? packagedExecutable : electronBin;
  const args = packaged ? [] : [bundle];
  const userData = join(root, `${name}-user-data`);
  await mkdir(userData, { recursive: true });
  const child = spawn(command, args, {
    env: {
      ...process.env,
      QUIT_PROOF_MODE: mode,
      QUIT_PROOF_RESULT: resultPath,
      QUIT_PROOF_USER_DATA: userData,
      WAYPOINT_TEST: waypointTest ?? '',
    },
    stdio: 'ignore',
  });
  let nativeWindows = '';
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    const current = await readResult(resultPath);
    if (current?.dialogShown && current.phase !== 'finished') {
      const names = await windowNames(child.pid);
      const nativeCount = names ? names.split(',').length : 0;
      const proofVisible = names.includes('DNAForge Quit Proof') && nativeCount >= 2;
      const legacyDialog = isLegacy(name);
      if (proofVisible || legacyDialog) {
        if (!nativeWindows) nativeWindows = names;
        await dismissDialog(child.pid);
      }
    }
    if (current?.phase === 'finished') break;
    if (child.exitCode != null) break;
    await sleep(150);
  }
  if (child.exitCode == null) child.kill('SIGKILL');
  await Promise.race([new Promise((resolve) => child.once('close', resolve)), sleep(2000)]);
  const result = await readResult(resultPath);
  return assertScenario(name, result, nativeWindows);
}

const scenarios = [
  { name: 'dev-fixed-quit', packaged: false, mode: 'fixed-quit' },
  { name: 'dev-fixed-close', packaged: false, mode: 'fixed-close' },
  { name: 'dev-legacy-quit', packaged: false, mode: 'legacy-quit' },
  { name: 'dev-legacy-close', packaged: false, mode: 'legacy-close' },
  { name: 'dev-suppressed', packaged: false, mode: 'fixed-quit', waypointTest: '1' },
  { name: 'packaged-fixed-quit', packaged: true, mode: 'fixed-quit' },
  { name: 'packaged-fixed-close', packaged: true, mode: 'fixed-close' },
  { name: 'packaged-legacy-quit', packaged: true, mode: 'legacy-quit' },
  { name: 'packaged-test-quit', packaged: true, mode: 'fixed-quit', waypointTest: '1' },
];

const reports = [];
for (const scenario of scenarios) {
  reports.push(await runScenario(scenario.name, scenario));
  process.stdout.write(`${JSON.stringify(reports[reports.length - 1])}\n`);
}

await rm(root, { recursive: true, force: true });
const failed = reports.filter((report) => !report.ok);
process.exit(failed.length === 0 ? 0 : 1);
