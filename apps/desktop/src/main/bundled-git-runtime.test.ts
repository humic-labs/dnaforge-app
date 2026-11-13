import { describe, expect, it, vi } from 'vitest';
import {
  assertBundledGitRuntimeReady,
  type BundledGitExecution,
  type BundledGitRuntimeError,
} from './bundled-git-runtime';

function execution(overrides: Partial<BundledGitExecution> = {}): BundledGitExecution {
  return {
    status: 0,
    signal: null,
    stdout: 'git version 2.53.0\n',
    stderr: '',
    ...overrides,
  };
}

describe('bundled Git runtime startup readiness', () => {
  it('requires and executes the exact bundled binary before reporting ready', () => {
    const assertExecutable = vi.fn();
    const execute = vi.fn(() => execution());

    expect(
      assertBundledGitRuntimeReady({
        resolveBinary: () => '/DNAForge/dugite/git/bin/git',
        assertExecutable,
        execute,
      })
    ).toEqual({
      binaryPath: '/DNAForge/dugite/git/bin/git',
      version: 'git version 2.53.0',
    });
    expect(assertExecutable).toHaveBeenCalledWith('/DNAForge/dugite/git/bin/git');
    expect(execute).toHaveBeenCalledWith('/DNAForge/dugite/git/bin/git');
  });

  it('fails closed when the bundled binary is missing', () => {
    expect(() =>
      assertBundledGitRuntimeReady({
        resolveBinary: () => '/missing/git',
        assertExecutable: () => {
          throw new Error('ENOENT');
        },
        execute: () => execution(),
      })
    ).toThrowError(
      expect.objectContaining<Partial<BundledGitRuntimeError>>({ code: 'BUNDLED_GIT_MISSING' })
    );
  });

  it('fails closed on execution failure or a non-Git response', () => {
    expect(() =>
      assertBundledGitRuntimeReady({
        resolveBinary: () => '/broken/git',
        assertExecutable: () => undefined,
        execute: () => execution({ status: 126, stderr: 'bad CPU type' }),
      })
    ).toThrowError(
      expect.objectContaining<Partial<BundledGitRuntimeError>>({ code: 'BUNDLED_GIT_EXECUTION' })
    );

    expect(() =>
      assertBundledGitRuntimeReady({
        resolveBinary: () => '/not-git',
        assertExecutable: () => undefined,
        execute: () => execution({ stdout: 'not git\n' }),
      })
    ).toThrowError(
      expect.objectContaining<Partial<BundledGitRuntimeError>>({ code: 'BUNDLED_GIT_VERSION' })
    );
  });
});
