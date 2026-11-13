import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userMessage } from '@waypoint/user-messages';
import { createHostedMemoryDb } from './memory-db';
import { createHostedLims } from './lims';
import { createHostedProjectionSourceCommands } from './entity-projection-source';
import { createMemoryNotebookPageCommands } from '../platform/memory-notebook-pages';
import { hostedBrowserBridge } from '../platform/hosted';
import {
  buildPrimerArtifact,
  serializePrimerArtifact,
} from '../shared/primer-artifacts/primer-artifact';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ROOT = `/hosted/${WORKSPACE_ID}`;
const files = new Map<string, string>();
let db = createHostedMemoryDb();
let lims = createHostedLims();
const fs = {
  readTextFile: async (path: string) => {
    const bytes = files.get(path);
    if (bytes === undefined) throw new Error(`Missing fixture source: ${path}`);
    return bytes;
  },
  stat: async (path: string) => ({
    mtime: 1,
    size: files.get(path)?.length ?? 0,
    isFile: files.has(path),
    isDirectory: path === ROOT,
  }),
  readDir: async () => [],
  validateWorkspacePath: async () => true,
  exists: async (path: string) => path === ROOT || files.has(path),
  writeWorkspaceTextFileAtomic: vi.fn(async () => {
    throw new Error('Projection reconstruction must not rewrite accepted files.');
  }),
};

vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      ...db,
      ...createHostedProjectionSourceCommands({
        db,
        fs,
        lims,
        settleNotebook: createMemoryNotebookPageCommands(db, fs).settleEntityProjectionSource,
      }),
    },
    fs,
    lims,
    workspace: hostedBrowserBridge.workspace,
  }),
}));

const { rebuildHostedFileProjections } = await import('./file-projections');
const { searchPrimers } = await import('../features/primers/primer-service');

beforeEach(() => {
  files.clear();
  db = createHostedMemoryDb();
  lims = createHostedLims();
  fs.writeWorkspaceTextFileAtomic.mockClear();
  document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
});

afterEach(() => {
  delete document.documentElement.dataset.dnaforgeRuntime;
});

describe('hosted saved-file reconstruction', () => {
  it('reports that no original desktop identity is available instead of selecting a server project', async () => {
    await expect(hostedBrowserBridge.workspace.getOriginalDefaultProject()).resolves.toEqual({
      status: 'unresolved',
      reason: 'project-unavailable',
      message: userMessage('hosted.unavailable'),
    });
  });

  it('rebuilds a saved primer into its project without requiring an original desktop project', async () => {
    const path = `${ROOT}/primers/fwd.primer.json`;
    const artifact = await buildPrimerArtifact({
      id: '22222222-2222-4222-8222-222222222222',
      catalogNumber: 'P001',
      name: 'Reloaded primer',
      sequence: 'ATGACCATGATTACGCCAAGC',
      workspaceRoot: ROOT,
      artifactPath: path,
    });
    const bytes = serializePrimerArtifact(artifact);
    files.set(path, bytes);
    await db.ensureWorkspaceOwner(ROOT, 'writable', { name: 'My Project', recordOpen: true });

    await expect(
      rebuildHostedFileProjections(WORKSPACE_ID, ['primers/fwd.primer.json'])
    ).resolves.toEqual({ primers: 1, entities: 0, errors: [] });
    expect((await searchPrimers({})).map((primer) => primer.name)).toEqual(['Reloaded primer']);
    const [owner] = await db.select<Array<{ id: number }>>(
      'SELECT id FROM workspaces WHERE path = ?',
      [ROOT]
    );
    const page = await lims.queryRegistrySummaries({ workspaceIds: [owner.id] });
    expect(page.totalCount).toBe(1);
    expect(page.summaries[0]).toMatchObject({
      id: artifact.registry.entityId,
      name: artifact.name,
    });
    expect(files.get(path)).toBe(bytes);
    expect(fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });
});
