// @vitest-environment node

import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineScientificFile } from '@waypoint/scientific-objects';
import {
  defineBlob,
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
  type Result,
} from '@waypoint/workspace-revisions';
import { serializeSequencePackageDocument } from '../db/sequence-package';
import { serializeTableSnapshot } from '../shared/table-package';
import { trackViewFixture } from '../shared/track-view-fixture';
import {
  flatDocuments,
  genbank,
  primer,
  recordFixture,
  referenceId,
  writeJson,
  writeNotebookDocumentFixture,
  writeSequenceDocumentFixture,
  writeTableDocumentFixture,
} from './__tests__/portable-document-fixtures';
import { createTestDb } from './__tests__/test-db';
import { createDocumentOpenSource } from './document-open-source';
import { listTrackViewReferences } from './features/reference-assets';
import { registerLimsEntityInDb, repairLimsEntityProjectionFromAuditInDb } from './lims';
import { inspectPortableDocument, type PortableDocumentKind } from './portable-document-open-check';
import { ensureSchema } from './schema';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { ScientificObjectStore } from './scientific-object-store';
import { newScientificSequencePackagePublication } from './scientific-sequence-package';
import { legacySequenceMetadataTransactionPath } from './sequence-package-legacy-metadata-journal';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test' } }));
vi.mock('./features/reference-assets', () => ({ listTrackViewReferences: vi.fn() }));

let db: ReturnType<typeof createTestDb>;
let root: string;
let workspaceId: number;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'portable-document-open-')));
  db = createTestDb();
  ensureSchema(db, ':memory:');
  workspaceId = Number(
    db
      .prepare('INSERT INTO workspaces (name,path,created_at,last_opened_at) VALUES (?, ?, 1, 1)')
      .run('Fixture', root).lastInsertRowid
  );
  vi.mocked(listTrackViewReferences).mockResolvedValue([
    {
      id: referenceId,
      assetCacheKey: referenceId,
      name: 'Synthetic reference',
      organism: '',
      description: '',
      members: [{ chrom: 'pUC19', lengthBp: 2686 }],
    },
  ]);
});

afterEach(async () => {
  vi.resetAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
});

function captures(path: string) {
  return createDocumentOpenSource(db, root, path, root);
}

function required<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function inspect(kind: PortableDocumentKind, path: string) {
  const capture = captures(path);
  const result = await inspectPortableDocument(kind, capture.forPath(path));
  return { result, revision: await capture.verifyCurrent(), paths: capture.paths() };
}

describe.each(flatDocuments)('$path', ({ kind, path: relativePath, fixture, broken, newer }) => {
  it('checks the normal reader and keeps the exact saved bytes', async () => {
    const path = join(root, relativePath);
    await writeJson(path, await fixture(root, path));
    const bytes = await readFile(path);
    await expect(inspect(kind, path)).resolves.toMatchObject({ paths: [path] });
    expect(await readFile(path)).toEqual(bytes);
  });

  it('distinguishes broken contents, truncated JSON, a foreign format, and a newer format', async () => {
    const path = join(root, relativePath);
    const valid = await fixture(root, path);
    await writeJson(path, { ...valid, ...broken });
    await expect(inspect(kind, path)).rejects.toMatchObject({
      code: 'malformed',
      recognized: true,
    });
    await writeFile(path, '{');
    await expect(inspect(kind, path)).rejects.toMatchObject({
      code: 'malformed',
      recognized: false,
    });
    await writeJson(path, { schema: 'other-format.v1' });
    await expect(inspect(kind, path)).rejects.toMatchObject({
      code: 'unsupported-format',
      recognized: false,
    });
    await writeJson(path, { ...valid, ...newer });
    await expect(inspect(kind, path)).rejects.toMatchObject({
      code: 'newer-format',
      recognized: true,
    });
  });
});

describe('required package files', () => {
  it('rejects a design when its embedded content belongs to a different ID', async () => {
    const design = flatDocuments.find(({ kind }) => kind === 'design');
    if (!design) throw new Error('Missing design fixture.');
    const path = join(root, design.path);
    await writeJson(path, { ...(await design.fixture(root, path)), id: 'different-id' });
    await expect(inspect('design', path)).rejects.toMatchObject({
      code: 'malformed',
      recognized: true,
    });
  });

  it('requires the notebook Markdown and exact referenced blocks', async () => {
    const { paths, payloadPath, payload } = await writeNotebookDocumentFixture(root);
    const first = await inspect('notebook', paths.metaPath);
    expect(first.paths).toEqual([paths.metaPath, paths.markdownPath, payloadPath]);
    await writeFile(payloadPath, '{}');
    await expect(inspect('notebook', paths.metaPath)).rejects.toMatchObject({ code: 'malformed' });
    await rm(payloadPath);
    await expect(inspect('notebook', paths.metaPath)).rejects.toMatchObject({
      code: 'missing-asset',
    });
    await writeFile(payloadPath, payload.content);
    await rm(paths.markdownPath);
    await expect(inspect('notebook', paths.metaPath)).rejects.toMatchObject({
      code: 'missing-asset',
    });
  });

  it('reports a newer notebook package version before reading its assets', async () => {
    const { paths, metadata } = await writeNotebookDocumentFixture(root);
    await writeJson(paths.metaPath, { ...metadata, formatVersion: 90 });
    await rm(paths.markdownPath);
    await expect(inspect('notebook', paths.metaPath)).rejects.toMatchObject({
      code: 'newer-format',
    });
  });

  it('blocks both notebook layouts when the normal opener cannot update the page projection', async () => {
    const { paths } = await writeNotebookDocumentFixture(root);
    const notebook = flatDocuments.find(({ kind }) => kind === 'notebook');
    if (!notebook) throw new Error('Missing flat notebook fixture.');
    const flatPath = join(root, notebook.path);
    await writeJson(flatPath, await notebook.fixture(root, flatPath));
    const packageCapture = captures(paths.metaPath);
    const flatCapture = captures(flatPath);
    await inspectPortableDocument('notebook', packageCapture.forPath(paths.metaPath));
    await inspectPortableDocument('notebook', flatCapture.forPath(flatPath));
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(workspaceId);
    await expect(packageCapture.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
    await expect(flatCapture.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
    for (const path of [paths.metaPath, flatPath]) {
      await expect(inspect('notebook', path)).rejects.toMatchObject({
        code: 'permission',
        recognized: true,
      });
    }
  });

  it('blocks a complete design whose file binding cannot be reconciled in a reference project', async () => {
    const design = flatDocuments.find(({ kind }) => kind === 'design');
    if (!design) throw new Error('Missing design fixture.');
    const path = join(root, design.path);
    await writeJson(path, await design.fixture(root, path));
    const capture = captures(path);
    await inspectPortableDocument('design', capture.forPath(path));
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(workspaceId);
    await expect(capture.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
    await expect(inspect('design', path)).rejects.toMatchObject({
      code: 'permission',
      recognized: true,
    });
    db.prepare("UPDATE workspaces SET access_mode='writable',archived_at=1 WHERE id=?").run(
      workspaceId
    );
    await expect(inspect('design', path)).rejects.toMatchObject({
      code: 'project',
      recognized: true,
    });
  });

  it('requires readable GenBank and records the effective product file', async () => {
    const { packageRoot, paths, metadata } = await writeSequenceDocumentFixture(root);
    const fallback = join(packageRoot, 'Renamed.gbk');
    await expect(inspect('sequence-package', paths.metaPath)).resolves.toMatchObject({
      result: {
        documentId: metadata.id,
        name: metadata.name,
        productPath: paths.productPath,
        schemaName: metadata.entity.schema.name,
      },
    });
    await rename(paths.productPath, fallback);
    await expect(inspect('sequence-package', paths.metaPath)).resolves.toMatchObject({
      result: { productPath: fallback },
    });
    await writeFile(join(packageRoot, 'Second.gb'), genbank);
    await expect(inspect('sequence-package', paths.metaPath)).rejects.toMatchObject({
      code: 'malformed',
    });
    await rm(join(packageRoot, 'Second.gb'));
    await writeFile(fallback, 'not GenBank');
    await expect(inspect('sequence-package', paths.metaPath)).rejects.toMatchObject({
      code: 'malformed',
    });
    await rm(fallback);
    await expect(inspect('sequence-package', paths.metaPath)).rejects.toMatchObject({
      code: 'missing-asset',
    });
  });

  it('can read a legacy sequence package without migrating the original files', async () => {
    const { packageRoot, paths, metadata } = await writeSequenceDocumentFixture(root);
    await writeJson(paths.metaPath, {
      ...metadata,
      schema: 'waypoint.plasmid.v1',
      kind: 'plasmid',
      formatVersion: undefined,
    });
    const bytes = await readFile(paths.metaPath);
    const entries = await readdir(packageRoot);
    const legacy = await inspect('sequence-package', paths.metaPath);
    expect(legacy.result).toMatchObject({
      documentId: metadata.id,
      productPath: paths.productPath,
    });
    expect(legacy.paths).toContain(legacySequenceMetadataTransactionPath(packageRoot));
    expect(await readFile(paths.metaPath)).toEqual(bytes);
    expect(await readdir(packageRoot)).toEqual(entries);
    await writeJson(paths.metaPath, { ...metadata, formatVersion: 90 });
    await expect(inspect('sequence-package', paths.metaPath)).rejects.toMatchObject({
      code: 'newer-format',
    });
  });

  it('pins both accepted sequence assets and rejects a changed accepted product with unchanged files', async () => {
    const { packageRoot, paths, metadata } = await writeSequenceDocumentFixture(root);
    const store = new ScientificObjectStore(db, workspaceId);
    const representation = { format: 'genbank-v1', text: genbank } as const;
    const productBytes = Buffer.from(genbank);
    const resourceId = required(parseResourceId(metadata.id));
    const productPath = `${basename(packageRoot)}/${basename(paths.productPath)}`;
    const marker = newScientificSequencePackagePublication({
      resourceId,
      path: productPath,
      representation,
      sequencePackageText: serializeSequencePackageDocument({
        ...metadata,
        product: { ...metadata.product, genBankChecksum: defineBlob(productBytes).hash },
      }),
    });
    expect(
      store.submit({
        operationId: required(parseOperationId('initial-package')),
        expectedHead: null,
        blobs: [productBytes, ...marker.blobs],
        mutations: [
          {
            kind: 'create-resource',
            path: required(parseWorkspacePath(productPath)),
            resourceId,
            origin: { kind: 'created' },
            state: defineScientificFile({ representation }, scientificNativeCodecs).state,
          },
          ...marker.mutations,
        ],
      }).kind
    ).toBe('changed');

    await writeFile(paths.metaPath, 'stale working marker');
    await writeFile(paths.productPath, 'stale working product');
    const checked = captures(paths.metaPath);
    await expect(
      inspectPortableDocument('sequence-package', checked.forPath(paths.metaPath))
    ).resolves.toMatchObject({ productPath: paths.productPath });
    const before = await checked.verifyCurrent();
    const current = store.read();
    const nextText = genbank.replace('acgttgca', 'agtccgtt');
    expect(
      store.submit({
        operationId: required(parseOperationId('replace-product-without-marker')),
        expectedHead: current.head,
        blobs: [Buffer.from(nextText)],
        mutations: [
          {
            kind: 'edit-resource',
            resourceId,
            expectedRevision: current.reader.current(resourceId)!.revisionId,
            state: defineScientificFile(
              { representation: { ...representation, text: nextText } },
              scientificNativeCodecs
            ).state,
          },
        ],
      }).kind
    ).toBe('changed');
    expect(before).toMatch(/^[0-9a-f]{64}$/u);
    await expect(checked.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
    await expect(inspect('sequence-package', paths.metaPath)).rejects.toMatchObject({
      code: 'project',
    });
    expect(await readFile(paths.metaPath, 'utf8')).toBe('stale working marker');
    expect(await readFile(paths.productPath, 'utf8')).toBe('stale working product');
  });

  it('verifies the exact immutable table snapshot instead of accepting the embedded preview', async () => {
    const { paths, snapshotPath, snapshot, head } = await writeTableDocumentFixture(root);
    await expect(inspect('table-package', paths.headPath)).resolves.toMatchObject({
      paths: [paths.headPath, snapshotPath],
    });
    await writeFile(
      snapshotPath,
      serializeTableSnapshot({ ...snapshot, title: 'Different bytes' })
    );
    await expect(inspect('table-package', paths.headPath)).rejects.toMatchObject({
      code: 'malformed',
    });
    await rm(snapshotPath);
    await expect(inspect('table-package', paths.headPath)).rejects.toMatchObject({
      code: 'missing-asset',
    });
    await writeJson(paths.headPath, { ...head, schema: 'dnaforge.table.v2' });
    await expect(inspect('table-package', paths.headPath)).rejects.toMatchObject({
      code: 'newer-format',
    });
  });

  it('does not reuse a verified result after a companion file changes', async () => {
    const { paths, snapshotPath } = await writeTableDocumentFixture(root);
    const state = captures(paths.headPath);
    await inspectPortableDocument('table-package', state.forPath(paths.headPath));
    await expect(state.verifyCurrent()).resolves.toMatch(/^[a-f0-9]{64}$/);
    await writeFile(snapshotPath, '{}');
    await expect(state.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
  });

  it('leaves a pending promotion unavailable even when the exact snapshot is intact', async () => {
    const { head, paths } = await writeTableDocumentFixture(root);
    await writeJson(paths.headPath, {
      ...head,
      status: 'pending-promotion',
      promotionId: 'a35e20e0-7e41-4a0c-b70e-f1599368530b',
    });
    await expect(inspect('table-package', paths.headPath)).rejects.toMatchObject({
      code: 'unknown',
      recognized: true,
    });
  });
});

describe('legacy Registry records', () => {
  async function legacyRecord() {
    const filename = 'Legacy.entity.json';
    const {
      schemaRevisionId,
      schemaSnapshot,
      archived: _archived,
      ...current
    } = recordFixture(filename);
    const document = {
      ...current,
      schema: 'waypoint.entity.v1',
      fields: {
        ...current.fields,
        artifact: { schema: 'waypoint.entity.v1', relativePath: filename },
      },
    };
    const path = await writeJson(join(root, filename), document);
    const project = () =>
      registerLimsEntityInDb(db, {
        id: document.id,
        kind: document.kind,
        name: document.name,
        fields: document.fields,
        registrationStatus: document.registrationStatus,
        domainStatus: document.domainStatus,
        schemaRevisionId,
        schemaSnapshot,
        workspaceId,
      });
    return { path, document, project, schemaSnapshot };
  }

  it('rejects a correct v1 file if the owning Registry has no frozen authority for its record', async () => {
    const { path, document } = await legacyRecord();
    const before = await readFile(path, 'utf8');
    await expect(inspect('entity', path)).rejects.toMatchObject({
      code: 'project',
      recognized: true,
    });
    expect(db.prepare('SELECT id FROM lims_entity WHERE id=?').get(document.id)).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('uses verified audit to prove a missing projection can be repaired, without writing during inspection', async () => {
    const { path, document, project, schemaSnapshot } = await legacyRecord();
    project();
    const initial = await inspect('entity', path);
    const storedRecord = db.prepare('SELECT * FROM lims_entity WHERE id=?').get(document.id);
    db.prepare('DELETE FROM lims_entity WHERE id=?').run(document.id);
    db.prepare('DELETE FROM lims_schema_revision WHERE id=?').run(schemaSnapshot.schemaRevisionId);
    const history = db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    const bytes = await readFile(path);
    const audited = await inspect('entity', path);
    expect(audited.paths).toContain(path);
    expect(db.prepare('SELECT id FROM lims_entity WHERE id=?').get(document.id)).toBeUndefined();
    expect(
      db
        .prepare('SELECT id FROM lims_schema_revision WHERE id=?')
        .get(schemaSnapshot.schemaRevisionId)
    ).toBeUndefined();
    expect(db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(history);
    expect(await readFile(path)).toEqual(bytes);

    expect(repairLimsEntityProjectionFromAuditInDb(db, document.id)).toBe(true);
    expect(db.prepare('SELECT * FROM lims_entity WHERE id=?').get(document.id)).toEqual(
      storedRecord
    );
    expect((await inspect('entity', path)).revision).toBe(initial.revision);
  });

  it('keeps an audit verification failure distinct from damaged record bytes', async () => {
    const { path, document, project } = await legacyRecord();
    project();
    db.prepare('DELETE FROM lims_entity WHERE id=?').run(document.id);
    const capture = captures(path);
    await inspectPortableDocument('entity', capture.forPath(path));
    db.prepare("UPDATE lims_audit SET actor='unverified change' WHERE subject_id=?").run(
      document.id
    );
    await expect(capture.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
    await expect(inspect('entity', path)).rejects.toMatchObject({
      code: 'unknown',
      recognized: true,
    });
    expect(db.prepare('SELECT id FROM lims_entity WHERE id=?').get(document.id)).toBeUndefined();
  });
});

it('requires the renderer to verify the exact draft named by a legacy design pointer', async () => {
  const path = join(root, 'Legacy.wpdesign.json');
  const marker = {
    schema: 'waypoint.design.v1',
    kind: 'assembly-design',
    id: 'old-project::draft-1',
    storage: { type: 'localStorage', key: 'waypoint-designs', id: 'draft-1' },
    design: null,
  };
  await writeJson(path, marker);
  await expect(inspect('design', path)).resolves.toMatchObject({
    result: { kind: 'design-draft', designId: 'draft-1' },
  });
  await writeJson(path, { ...marker, design: undefined });
  await expect(inspect('design', path)).resolves.toMatchObject({
    result: { kind: 'design-draft', designId: 'draft-1' },
  });
  await writeJson(path, { ...marker, design: 'corrupt' });
  await expect(inspect('design', path)).rejects.toMatchObject({ code: 'malformed' });
  await writeJson(path, { ...marker, storage: { ...marker.storage, id: 'different-draft' } });
  await expect(inspect('design', path)).rejects.toMatchObject({ code: 'missing-asset' });
});

it('rejects legacy draft recovery when the exact file is catalogued under a different design', async () => {
  const path = await writeJson(join(root, 'Legacy.wpdesign.json'), {
    schema: 'waypoint.design.v1',
    kind: 'assembly-design',
    id: 'draft-1',
    storage: { type: 'localStorage', key: 'waypoint-designs', id: 'draft-1' },
    design: null,
  });
  const capture = captures(path);
  await expect(inspectPortableDocument('design', capture.forPath(path))).resolves.toMatchObject({
    kind: 'design-draft',
    designId: 'draft-1',
  });
  db.prepare(
    `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
      VALUES ('different-draft','design','Different','entity://design/different-draft','localStorage',?,1,1)`
  ).run(workspaceId);
  db.prepare(
    `INSERT INTO catalog_entity_files
      (id,entity_id,workspace_id,path,file_kind,created_at,updated_at)
      VALUES ('another-file','different-draft',?,?,'waypoint-design',1,1)`
  ).run(workspaceId, path);
  await expect(capture.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
  await expect(inspect('design', path)).rejects.toMatchObject({ code: 'project' });
});

it('distinguishes an unavailable required reference from a failed reference service', async () => {
  const path = await writeJson(join(root, 'Example.dnaforge-track-view.json'), trackViewFixture());
  vi.mocked(listTrackViewReferences).mockResolvedValue([]);
  await expect(inspect('track-view', path)).rejects.toMatchObject({
    code: 'missing-asset',
    recognized: true,
  });
  vi.mocked(listTrackViewReferences).mockRejectedValue(new Error('fixture runtime failure'));
  await expect(inspect('track-view', path)).rejects.toMatchObject({
    code: 'runtime',
    recognized: true,
  });
});

it('requires the saved reference rather than a replacement with the same identifier', async () => {
  const path = await writeJson(join(root, 'Example.dnaforge-track-view.json'), trackViewFixture());
  vi.mocked(listTrackViewReferences).mockResolvedValue([
    {
      id: referenceId,
      assetCacheKey: referenceId,
      name: 'Changed reference',
      organism: '',
      description: '',
      members: [{ chrom: 'pUC19', lengthBp: 12 }],
    },
  ]);
  await expect(inspect('track-view', path)).rejects.toMatchObject({
    code: 'missing-asset',
    recognized: true,
  });
});

it('follows the normal track view reader policy for a symlink inside the project', async () => {
  const path = await writeJson(join(root, 'Example.dnaforge-track-view.json'), trackViewFixture());
  const link = join(root, 'Alias.dnaforge-track-view.json');
  await symlink(path, link);
  await expect(inspect('track-view', link)).rejects.toMatchObject({ code: 'permission' });
});

it('uses the current project to check a primer, including its manifest location', async () => {
  const path = join(root, 'Example.primer.json');
  await writeJson(path, await primer(root, path));
  const renamed = join(root, 'Other.primer.json');
  await rename(path, renamed);
  await expect(inspect('primer', renamed)).rejects.toMatchObject({
    code: 'malformed',
    recognized: true,
  });
  db.prepare('UPDATE workspaces SET archived_at=2 WHERE path=?').run(root);
  await expect(inspect('primer', renamed)).rejects.toMatchObject({ code: 'project' });
});

it('keeps denied paths, invalid encoding, a vanished file, and a size limit distinct', async () => {
  const path = await writeJson(join(root, 'Example.dnaforge-track-view.json'), trackViewFixture());
  await truncate(path, 4 * 1024 * 1024 + 1);
  await expect(inspect('track-view', path)).rejects.toMatchObject({ code: 'too-large' });
  await writeFile(path, Buffer.from([0xff, 0xfe, 0xfd]));
  await expect(inspect('track-view', path)).rejects.toMatchObject({
    code: 'malformed',
    recognized: false,
  });
  await rm(path);
  await expect(inspect('track-view', path)).rejects.toMatchObject({ code: 'missing' });
  const outsideRoot = await mkdtemp(join(tmpdir(), 'portable-document-outside-'));
  try {
    const outside = await writeJson(
      join(outsideRoot, 'Valid.dnaforge-track-view.json'),
      trackViewFixture()
    );
    await symlink(outside, path);
    await expect(inspect('track-view', path)).rejects.toMatchObject({ code: 'permission' });
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
