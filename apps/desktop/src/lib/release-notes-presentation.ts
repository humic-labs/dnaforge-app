import type { AppBuildIdentity } from '../shared/app-build-identity';
import { installedReleaseVersion } from '../shared/app-build-identity';
import {
  sanitizeReleaseNoteIdentity,
  sanitizeReleaseBuildIdentity,
  type ReleaseNotesRequestKind,
} from '../shared/release-notes-telemetry';
import { VERSION_HISTORY, getReleaseNote } from './release-notes';

export function resolveReleaseNotesRequest(
  build: AppBuildIdentity,
  initialVersion?: string
): { version: string; kind: ReleaseNotesRequestKind } {
  if (initialVersion !== undefined)
    return { version: sanitizeReleaseNoteIdentity(initialVersion) ?? 'unknown', kind: 'explicit' };
  const installed = installedReleaseVersion(build);
  const related = installed ?? build.sourceReleaseVersion;
  if (related && VERSION_HISTORY.includes(related) && getReleaseNote(related))
    return { version: related, kind: installed ? 'installed_release' : 'source_release' };
  return { version: VERSION_HISTORY[0], kind: 'latest_registry' };
}

export function publicReleaseNoteIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !sanitizeReleaseNoteIdentity(value) ||
    value === 'unknown' ||
    value === 'missing'
  )
    return 'unknown';
  return VERSION_HISTORY.includes(value) && getReleaseNote(value) ? value : 'missing';
}

export function validatedBuildReleaseIdentity(value: unknown): string {
  return sanitizeReleaseBuildIdentity(value) ?? 'unknown';
}
