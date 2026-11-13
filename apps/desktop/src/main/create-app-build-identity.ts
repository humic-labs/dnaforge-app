import { execFileSync } from 'node:child_process';
import type { AppBuildIdentity } from '../shared/app-build-identity';
import { BUILD_SOURCE_GIT_EXECUTABLE } from './build-source-fingerprint';
import {
  buildTagFromTelemetryStamp,
  classifyReleaseBuildStamp,
  releaseBuildStampFromEnv,
  sourceCommitStamp,
  telemetryBuildTagStampFromEnv,
} from './release-stamp';

export function readDesktopSourceDescription(
  repoRoot: string,
  sourceCommit: string
): string | null {
  sourceCommitStamp(sourceCommit);
  try {
    return execFileSync(
      BUILD_SOURCE_GIT_EXECUTABLE,
      [
        'describe',
        '--tags',
        '--first-parent',
        '--match',
        'v[0-9]*',
        '--exclude',
        '*-*',
        '--long',
        '--abbrev=40',
        sourceCommit,
      ],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: 'pipe' }
    ).trim();
  } catch (error) {
    const failure = error as { status?: number; stderr?: string | Buffer };
    if (
      failure.status === 128 &&
      /No names found|No tags can describe/.test(String(failure.stderr))
    ) {
      return null;
    }
    throw error;
  }
}

export function createAppBuildIdentity(input: {
  command: string;
  mode: string;
  version: string;
  sourceCommit: string;
  sourceModified: boolean;
  sourceDescription: string | null;
  releaseBuild: string | undefined;
  buildTag: string | undefined;
}): AppBuildIdentity {
  sourceCommitStamp(input.sourceCommit);
  const release = classifyReleaseBuildStamp(releaseBuildStampFromEnv(input.releaseBuild));
  if (release.status === 'malformed') {
    throw new Error('Invalid DNAFORGE_RELEASE_BUILD; cannot identify this desktop build');
  }
  if (release.isReleaseBuild) {
    if (input.command !== 'build' || input.mode !== 'production') {
      throw new Error('A desktop release identity requires a production build');
    }
    const tag = buildTagFromTelemetryStamp(telemetryBuildTagStampFromEnv(input.buildTag));
    if (tag !== `v${input.version}`) {
      throw new Error('DNAFORGE_BUILD_TAG must match the desktop package version for a release');
    }
    return Object.freeze({
      kind: 'release',
      version: input.version,
      sourceReleaseVersion: input.version,
      sourceCommit: input.sourceCommit,
      sourceModified: input.sourceModified,
    });
  }
  const kind = input.mode === 'test' ? 'test' : input.command === 'serve' ? 'development' : 'local';
  let sourceReleaseVersion: string | null = null;
  let version: string | null = null;
  if (input.sourceDescription !== null) {
    const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-(\d+)-g([0-9a-f]{40})$/.exec(
      input.sourceDescription
    );
    if (!match || match[3] !== input.sourceCommit) {
      throw new Error(
        'Desktop source description must identify the exact build commit and a stable release tag'
      );
    }
    sourceReleaseVersion = match[1];
    const label = kind === 'development' ? 'dev' : kind;
    version = `${sourceReleaseVersion}+${label}.${match[2]}.g${input.sourceCommit.slice(0, 12)}${input.sourceModified ? '.dirty' : ''}`;
  }
  return Object.freeze({
    kind,
    version,
    sourceReleaseVersion,
    sourceCommit: input.sourceCommit,
    sourceModified: input.sourceModified,
  });
}
