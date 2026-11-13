import type { IndexedGenomeManifest } from '@waypoint/genome-data';

export interface OverviewSourceStat {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  dev?: number;
  ino?: number;
}

export interface OverviewTileCacheDeps {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<OverviewSourceStat>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<unknown>;
  sourceBuildFingerprint?: string | null;
}

export function sourceBuildFingerprint(
  deps: Pick<OverviewTileCacheDeps, 'sourceBuildFingerprint'>
): string {
  const explicit = deps.sourceBuildFingerprint?.trim();
  if (explicit && explicit.length > 0) return explicit;
  if (
    typeof __WAYPOINT_BUILD_SOURCE_FINGERPRINT__ === 'string' &&
    __WAYPOINT_BUILD_SOURCE_FINGERPRINT__.trim().length > 0
  ) {
    return __WAYPOINT_BUILD_SOURCE_FINGERPRINT__.trim();
  }
  return 'unknown-source-build';
}

export async function fingerprintManifestFiles(
  manifest: IndexedGenomeManifest,
  deps: OverviewTileCacheDeps
): Promise<string> {
  const paths = [
    manifest.fastaPath,
    manifest.faiPath,
    manifest.gffPath ?? undefined,
    manifest.tbiPath ?? undefined,
  ].filter((path): path is string => Boolean(path));

  const parts = await Promise.all(
    paths.map(async (path) => {
      const [resolvedPath, sourceStat] = await Promise.all([deps.realpath(path), deps.stat(path)]);
      return [
        resolvedPath,
        sourceStat.size,
        Math.trunc(sourceStat.mtimeMs),
        Math.trunc(sourceStat.ctimeMs ?? 0),
        sourceStat.dev ?? 'dev-unknown',
        sourceStat.ino ?? 'ino-unknown',
      ].join(':');
    })
  );
  return parts.join('|');
}
