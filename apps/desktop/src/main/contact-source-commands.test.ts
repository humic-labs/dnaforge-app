import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTACT_MATRIX_SCHEMA,
  CONTACT_SOURCE_SCHEMA,
  MAX_CONTACT_SOURCE_BYTES,
  type ContactSourceDocument,
  type ContactSourceReadRequest,
} from '../shared/contact-source';
import { ContactSourceCommands } from './contact-source-commands';

import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { TrackViewLibrary } from './track-view-library';
import { trackViewFixture } from '../shared/track-view-fixture';
import { parseTrackViewDocument } from '../shared/track-view';
import { savedFileWorkspace } from './saved-file-publication';
import { listSavedFileVersions, restoreSavedFileSource } from './saved-file-sources';
import { readFile } from 'node:fs/promises';
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'dnaforge-contact-'));
  folders.push(temporary);
  const root = await realpath(temporary);
  const path = join(root, 'measurements', 'contacts.json');
  await mkdir(join(root, 'measurements'));
  const document: ContactSourceDocument = {
    schema: CONTACT_MATRIX_SCHEMA,
    id: 'measured-contact',
    label: 'Measured contacts',
    unit: 'counts',
    xReference: { id: 'ref-a', chrom: 'chr1', length: 100 },
    yReference: { id: 'ref-b', chrom: 'chr2', length: 200 },
    cells: [{ id: 'first', start: 0, end: 10, targetStart: 20, targetEnd: 30, value: 4 }],
    colorScale: {
      kind: 'continuous',
      domain: [0, 10],
      colors: ['#000000', '#ffffff'],
      missingColor: '#cccccc',
      transform: 'linear',
    },
  };
  const content = JSON.stringify(document);
  await writeFile(path, content);
  const request: ContactSourceReadRequest = {
    project: root,
    source: {
      schema: CONTACT_SOURCE_SCHEMA,
      path: 'measurements/contacts.json',
      sha256: createHash('sha256').update(content).digest('hex'),
      xReference: document.xReference,
      yReference: document.yReference,
    },
  };
  const assertCurrent = vi.fn();
  const resolveProject = vi.fn(async (project: string) => {
    if (project !== root) throw new Error('PROJECT_NOT_ADMITTED');
    return root;
  });
  const captureReadable = vi.fn(() => assertCurrent);
  const commands = new ContactSourceCommands({ resolveProject, captureReadable });
  return { root, path, document, content, request, commands, assertCurrent, captureReadable };
}

it('restores the exact admitted contact matrix after publication of its Track view and working source loss', async () => {
  const f = await fixture();
  const db = createFileTestDb('retained-contact-view');
  try {
    ensureSchema(db.db, db.dbPath);
    const lib = new TrackViewLibrary(join(db.tmpDir, 'library'), {
      db: () => db.db,
      contacts: f.commands,
    });
    const original = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const axis = f.request.source.xReference;
    const document = {
      ...original,
      reference: {
        ...original.reference,
        chromosomes: [{ chrom: axis.chrom, length: axis.length }],
      },
      viewport: { start0: 0, end0: axis.length },
      contactProjection: {
        kind: 'contact-matrix' as const,
        project: f.root,
        source: f.request.source,
      },
    };
    await lib.save({ document, expectedRevision: null });
    const owner = {
      workspaceId: savedFileWorkspace(db.db, f.root)!.id,
      entityId: 'contact:' + f.request.source.sha256,
    };
    const [revision] = listSavedFileVersions(db.db, { ...owner, offset: 0, limit: 1 }).versions;
    expect(revision).toBeDefined();
    await rm(f.path);
    await restoreSavedFileSource(db.db, { ...owner, revisionId: revision.id, destination: f.path });
    expect(await readFile(f.path, 'utf8')).toBe(f.content);
    expect((await f.commands.read(f.request)).revision).toBe(f.request.source.sha256);
  } finally {
    db.cleanup();
  }
});

describe('native contact sources', () => {
  it('returns only a projection from the admitted immutable file and its verified revision', async () => {
    const state = await fixture();
    const result = await state.commands.read(state.request);
    expect(result).toEqual({
      path: state.path,
      revision: state.request.source.sha256,
      label: state.document.label,
      unit: state.document.unit,
      projection: {
        kind: 'contact-matrix',
        id: `${state.document.id}:${state.request.source.sha256}`,
        xReference: state.document.xReference,
        yReference: state.document.yReference,
        cells: state.document.cells,
        colorScale: state.document.colorScale,
      },
    });
    expect(state.captureReadable).toHaveBeenCalledWith(state.root);
    expect(state.assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('refuses an unadmitted project before reading', async () => {
    const state = await fixture();
    await expect(
      state.commands.read({ ...state.request, project: '/not-admitted' })
    ).rejects.toThrow('PROJECT_NOT_ADMITTED');
    expect(state.captureReadable).not.toHaveBeenCalled();
  });

  it('refuses replaced bytes even when the replacement remains a valid contact matrix', async () => {
    const state = await fixture();
    await writeFile(state.path, JSON.stringify({ ...state.document, label: 'Changed contacts' }));
    await expect(state.commands.read(state.request)).rejects.toThrow('fingerprint');
  });

  it('refuses a descriptor that swaps either axis reference', async () => {
    const state = await fixture();
    for (const axis of ['xReference', 'yReference'] as const) {
      await expect(
        state.commands.read({
          ...state.request,
          source: {
            ...state.request.source,
            [axis]: { ...state.request.source[axis], id: 'wrong-reference' },
          },
        })
      ).rejects.toThrow('axis references');
    }
  });

  it('refuses lexical traversal and file or parent symlinks outside the owning project', async () => {
    const state = await fixture();
    await expect(
      state.commands.read({
        ...state.request,
        source: { ...state.request.source, path: '../contacts.json' },
      })
    ).rejects.toThrow('relative');
    const outside = await mkdtemp(join(tmpdir(), 'dnaforge-contact-outside-'));
    folders.push(outside);
    await writeFile(join(outside, 'contacts.json'), state.content);
    await symlink(join(outside, 'contacts.json'), join(state.root, 'linked.json'));
    await symlink(outside, join(state.root, 'linked-directory'));
    for (const path of ['linked.json', 'linked-directory/contacts.json']) {
      await expect(
        state.commands.read({ ...state.request, source: { ...state.request.source, path } })
      ).rejects.toThrow('inside the owning workspace');
    }
  });

  it('refuses a file over 16 MiB before parsing or hashing its contents', async () => {
    const state = await fixture();
    const handle = await open(state.path, 'w');
    await handle.truncate(MAX_CONTACT_SOURCE_BYTES + 1);
    await handle.close();
    await expect(state.commands.read(state.request)).rejects.toThrow('bounded read limit');
  });

  it('rejects malformed JSON and invalid cell intervals even with matching fingerprints', async () => {
    const state = await fixture();
    for (const content of [
      '{',
      JSON.stringify({
        ...state.document,
        cells: [{ ...state.document.cells[0], targetEnd: 201 }],
      }),
    ]) {
      await writeFile(state.path, content);
      await expect(
        state.commands.read({
          ...state.request,
          source: {
            ...state.request.source,
            sha256: createHash('sha256').update(content).digest('hex'),
          },
        })
      ).rejects.toThrow();
    }
  });

  it('refuses read authority revoked before return', async () => {
    const state = await fixture();
    state.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => {});
    state.assertCurrent.mockImplementation(() => {
      throw new Error('PROJECT_READ_REVOKED');
    });
    await expect(state.commands.read(state.request)).rejects.toThrow('PROJECT_READ_REVOKED');
    expect(state.assertCurrent).toHaveBeenCalledTimes(3);
  });
});
