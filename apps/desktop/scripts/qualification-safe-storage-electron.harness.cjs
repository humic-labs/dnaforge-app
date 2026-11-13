const { existsSync, writeFileSync } = require('node:fs');

const electron = require('electron');

const REQUIRED_METHODS = [
  'isEncryptionAvailable',
  'encryptString',
  'decryptString',
  'isAsyncEncryptionAvailable',
  'encryptStringAsync',
  'decryptStringAsync',
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function writeResult(path, result) {
  writeFileSync(path, `${JSON.stringify(result)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function fail(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`QUALIFICATION_SAFE_STORAGE_ELECTRON_PROOF_FAILED: ${message}\n`);
  electron.app.exit(1);
}

try {
  if (process.platform !== 'darwin') {
    throw new Error(`real Safe Storage proof requires macOS, got ${process.platform}`);
  }
  if (process.type !== 'browser' || !process.versions.electron) {
    throw new Error('proof must run in the real Electron main process');
  }

  const bundlePath = requiredEnvironment('DNAFORGE_SAFE_STORAGE_PROOF_BUNDLE');
  const resultPath = requiredEnvironment('DNAFORGE_SAFE_STORAGE_PROOF_RESULT');
  const userDataPath = requiredEnvironment('DNAFORGE_SAFE_STORAGE_PROOF_USER_DATA');
  if (!existsSync(bundlePath)) throw new Error('qualification Safe Storage bundle does not exist');
  if (!existsSync(userDataPath)) throw new Error('isolated user-data directory does not exist');

  electron.app.setPath('userData', userDataPath);
  const appWasReadyBeforeGuard = electron.app.isReady();
  const originalMethods = Object.fromEntries(
    REQUIRED_METHODS.map((method) => [method, electron.safeStorage[method]])
  );
  for (const method of REQUIRED_METHODS) {
    if (typeof originalMethods[method] !== 'function') {
      throw new Error(`Electron safeStorage.${method} is not a function`);
    }
  }

  const { installQualificationSafeStorageGuard } = require(bundlePath);
  if (typeof installQualificationSafeStorageGuard !== 'function') {
    throw new Error('bundled production module does not export the guard installer');
  }
  const audit = installQualificationSafeStorageGuard(true);
  const replacements = Object.fromEntries(
    REQUIRED_METHODS.map((method) => [
      method,
      typeof electron.safeStorage[method] === 'function' &&
        electron.safeStorage[method] !== originalMethods[method],
    ])
  );
  if (Object.values(replacements).some((replaced) => replaced !== true)) {
    throw new Error('one or more real Electron Safe Storage methods were not replaced');
  }
  if (
    !audit ||
    audit.installed !== true ||
    audit.attempts !== 0 ||
    !Array.isArray(audit.methods) ||
    audit.methods.length !== 0
  ) {
    throw new Error('guard installation touched Safe Storage before the audit completed');
  }

  writeResult(resultPath, {
    schema: 'dnaforge.qualification-safe-storage-electron-proof.v1',
    platform: process.platform,
    processType: process.type,
    electronVersion: process.versions.electron,
    embeddedNodeVersion: process.versions.node,
    appWasReadyBeforeGuard,
    replacements,
    audit,
  });
  electron.app.exit(0);
} catch (error) {
  fail(error);
}
