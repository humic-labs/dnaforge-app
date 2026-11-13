export interface AppBuildIdentity {
  readonly kind: 'development' | 'local' | 'release' | 'test' | 'unknown';
  readonly version: string | null;
  readonly sourceReleaseVersion: string | null;
  readonly sourceCommit: string | null;
  readonly sourceModified: boolean | null;
}

export function installedReleaseVersion(build: AppBuildIdentity): string | null {
  return build.kind === 'release' ? build.version : null;
}

export function appBuildLabel(build: AppBuildIdentity): string {
  return build.version ? `v${build.version}` : 'Version unavailable';
}

export function appBuildKindLabel(build: AppBuildIdentity): string {
  switch (build.kind) {
    case 'release':
      return 'Release build';
    case 'development':
      return 'Development build';
    case 'local':
      return 'Local build';
    case 'test':
      return 'Test build';
    case 'unknown':
      return 'Build information unavailable';
  }
}

export function nativeAboutBuildOptions(build: AppBuildIdentity) {
  return {
    applicationName: 'DNAForge',
    applicationVersion: build.version ?? 'Version unavailable',
    version: appBuildKindLabel(build),
    website: 'https://dnaforge.com',
  };
}
