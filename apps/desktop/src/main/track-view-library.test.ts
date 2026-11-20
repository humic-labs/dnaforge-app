import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackViewLibrary } from './track-view-library';
import { trackViewFixture } from '../shared/track-view-fixture';

import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { beforeEach } from 'vitest';

let retained: ReturnType<typeof createFileTestDb>;
beforeEach(() => {
  retained = createFileTestDb('document-source');
  ensureSchema(retained.db,retained.dbPath);
});
afterEach(() => retained.cleanup());
const store = {db:() => retained.db};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Track view file authority', () => {
  it('projects six physical metadata/document files into five named views after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-mixed-library-'));
    roots.push(root);
    const libraryRoot = join(root, 'library');
    const library = new TrackViewLibrary(libraryRoot,store);
    const expected = [];
    for (let index = 0; index < 5; index++) {
      const workspaceRoot = index === 4 ? libraryRoot : join(root, `project-${index}`);
      await mkdir(workspaceRoot, { recursive: true });
      expected.push(
        await library.save({
          document: {
            ...trackViewFixture(`track-view-mixed-000${index}`),
            name: `Research view ${index}`,
          },
          expectedRevision: null,
          destination: {
            workspaceRoot,
            path: join(workspaceRoot, `View ${index}.dnaforge-track-view.json`),
          },
        })
      );
    }
    expect(await readdir(libraryRoot)).toHaveLength(6);
    const restarted = new TrackViewLibrary(libraryRoot,store);
    const listed = await restarted.list();
    expect(listed.errors).toEqual([]);
    expect(listed.views).toHaveLength(5);
    expect(new Set(listed.views.map((view) => view.document.name))).toEqual(
      new Set(expected.map((view) => view.document.name))
    );
    for (const view of listed.views) expect(await restarted.read(view.document.id)).toEqual(view);
    await rm(expected[0].path);
    const partial = await restarted.list();
    expect(partial.views).toHaveLength(4);
    expect(partial.errors).toHaveLength(1);
    expect(await readFile(expected[1].path, 'utf8')).toContain('Research view 1');
  });
  it('lists a named file in the default folder exactly once and opens a file by path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const path = join(root, 'My genes.dnaforge-track-view.json');
    const library = new TrackViewLibrary(root,store);
    const saved = await library.save({
      document: trackViewFixture(),
      expectedRevision: null,
      destination: { workspaceRoot: root, path },
    });
    expect(saved.workspaceRoot).toBeUndefined();
    const restarted = new TrackViewLibrary(root,store);
    expect(await restarted.list()).toEqual({ views: [saved], errors: [] });
    expect(await restarted.read(path)).toEqual(saved);
    expect(await restarted.read(saved.document.id)).toEqual(saved);
    const renamed = await restarted.save({
      document: { ...saved.document, name: 'Renamed genes' },
      expectedRevision: saved.revision,
    });
    expect(renamed.workspaceRoot).toBeUndefined();
    expect(renamed.path).toBe(path);
    expect(await restarted.read(saved.document.id)).toEqual(renamed);
  });
  it('saves to a chosen project folder and reopens that exact file after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const project = join(root, 'project');
    await mkdir(join(project, 'views'), { recursive: true });
    const path = join(project, 'views', 'My view.dnaforge-track-view.json');
    const library = new TrackViewLibrary(join(root, 'library'),store);
    const saved = await library.save({
      document: trackViewFixture(),
      expectedRevision: null,
      destination: { workspaceRoot: project, path },
    });
    expect(saved.path).toBe(path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved.document);
    const restarted = new TrackViewLibrary(join(root, 'library'),store);
    expect(await restarted.read(saved.document.id)).toEqual(saved);
    expect(await restarted.read(path)).toEqual(saved);
    expect((await restarted.list()).views).toEqual([saved]);
    const updated = await restarted.save({
      document: { ...saved.document, name: 'Updated view' },
      expectedRevision: saved.revision,
    });
    expect(updated.path).toBe(path);
    expect(JSON.parse(await readFile(path, 'utf8')).name).toBe('Updated view');
  });

  it('reconciles a restored viewport with a newer track setting on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-reconcile-'));
    roots.push(root);
    const library = new TrackViewLibrary(root,store);
    const base = await library.save({ document: trackViewFixture(), expectedRevision: null });
    const annotation = {
      ...base.document.annotation,
      policy: { isoformMode: 'expanded', laneLimit: 5 },
    };
    await library.save({
      document: { ...base.document, annotation },
      expectedRevision: base.revision,
    });
    const viewport = { start0: 404, end0: 800 };
    const document = { ...base.document, viewport, scope: { kind: 'chromosome', chrom: 'pUC19' } };
    const reopened = new TrackViewLibrary(root,store);
    const result = await reopened.save({
      document,
      baseDocument: base.document,
      expectedRevision: base.revision,
    });
    expect(result.reconciliation).toBe('merged');
    expect(result.path).toBe(base.path);
    expect((await reopened.read(base.document.id)).document).toMatchObject({
      viewport,
      scope: document.scope,
      annotation,
    });
  });

  it('combines independent edits to the same alignment track and preserves its source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-merge-lane-'));
    roots.push(root);
    const library = new TrackViewLibrary(root,store);
    const track = {
      trackId: 'reads',
      label: 'Reads',
      visible: true,
      trackPx: 340,
      laneHeightPx: 4,
      coverageCutoffDepth: 80,
      source: { bamPath: '/reference/reads.bam', indexPath: '/reference/reads.bam.bai' },
    };
    const base = await library.save({
      document: { ...trackViewFixture(), bamTracks: [track] },
      expectedRevision: null,
    });
    await library.save({
      document: { ...base.document, bamTracks: [{ ...track, trackPx: 276, laneHeightPx: 3 }] },
      expectedRevision: base.revision,
    });
    const local = { ...base.document, bamTracks: [{ ...track, coverageCutoffDepth: 0 }] };
    const saved = await library.save({
      document: local,
      expectedRevision: base.revision,
      baseDocument: base.document,
    });
    expect(saved.reconciliation).toBe('merged');
    const reopened = await new TrackViewLibrary(root,store).read(base.document.id);
    expect(reopened.document.bamTracks).toEqual([
      { ...track, trackPx: 276, laneHeightPx: 3, coverageCutoffDepth: 0 },
    ]);
  });

  it('keeps both versions of an overlapping viewport edit under distinct saved identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-conflict-'));
    roots.push(root);
    const library = new TrackViewLibrary(root,store);
    const base = await library.save({ document: trackViewFixture(), expectedRevision: null });
    const newer = await library.save({
      document: { ...base.document, viewport: { start0: 300, end0: 550 } },
      expectedRevision: base.revision,
    });
    const document = { ...base.document, viewport: { start0: 50, end0: 200 } };
    const draft = { document, baseDocument: base.document, expectedRevision: base.revision };
    const recovered = await library.save(draft);
    expect(recovered.reconciliation).toBe('saved-copy');
    expect(recovered.document.id).not.toBe(base.document.id);
    expect((await library.read(recovered.document.id)).document.viewport).toEqual(
      document.viewport
    );
    expect(await library.read(base.document.id)).toEqual(newer);
    expect((await library.save(draft)).document.id).toBe(recovered.document.id);
    expect((await library.list()).views).toHaveLength(2);
  });

  it('does not follow a symlink out of the personal library when opening a view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const personal = join(root, 'personal');
    const outside = join(root, 'outside');
    await mkdir(personal);
    await mkdir(outside);
    const fileName = 'Genes.dnaforge-track-view.json';
    await writeFile(join(outside, fileName), JSON.stringify(trackViewFixture()));
    await symlink(outside, join(personal, 'shortcut'), 'dir');
    const library = new TrackViewLibrary(personal,store);
    await expect(library.read(join(personal, 'shortcut', fileName))).rejects.toThrow(
      /inside the owning workspace/
    );
  });

  it('refuses to replace another file at the chosen destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const path = join(root, 'Existing.dnaforge-track-view.json');
    await writeFile(path, 'original bytes');
    const library = new TrackViewLibrary(join(root, 'library'),store);
    await expect(
      library.save({
        document: trackViewFixture(),
        expectedRevision: null,
        destination: { workspaceRoot: root, path },
      })
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('original bytes');
  });

  it('rejects destinations outside the chosen root, including symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, join(project, 'shortcut'), 'dir');
    const library = new TrackViewLibrary(join(root, 'library'),store);
    for (const path of [
      join(outside, 'View.dnaforge-track-view.json'),
      join(project, 'shortcut', 'View.dnaforge-track-view.json'),
    ]) {
      await expect(
        library.save({
          document: trackViewFixture(),
          expectedRevision: null,
          destination: { workspaceRoot: project, path },
        })
      ).rejects.toThrow();
    }
    await expect(readFile(join(outside, 'View.dnaforge-track-view.json'))).rejects.toThrow();
    expect((await library.list()).views).toEqual([]);
  });

  it('keeps the real file authoritative when the sidebar location index cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const libraryRoot = join(root, 'library');
    const document = trackViewFixture();
    await mkdir(join(libraryRoot, `${document.id}.location.json`), { recursive: true });
    const library = new TrackViewLibrary(libraryRoot,store);
    const destination = { workspaceRoot: root, path: join(root, 'View.dnaforge-track-view.json') };
    const saved = await library.save({ document, destination, expectedRevision: null });
    expect(saved.warning).toContain('view file was saved');
    expect(JSON.parse(await readFile(saved.path, 'utf8'))).toEqual(saved.document);
    expect((await library.read(saved.path)).document).toEqual(saved.document);
    const updated = await library.save({
      document: { ...saved.document, name: 'Updated' },
      destination,
      expectedRevision: saved.revision,
    });
    expect(updated.document.name).toBe('Updated');
  });

  it('discovers a named file when its secondary location entry is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const document = trackViewFixture();
    await writeFile(join(root, 'Genes.dnaforge-track-view.json'), JSON.stringify(document));
    const library = new TrackViewLibrary(root,store);
    const list = await library.list();
    expect(list.views).toHaveLength(1);
    expect(list.errors).toEqual([]);
    expect((await library.read(String(document.id))).document).toEqual(list.views[0].document);
  });

  it('keeps two views on one reference across restart and refuses a stale overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const library = new TrackViewLibrary(root,store);
    const a = await library.save({ document: trackViewFixture(), expectedRevision: null });
    const b = await library.save({
      document: { ...trackViewFixture('track-view-22222222'), name: 'Coverage' },
      expectedRevision: null,
    });
    expect(a.document.reference).toEqual(b.document.reference);
    const restarted = new TrackViewLibrary(root,store);
    expect((await restarted.list()).views.map((view) => view.document.name).sort()).toEqual([
      'Coverage',
      'Genes',
    ]);
    const updated = await restarted.save({
      document: { ...a.document, name: 'Gene detail' },
      expectedRevision: a.revision,
    });
    await expect(
      library.save({ document: { ...a.document, name: 'Stale' }, expectedRevision: a.revision })
    ).rejects.toThrow(/changed/i);
    expect(JSON.parse(await readFile(updated.path, 'utf8')).name).toBe('Gene detail');
    expect((await restarted.read(b.document.id)).document.name).toBe('Coverage');
  });
  it('reports corrupt files while retaining readable views and rejects path traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'track-view-test-'));
    roots.push(root);
    const library = new TrackViewLibrary(root,store);
    await library.save({ document: trackViewFixture(), expectedRevision: null });
    await writeFile(join(root, 'broken.dnaforge-track-view.json'), '{');
    const result = await library.list();
    expect(result.views).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    await expect(library.read('../outside')).rejects.toThrow();
  });
});
