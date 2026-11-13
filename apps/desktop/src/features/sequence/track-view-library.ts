import { platform } from '../../platform';
import { trackViewAdapter } from '../../db/entity-substrate/track-view-adapter';
import type { SavedTrackView, SaveTrackViewRequest, TrackViewList } from '../../shared/track-view';
import { emitRegistryChanged } from '../../shared/registry-events';
import { useWorkspaceStore } from '../../stores/workspaceStore';

export const TRACK_VIEW_LIBRARY_CHANGED = 'dnaforge:track-view-library-changed';

const inFlightProjections = new Map<string, Promise<void>>();

export async function projectSavedTrackView(saved: SavedTrackView): Promise<void> {
  const existing = inFlightProjections.get(saved.document.id);
  if (existing) return existing;

  const projection = trackViewAdapter
    .writeProjection(
      saved.document,
      saved.document.id,
      Date.parse(saved.document.updatedAt),
      saved.path,
      { workspaceRoot: saved.workspaceRoot ?? null }
    )
    .then(() => undefined);
  inFlightProjections.set(saved.document.id, projection);
  try {
    await projection;
  } finally {
    if (inFlightProjections.get(saved.document.id) === projection) {
      inFlightProjections.delete(saved.document.id);
    }
  }
}

export async function listSavedTrackViews(): Promise<TrackViewList> {
  const result = await platform().trackViews.list();
  let projectedAny = false;
  for (const saved of result.views) {
    try {
      await projectSavedTrackView(saved);
      projectedAny = true;
    } catch (error) {
      result.errors.push({
        name: saved.document.name,
        message: `The saved file is available, but its catalog entry could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (projectedAny) emitRegistryChanged();
  return result;
}

export async function saveTrackView(
  request: SaveTrackViewRequest
): Promise<{ saved: SavedTrackView; warning?: string }> {
  const saved = await platform().trackViews.save(request);
  let warning: string | undefined = saved.warning;
  try {
    await projectSavedTrackView(saved);
    emitRegistryChanged();
  } catch {
    warning = 'The view file was saved, but its Registry entry could not be refreshed yet.';
  }
  window.dispatchEvent(new Event(TRACK_VIEW_LIBRARY_CHANGED));
  useWorkspaceStore.getState().bumpFileTreeRefresh();
  return { saved, warning };
}
