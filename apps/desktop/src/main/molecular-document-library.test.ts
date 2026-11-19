import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MolecularDocumentLibrary } from './molecular-document-library';
import { molecularDocumentFixture } from '../test/fixtures/molecular-documents';
import {
  MOLECULAR_DOCUMENT_SCHEMA,
  serializeMolecularDocument,
} from '../shared/molecular-document';
import { coordinateDigest } from '../shared/molecular-view';
import legacyV1 from '../test/fixtures/molecular-document-v1.json';
import {
  appendSavedResidueSelectionRevision,
  createSavedResidueSelectionDocument,
} from '@waypoint/workspace-editor/saved-residue-selection';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function destination() {
  const root = await mkdtemp(join(tmpdir(), 'molecular-document-test-'));
  roots.push(root);
  return { workspaceRoot: root, path: join(root, 'views', 'Pocket.dnaforge-molecular.json') };
}

describe('native molecular document file authority', () => {
  it('keeps a scene with an unsupported viewer format out of open and save', async () => {
    const target = await destination();
    await mkdir(join(target.workspaceRoot, 'views'));
    const document = await molecularDocumentFixture();
    const snapshot = document.history[0].snapshot;
    const scene = JSON.parse(snapshot.scene);
    scene.metadata.version = '99';
    snapshot.scene = JSON.stringify(scene);
    const bytes = serializeMolecularDocument(document);
    await writeFile(target.path, bytes);
    const library = new MolecularDocumentLibrary();

    await expect(library.read(target)).rejects.toThrow(/supports MolViewSpec major version/);
    expect(await readFile(target.path, 'utf8')).toBe(bytes);

    const newTarget = {
      ...target,
      path: join(target.workspaceRoot, 'New.dnaforge-molecular.json'),
    };
    await expect(
      library.save({ document, destination: newTarget, expectedRevision: null })
    ).rejects.toThrow(/supports MolViewSpec major version/);
    await expect(readFile(newTarget.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not accept a matching coordinate digest if the coordinates do not load', async () => {
    const target = await destination();
    await mkdir(join(target.workspaceRoot, 'views'));
    const document = await molecularDocumentFixture();
    const text = 'This resource contains no atomic structure.';
    document.history[0].snapshot.coordinates = {
      format: 'pdb',
      text,
      sha256: await coordinateDigest(text),
    };
    const bytes = serializeMolecularDocument(document);
    await writeFile(target.path, bytes);
    const library = new MolecularDocumentLibrary();

    await expect(library.read(target)).rejects.toThrow(/coordinate|structure/i);
    expect(await readFile(target.path, 'utf8')).toBe(bytes);
  });

  it('does not admit a valid scene description with no structure to show', async () => {
    const target = await destination();
    await mkdir(join(target.workspaceRoot, 'views'));
    const document = await molecularDocumentFixture();
    const snapshot = document.history[0].snapshot;
    const scene = JSON.parse(snapshot.scene);
    scene.root.children = [];
    snapshot.scene = JSON.stringify(scene);
    await writeFile(target.path, serializeMolecularDocument(document));

    await expect(new MolecularDocumentLibrary().read(target)).rejects.toThrow(/no structure/);
  });

  it('leaves unsupported newer documents and essential extensions untouched on native open', async () => {
    const target = await destination();
    await mkdir(join(target.workspaceRoot, 'views'));
    const library = new MolecularDocumentLibrary();
    for (const stored of [
      { ...legacyV1, schema: 'dnaforge.molecular-document.v99' },
      {
        ...legacyV1,
        schema: 'dnaforge.molecular-document.v2',
        extensions: { 'org.example.essential': { version: 1, data: {} } },
        requiredExtensions: ['org.example.essential'],
      },
    ]) {
      const bytes = JSON.stringify(stored);
      await writeFile(target.path, bytes);
      await expect(library.read(target)).rejects.toThrow(
        /MOLECULAR_DOCUMENT_(NEWER_FORMAT|UNSUPPORTED_EXTENSION)/
      );
      expect(await readFile(target.path, 'utf8')).toBe(bytes);
    }
  });

  it('leaves a v1 file untouched on open and keeps its exact original bytes before an explicit upgrade Save', async () => {
    const target = await destination();
    await mkdir(join(target.workspaceRoot, 'views'));
    const bytes = JSON.stringify(legacyV1, null, 2) + '\n';
    await writeFile(target.path, bytes);
    const library = new MolecularDocumentLibrary();
    const opened = await library.read(target);
    expect(opened.document.schema).toBe('dnaforge.molecular-document.v2');
    expect(await readFile(target.path, 'utf8')).toBe(bytes);
    const saved = await library.save({
      document: { ...opened.document, name: 'Upgraded explanation' },
      destination: target,
      expectedRevision: opened.revision,
    });
    const backup = join(
      target.workspaceRoot,
      'views',
      `.Pocket.dnaforge-molecular.json.before-${opened.revision}`
    );
    expect(await readFile(backup, 'utf8')).toBe(bytes);
    const disk = JSON.parse(await readFile(target.path, 'utf8'));
    expect(disk.schema).toBe('dnaforge.molecular-document.v2');
    expect(disk.history).toEqual(legacyV1.history);
    expect(disk.coordinateAssets).toEqual(legacyV1.coordinateAssets);
    expect((await library.read(target)).document).toEqual(saved.document);
  });

  it('preserves optional extensions through native saves and refuses a writer that drops or changes them', async () => {
    const target = await destination();
    const document = {
      ...(await molecularDocumentFixture()),
      extensions: {
        'org.example.future-feature': { version: 7, data: { retained: [1, 'two', true] } },
      },
    };
    const library = new MolecularDocumentLibrary();
    const saved = await library.save({ document, destination: target, expectedRevision: null });
    const renamed = await library.save({
      document: { ...saved.document, name: 'New name' },
      destination: target,
      expectedRevision: saved.revision,
    });
    expect((await library.read(target)).document).toMatchObject({
      extensions: document.extensions,
    });
    const bytes = await readFile(target.path, 'utf8');
    const { extensions: _extensions, ...truncated } = renamed.document as typeof document;
    for (const next of [truncated, { ...renamed.document, extensions: {} }])
      await expect(
        library.save({ document: next, destination: target, expectedRevision: renamed.revision })
      ).rejects.toThrow(/extension.*preserv|extension.*chang|extension.*remov/i);
    expect(await readFile(target.path, 'utf8')).toBe(bytes);
  });

  it('reopens a copied document with exact complete result history and pooled coordinates', async () => {
    const original = await destination();
    const document = await molecularDocumentFixture();
    const saved = await new MolecularDocumentLibrary().save({
      document,
      destination: original,
      expectedRevision: null,
    });
    const copied = await destination();
    await mkdir(join(copied.workspaceRoot, 'views'));
    await cp(original.path, copied.path);
    const reopened = await new MolecularDocumentLibrary().read(copied);
    expect(reopened.document).toEqual(document);
    expect(reopened.revision).toBe(saved.revision);
    expect(
      Object.keys(JSON.parse(await readFile(original.path, 'utf8')).coordinateAssets)
    ).toHaveLength(1);
  });

  it('checks the expected file revision and rejects history changes or another document identity', async () => {
    const target = await destination();
    const document = await molecularDocumentFixture();
    const library = new MolecularDocumentLibrary();
    const saved = await library.save({ document, destination: target, expectedRevision: null });
    const updated = await library.save({
      document: { ...document, name: 'Renamed explanation' },
      destination: target,
      expectedRevision: saved.revision,
    });
    await expect(
      library.save({
        document,
        destination: target,
        expectedRevision: saved.revision,
      })
    ).rejects.toThrow(/changed|revision/i);
    await expect(
      library.save({
        document: { ...document, id: '55555555-5555-4555-8555-555555555555' },
        destination: target,
        expectedRevision: updated.revision,
      })
    ).rejects.toThrow(/another|identity/i);
    const altered = structuredClone(updated.document);
    altered.history[0].snapshot.caption = 'Rewritten historical meaning';
    await expect(
      library.save({
        document: altered,
        destination: target,
        expectedRevision: updated.revision,
      })
    ).rejects.toThrow(/histor|result|snapshot/i);
    expect((await library.read(target)).document).toEqual(updated.document);
  });

  it('refuses an occupied destination and verifies coordinate digests on native read and save', async () => {
    const target = await destination();
    await mkdir(join(target.workspaceRoot, 'views'));
    const document = await molecularDocumentFixture();
    await writeFile(target.path, 'original bytes');
    const library = new MolecularDocumentLibrary();
    await expect(
      library.save({
        document,
        destination: target,
        expectedRevision: null,
      })
    ).rejects.toThrow();
    expect(await readFile(target.path, 'utf8')).toBe('original bytes');
    const bytes = JSON.parse(serializeMolecularDocument(document));
    bytes.coordinateAssets[document.history[0].snapshot.coordinates.sha256] =
      'tampered coordinates';
    await writeFile(target.path, JSON.stringify(bytes));
    await expect(library.read(target)).rejects.toThrow(/digest|coordinate/i);
    const tampered = structuredClone(document);
    tampered.history[0].snapshot.coordinates.text = 'tampered coordinates';
    await expect(
      library.save({
        document: tampered,
        destination: target,
        expectedRevision: null,
      })
    ).rejects.toThrow(/digest|coordinate/i);
  });

  it('rejects cross-project and symlink escape reads and writes', async () => {
    const target = await destination();
    const outside = await destination();
    const document = await molecularDocumentFixture();
    const library = new MolecularDocumentLibrary();
    await library.save({ document, destination: outside, expectedRevision: null });
    await symlink(outside.workspaceRoot, join(target.workspaceRoot, 'shortcut'), 'dir');
    for (const path of [
      outside.path,
      join(target.workspaceRoot, 'shortcut', 'views', 'Pocket.dnaforge-molecular.json'),
    ]) {
      const escape = { workspaceRoot: target.workspaceRoot, path };
      await expect(library.read(escape)).rejects.toThrow();
      await expect(
        library.save({
          document,
          destination: escape,
          expectedRevision: null,
        })
      ).rejects.toThrow();
    }
  });
});

function selectionFor(coordinateDigestSha256: string) {
  return createSavedResidueSelectionDocument({
    id: 'selection-1',
    name: 'Catalytic residues',
    color: '#ef4444',
    revisionId: 'selection-revision-1',
    createdAt: '2026-10-31T12:00:00.000Z',
    actor: { kind: 'user' },
    members: [
      {
        id: 'member-1',
        selection: {
          target: {
            moleculeId: 'protein:sha256:abc123',
            moleculeKind: 'protein',
            coordinateSystem: 'residue',
            intervals: [{ start: 1, end: 1 }],
          },
        },
        scope: { kind: 'polymer' },
        polymerRevision: {
          moleculeId: 'protein:sha256:abc123',
          moleculeKind: 'protein',
          sequenceDigestSha256: 'abc123',
        },
      },
    ],
    structureRevisions: [
      { id: 'structure-revision-1', structureId: 'view-structure', coordinateDigestSha256 },
    ],
  });
}

describe('named selections stored in the view file ', () => {
  it('stores selections in the view file and reopens them exactly', async () => {
    const target = await destination();
    const document = await molecularDocumentFixture();
    const selection = selectionFor(document.history[0].snapshot.coordinates.sha256);
    const library = new MolecularDocumentLibrary();
    await library.save({
      document: { ...document, selections: [selection] },
      destination: target,
      expectedRevision: null,
    });
    const stored = JSON.parse(await readFile(target.path, 'utf8'));
    expect(stored.schema).toBe(MOLECULAR_DOCUMENT_SCHEMA);
    expect(stored.selections).toHaveLength(1);
    const reopened = await library.read(target);
    expect(reopened.document.selections).toEqual([selection]);
    expect(reopened.document.history).toEqual(document.history);
  });

  it('writes no selections field for a view without selections', async () => {
    const target = await destination();
    await new MolecularDocumentLibrary().save({
      document: await molecularDocumentFixture(),
      destination: target,
      expectedRevision: null,
    });
    const stored = JSON.parse(await readFile(target.path, 'utf8'));
    expect(stored).not.toHaveProperty('selections');
  });

  it('rejects a selection pinned to coordinates the view does not hold', async () => {
    const target = await destination();
    const document = await molecularDocumentFixture();
    await expect(
      new MolecularDocumentLibrary().save({
        document: { ...document, selections: [selectionFor('f'.repeat(64))] },
        destination: target,
        expectedRevision: null,
      })
    ).rejects.toThrow(/coordinate/i);
  });

  it('rejects a malformed selection', async () => {
    const target = await destination();
    const document = await molecularDocumentFixture();
    const selection = {
      ...selectionFor(document.history[0].snapshot.coordinates.sha256),
      color: 'not a color',
    };
    await expect(
      new MolecularDocumentLibrary().save({
        document: { ...document, selections: [selection] },
        destination: target,
        expectedRevision: null,
      })
    ).rejects.toThrow(/color/i);
  });

  it('appends selection revisions but refuses to drop a selection or rewrite its history', async () => {
    const target = await destination();
    const document = await molecularDocumentFixture();
    const selection = selectionFor(document.history[0].snapshot.coordinates.sha256);
    const library = new MolecularDocumentLibrary();
    const first = await library.save({
      document: { ...document, selections: [selection] },
      destination: target,
      expectedRevision: null,
    });
    const renamed = appendSavedResidueSelectionRevision(selection, {
      revisionId: 'selection-revision-2',
      createdAt: '2026-10-31T12:05:00.000Z',
      actor: { kind: 'user' },
      name: 'Active site',
      members: selection.revisions[0].members,
      structureRevisions: selection.revisions[0].structureRevisions,
    });
    const second = await library.save({
      document: { ...first.document, selections: [renamed] },
      destination: target,
      expectedRevision: first.revision,
    });
    expect(second.document.selections?.[0].name).toBe('Active site');
    await expect(
      library.save({
        document: { ...second.document, selections: [] },
        destination: target,
        expectedRevision: second.revision,
      })
    ).rejects.toThrow(/selection/i);
    const rewritten = structuredClone(renamed);
    rewritten.revisions[0].reason = 'Rewritten history';
    await expect(
      library.save({
        document: { ...second.document, selections: [rewritten] },
        destination: target,
        expectedRevision: second.revision,
      })
    ).rejects.toThrow(/selection/i);
  });
});
