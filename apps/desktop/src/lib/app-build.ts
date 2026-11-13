import type { AppBuildIdentity } from '../shared/app-build-identity';

export const APP_BUILD: AppBuildIdentity = Object.freeze(
  (typeof __DNAFORGE_APP_BUILD__ === 'undefined' ? undefined : __DNAFORGE_APP_BUILD__) ?? {
    kind: 'unknown',
    version: null,
    sourceReleaseVersion: null,
    sourceCommit: null,
    sourceModified: null,
  }
);
