import { join } from 'node:path';
import { BENCHLING_MIGRATION_WORKSPACE_MARKER } from '../../shared/workspace-git-types';
import { readFileBoundedFromHandle } from '../ipc/bounded-file-read';

const MAX_BENCHLING_MIGRATION_WORKSPACE_MARKER_BYTES = 16 * 1024;

export async function benchlingProjectionLayoutPolicy(
  repoPath: string,
  expectedWorkspaceId?: string
): Promise<'ordinary' | 'preserve' | 'locked'> {
  const markerPath = join(repoPath, BENCHLING_MIGRATION_WORKSPACE_MARKER);
  let markerBytes: Uint8Array;
  try {
    markerBytes = await readFileBoundedFromHandle(
      markerPath,
      MAX_BENCHLING_MIGRATION_WORKSPACE_MARKER_BYTES
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'ordinary';
    console.warn(
      '[workspace-git] could not validate the Benchling migration marker; preserving the existing layout:',
      error
    );
    return 'preserve';
  }

  if (markerBytes.byteLength <= 0) {
    console.warn('[workspace-git] Benchling migration marker is empty; preserving the layout.');
    return 'preserve';
  }

  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(markerBytes)) as Record<
      string,
      unknown
    >;
  } catch {
    console.warn('[workspace-git] Benchling migration marker is malformed; preserving the layout.');
    return 'preserve';
  }

  if (marker.status === 'locked') return 'locked';

  const exactMarker =
    marker.schema === 'dnaforge.benchling-migration-workspace.v1' &&
    typeof marker.workspaceId === 'string' &&
    marker.runId === `migration-${marker.workspaceId}` &&
    marker.status === 'unlocked' &&
    (expectedWorkspaceId === undefined || marker.workspaceId === expectedWorkspaceId);
  if (!exactMarker) {
    console.warn(
      '[workspace-git] Benchling migration marker has an unknown shape; preserving the layout.'
    );
  }
  return 'preserve';
}
