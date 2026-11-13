import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostedLims } from './lims';
import { createHostedMemoryDb } from './memory-db';
import { createHostedProjectionSourceCommands } from './entity-projection-source';
import { createMemoryNotebookPageCommands } from '../platform/memory-notebook-pages';
import { entityArtifactProjectionFingerprint } from '../shared/entity-artifact-projection';
import { parseEntityArtifact, serializeEntityArtifact } from '../shared/entity-artifact';
import type { SettleEntityProjectionSourceInput } from '../shared/entity-projection-source';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ROOT = `/hosted/${WORKSPACE_ID}`;
const files = new Map<string, string>();
let db = createHostedMemoryDb();
let lims = createHostedLims();
const fs = {
  readTextFile: async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  },
  stat: async () => ({ mtime: 1, size: 1, isFile: true, isDirectory: false }),
  readDir: async () => [],
  validateWorkspacePath: async () => true,
  exists: async (path: string) => files.has(path),
  writeWorkspaceTextFileAtomic: async ({ path, content }: { path: string; content: string }) => {
    files.set(path, content);
    return {};
  },
};

function projectionCommands() {
  return createHostedProjectionSourceCommands({
    db,
    fs,
    lims,
    settleNotebook: createMemoryNotebookPageCommands(db, fs).settleEntityProjectionSource,
  });
}

vi.mock('../platform', () => ({
  platform: () => ({
    db: { ...db, ...projectionCommands() },
    lims,
    fs,
    workspace: { getOriginalDefaultProject: async () => null },
  }),
}));
vi.mock('./controller', () => ({
  hostedWorkspaceSessionController: { getState: vi.fn(), subscribe: vi.fn() },
}));

const { buildPrimerArtifact, serializePrimerArtifact } =
  await import('../shared/primer-artifacts/primer-artifact');
const { searchPrimers } = await import('../features/primers/primer-service');
const { registerLimsEntityArtifactAdapter } =
  await import('../db/entity-substrate/lims-entity-adapter');
const { recordEntityArtifact } = await import('../features/lims/record-entity-artifact');
const { rebuildHostedFileProjections } = await import('./file-projections');
const { getCatalogWorkspaceRootForFilePath } = await import('../db/workspace-catalog');
const { oligoDefinition } = await import('../features/entity-details/oligo-adapter');

describe('hosted file projections', () => {
  beforeEach(() => {
    files.clear();
    db = createHostedMemoryDb();
    lims = createHostedLims();
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
  });

  afterEach(() => {
    delete document.documentElement.dataset.dnaforgeRuntime;
  });

  it('rebuilds the primer library and Registry from saved project files after a reload', async () => {
    const primerPath = `${ROOT}/primers/fwd.primer.json`;
    const primer = await buildPrimerArtifact({
      id: 'primer-1',
      catalogNumber: 'P001',
      name: 'fwd',
      sequence: 'ATGACCATGATTACGCCAAGC',
      workspaceRoot: ROOT,
      artifactPath: primerPath,
    });
    files.set(primerPath, serializePrimerArtifact(primer));
    registerLimsEntityArtifactAdapter();
    await recordEntityArtifact({
      kind: 'strain',
      name: 'saved strain',
      fields: { genotypeCanonical: 'MATa his3D1' },
      workspaceRoot: ROOT,
      destinationDir: `${ROOT}/records`,
    });
    const entityPath = [...files.keys()].find((path) => path.endsWith('.entity.json'))!;
    db = createHostedMemoryDb();
    lims = createHostedLims();
    await db.execute('INSERT INTO workspaces (name, path) VALUES (?, ?)', ['Saved project', ROOT]);
    const listener = vi.fn();
    window.addEventListener('waypoint:lims-registry-changed', listener);

    const result = await rebuildHostedFileProjections(WORKSPACE_ID, [
      'sequences/a/a.gb',
      primerPath.slice(ROOT.length + 1),
      entityPath.slice(ROOT.length + 1),
    ]);

    expect(result).toEqual({ primers: 1, entities: 1, errors: [] });
    expect((await searchPrimers({})).map((primer) => primer.name)).toEqual(['fwd']);
    expect(
      (await lims.queryRegistrySummaries({})).summaries.map((summary) => summary.name).sort()
    ).toEqual(['fwd', 'saved strain']);
    await expect(getCatalogWorkspaceRootForFilePath(primerPath)).resolves.toBe(ROOT);
    await expect(
      getCatalogWorkspaceRootForFilePath(`${ROOT}/missing.primer.json`)
    ).resolves.toBeNull();
    const metadata = await oligoDefinition(
      await lims.getRegistryPreview({ entityId: primer.registry.entityId })
    );
    expect(metadata.record.readOnlyReason).toBeUndefined();
    expect(metadata.record.scientific?.notation).toBe(primer.sequence.bases);
    expect(metadata.save).toBeTypeOf('function');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('waypoint:lims-registry-changed', listener);
  });

  it('does nothing for a project without primer or Registry files', async () => {
    await expect(rebuildHostedFileProjections(WORKSPACE_ID, ['notes.txt'])).resolves.toEqual({
      primers: 0,
      entities: 0,
      errors: [],
    });
  });

  it('refuses forged Registry equality receipts without altering the saved synchronization', async () => {
    const saved = await recordEntityArtifact({
      kind: 'strain',
      name: 'owned strain',
      fields: { genotypeCanonical: 'MATa his3D1' },
      workspaceRoot: ROOT,
      destinationDir: ROOT,
    });
    const receipts = await db.select<
      Array<{ workspace_key: string; synchronized_fingerprint: string }>
    >('SELECT * FROM entity_projection_sources');
    expect(receipts).toHaveLength(1);
    const valid: SettleEntityProjectionSourceInput = {
      key: {
        adapterKind: 'lims-entity',
        entityId: saved.artifact.id,
        workspaceKey: receipts[0].workspace_key,
        relativePath: saved.relativePath,
        projectionVersion: 1,
      },
      fingerprint: entityArtifactProjectionFingerprint(saved.artifact),
    };
    const settle = projectionCommands().settleEntityProjectionSource;
    for (const patch of [
      { adapterKind: 'sequence' },
      { projectionVersion: 2 },
      { entityId: 'different-entity' },
      { workspaceKey: 'workspace:99999' },
      { relativePath: `../${saved.relativePath}` },
    ])
      await expect(settle({ ...valid, key: { ...valid.key, ...patch } })).rejects.toThrow();
    await expect(settle({ ...valid, fingerprint: 'forged' })).rejects.toThrow(
      'differs from its canonical file'
    );
    const document = parseEntityArtifact(files.get(saved.artifactPath)!);
    document.name = 'changed source';
    files.set(saved.artifactPath, serializeEntityArtifact(document));
    await expect(settle(valid)).rejects.toThrow('differs from its canonical file');
    expect(await db.select('SELECT * FROM entity_projection_sources')).toEqual(receipts);
  });

  it('refuses a changed source or frozen schema before recording Registry equality', async () => {
    const saved = await recordEntityArtifact({
      kind: 'strain',
      name: 'stable strain',
      fields: { genotypeCanonical: 'MATa his3D1' },
      workspaceRoot: ROOT,
      destinationDir: ROOT,
    });
    const [receipt] = await db.select<Array<{ workspace_key: string }>>(
      'SELECT * FROM entity_projection_sources'
    );
    const input: SettleEntityProjectionSourceInput = {
      key: {
        adapterKind: 'lims-entity',
        entityId: saved.artifact.id,
        workspaceKey: receipt.workspace_key,
        relativePath: saved.relativePath,
        projectionVersion: 1,
      },
      fingerprint: entityArtifactProjectionFingerprint(saved.artifact),
    };
    await db.execute('DELETE FROM entity_projection_sources');
    const content = files.get(saved.artifactPath)!;
    const read = vi.spyOn(fs, 'readTextFile');
    read.mockResolvedValueOnce(content).mockResolvedValueOnce(`${content}\n`);
    await expect(projectionCommands().settleEntityProjectionSource(input)).rejects.toThrow(
      'source changed'
    );
    read.mockRestore();
    const preview = await lims.getRegistryPreview({ entityId: saved.artifact.id });
    preview.schemaSnapshot.fields[0].label = 'Different frozen definition';
    await expect(projectionCommands().settleEntityProjectionSource(input)).rejects.toThrow(
      'differs from its canonical file'
    );
    expect(await db.select('SELECT * FROM entity_projection_sources')).toEqual([]);
  });
});
