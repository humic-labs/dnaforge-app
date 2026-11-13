import {
  qualificationEphemeralAuthSourceFromStamp,
  type ReleaseBHostedAuthority,
  type ReleaseBuildIdentity,
} from './release-stamp';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, sep } from 'node:path';

const USER_DATA_ARGUMENT = '--user-data-dir=';
const ATTEMPT_ARGUMENT = '--dnaforge-qualification-attempt=';
const ATTEMPT_SCHEMA = 'waypoint.hosted-codex-electron-attempt/v1';
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const SAFE_SCENARIO = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const MAX_ATTEMPT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

interface QualificationEphemeralAuthInput {
  isPackaged: boolean;
  releaseBuildIdentity: ReleaseBuildIdentity;
  releaseBHostedAuthority: ReleaseBHostedAuthority;
  packagedSourceCommit: string | null;
  bakedAuthorityStamp: unknown;
}

interface QualificationAttemptMarker {
  schema: typeof ATTEMPT_SCHEMA;
  scenarioId: string;
  sourceCommit: string;
  packageTreeSha256: string;
  createdAt: string;
}

export interface QualificationEphemeralAuthLaunchInput {
  sourceCommit: string | null;
  platform: NodeJS.Platform;
  argv: readonly string[];
  appDataPath: string;
  appName: string;
  now?: number;
}

export interface QualificationEphemeralAuthLaunch {
  sourceCommit: string;
  userDataPath: string;
  attemptMarkerPath: string;
  scenarioId: string;
  packageTreeSha256: string;
}

export function qualifyEphemeralAuthSource(input: QualificationEphemeralAuthInput): string | null {
  if (input.bakedAuthorityStamp === undefined || input.bakedAuthorityStamp === '') return null;

  const sourceCommit = qualificationEphemeralAuthSourceFromStamp(input.bakedAuthorityStamp);
  if (!sourceCommit) {
    throw new Error('packaged qualification ephemeral auth is malformed');
  }
  if (
    !input.isPackaged ||
    !input.releaseBuildIdentity.isReleaseBuild ||
    !input.releaseBHostedAuthority.enabled ||
    !input.packagedSourceCommit ||
    input.packagedSourceCommit !== sourceCommit
  ) {
    throw new Error('packaged qualification ephemeral auth lacks exact release authority');
  }

  return sourceCommit;
}

function oneExactArgument(argv: readonly string[], prefix: string, bareName: string): string {
  if (argv.includes(bareName)) {
    throw new Error(`qualification ephemeral auth requires ${prefix}<absolute-path>`);
  }
  const values = argv.filter((argument) => argument.startsWith(prefix));
  if (values.length !== 1) {
    throw new Error(`qualification ephemeral auth requires exactly one ${prefix}<absolute-path>`);
  }
  const value = values[0].slice(prefix.length);
  if (!value || !isAbsolute(value) || normalize(value) !== value) {
    throw new Error(`qualification ephemeral auth requires canonical absolute ${prefix} path`);
  }
  return value;
}

function exactAttemptMarker(value: unknown): QualificationAttemptMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('qualification ephemeral auth attempt marker must be an object');
  }
  const marker = value as Partial<QualificationAttemptMarker>;
  if (
    JSON.stringify(Object.keys(marker).sort()) !==
    JSON.stringify(['createdAt', 'packageTreeSha256', 'scenarioId', 'schema', 'sourceCommit'])
  ) {
    throw new Error('qualification ephemeral auth attempt marker keys are invalid');
  }
  if (
    marker.schema !== ATTEMPT_SCHEMA ||
    typeof marker.scenarioId !== 'string' ||
    !SAFE_SCENARIO.test(marker.scenarioId) ||
    typeof marker.sourceCommit !== 'string' ||
    !HEX_40.test(marker.sourceCommit) ||
    typeof marker.packageTreeSha256 !== 'string' ||
    !HEX_64.test(marker.packageTreeSha256) ||
    typeof marker.createdAt !== 'string' ||
    new Date(marker.createdAt).toISOString() !== marker.createdAt
  ) {
    throw new Error('qualification ephemeral auth attempt marker is malformed');
  }
  return marker as QualificationAttemptMarker;
}

export function qualifyEphemeralAuthLaunch(
  input: QualificationEphemeralAuthLaunchInput
): QualificationEphemeralAuthLaunch | null {
  if (input.sourceCommit === null) return null;
  if (input.platform !== 'darwin') {
    throw new Error('qualification ephemeral auth is restricted to packaged macOS canaries');
  }

  const userDataPath = oneExactArgument(input.argv, USER_DATA_ARGUMENT, '--user-data-dir');
  const attemptMarkerPath = oneExactArgument(
    input.argv,
    ATTEMPT_ARGUMENT,
    '--dnaforge-qualification-attempt'
  );
  const userDataStatus = lstatSync(userDataPath);
  if (!userDataStatus.isDirectory() || userDataStatus.isSymbolicLink()) {
    throw new Error('qualification ephemeral auth user-data path must be one real directory');
  }
  const canonicalUserDataPath = realpathSync(userDataPath);
  if (canonicalUserDataPath !== userDataPath) {
    throw new Error('qualification ephemeral auth user-data path must contain no symlink aliases');
  }
  const canonicalAppDataPath = realpathSync(input.appDataPath);
  const relativeToAppData = relative(canonicalAppDataPath, canonicalUserDataPath);
  const insideAppData =
    relativeToAppData === '' ||
    (relativeToAppData !== '..' &&
      !relativeToAppData.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToAppData));
  if (insideAppData) {
    throw new Error('qualification ephemeral auth refuses every installed app-data profile');
  }
  if (dirname(attemptMarkerPath) !== canonicalUserDataPath) {
    throw new Error('qualification ephemeral auth attempt marker must be inside user-data');
  }
  const markerStatus = lstatSync(attemptMarkerPath);
  if (!markerStatus.isFile() || markerStatus.isSymbolicLink()) {
    throw new Error('qualification ephemeral auth attempt marker must be one real file');
  }
  if (process.platform !== 'win32' && (markerStatus.mode & 0o077) !== 0) {
    throw new Error('qualification ephemeral auth attempt marker must have mode 0600');
  }
  const marker = exactAttemptMarker(JSON.parse(readFileSync(attemptMarkerPath, 'utf8')));
  if (
    basename(attemptMarkerPath) !==
    `.dnaforge-hosted-qualification-attempt-${marker.scenarioId}.json`
  ) {
    throw new Error('qualification ephemeral auth attempt marker name is invalid');
  }
  if (marker.sourceCommit !== input.sourceCommit) {
    throw new Error('qualification ephemeral auth attempt marker source does not match package');
  }
  const createdAt = Date.parse(marker.createdAt);
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(createdAt) ||
    createdAt < now - MAX_ATTEMPT_AGE_MS ||
    createdAt > now + MAX_FUTURE_SKEW_MS
  ) {
    throw new Error('qualification ephemeral auth attempt marker is outside its validity window');
  }

  return {
    sourceCommit: marker.sourceCommit,
    userDataPath: canonicalUserDataPath,
    attemptMarkerPath,
    scenarioId: marker.scenarioId,
    packageTreeSha256: marker.packageTreeSha256,
  };
}
