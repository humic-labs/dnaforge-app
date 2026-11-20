import { createNativeContactSources } from './contact-sources';
import { createNativeComparisonSources } from './comparison-sources';
import { trackViewCommandResultSchema } from '../../shared/track-view-commands';
import { app } from 'electron';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { mainIpc, handleGroup } from '../../shared/ipc-contract';
import { trackViewCommandsContract } from '../../shared/ipc/track-view-commands.contract';
import { resolveExplicitProjectRoot } from '../../shared/project-root-selection';
import { TrackViewCommands } from '../track-view-commands';
import { admitTrackViewSource } from '../track-view-source-admission';
import { getDb } from './database';
import { assertSafePath, assertSafeWritablePath, resolveCanonicalPath } from './path-allowlist';
import { assertKnownWorkspaceContentWritable } from '../workspace-content-write-access';
import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import type { SaveTrackViewRequest } from '../../shared/track-view';
import { TrackViewLibrary } from '../track-view-library';

export function registerTrackViewIpcHandlers(): void {
  const library = new TrackViewLibrary(join(app.getPath('userData'), 'Track views'), {
    db: getDb,
    comparisons: createNativeComparisonSources(),
    contacts: createNativeContactSources(),
  });
  const commands = new TrackViewCommands({
    library,
    resolveProject: async (project) => {
      const { nativeDocuments } = await import('../features/native-documents');
      const roots = new Set(nativeDocuments.workspaces.readableRoots());
      const rows = getDb()
        .prepare(
          'SELECT name, path FROM workspaces WHERE path IS NOT NULL AND archived_at IS NULL AND trashed_at IS NULL'
        )
        .all() as Array<{ name: string; path: string }>;
      const selected = resolveExplicitProjectRoot(
        rows.filter((row) => roots.has(row.path)),
        project
      );
      if (!selected)
        throw new Error('PROJECT_NOT_FOUND: Choose an exact admitted project name or root.');
      return resolveCanonicalPath(selected.path);
    },
    resolvePath: (path) => assertSafePath(path, { requireAbsolute: true }),
    capture: async (root, mutating) => {
      const { nativeDocuments } = await import('../features/native-documents');
      return mutating
        ? nativeDocuments.workspaces.capture(root)
        : nativeDocuments.workspaces.captureReadable(root);
    },
    assertWritable: async (root, path) => {
      await assertSafeWritablePath(path, { requireAbsolute: true });
      assertKnownWorkspaceContentWritable(getDb(), root);
      assertWorkspaceWriteAllowed(getDb(), [path]);
    },
    references: async () =>
      (await import('../features/reference-assets')).listTrackViewReferences(),
    reference: async (id) =>
      (await import('../features/reference-assets')).resolveTrackViewReference(id),
    admit: admitTrackViewSource,
  });
  handleGroup(trackViewCommandsContract, {
    run: async (_event, request) => trackViewCommandResultSchema.parse(await commands.run(request)),
  });
  mainIpc.handle('trackViews:locations', async () => {
    const defaultDirectory = join(app.getPath('userData'), 'Track views');
    await mkdir(defaultDirectory, { recursive: true });
    return { defaultDirectory, homeDirectory: app.getPath('home') };
  });
  mainIpc.handle('trackViews:list', () => library.list());
  mainIpc.handle('trackViews:read', (_event, id: string) => library.read(id));
  mainIpc.handle('trackViews:save', (_event, request: SaveTrackViewRequest) =>
    library.save(request)
  );
}
