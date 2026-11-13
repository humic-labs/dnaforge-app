import type { MolstarPlugin } from './cache';

export function observeMolecularEdits(plugin: MolstarPlugin) {
  const original = plugin.managers.structure.hierarchy.current.structures.map(
    (item) => item.cell.obj!.data
  );
  const models = original.flatMap((structure) => structure.models);
  const camera = JSON.stringify(plugin.canvas3d?.camera.getSnapshot());
  const events: string[] = [];
  const cameraRequests: Array<{ snapshot: string; stack?: string }> = [];
  const subscription = plugin.canvas3d?.camera.stateChanged.subscribe((snapshot) => {
    events.push(JSON.stringify(plugin.canvas3d?.camera.getSnapshot()));
    cameraRequests.push({ snapshot: JSON.stringify(snapshot), stack: new Error().stack });
  });

  events.length = 0;
  cameraRequests.length = 0;
  const tasks: string[] = [];
  const runTask = plugin.runTask;
  const runBound = runTask.bind(plugin) as typeof runTask;
  const observing: typeof runTask = (task, params) => {
    tasks.push(task.name);
    return runBound(task, params);
  };
  plugin.runTask = observing;
  return {
    read: () => {
      const current = plugin.managers.structure.hierarchy.current.structures.map(
        (item) => item.cell.obj!.data
      );
      const currentModels = current.flatMap((structure) => structure.models);
      return {
        sceneLoads: tasks.filter((name) => name === 'Load MVS').length,
        cameraChanges: events.length,
        cameraEvents: [...events],
        cameraRequests: [...cameraRequests],
        cameraUnchanged: camera === JSON.stringify(plugin.canvas3d?.camera.getSnapshot()),
        coordinateIdentityRetained:
          models.length === currentModels.length &&
          models.every((model, index) => model === currentModels[index]),
        structureIdentityRetained:
          original.length === current.length &&
          original.every((structure, index) => structure === current[index]),
        taskNames: [...tasks],
      };
    },
    stop: () => {
      subscription?.unsubscribe();
      if (plugin.runTask === observing) plugin.runTask = runTask;
    },
  };
}
