import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockData, setMockFileContent } from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import {
  createNotebookArtifactFile,
  resolveArtifactFile,
  planWorkspaceArtifactRepair,
} from './workspace-artifacts';
import {
  getCatalogFilesForEntity,
  resolveWorkspaceScope,
  registerCatalogEntity,
} from './workspace-catalog';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { platform } from '../platform';

const NOTEBOOK = (id: string, title: string) =>
  JSON.stringify({
    schema: 'waypoint.notebook.v1',
    kind: 'notebook',
    id,
    title,
    content: { type: 'doc', content: [] },
  });

async function upsertPagesRow(id: string, title: string): Promise<void> {
  const now = Date.now();
  const existing = await platform().db.select<{ id: string }[]>(
    'SELECT id FROM pages WHERE id = ?',
    [id]
  );
  if (existing.length > 0) {
    await platform().db.execute(
      'UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?',
      [title, JSON.stringify({ type: 'doc', content: [] }), now, id]
    );
  } else {
    await platform().db.execute(
      'INSERT INTO pages (id, title, content, date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, title, JSON.stringify({ type: 'doc', content: [] }), null, now, now]
    );
  }
}

describe('workspace-scoped catalog identity', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });
  afterEach(() => vi.restoreAllMocks());

  it('the same embedded id in two workspaces resolves to TWO distinct catalog entities', async () => {
    const embeddedId = 'example-moclo-golden-gate';
    const pkgA = '/workspace-a/notebooks/MoClo';
    const pkgB = '/workspace-b/notebooks/MoClo';
    setMockFileContent(`${pkgA}/.forge/notebook.json`, NOTEBOOK(embeddedId, 'MoClo'));
    setMockFileContent(`${pkgB}/.forge/notebook.json`, NOTEBOOK(embeddedId, 'MoClo'));

    const a = await resolveArtifactFile({ path: pkgA, workspaceRoot: '/workspace-a' });
    const b = await resolveArtifactFile({ path: pkgB, workspaceRoot: '/workspace-b' });

    expect(a.entity.id).not.toBe(b.entity.id);

    const filesA = await getCatalogFilesForEntity(a.entity.id);
    const filesB = await getCatalogFilesForEntity(b.entity.id);
    expect(filesA.map((f) => f.path)).toEqual([pkgA]);
    expect(filesB.map((f) => f.path)).toEqual([pkgB]);
    expect(filesA.every((f) => f.status === 'current')).toBe(true);
    expect(filesB.every((f) => f.status === 'current')).toBe(true);

    const entities = await platform().db.select<{ id: string }[]>(
      'SELECT id FROM catalog_entities'
    );
    expect(entities.length).toBe(2);
  });

  it('a single workspace still yields exactly one entity (no gratuitous duplication)', async () => {
    const pkg = '/solo/notebooks/MoClo';
    setMockFileContent(
      `${pkg}/.forge/notebook.json`,
      NOTEBOOK('example-moclo-golden-gate', 'MoClo')
    );

    await resolveArtifactFile({ path: pkg, workspaceRoot: '/solo' });
    await resolveArtifactFile({ path: pkg, workspaceRoot: '/solo' });

    const entities = await platform().db.select<{ id: string }[]>(
      'SELECT id FROM catalog_entities'
    );
    expect(entities.length).toBe(1);
  });

  it('reconcile and repair derive the IDENTICAL scoped id as the canonical rule', async () => {
    const embeddedId = 'nb-parity';
    const pkg = '/wsp/notebooks/Nb';
    setMockFileContent(`${pkg}/.forge/notebook.json`, NOTEBOOK(embeddedId, 'Nb'));

    const canonical = scopedProjectionId(await resolveWorkspaceScope('/wsp'), embeddedId);
    const reconciled = await resolveArtifactFile({ path: pkg, workspaceRoot: '/wsp' });
    const plan = await planWorkspaceArtifactRepair({ path: pkg, workspaceRoot: '/wsp' });

    expect(canonical).toMatch(/::nb-parity$/);
    expect(reconciled.entity.id).toBe(canonical);
    expect(plan.entityId).toBe(canonical);
  });

  it('createNotebookArtifactFile + pages upsert keep pages.id === catalog entity id', async () => {
    const workspaceRoot = '/create-ws';
    const scope = await resolveWorkspaceScope(workspaceRoot);
    const pageId = scopedProjectionId(scope, 'create-nb-uuid');

    await upsertPagesRow(pageId, 'Created');
    await registerCatalogEntity({
      id: pageId,
      type: 'notebook',
      name: 'Created',
      locator: `entity://page/${pageId}`,
      storageType: 'database',
      workspaceRoot,
    });
    const created = await createNotebookArtifactFile({
      entityId: pageId,
      pageId,
      title: 'Created',
      content: { type: 'doc', content: [] },
      workspaceRoot,
      fileName: 'Created',
      context: {
        targetPath: workspaceRoot,
        targetKind: 'folder',
        parentPath: workspaceRoot,
        workspaceRoot,
      },
    });
    expect(created).not.toBeNull();

    const resolved = await resolveArtifactFile({
      path: created!.path,
      workspaceRoot,
    });
    expect(resolved.entity.id).toBe(pageId);
    expect(resolved.artifact.id).toBe('create-nb-uuid');

    const pages = await platform().db.select<{ id: string }[]>('SELECT id FROM pages');
    expect(pages.map((p) => p.id)).toEqual([pageId]);
    expect(pages[0].id).toBe(resolved.entity.id);
  });

  it('file-open path: upserting under entity.id keeps pages.id === catalog_entities.id', async () => {
    const embeddedId = 'open-nb-uuid';
    const workspaceRoot = '/open-ws';
    const pkg = `${workspaceRoot}/notebooks/OpenMe`;
    setMockFileContent(`${pkg}/.forge/notebook.json`, NOTEBOOK(embeddedId, 'OpenMe'));

    const resolved = await resolveArtifactFile({ path: pkg, workspaceRoot });
    expect(resolved.entity.id).toContain('::');
    expect(resolved.artifact.id).toBe(embeddedId);
    expect(resolved.entity.id).not.toBe(resolved.artifact.id);

    await upsertPagesRow(resolved.entity.id, resolved.artifact.title ?? 'OpenMe');

    const pages = await platform().db.select<{ id: string }[]>('SELECT id FROM pages ORDER BY id');
    expect(pages.map((p) => p.id)).toEqual([resolved.entity.id]);
    expect(pages.some((p) => p.id === embeddedId)).toBe(false);
  });

  it('cross-workspace copy of the same notebook file yields two scoped projections', async () => {
    const embeddedId = 'copied-nb';
    const pkgA = '/copy-a/notebooks/Shared';
    const pkgB = '/copy-b/notebooks/Shared';
    setMockFileContent(`${pkgA}/.forge/notebook.json`, NOTEBOOK(embeddedId, 'Shared'));
    setMockFileContent(`${pkgB}/.forge/notebook.json`, NOTEBOOK(embeddedId, 'Shared'));

    const a = await resolveArtifactFile({ path: pkgA, workspaceRoot: '/copy-a' });
    const b = await resolveArtifactFile({ path: pkgB, workspaceRoot: '/copy-b' });

    expect(a.artifact.id).toBe(embeddedId);
    expect(b.artifact.id).toBe(embeddedId);
    expect(a.entity.id).toBe(
      scopedProjectionId(await resolveWorkspaceScope('/copy-a'), embeddedId)
    );
    expect(b.entity.id).toBe(
      scopedProjectionId(await resolveWorkspaceScope('/copy-b'), embeddedId)
    );
    expect(a.entity.id).not.toBe(b.entity.id);
  });

  it('resolveWorkspaceScope agrees with workspaceScopeKey for managed and fallback scopes', async () => {
    const scope = await resolveWorkspaceScope('/scope-agree');
    const rows = await platform().db.select<{ id: number; repo_uuid: string | null }[]>(
      'SELECT id, repo_uuid FROM workspaces WHERE path = ?',
      ['/scope-agree']
    );
    expect(rows).toHaveLength(1);
    expect(scope).toBe(workspaceScopeKey(rows[0].repo_uuid, rows[0].id));
  });
});
