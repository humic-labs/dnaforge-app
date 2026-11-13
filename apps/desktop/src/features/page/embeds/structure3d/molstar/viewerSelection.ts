import type { Camera } from 'molstar/lib/mol-canvas3d/camera';
import { Loci } from 'molstar/lib/mol-model/loci';
import { ButtonsType } from 'molstar/lib/mol-util/input/input-observer';
import type { MolstarPlugin } from './cache';

function viewIdentity(plugin: MolstarPlugin) {
  return {
    snapshotId: plugin.managers?.snapshot?.current?.snapshot.id,
    structures: (plugin.managers?.structure?.hierarchy?.current.structures ?? []).map(
      (s) => s.transform?.cell.obj?.data ?? s.cell.obj?.data
    ),
  };
}

const overviews = new WeakMap<
  MolstarPlugin,
  { identity: ReturnType<typeof viewIdentity>; snapshot: Camera.Snapshot }
>();

function sameView(a: ReturnType<typeof viewIdentity>, b: ReturnType<typeof viewIdentity>) {
  return (
    a.snapshotId === b.snapshotId &&
    a.structures.length === b.structures.length &&
    a.structures.every((structure, index) => structure === b.structures[index])
  );
}

export function rememberViewerOverview(plugin: MolstarPlugin): void {
  const camera = plugin.canvas3d?.camera;
  if (!camera) return;
  const identity = viewIdentity(plugin);
  const previous = overviews.get(plugin);
  if (!previous || !sameView(previous.identity, identity))
    overviews.set(plugin, { identity, snapshot: camera.getSnapshot() });
}

export function forgetViewerOverview(plugin: MolstarPlugin): void {
  overviews.delete(plugin);
}

export function installViewerSelectionInteractions(plugin: MolstarPlugin): void {
  plugin.behaviors?.interaction?.click?.subscribe(({ current, button, modifiers }) => {
    if (
      !plugin.canvas3d ||
      plugin.isBusy ||
      button !== ButtonsType.Flag.Primary ||
      modifiers.alt ||
      modifiers.control ||
      modifiers.meta ||
      modifiers.shift ||
      !Loci.isEmpty(current.loci)
    )
      return;
    const overview = overviews.get(plugin);
    plugin.managers.interactivity.lociSelects.deselectAll();
    plugin.managers.interactivity.lociHighlights.clearHighlights();
    plugin.managers.structure.focus.clear();
    if (overview && sameView(overview.identity, viewIdentity(plugin)))
      plugin.canvas3d.camera.setState(overview.snapshot, 250);
    else plugin.canvas3d.requestCameraReset({ durationMs: 250 });
    overviews.delete(plugin);
  });
}
