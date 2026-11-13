export const BUILD_DISTRIBUTIONS = ['official', 'community'] as const;

export type BuildDistribution = (typeof BUILD_DISTRIBUTIONS)[number];

export const BUILD_DISTRIBUTION_SCHEMA = 'dnaforge.build-distribution.v1';

function isBuildDistribution(value: unknown): value is BuildDistribution {
  return typeof value === 'string' && (BUILD_DISTRIBUTIONS as readonly string[]).includes(value);
}

export function resolveBuildDistribution(input: {
  file: string;
  override?: string;
  releaseBuild: boolean;
}): BuildDistribution {
  const parsed = JSON.parse(input.file) as { schema?: unknown; distribution?: unknown };
  if (parsed.schema !== BUILD_DISTRIBUTION_SCHEMA || !isBuildDistribution(parsed.distribution)) {
    throw new Error(
      `distribution.json must use ${BUILD_DISTRIBUTION_SCHEMA} with distribution "official" or "community"`
    );
  }
  const override = input.override?.trim();
  if (override && !isBuildDistribution(override)) {
    throw new Error(`DNAFORGE_DISTRIBUTION must be "official" or "community", not "${override}"`);
  }
  const distribution = (override || parsed.distribution) as BuildDistribution;
  if (input.releaseBuild && distribution !== 'official') {
    throw new Error('Release builds must use the official distribution');
  }
  return distribution;
}

export function communityRendererEnvDefaults(
  distribution: BuildDistribution
): Record<string, string> {
  return distribution === 'community'
    ? { VITE_ENABLE_DESKTOP_SIGNIN: 'false', VITE_ENABLE_WORKSPACE_CLOUD_SYNC: 'false' }
    : {};
}
