import { describe, expect, it } from 'vitest';
import { join } from 'path';

import { buildCoverageCacheEnv, type CoverageCacheEnvInput } from './coverage-cache-env';

type CoverageCacheEnvOverrides = NonNullable<CoverageCacheEnvInput['env']>;

function cacheEnv(overrides: Partial<CoverageCacheEnvOverrides> = {}): CoverageCacheEnvOverrides {
  return {
    WAYPOINT_ALIGNMENT_INDEX_DIR: undefined,
    WAYPOINT_COVERAGE_CACHE_DIR: undefined,
    WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR: undefined,
    WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS: undefined,
    WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR: undefined,
    WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES: undefined,
    ...overrides,
  };
}

describe('coverage cache env', () => {
  it('keeps managed alignment indexes under app userData unless explicitly overridden', () => {
    const userDataPath = '/Users/tester/Library/Application Support/Waypoint';

    const defaultEnv = buildCoverageCacheEnv({
      isPackaged: true,
      userDataPath,
      homePath: '/Users/tester',
      env: cacheEnv(),
    });
    const overriddenEnv = buildCoverageCacheEnv({
      isPackaged: true,
      userDataPath,
      homePath: '/Users/tester',
      env: cacheEnv({
        WAYPOINT_ALIGNMENT_INDEX_DIR: '/explicit/alignment-index-cache',
      }),
    });

    expect(defaultEnv.WAYPOINT_ALIGNMENT_INDEX_DIR).toBe(
      join(userDataPath, 'alignment-index-cache')
    );
    expect(overriddenEnv.WAYPOINT_ALIGNMENT_INDEX_DIR).toBe('/explicit/alignment-index-cache');
    expect(defaultEnv.WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR).toBe(
      join(userDataPath, 'indexed-track-range-cache-v1')
    );
    expect(defaultEnv.WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES).toBe('1073741824');
  });

  it('keeps indexed-track ranges profile-global and allows an operator route override', () => {
    const env = buildCoverageCacheEnv({
      isPackaged: true,
      userDataPath: '/Users/tester/Library/Application Support/DNAForge',
      homePath: '/Users/tester',
      env: cacheEnv({
        WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR: '/Volumes/fast-cache/indexed-ranges',
        WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES: '2147483648',
      }),
    });

    expect(env).toMatchObject({
      WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR: '/Volumes/fast-cache/indexed-ranges',
      WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES: '2147483648',
    });
  });

  it('uses one durable derived-artifact store in dev and packaged runtimes', () => {
    const dev = buildCoverageCacheEnv({
      isPackaged: false,
      userDataPath: '/tmp/worktree-user-data',
      homePath: '/Users/tester',
      env: cacheEnv(),
    });
    const packaged = buildCoverageCacheEnv({
      isPackaged: true,
      userDataPath: '/Users/tester/Library/Application Support/DNAForge',
      homePath: '/Users/tester',
      env: cacheEnv(),
    });

    const sharedRoot = join(
      '/Users/tester',
      '.dnaforge',
      'derived-artifacts',
      'coverage-pyramid-v1'
    );
    expect(dev).toMatchObject({
      WAYPOINT_COVERAGE_CACHE_DIR: join('/tmp/worktree-user-data', 'coverage-cache'),
      WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR: sharedRoot,
    });
    expect(packaged).toMatchObject({
      WAYPOINT_COVERAGE_CACHE_DIR: join(
        '/Users/tester/Library/Application Support/DNAForge',
        'coverage-cache'
      ),
      WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR: sharedRoot,
    });
    expect(dev.WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS).toContain(
      join('/Users/tester', '.dnaforge', 'waypoint-coverage-pyramid')
    );
    expect(packaged.WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS).toContain(
      join('/Users/tester/Library/Application Support/DNAForge', 'coverage-pyramid-cache')
    );
  });

  it('lets an explicit pyramid cache env override the dev durable default', () => {
    const env = buildCoverageCacheEnv({
      isPackaged: false,
      userDataPath: '/tmp/worktree-user-data',
      homePath: '/Users/tester',
      env: cacheEnv({
        WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR: '/explicit/pyramid-cache',
      }),
    });

    expect(env.WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR).toBe('/explicit/pyramid-cache');
  });

  it('preserves the legacy coverage cache env as the fallback for both cache families', () => {
    const env = buildCoverageCacheEnv({
      isPackaged: false,
      userDataPath: '/tmp/worktree-user-data',
      homePath: '/Users/tester',
      env: cacheEnv({
        WAYPOINT_COVERAGE_CACHE_DIR: '/legacy/coverage-cache',
      }),
    });

    expect(env).toMatchObject({
      WAYPOINT_COVERAGE_CACHE_DIR: '/legacy/coverage-cache',
      WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR: '/legacy/coverage-cache',
    });
  });
});
