import { describe, expect, it } from 'vitest';

import {
  BUILD_SOURCE_GIT_EXECUTABLE,
  computeRuntimeSourceFingerprint,
  RUNTIME_SOURCE_FINGERPRINT_FILE_PATHS,
  RUNTIME_SOURCE_FINGERPRINT_GIT_PATHS,
  type BuildSourceFingerprintDeps,
} from './build-source-fingerprint';

function makeDeps(overrides: {
  head?: string;
  trackedTree?: string;
  worktreeDiff?: string;
  stagedDiff?: string;
  untrackedPaths?: string[];
  files?: Record<string, string>;
}): BuildSourceFingerprintDeps {
  const files = new Map(Object.entries(overrides.files ?? {}));
  return {
    gitOutput(_repoRoot, args) {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return overrides.head ?? 'head-a';
      if (args[0] === 'ls-files' && args.includes('--stage')) {
        return overrides.trackedTree ?? '100644 blob-a 0\tapps/desktop/src/main.tsx\n';
      }
      if (args[0] === 'diff' && args.includes('--cached')) return overrides.stagedDiff ?? '';
      if (args[0] === 'diff') return overrides.worktreeDiff ?? '';
      if (args[0] === 'ls-files') return (overrides.untrackedPaths ?? []).join('\n');
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    },
    readText(_repoRoot, relativePath) {
      return files.get(relativePath) ?? null;
    },
  };
}

function fingerprint(
  overrides: {
    mode?: string;
    head?: string;
    trackedTree?: string;
    worktreeDiff?: string;
    stagedDiff?: string;
    untrackedPaths?: string[];
    files?: Record<string, string>;
  } = {}
): string {
  return computeRuntimeSourceFingerprint({
    repoRoot: '/repo',
    mode: overrides.mode ?? 'development',
    deps: makeDeps(overrides),
  });
}

describe('runtime build source fingerprint', () => {
  it('uses the root-owned Git executable on POSIX and the native executable name on Windows', () => {
    expect(BUILD_SOURCE_GIT_EXECUTABLE).toBe(
      process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'
    );
  });

  it('covers every source-backed workspace package imported by the desktop runtime', () => {
    expect(RUNTIME_SOURCE_FINGERPRINT_GIT_PATHS).toEqual(
      expect.arrayContaining([
        'apps/api/src',
        'apps/api/run_server.py',
        'apps/desktop/native',
        'packages/core/genome-data/src',
        'packages/core/genome-renderer/src',
        'packages/core/sequence-utils/src',
        'packages/core/workspace-editor/src',
        'packages/features/plasmid-viewer/src',
        'packages/ui/components/src',
      ])
    );
    expect(RUNTIME_SOURCE_FINGERPRINT_FILE_PATHS).toEqual(
      expect.arrayContaining([
        'apps/api/pyproject.toml',
        'apps/api/uv.lock',
        'apps/desktop/scripts/build-sequence-wheel.cjs',
        'packages/core/genome-data/package.json',
        'packages/core/genome-renderer/package.json',
        'packages/core/sequence-utils/package.json',
        'packages/core/workspace-editor/package.json',
        'packages/features/plasmid-viewer/package.json',
        'packages/ui/components/package.json',
      ])
    );
  });

  it('changes when the build mode changes', () => {
    expect(fingerprint({ mode: 'development' })).not.toBe(fingerprint({ mode: 'test' }));
  });

  it('binds test builds to source content rather than an unrelated commit identity', () => {
    expect(fingerprint({ mode: 'test', head: 'head-a' })).toBe(
      fingerprint({ mode: 'test', head: 'head-b' })
    );
    expect(fingerprint({ mode: 'development', head: 'head-a' })).not.toBe(
      fingerprint({ mode: 'development', head: 'head-b' })
    );
  });

  it('changes a reusable test build when tracked source content changes', () => {
    expect(fingerprint({ mode: 'test', trackedTree: '100644 blob-a 0\tsource.ts\n' })).not.toBe(
      fingerprint({ mode: 'test', trackedTree: '100644 blob-b 0\tsource.ts\n' })
    );
  });

  it('changes when a dependency lockfile changes', () => {
    const baseFiles = { 'pnpm-lock.yaml': 'pixi.js: 8.9.0' };

    expect(fingerprint({ files: baseFiles })).not.toBe(
      fingerprint({ files: { ...baseFiles, 'pnpm-lock.yaml': 'pixi.js: 8.10.0' } })
    );
  });

  it('changes when a runtime package manifest changes', () => {
    const baseFiles = {
      'packages/core/genome-renderer/package.json': '{"dependencies":{"pixi.js":"8.9.0"}}',
    };

    expect(fingerprint({ files: baseFiles })).not.toBe(
      fingerprint({
        files: {
          ...baseFiles,
          'packages/core/genome-renderer/package.json': '{"dependencies":{"pixi.js":"8.10.0"}}',
        },
      })
    );
  });

  it('changes when tracked runtime source diffs change', () => {
    expect(fingerprint({ worktreeDiff: 'old renderer diff' })).not.toBe(
      fingerprint({ worktreeDiff: 'new renderer diff' })
    );
  });

  it('changes when an untracked runtime source file changes', () => {
    const untrackedPaths = ['packages/core/genome-renderer/src/new-atlas.ts'];
    expect(
      fingerprint({
        untrackedPaths,
        files: { [untrackedPaths[0]]: 'export const atlas = 1;' },
      })
    ).not.toBe(
      fingerprint({
        untrackedPaths,
        files: { [untrackedPaths[0]]: 'export const atlas = 2;' },
      })
    );
  });

  it('is stable when git returns untracked runtime paths in a different order', () => {
    const files = {
      'apps/desktop/src/new-viewer.ts': 'viewer',
      'packages/core/genome-renderer/src/new-atlas.ts': 'atlas',
    };
    expect(fingerprint({ untrackedPaths: Object.keys(files), files })).toBe(
      fingerprint({ untrackedPaths: Object.keys(files).reverse(), files })
    );
  });
});
