#!/usr/bin/env node

const { execFileSync, spawn } = require('node:child_process');
const {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const { backgroundWindowRequested, isTestLaunch } = require('./background-window-policy.cjs');

const WRAPPER_PATH = path.resolve(__filename);

function backgroundDevRequested(env = process.env, platform = process.platform) {
  return (
    platform === 'darwin' && !isTestLaunch(env, []) && backgroundWindowRequested(env, platform)
  );
}

function configureBackgroundElectronLaunch(
  env,
  platform = process.platform,
  electronBinary,
  appDirectory = process.cwd()
) {
  if (!backgroundDevRequested(env, platform)) return env;
  const appBundle = path.resolve(path.dirname(electronBinary ?? require('electron')), '../..');
  if (!appBundle.endsWith('/Electron.app') || !existsSync(appBundle)) {
    throw new Error('Background Electron launch requires a real Electron.app bundle.');
  }
  return {
    ...env,
    ELECTRON_EXEC_PATH: WRAPPER_PATH,
    DNAFORGE_BACKGROUND_ELECTRON_APP_PATH: appBundle,
    DNAFORGE_BACKGROUND_WORKTREE_CWD: path.resolve(appDirectory),
    DNAFORGE_BACKGROUND_LAUNCH_SAFE: '1',
  };
}

function assertBackgroundElectronLaunchProtected(
  env,
  platform = process.platform,
  wrapperPath = WRAPPER_PATH
) {
  if (!backgroundDevRequested(env, platform)) return;
  if (env.ELECTRON_EXEC_PATH !== wrapperPath || env.DNAFORGE_BACKGROUND_LAUNCH_SAFE !== '1') {
    throw new Error(
      'Refusing an agent/background Electron dev launch without the macOS open -g wrapper. Use pnpm --dir apps/desktop dev.'
    );
  }
}

function openArguments(appBundle, entry, electronArgs, cwd = process.cwd()) {
  if (!path.isAbsolute(appBundle) || !appBundle.endsWith('/Electron.app')) {
    throw new Error('Background Electron launch needs an absolute Electron.app path.');
  }
  if (!entry) throw new Error('Background Electron launch needs an app entry.');
  return [
    '-g',
    '-n',
    '-F',
    '-W',
    '-a',
    appBundle,
    '--env',
    'DNAFORGE_BACKGROUND_WINDOW=1',
    '--env',
    'DNAFORGE_BACKGROUND_LAUNCH_SAFE=1',
    '--env',
    `DNAFORGE_BACKGROUND_WORKTREE_CWD=${path.resolve(cwd)}`,
    '--args',
    path.resolve(cwd, entry),
    ...electronArgs,
  ];
}

function ownedElectronPids(appBundle, absoluteEntry, execute = execFileSync) {
  const executable = path.join(appBundle, 'Contents/MacOS/Electron');
  const output = execute('/bin/ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const prefix = `${executable} ${absoluteEntry}`;
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((match) => match && (match[2] === prefix || match[2].startsWith(`${prefix} `)))
    .map((match) => Number(match[1]));
}

async function waitForPreviousElectron(
  appBundle,
  absoluteEntry,
  listPids = ownedElectronPids,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (listPids(appBundle, absoluteEntry).length === 0) return;
    await pause(50);
  }
  throw new Error('Previous worktree Electron process did not exit; refusing a duplicate launch.');
}

function retainLaunchDiagnostics(applicationRoot) {
  const cache = path.join(process.cwd(), '.cache/dnaforge-dev-runtime');
  const launches = path.join(cache, 'launches');
  mkdirSync(launches, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(launches, 'attempt-'));
  const metadata = {
    applicationRoot,
    launcherPid: process.pid,
    startedAt: new Date().toISOString(),
    stdout: path.join(directory, 'stdout.log'),
    stderr: path.join(directory, 'stderr.log'),
  };
  for (const file of [metadata.stdout, metadata.stderr]) closeSync(openSync(file, 'wx', 0o600));
  const contents = JSON.stringify(metadata, null, 2) + '\n';
  writeFileSync(path.join(directory, 'launch.json'), contents, { mode: 0o600, flag: 'wx' });
  const temporary = path.join(directory, 'last-launch.tmp');
  writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  const latest = path.join(cache, 'last-launch.json');
  renameSync(temporary, latest);
  console.log(`ELECTRON_DEV_NATIVE_DIAGNOSTICS ${latest}`);
  return metadata;
}

async function main() {
  const appBundle = process.env.DNAFORGE_BACKGROUND_ELECTRON_APP_PATH;
  if (process.platform !== 'darwin' || !appBundle || !existsSync(appBundle)) {
    throw new Error('Background Electron wrapper may run only with a valid macOS Electron.app.');
  }
  assertBackgroundElectronLaunchProtected(process.env);
  const [entry, ...electronArgs] = process.argv.slice(2);
  const args = openArguments(appBundle, entry, electronArgs);
  const absoluteEntry = args[args.indexOf('--args') + 1];
  await waitForPreviousElectron(appBundle, absoluteEntry);
  const before = new Set(ownedElectronPids(appBundle, absoluteEntry));
  const diagnostics = retainLaunchDiagnostics(appBundle);
  args.splice(
    args.indexOf('--args'),
    0,
    '--stdout',
    diagnostics.stdout,
    '--stderr',
    diagnostics.stderr
  );
  const opened = spawn('/usr/bin/open', args, { stdio: 'inherit' });
  let stopping = false;
  let exitCode = 0;
  let ownedPid = null;
  const findNewProcess = () => {
    if (ownedPid !== null) return ownedPid;
    ownedPid = ownedElectronPids(appBundle, absoluteEntry).find((pid) => !before.has(pid)) ?? null;
    return ownedPid;
  };
  const stillOwned = (pid) => ownedElectronPids(appBundle, absoluteEntry).includes(pid);
  const monitor = setInterval(() => {
    const pid = findNewProcess();
    if (stopping && pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    } else if (pid !== null) {
      clearInterval(monitor);
    }
  }, 100);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const pid = findNewProcess();
    if (pid !== null && stillOwned(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    setTimeout(() => {
      const latePid = findNewProcess();
      if (latePid !== null && stillOwned(latePid)) {
        try {
          process.kill(latePid, 'SIGKILL');
        } catch {}
      }
      opened.kill('SIGTERM');
      clearInterval(monitor);
      process.exit(exitCode);
    }, 2000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  opened.on('error', (error) => {
    clearInterval(monitor);
    console.error('[background-electron-launch]', error.stack ?? String(error));
    process.exit(1);
  });
  opened.on('exit', (code) => {
    clearInterval(monitor);
    exitCode = code ?? 1;
    if (!stopping) process.exit(exitCode);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[background-electron-launch]', error.stack ?? String(error));
    process.exit(1);
  });
}

module.exports = {
  assertBackgroundElectronLaunchProtected,
  backgroundDevRequested,
  configureBackgroundElectronLaunch,
  openArguments,
  ownedElectronPids,
  waitForPreviousElectron,
};
