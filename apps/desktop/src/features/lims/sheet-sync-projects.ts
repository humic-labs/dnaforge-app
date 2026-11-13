import { useSyncExternalStore } from 'react';
import { platform } from '../../platform';
import { localSheetSyncAuthorization } from './sheet-sync-local-state';
import {
  sheetSyncWorkspacePath,
  sheetSyncSourceView,
  type SheetSyncConnection,
} from './sheet-sync-connection';
import { listSheetSyncConnections } from './sheet-sync-connection';
import type { SheetSyncPullSummary } from './sheet-sync-runtime';

type ConnectionView = {
  workspaceRoot: string;
  connectionId: string;
  provider: 'google-sheets' | 'local-excel';
  sourcePath: string;
  sheetName: string;
};
export type SheetSyncView =
  | (ConnectionView & { kind: 'syncing' })
  | (ConnectionView & { kind: 'ready'; summary: SheetSyncPullSummary })
  | (ConnectionView & { kind: 'paused' })
  | (ConnectionView & { kind: 'authorization-required' })
  | (ConnectionView & { kind: 'error'; message: string })
  | { kind: 'invalid'; workspaceRoot: string; name: string; message: string };

const views = new Map<string, SheetSyncView>();
const listeners = new Set<() => void>();
const EMPTY: readonly SheetSyncView[] = [];
let viewSnapshot: readonly SheetSyncView[] = EMPTY;
const projects = new Map<string, ProjectController>();
const stoppingProjects = new Map<string, Promise<void>>();
function publish(key: string, value: SheetSyncView) {
  views.set(key, value);
  notify();
}
function notify() {
  viewSnapshot = [...views.values()];
  for (const listener of listeners) listener();
}
function viewKey(root: string, id: string) {
  return `${root}\0${id}`;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function getSheetSyncViews(): readonly SheetSyncView[] {
  return viewSnapshot;
}
export function subscribeSheetSyncViews(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useSheetSyncViews() {
  return useSyncExternalStore(subscribeSheetSyncViews, getSheetSyncViews, () => EMPTY);
}

function connectionController(
  workspaceRoot: string,
  connection: SheetSyncConnection,
  projectIsCurrent: () => boolean
) {
  const base: ConnectionView = {
    workspaceRoot,
    connectionId: connection.id,
    ...sheetSyncSourceView(connection.source),
  };
  const key = viewKey(workspaceRoot, connection.id);
  let stopped = false;
  let requested = false;
  let running: Promise<SheetSyncPullSummary | null> | null = null;
  let unsubscribe: (() => void) | null = null;
  let watching = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const assertCurrent = () => {
    if (stopped || !projectIsCurrent()) throw new Error('Spreadsheet watcher stopped.');
  };
  function pull(changed = false): Promise<SheetSyncPullSummary | null> {
    if (stopped || !projectIsCurrent())
      return Promise.reject(new Error('Spreadsheet watcher is stopped.'));
    if (running) {
      if (changed) requested = true;
      return running;
    }
    requested = true;
    const run = async () => {
      let result: SheetSyncPullSummary | null = null;
      while (requested && !stopped && projectIsCurrent()) {
        requested = false;
        publish(key, { ...base, kind: 'syncing' });
        try {
          const { pullExcelSheetConnection } = await import('./sheet-sync-runtime');
          result = await pullExcelSheetConnection({
            workspaceRoot,
            id: connection.id,
            assertCurrent,
          });
          if (!stopped && projectIsCurrent())
            publish(
              key,
              result === null
                ? { ...base, kind: 'paused' }
                : { ...base, kind: 'ready', summary: result }
            );
        } catch (error) {
          if (!stopped && projectIsCurrent())
            publish(key, { ...base, kind: 'error', message: message(error) });
          throw error;
        }
      }
      return result;
    };
    const current = run();
    running = current;
    void current
      .finally(() => {
        if (running === current) {
          running = null;
          if (requested && !stopped && projectIsCurrent()) void pull().catch(() => {});
        }
      })
      .catch(() => {});
    return current;
  }
  return {
    signature: JSON.stringify(connection.source),
    pull,
    async start() {
      if ('provider' in connection.source) {
        assertCurrent();
        timer = setInterval(() => {
          void pull(true).catch(() => {});
        }, 60000);
        return;
      }
      const path = connection.source.path;
      unsubscribe = platform().on('file-changed', (...args: unknown[]) => {
        if (args[0] === path && !stopped) void pull(true).catch(() => {});
      });
      try {
        await platform().fs.watchFile(path);
        watching = true;
        assertCurrent();
      } catch (error) {
        unsubscribe();
        unsubscribe = null;
        throw error;
      }
    },
    async stop() {
      stopped = true;
      requested = false;
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      if (watching && !('provider' in connection.source)) {
        watching = false;
        await platform().fs.unwatchFile(connection.source.path);
      }
      await running?.catch(() => {});
    },
  };
}

type ActiveConnection = ReturnType<typeof connectionController>;
interface ProjectController {
  refs: number;
  refresh(): Promise<void>;
  stop(): Promise<void>;
  connection(id: string): ActiveConnection | undefined;
}

function projectController(workspaceRoot: string, priorStop?: Promise<void>): ProjectController {
  const active = new Map<string, ActiveConnection>();
  const metadataWatches = new Set<string>();
  let disposed = false;
  let providerRevision = 0;
  let unsubscribeProvider: (() => void) | null = null;
  let scanAgain = false;
  let scanning: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  function projectError(error: unknown) {
    if (!disposed)
      publish(viewKey(workspaceRoot, '__project__'), {
        kind: 'invalid',
        workspaceRoot,
        name: 'Spreadsheet connections',
        message: message(error),
      });
  }
  async function metadataWatchesForProject() {
    const wanted = new Set([workspaceRoot]);
    for (const relative of ['.waypoint', '.waypoint/sheet-sync']) {
      const path = sheetSyncWorkspacePath(workspaceRoot, relative);
      if (await platform().fs.exists(path)) wanted.add(path);
    }
    for (const path of metadataWatches)
      if (!wanted.has(path)) {
        await platform().fs.unwatchFile(path);
        metadataWatches.delete(path);
      }
    for (const path of wanted)
      if (!metadataWatches.has(path)) {
        await platform().fs.watchFile(path);
        metadataWatches.add(path);
      }
  }
  async function scan() {
    do {
      scanAgain = false;
      if (disposed) return;
      const entries = await listSheetSyncConnections(workspaceRoot);
      if (disposed) return;
      await metadataWatchesForProject();
      const ids = new Set<string>();
      const invalidKeys = new Set<string>();
      for (const entry of entries) {
        if (disposed) return;
        if (entry.kind === 'invalid') {
          const key = viewKey(workspaceRoot, `invalid:${entry.name}`);
          invalidKeys.add(key);
          publish(key, {
            kind: 'invalid',
            workspaceRoot,
            name: entry.name,
            message: entry.message,
          });
          continue;
        }
        const connection = entry.stored.connection;
        ids.add(connection.id);
        const authorization = await localSheetSyncAuthorization(workspaceRoot, connection);
        if (disposed) return;
        const existing = active.get(connection.id);
        if (!connection.enabled || authorization !== 'authorized') {
          if (existing) {
            await existing.stop();
            active.delete(connection.id);
          }
          publish(viewKey(workspaceRoot, connection.id), {
            workspaceRoot,
            connectionId: connection.id,
            ...sheetSyncSourceView(connection.source),
            kind:
              connection.enabled && authorization === 'required'
                ? 'authorization-required'
                : 'paused',
          });
          continue;
        }
        const revision = providerRevision;
        const signature =
          JSON.stringify(connection.source) +
          ('provider' in connection.source ? `:${revision}` : '');
        if (existing && existing.signature === signature) continue;
        if (existing) await existing.stop();
        if (disposed) return;
        const controller = connectionController(
          workspaceRoot,
          connection,
          () => !disposed && (!('provider' in connection.source) || revision === providerRevision)
        );
        controller.signature = signature;
        active.set(connection.id, controller);
        try {
          await controller.start();
          if (!disposed) void controller.pull().catch(() => {});
        } catch (error) {
          await controller.stop().catch(() => {});
          active.delete(connection.id);
          if (!disposed)
            publish(viewKey(workspaceRoot, connection.id), {
              workspaceRoot,
              connectionId: connection.id,
              ...sheetSyncSourceView(connection.source),
              kind: 'error',
              message: message(error),
            });
        }
      }
      for (const [id, controller] of active)
        if (!ids.has(id)) {
          await controller.stop();
          active.delete(id);
          views.delete(viewKey(workspaceRoot, id));
        }
      for (const [key, value] of views) {
        if (value.workspaceRoot !== workspaceRoot) continue;
        if (value.kind === 'invalid' ? !invalidKeys.has(key) : !ids.has(value.connectionId))
          views.delete(key);
      }
      notify();
    } while (scanAgain && !disposed);
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (scanning) {
      scanAgain = true;
      return scanning;
    }
    const current = scan();
    scanning = current;
    void current
      .finally(() => {
        if (scanning === current) {
          scanning = null;
          if (scanAgain && !disposed) void refresh().catch(projectError);
        }
      })
      .catch(() => {});
    return current;
  }
  const initialization = (async () => {
    await priorStop?.catch(() => {});
    if (disposed) return;
    unsubscribeProvider = platform().googleSheets.onChanged(() => {
      providerRevision += 1;
      void refresh().catch(projectError);
    });
    unsubscribe = platform().on('file-changed', (...args: unknown[]) => {
      if (typeof args[0] === 'string' && metadataWatches.has(args[0]))
        void refresh().catch(projectError);
    });
    await refresh();
  })();
  void initialization.catch(projectError);
  return {
    refs: 1,
    refresh: async () => {
      await initialization;
      await refresh();
    },
    connection: (id) => active.get(id),
    async stop() {
      disposed = true;
      unsubscribeProvider?.();
      unsubscribeProvider = null;
      unsubscribe?.();
      unsubscribe = null;
      await initialization.catch(() => {});
      await scanning?.catch(() => {});
      await Promise.all(
        [...active.values()].map((controller) => controller.stop().catch(() => {}))
      );
      active.clear();
      await Promise.all(
        [...metadataWatches].map((path) =>
          platform()
            .fs.unwatchFile(path)
            .catch(() => {})
        )
      );
      metadataWatches.clear();
      for (const [key, value] of views)
        if (value.workspaceRoot === workspaceRoot) views.delete(key);
      notify();
    },
  };
}

export function retainSheetSyncProject(workspaceRoot: string): () => void {
  let project = projects.get(workspaceRoot);
  if (project) project.refs += 1;
  else {
    project = projectController(workspaceRoot, stoppingProjects.get(workspaceRoot));
    projects.set(workspaceRoot, project);
  }
  const owned = project;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owned.refs -= 1;
    if (owned.refs > 0) return;
    if (projects.get(workspaceRoot) === owned) projects.delete(workspaceRoot);
    const stop = owned.stop();
    stoppingProjects.set(workspaceRoot, stop);
    void stop
      .finally(() => {
        if (stoppingProjects.get(workspaceRoot) === stop) stoppingProjects.delete(workspaceRoot);
      })
      .catch(() => {});
  };
}
export async function refreshSheetSyncProject(workspaceRoot: string): Promise<void> {
  const project = projects.get(workspaceRoot);
  if (!project) throw new Error('Open this project before synchronizing its spreadsheet.');
  await project.refresh();
}
export async function requestSheetSyncPull(workspaceRoot: string, id: string): Promise<void> {
  await refreshSheetSyncProject(workspaceRoot);
  const controller = projects.get(workspaceRoot)?.connection(id);
  if (!controller)
    throw new Error('Enable and authorize this spreadsheet connection before syncing.');
  await controller.pull();
}
