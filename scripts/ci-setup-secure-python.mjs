#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  assertPythonVersion,
  assertUvVersion,
  minimumPythonVersion,
  policy,
} = require('./python-runtime-security.cjs');

function normalizedArchitecture(arch) {
  if (['x64', 'x86_64', 'AMD64', 'X64'].includes(arch)) return 'x86_64';
  if (['arm64', 'aarch64', 'ARM64'].includes(arch)) return 'aarch64';
  throw new Error(`Unsupported Python architecture: ${arch}`);
}

export function pythonDownloadTarget(requested, arch = process.arch, platform = process.platform) {
  const version = minimumPythonVersion(requested);
  const operatingSystem = { darwin: 'macos', linux: 'linux', win32: 'windows' }[platform];
  if (!operatingSystem) throw new Error(`Unsupported Python platform: ${platform}`);
  return `cpython-${version}-${operatingSystem}-${normalizedArchitecture(arch)}-${platform === 'linux' ? 'gnu' : 'none'}`;
}

function readPythonRuntime(pythonPath, env) {
  return JSON.parse(
    execFileSync(
      pythonPath,
      [
        '-I',
        '-c',
        'import json,platform,ssl,pyexpat,sys; print(json.dumps(dict(version=platform.python_version(),arch=platform.machine(),openssl=ssl.OPENSSL_VERSION,expat=pyexpat.EXPAT_VERSION,isolated=sys.prefix!=sys.base_prefix)))',
      ],
      { env, encoding: 'utf8' }
    )
  );
}

export function installSecurePython(requested, architecture = process.arch, env = process.env) {
  const target = pythonDownloadTarget(requested, architecture);
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) {
    throw new Error('RUNNER_TEMP must name an absolute task-owned runtime directory');
  }
  assertUvVersion(execFileSync('uv', ['--version'], { encoding: 'utf8', env }).trim());
  mkdirSync(env.RUNNER_TEMP, { recursive: true });
  const installDir = mkdtempSync(path.join(env.RUNNER_TEMP, 'dnaforge-python-'));
  const installEnv = { ...env, UV_PYTHON_INSTALL_DIR: installDir };
  execFileSync(
    'uv',
    [
      'python',
      'install',
      '--no-bin',
      '--python-downloads-json-url',
      policy.downloadsJsonUrl,
      target,
    ],
    {
      env: installEnv,
      stdio: ['ignore', process.stderr, process.stderr],
    }
  );
  const basePythonPath = realpathSync(
    execFileSync('uv', ['python', 'find', '--managed-python', target], {
      env: installEnv,
      encoding: 'utf8',
    }).trim()
  );
  const baseRuntime = readPythonRuntime(basePythonPath, installEnv);
  assertPythonVersion(baseRuntime.version, requested);
  if (normalizedArchitecture(baseRuntime.arch) !== normalizedArchitecture(architecture)) {
    throw new Error(
      `Python architecture ${baseRuntime.arch} does not match requested ${architecture}`
    );
  }
  const environmentDir = path.join(installDir, 'environment');
  execFileSync(basePythonPath, ['-m', 'venv', environmentDir], {
    env: installEnv,
    stdio: ['ignore', process.stderr, process.stderr],
  });
  const pythonPath = path.join(
    environmentDir,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  );
  const runtime = readPythonRuntime(pythonPath, installEnv);
  assertPythonVersion(runtime.version, requested);
  if (normalizedArchitecture(runtime.arch) !== normalizedArchitecture(architecture)) {
    throw new Error(`Python architecture ${runtime.arch} does not match requested ${architecture}`);
  }
  if (!runtime.isolated)
    throw new Error('The job Python environment must be isolated from its base');
  for (const [file, content] of [
    [env.GITHUB_ENV, `UV_PYTHON_INSTALL_DIR=${installDir}\nVIRTUAL_ENV=${environmentDir}\n`],
    [env.GITHUB_PATH, `${path.dirname(pythonPath)}\n`],
    [env.GITHUB_OUTPUT, `python-path=${pythonPath}\npython-version=${runtime.version}\n`],
  ]) {
    if (file) appendFileSync(file, content);
  }
  return { pythonPath, basePythonPath, environmentDir, installDir, target, ...runtime };
}

function isEntrypoint() {
  try {
    return (
      Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; ) {
      if (args[index] === '--target-only') {
        options.targetOnly = true;
        index += 1;
        continue;
      }
      if (!['--version', '--arch'].includes(args[index]) || !args[index + 1]) {
        throw new Error(
          'Usage: ci-setup-secure-python.mjs --version <series-or-patch> [--arch <architecture>]'
        );
      }
      options[args[index]] = args[index + 1];
      index += 2;
    }
    if (options.targetOnly) {
      process.stdout.write(`${pythonDownloadTarget(options['--version'], options['--arch'])}\n`);
    } else {
      const runtime = installSecurePython(options['--version'], options['--arch']);
      process.stdout.write(`${JSON.stringify(runtime)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
