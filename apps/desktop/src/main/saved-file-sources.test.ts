// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeCatalogDatabase } from './native-catalog-repository';
import { MolecularDocumentLibrary } from './molecular-document-library';
import { molecularDocumentFixture } from '../test/fixtures/molecular-documents';
import { TrackViewLibrary } from './track-view-library';
import { trackViewFixture } from '../shared/track-view-fixture';
import {
  captureSavedFileSource,
  prepareSavedFileSource,
  recordSavedFilePublicationWitness,
  recoverPendingSavedFileSources,
  listSavedFileVersions,
  restoreSavedFileSource,
} from './saved-file-sources';
import { createNativeWorkspaceCommands } from './native-workspace-commands';
import { runSavedFileSourceCommand } from './saved-file-source-command';
import { writeWithBoundFileRetention } from './saved-file-publication';
import { registerAdmittedProjectRoot } from './admitted-project-roots';
import { receiveWorkspaceSyncBlob } from './workspace-sync-blob-cache';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
let profile: ReturnType<typeof createFileTestDb>, root: string;
beforeEach(async () => {
  profile = createFileTestDb('retained-source');
  root = join(profile.tmpDir, 'project');
  await mkdir(root);
  ensureSchema(profile.db, profile.dbPath);
  profile.db
    .prepare("INSERT INTO workspaces(id,path,name,created_at) VALUES(1,?,'Test project',1)")
    .run(root);
  registerAdmittedProjectRoot(root);
});
afterEach(() => {
  profile.cleanup();
});
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const store = { db: () => profile.db };
const native = () =>
  createNativeWorkspaceCommands({
    db: () => profile.db,
    readableRoots: () => [root],
    writableRoots: () => [root],
    captureWorkspace: () => () => {},
    assertFileSaved: async () => {},
  });

describe('native retained source recovery', () => {
  it('recovers every published molecular document and personal Track view revision after working files are moved or removed', async () => {
    const mol = await molecularDocumentFixture();
    const { MOLECULAR_DOCUMENT_SUFFIX } = await import('../shared/molecular-document');
    const target = { workspaceRoot: root, path: join(root, 'one' + MOLECULAR_DOCUMENT_SUFFIX) };
    const molecules = new MolecularDocumentLibrary(store);
    const first = await molecules.save({
      document: mol,
      destination: target,
      expectedRevision: null,
    });
    const before = await readFile(target.path);
    await molecules.save({
      document: { ...mol, name: 'Second name' },
      destination: target,
      expectedRevision: first.revision,
    });
    const after = await readFile(target.path);
    await rename(target.path, join(root, 'external-move'));
    const entityId = 'ws1::' + mol.id.split('::').at(-1);
    const commands = native();
    const result = await commands.savedFileSource({
      project: 'Test project',
      operation: { kind: 'versions', entityId },
    });
    if (!('versions' in result)) throw new Error('Missing versions');
    expect(result.versions).toHaveLength(2);
    for (const [idx, bytes] of [after, before].entries()) {
      const rel = 'restored-' + idx + MOLECULAR_DOCUMENT_SUFFIX;
      await commands.savedFileSource({
        project: 'Test project',
        operation: {
          kind: 'restore',
          entityId,
          revisionId: result.versions[idx].id,
          destination: rel,
        },
      });
      expect(await readFile(join(root, rel))).toEqual(bytes);
    }
    const occupied = join(root, 'occupied');
    await writeFile(occupied, 'user-created');
    await expect(
      commands.savedFileSource({
        project: 'Test project',
        operation: {
          kind: 'restore',
          entityId,
          revisionId: result.versions[0].id,
          destination: 'occupied',
        },
      })
    ).rejects.toThrow();
    expect(await readFile(occupied, 'utf8')).toBe('user-created');
    const personal = join(profile.tmpDir, 'Track views'),
      views = new TrackViewLibrary(personal, store);
    const saved = await views.save({ document: trackViewFixture(), expectedRevision: null });
    const viewOriginal = await readFile(saved.path);
    await views.save({
      document: { ...saved.document, name: 'Later' },
      expectedRevision: saved.revision,
    });
    await rm(saved.path);
    const request = {
      workspaceRoot: null,
      operation: { kind: 'versions' as const, entityId: saved.document.id },
    };
    const scoped = { workspaceId: null, root: personal, assertCurrent: () => {} };
    const versions = await runSavedFileSourceCommand(profile.db, request, scoped);
    if (!('versions' in versions)) throw new Error('Missing personal revisions');
    expect(versions.versions).toHaveLength(2);
    await runSavedFileSourceCommand(
      profile.db,
      {
        ...request,
        operation: {
          kind: 'restore',
          entityId: saved.document.id,
          revisionId: versions.versions[1].id,
          destination: 'recovered.json',
        },
      },
      scoped
    );
    expect(await readFile(join(personal, 'recovered.json'))).toEqual(viewOriginal);
  });
  it('retains catalog imports, raw replacements and appends; rejects stale candidate promotion and can recover an older verified cache blob', async () => {
    const db = profile.db,
      catalog = createNativeCatalogDatabase(db, { assertCurrent: () => {} });
    const source = join(root, 'experiment.dat'),
      binary = Buffer.from([0xff, 0, 0x9a, 1]);
    await writeFile(source, binary);
    const row = await catalog.registerWorkspaceFile({
      workspaceRoot: root,
      path: source,
      contentHash: 'sha256:' + hash(binary),
      entityType: 'file',
      fileKind: 'file',
    });
    const owner = { workspaceId: 1, entityId: row.id },
      versions = () => listSavedFileVersions(db, { ...owner, limit: 20, offset: 0 });
    expect(versions().versions).toHaveLength(1);
    await writeWithBoundFileRetention(db, { path: source, content: 'edit' }, () =>
      writeFile(source, 'edit')
    );
    await writeWithBoundFileRetention(db, { path: source, content: ' more', append: true }, () =>
      writeFile(source, ' more', { flag: 'a' })
    );
    expect(versions().versions).toHaveLength(3);
    const candidate = await prepareSavedFileSource(db, {
      ...owner,
      path: source,
      members: [{ relativePath: '', bytes: Buffer.from('never written') }],
    });
    await recoverPendingSavedFileSources(db, { workspaceId: 1 });
    expect(versions().versions.map((v) => v.id)).not.toContain(candidate.id);
    await writeFile(source, 'never written');
    await recoverPendingSavedFileSources(db, { workspaceId: 1 });
    expect(versions().versions.map((v) => v.id)).not.toContain(candidate.id);
    const staged = join(root, 'file-to-publish');
    await writeFile(staged, 'never written');
    recordSavedFilePublicationWitness(db, candidate, staged);
    await rename(staged, source);
    await recoverPendingSavedFileSources(db, { workspaceId: 1 });
    expect(versions().versions[0].id).toBe(candidate.id);
    await rm(source);
    await restoreSavedFileSource(db, {
      ...owner,
      revisionId: versions().versions.at(-1)!.id,
      destination: source,
    });
    expect(await readFile(source)).toEqual(binary);
    const legacy = 'legacy-' + row.id,
      cache = Buffer.from('known archived source');
    db.prepare(
      "INSERT INTO catalog_entities(id,workspace_id,name,type,locator,storage_type,status,created_at,updated_at) VALUES(?,1,'Legacy','file',?,'file','active',1,1)"
    ).run(legacy, 'file://' + join(root, 'legacy.dat'));
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,content_hash,status,created_at,updated_at) VALUES(?,?,1,?,'file',?,'missing',1,1)"
    ).run(legacy, legacy, join(root, 'legacy.dat'), 'sha256:' + hash(cache));
    await receiveWorkspaceSyncBlob(
      [cache],
      { sha256: hash(cache), sizeBytes: cache.length },
      { cacheRoot: join(profile.tmpDir, 'workspace-sync', 'blobs') }
    );
    const result = await native().savedFileSource({
      project: root,
      operation: { kind: 'versions', entityId: legacy },
    });
    expect('versions' in result && result.versions.length).toBe(1);
    await restoreSavedFileSource(db, {
      workspaceId: 1,
      entityId: legacy,
      destination: join(root, 'from-cache'),
    });
    expect(await readFile(join(root, 'from-cache'))).toEqual(cache);
  });
  it('restores complete independent directories and rejects a damaged retained blob', async () => {
    const source = join(root, 'package');
    await mkdir(join(source, 'assets'), { recursive: true });
    await mkdir(join(source, 'empty'));
    await writeFile(join(source, 'doc.json'), '{}');
    await writeFile(join(source, 'assets', 'attachment.bin'), Buffer.alloc(2_600_000, 0xa4));
    const owner = { workspaceId: 1, entityId: 'package-id' };
    await captureSavedFileSource(profile.db, { ...owner, path: source });
    await rm(source, { recursive: true });
    const destination = join(root, 'restored');
    await restoreSavedFileSource(profile.db, { ...owner, destination });
    expect((await stat(join(destination, 'empty'))).isDirectory()).toBe(true);
    expect(hash(await readFile(join(destination, 'assets', 'attachment.bin')))).toBe(
      hash(Buffer.alloc(2_600_000, 0xa4))
    );
    const sha = hash('{}'),
      blob = join(profile.tmpDir, 'retained-file-blobs', sha.slice(0, 2), sha);
    await rm(blob);
    await writeFile(blob, 'damaged');
    await expect(
      restoreSavedFileSource(profile.db, { ...owner, destination: join(root, 'wrong') })
    ).rejects.toThrow();
    await expect(stat(join(root, 'wrong'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
