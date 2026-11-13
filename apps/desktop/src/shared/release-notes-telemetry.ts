export const RELEASE_NOTES_SOURCES = ['settings', 'home', 'post_update_toast'] as const;
export const RELEASE_NOTES_PHASES = ['presented', 'version_changed', 'closed'] as const;
export const RELEASE_NOTES_CLOSE_REASONS = ['escape', 'backdrop', 'close'] as const;
export const RELEASE_NOTES_REQUEST_KINDS = [
  'explicit',
  'installed_release',
  'source_release',
  'latest_registry',
] as const;
export const RELEASE_NOTES_ARTIFACT_KINDS = [
  'development',
  'local',
  'release',
  'test',
  'unknown',
] as const;
export type ReleaseNotesSource = (typeof RELEASE_NOTES_SOURCES)[number];
export type ReleaseNotesPhase = (typeof RELEASE_NOTES_PHASES)[number];
export type ReleaseNotesCloseReason = (typeof RELEASE_NOTES_CLOSE_REASONS)[number];
export type ReleaseNotesRequestKind = (typeof RELEASE_NOTES_REQUEST_KINDS)[number];

export function sanitizeReleaseNoteIdentity(value: unknown): string | undefined {
  return typeof value === 'string' &&
    (value === 'unknown' || value === 'missing' || /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(value))
    ? value
    : undefined;
}

export function sanitizeReleaseBuildIdentity(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 80 &&
    (value === 'unknown' || /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(value))
    ? value
    : undefined;
}
