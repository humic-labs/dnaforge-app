import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = dirname(scriptDirectory);
const repositoryDirectory = dirname(dirname(desktopDirectory));
const electronPackage = require('electron/package.json');
const electronBinary = require('electron');
const harnessPath = join(scriptDirectory, 'qualification-safe-storage-electron.harness.cjs');
const productionSource = join(desktopDirectory, 'src', 'main', 'qualification-safe-storage.ts');

const CHILD_TIMEOUT_MS = 15_000;
const PROVIDER_ENVIRONMENT_PREFIXES = [
  'ANTHROPIC_',
  'AZURE_',
  'OPENAI_',
  'HOSTED_AI_',
  'DNAFORGE_HOSTED_',
];

function childEnvironment(input) {
  const environment = { ...process.env, ...input };
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(environment)) {
    if (PROVIDER_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      delete environment[name];
    }
  }
  return environment;
}

function runElectronProof(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [harnessPath], {
      cwd: repositoryDirectory,
      env: childEnvironment(environment),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(new Error(`Electron Safe Storage proof timed out after ${CHILD_TIMEOUT_MS}ms`))
      );
    }, CHILD_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code, signal) => {
      finish(() => {
        if (code !== 0 || signal) {
          reject(
            new Error(
              `Electron Safe Storage proof failed (code=${code}, signal=${signal ?? 'none'})\n` +
                `stdout:\n${stdout}\nstderr:\n${stderr}`
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

test('real installed Electron replaces all Safe Storage methods before ready without access', async () => {
  assert.equal(process.platform, 'darwin', 'real Safe Storage proof is macOS-only');
  assert.match(process.versions.node, /^22\./u, 'parent proof runner must use Node 22');

  const directory = await mkdtemp(join(tmpdir(), 'dnaforge-safe-storage-electron-proof-'));
  const bundlePath = join(directory, 'qualification-safe-storage.bundle.cjs');
  const resultPath = join(directory, 'result.json');
  const userDataPath = join(directory, 'user-data');
  await mkdir(userDataPath, { mode: 0o700 });

  try {
    await build({
      entryPoints: [productionSource],
      outfile: bundlePath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['electron'],
      legalComments: 'none',
      logLevel: 'silent',
    });

    const child = await runElectronProof({
      DNAFORGE_SAFE_STORAGE_PROOF_BUNDLE: bundlePath,
      DNAFORGE_SAFE_STORAGE_PROOF_RESULT: resultPath,
      DNAFORGE_SAFE_STORAGE_PROOF_USER_DATA: userDataPath,
    });
    assert.equal(child.stderr, '');

    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.deepEqual(result, {
      schema: 'dnaforge.qualification-safe-storage-electron-proof.v1',
      platform: 'darwin',
      processType: 'browser',
      electronVersion: electronPackage.version,
      embeddedNodeVersion: result.embeddedNodeVersion,
      appWasReadyBeforeGuard: false,
      replacements: {
        isEncryptionAvailable: true,
        encryptString: true,
        decryptString: true,
        isAsyncEncryptionAvailable: true,
        encryptStringAsync: true,
        decryptStringAsync: true,
      },
      audit: { installed: true, attempts: 0, methods: [] },
    });
    assert.match(result.embeddedNodeVersion, /^24\./u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
