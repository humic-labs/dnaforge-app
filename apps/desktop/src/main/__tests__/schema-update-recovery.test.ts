import { describe, expect, it, vi } from 'vitest';

import { SchemaVersionTooNewError } from '../native-module-error';
import {
  runSchemaUpdateRecovery,
  shouldAutomaticallyRecoverNewerSchema,
} from '../schema-update-recovery';

const newerSchemaError = new SchemaVersionTooNewError({
  dbVersion: 33,
  supportedVersion: 27,
  appVersion: '0.8.3',
});

describe('newer-schema automatic update eligibility', () => {
  it('admits only the typed error from an interactive official release', () => {
    expect(
      shouldAutomaticallyRecoverNewerSchema({
        error: newerSchemaError,
        isPackaged: true,
        isReleaseBuild: true,
        isSharedProfile: true,
        isValidationApp: false,
        isManagedRuntime: false,
        e2eSharedProfile: false,
      })
    ).toBe(true);

    for (const rejected of [
      { error: new Error('database busy'), isPackaged: true, isReleaseBuild: true },
      { error: newerSchemaError, isPackaged: false, isReleaseBuild: true },
      { error: newerSchemaError, isPackaged: true, isReleaseBuild: false },
      {
        error: newerSchemaError,
        isPackaged: true,
        isReleaseBuild: true,
        isSharedProfile: false,
      },
      {
        error: newerSchemaError,
        isPackaged: true,
        isReleaseBuild: true,
        isValidationApp: true,
      },
      {
        error: newerSchemaError,
        isPackaged: true,
        isReleaseBuild: true,
        isManagedRuntime: true,
      },
    ]) {
      expect(
        shouldAutomaticallyRecoverNewerSchema({
          isManagedRuntime: false,
          isSharedProfile: true,
          isValidationApp: false,
          e2eSharedProfile: false,
          ...rejected,
        })
      ).toBe(false);
    }
  });

  it('admits only the explicit un-packaged E2E shared-profile seam', () => {
    expect(
      shouldAutomaticallyRecoverNewerSchema({
        error: newerSchemaError,
        isPackaged: false,
        isReleaseBuild: false,
        isSharedProfile: false,
        isValidationApp: false,
        isManagedRuntime: false,
        e2eSharedProfile: true,
      })
    ).toBe(true);
    expect(
      shouldAutomaticallyRecoverNewerSchema({
        error: newerSchemaError,
        isPackaged: false,
        isReleaseBuild: false,
        isSharedProfile: false,
        isValidationApp: false,
        isManagedRuntime: true,
        e2eSharedProfile: true,
      })
    ).toBe(false);
  });
});

describe('newer-schema automatic update orchestration', () => {
  it('closes SQLite and flushes fatal diagnostics before download and native install', async () => {
    const order: string[] = [];
    const result = await runSchemaUpdateRecovery({
      runningVersion: '0.8.3',
      closeDatabase: () => order.push('database-closed'),
      flushFatalDiagnostics: async () => {
        order.push('diagnostics-flushed');
      },
      checkAndDownload: async () => {
        order.push('update-downloaded');
        return { kind: 'downloaded' as const, targetVersion: '0.8.10' };
      },
      beginInstall: (targetVersion) => {
        order.push(`install-started:${targetVersion}`);
      },
      reportDiagnosticFailure: vi.fn(),
    });

    expect(result).toEqual({ kind: 'install-started', targetVersion: '0.8.10' });
    expect(order).toEqual([
      'database-closed',
      'diagnostics-flushed',
      'update-downloaded',
      'install-started:0.8.10',
    ]);
  });

  it('continues recovery when fatal analytics cannot flush', async () => {
    const reportDiagnosticFailure = vi.fn();
    const beginInstall = vi.fn();

    await expect(
      runSchemaUpdateRecovery({
        runningVersion: '0.8.3',
        closeDatabase: vi.fn(),
        flushFatalDiagnostics: async () => {
          throw new Error('PostHog unavailable');
        },
        checkAndDownload: async () => ({
          kind: 'downloaded' as const,
          targetVersion: '0.8.10',
        }),
        beginInstall,
        reportDiagnosticFailure,
      })
    ).resolves.toEqual({ kind: 'install-started', targetVersion: '0.8.10' });
    expect(reportDiagnosticFailure).toHaveBeenCalledOnce();
    expect(beginInstall).toHaveBeenCalledWith('0.8.10');
  });

  it('requests the canonical installer without invoking native install when no update exists', async () => {
    const beginInstall = vi.fn();
    const result = await runSchemaUpdateRecovery({
      runningVersion: '0.8.3',
      closeDatabase: vi.fn(),
      flushFatalDiagnostics: vi.fn(async () => undefined),
      checkAndDownload: vi.fn(async () => ({ kind: 'no-update' as const })),
      beginInstall,
      reportDiagnosticFailure: vi.fn(),
    });

    expect(result).toEqual({ kind: 'fallback-required', reason: 'no-update' });
    expect(beginInstall).not.toHaveBeenCalled();
  });

  it.each(['0.8.3', '0.8.2', 'not-a-version'])(
    'rejects a non-newer downloaded target %s before native installation',
    async (targetVersion) => {
      const beginInstall = vi.fn();
      const result = await runSchemaUpdateRecovery({
        runningVersion: '0.8.3',
        closeDatabase: vi.fn(),
        flushFatalDiagnostics: vi.fn(async () => undefined),
        checkAndDownload: vi.fn(async () => ({ kind: 'downloaded' as const, targetVersion })),
        beginInstall,
        reportDiagnosticFailure: vi.fn(),
      });

      expect(result).toMatchObject({ kind: 'fallback-required', reason: 'failed' });
      expect(beginInstall).not.toHaveBeenCalled();
    }
  );

  it.each(['close', 'check', 'install'] as const)(
    'requests the canonical installer after a %s failure and never throws a second startup error',
    async (failurePoint) => {
      const beginInstall = vi.fn((_: string) => {
        if (failurePoint === 'install') throw new Error('native installer refused');
      });
      const result = await runSchemaUpdateRecovery({
        runningVersion: '0.8.3',
        closeDatabase: () => {
          if (failurePoint === 'close') throw new Error('close failed');
        },
        flushFatalDiagnostics: vi.fn(async () => undefined),
        checkAndDownload: async () => {
          if (failurePoint === 'check') throw new Error('feed unavailable');
          return { kind: 'downloaded' as const, targetVersion: '0.8.10' };
        },
        beginInstall,
        reportDiagnosticFailure: vi.fn(),
      });

      expect(result).toMatchObject({ kind: 'fallback-required', reason: 'failed' });
    }
  );
});
