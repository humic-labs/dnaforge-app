import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mainIndex = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
const bootstrap = readFileSync(resolve(__dirname, '../bootstrap.ts'), 'utf8');
const preReady = readFileSync(resolve(__dirname, '../electron-pre-ready.ts'), 'utf8');

describe('single-instance lock in main bootstrap', () => {
  it('configures a noninteractive Linux password store before app readiness in tests', () => {
    const passwordStoreIdx = preReady.indexOf(
      "app.commandLine.appendSwitch('password-store', 'basic')"
    );
    expect(passwordStoreIdx).toBeGreaterThan(-1);
    expect(bootstrap.indexOf('configureElectronBeforeReady();')).toBeLessThan(
      bootstrap.indexOf("await import('./index')")
    );
  });

  it('requests the lock', () => {
    expect(mainIndex).toContain('requestSingleInstanceLock');
  });

  it('aborts module evaluation when the lock cannot be acquired', () => {
    expect(mainIndex).toMatch(/if \(!app\.requestSingleInstanceLock\(\)\)/);
    expect(mainIndex).toContain('throw new ProfileAlreadyOwnedError(managedRuntimeLaunch ? 1 : 0)');
    expect(bootstrap).toMatch(
      /error instanceof ProfileAlreadyOwnedError[\s\S]*app\.exit\(error\.exitCode\)/
    );
  });

  it('only shows the lock-rejected dialog for packaged launches', () => {
    const lockRejectIdx = mainIndex.indexOf('if (!app.requestSingleInstanceLock())');
    const exitIdx = mainIndex.indexOf('throw new ProfileAlreadyOwnedError', lockRejectIdx);
    expect(lockRejectIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(lockRejectIdx);

    const lockRejectBlock = mainIndex.slice(lockRejectIdx, exitIdx);
    expect(lockRejectBlock).toContain('app.isPackaged');
    expect(lockRejectBlock).toMatch(
      /(?:\bdialog|createUserDialogs\(dialog\))\.(showErrorBox|showMessageBoxSync)\(/
    );
  });

  it('registers a second-instance handler that focuses the existing window', () => {
    expect(mainIndex).toMatch(/app\.on\(['"]second-instance['"]/);
    expect(mainIndex).toMatch(/\.focus\(\)/);
  });

  it('acquires the lock AFTER setting the worktree-scoped userData path', () => {
    const prepareProfileIdx = mainIndex.indexOf('prepareStartupProfile({');
    const setPathIdx = mainIndex.indexOf("app.setPath('userData'");
    const lockIdx = mainIndex.indexOf('requestSingleInstanceLock');
    expect(prepareProfileIdx).toBeGreaterThan(-1);
    expect(setPathIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(-1);
    expect(setPathIdx).toBeGreaterThan(prepareProfileIdx);
    expect(lockIdx).toBeGreaterThan(setPathIdx);
  });

  it('routes production startup through the release-aware schema gate', () => {
    expect(mainIndex).toContain('ensureSchemaForBuild(database, getDbPath(), {');
    expect(mainIndex).not.toContain('ensureSchema(getDb(), getDbPath())');
  });

  it('reconciles an interrupted restore after acquiring the lock and before opening SQLite', () => {
    const lockIdx = mainIndex.indexOf('requestSingleInstanceLock');
    const reconcileIdx = mainIndex.indexOf('reconcileInterruptedDatabaseRestore(getDbPath())');
    const getDbIdx = mainIndex.indexOf('database = getDb(');
    expect(reconcileIdx).toBeGreaterThan(lockIdx);
    expect(getDbIdx).toBeGreaterThan(reconcileIdx);
  });

  it('handles a newer schema before sidecar startup or a write-capable database open', () => {
    const reconcileIdx = mainIndex.indexOf('reconcileInterruptedDatabaseRestore(getDbPath())');
    const schemaReadIdx = mainIndex.indexOf('readDatabaseSchemaVersion(getDbPath())');
    const recoveryIdx = mainIndex.indexOf(
      'await recoverNewerSchemaWithoutUserChoice(newerSchemaError)'
    );
    const sidecarPreflightIdx = mainIndex.indexOf('preflightSidecarRuntime()');
    const getDbIdx = mainIndex.indexOf('database = getDb(');

    expect(schemaReadIdx).toBeGreaterThan(reconcileIdx);
    expect(recoveryIdx).toBeGreaterThan(schemaReadIdx);
    const earlyRefusal = mainIndex.slice(recoveryIdx, sidecarPreflightIdx);
    expect(earlyRefusal).toMatch(/await refuseStartupSchema\(newerSchemaError\);\s+return;/);
    expect(sidecarPreflightIdx).toBeGreaterThan(recoveryIdx);
    expect(getDbIdx).toBeGreaterThan(recoveryIdx);
  });
});
