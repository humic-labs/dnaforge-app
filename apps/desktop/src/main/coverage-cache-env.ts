import { delimiter, join } from 'path';

export interface CoverageCacheEnvInput {
  readonly isPackaged: boolean;
  readonly userDataPath: string;
  readonly homePath: string;
  readonly env?: Pick<
    NodeJS.ProcessEnv,
    | 'WAYPOINT_ALIGNMENT_INDEX_DIR'
    | 'WAYPOINT_COVERAGE_CACHE_DIR'
    | 'WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR'
    | 'WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS'
    | 'WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR'
    | 'WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES'
  >;
}

const DERIVED_ARTIFACT_PYRAMID_SUBDIR = join(
  '.dnaforge',
  'derived-artifacts',
  'coverage-pyramid-v1'
);
const LEGACY_DEV_PYRAMID_CACHE_SUBDIR = join('.dnaforge', 'waypoint-coverage-pyramid');
const DEFAULT_INDEXED_TRACK_RANGE_CACHE_BYTES = String(1024 * 1024 * 1024);

export function buildCoverageCacheEnv(input: CoverageCacheEnvInput): Record<string, string> {
  const env = input.env ?? process.env;
  const legacyCoverageCacheDir =
    env.WAYPOINT_COVERAGE_CACHE_DIR ?? join(input.userDataPath, 'coverage-cache');
  const defaultPyramidCoverageCacheDir = join(input.homePath, DERIVED_ARTIFACT_PYRAMID_SUBDIR);
  const pyramidCoverageCacheDir =
    env.WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR ??
    env.WAYPOINT_COVERAGE_CACHE_DIR ??
    defaultPyramidCoverageCacheDir;
  const legacyPyramidCoverageDirs =
    env.WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS ??
    [
      join(input.homePath, LEGACY_DEV_PYRAMID_CACHE_SUBDIR),
      join(input.userDataPath, 'coverage-pyramid-cache'),
    ]
      .filter(
        (candidate, index, all) =>
          candidate !== pyramidCoverageCacheDir && all.indexOf(candidate) === index
      )
      .join(delimiter);
  const configuredAlignmentIndexDir = env.WAYPOINT_ALIGNMENT_INDEX_DIR?.trim();
  const alignmentIndexDir =
    configuredAlignmentIndexDir || join(input.userDataPath, 'alignment-index-cache');
  const indexedTrackRangeCacheDir =
    env.WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR?.trim() ||
    join(input.userDataPath, 'indexed-track-range-cache-v1');
  const indexedTrackRangeCacheBytes =
    env.WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES?.trim() || DEFAULT_INDEXED_TRACK_RANGE_CACHE_BYTES;
  return {
    WAYPOINT_ALIGNMENT_INDEX_DIR: alignmentIndexDir,
    WAYPOINT_COVERAGE_CACHE_DIR: legacyCoverageCacheDir,
    WAYPOINT_COVERAGE_PYRAMID_CACHE_DIR: pyramidCoverageCacheDir,
    WAYPOINT_COVERAGE_PYRAMID_LEGACY_DIRS: legacyPyramidCoverageDirs,
    WAYPOINT_INDEXED_TRACK_RANGE_CACHE_DIR: indexedTrackRangeCacheDir,
    WAYPOINT_INDEXED_TRACK_RANGE_CACHE_BYTES: indexedTrackRangeCacheBytes,
  };
}
