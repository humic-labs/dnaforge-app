import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPARISON_SOURCE_SCHEMA,
  MAX_COMPARISON_SOURCE_BYTES,
  type ComparisonSourceReadRequest,
} from '../shared/comparison-source';
import { ComparisonSourceCommands } from './comparison-source-commands';

import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { TrackViewLibrary } from './track-view-library';
import { trackViewFixture } from '../shared/track-view-fixture';
import { parseTrackViewDocument } from '../shared/track-view';
import { comparisonSourceProjectionId } from '../shared/comparison-source';
import { savedFileWorkspace } from './saved-file-publication';
import { listSavedFileVersions, restoreSavedFileSource } from './saved-file-sources';
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

const publicFixture = fileURLToPath(
  new URL(
    '../../../../test-fixtures/genome-view-prototypes/MG1655-Shigella2457T-gapped.paf',
    import.meta.url
  )
);
const publicFixtureSha256 = '87a00a4f29828486d242fdc9abc89ffb2309b08654f99b8c75e042500aabc211';
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'dnaforge-comparison-'));
  folders.push(temporary);
  const root = await realpath(temporary);
  const path = join(root, 'measurements', 'alignment.paf');
  await mkdir(join(root, 'measurements'));
  await copyFile(publicFixture, path);
  const request: ComparisonSourceReadRequest = {
    project: root,
    source: {
      schema: COMPARISON_SOURCE_SCHEMA,
      path: 'measurements/alignment.paf',
      sha256: publicFixtureSha256,
      targetReference: {
        id: 'NC_000913.3',
        chrom: 'NC_000913.3',
        length: 4_641_652,
        label: 'E. coli K-12 MG1655',
      },
      queryReference: {
        id: 'NC_004741.1',
        chrom: 'NC_004741.1',
        length: 4_599_354,
        label: 'Shigella flexneri 2457T',
      },
    },
  };
  const assertCurrent = vi.fn();
  const captureReadable = vi.fn(() => assertCurrent);
  const commands = new ComparisonSourceCommands({
    resolveProject: async (project) => {
      if (project !== root) throw new Error('PROJECT_NOT_ADMITTED');
      return root;
    },
    captureReadable,
  });
  return { root, path, request, commands, assertCurrent, captureReadable };
}

it('saves a Track view and its admitted alignment bytes, keeps the view editable after source loss and restores the alignment exactly', async () => {
  const f = await fixture();
  const db = createFileTestDb('retained-comparison-track-view');
  try {
    ensureSchema(db.db, db.dbPath);
    const lib = new TrackViewLibrary(join(db.tmpDir, 'library'), {
      db: () => db.db,
      comparisons: f.commands,
    });
    const original = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const axis = f.request.source.targetReference;
    const document = {
      ...original,
      reference: {
        ...original.reference,
        chromosomes: [{ chrom: axis.chrom, length: axis.length }],
      },
      comparisonProjection: {
        kind: 'aligned-genomes' as const,
        project: f.root,
        source: f.request.source,
      },
    };
    await expect(
      lib.save({
        document: {
          ...document,
          comparisonProjection: { ...document.comparisonProjection, project: '/outside' },
        },
        expectedRevision: null,
      })
    ).rejects.toThrow('PROJECT_NOT_ADMITTED');
    const saved = await lib.save({ document, expectedRevision: null });
    const owner = {
      workspaceId: savedFileWorkspace(db.db, f.root)!.id,
      entityId: comparisonSourceProjectionId(f.request.source),
    };
    const [revision] = listSavedFileVersions(db.db, { ...owner, offset: 0, limit: 1 }).versions;
    expect(revision).toBeDefined();
    const bytes = await readFile(f.path);
    await rm(f.path);
    const edited = await lib.save({
      document: { ...document, name: 'Renamed view' },
      expectedRevision: saved.revision,
    });
    expect(edited.document.comparisonProjection?.source).toEqual(f.request.source);
    await restoreSavedFileSource(db.db, { ...owner, revisionId: revision.id, destination: f.path });
    expect(await readFile(f.path)).toEqual(bytes);
    expect((await f.commands.read(f.request)).revision).toBe(f.request.source.sha256);
  } finally {
    db.cleanup();
  }
});

describe('native comparison sources', () => {
  it('reads every actual PAF row and retains its complete CIGAR-derived alignment segments', async () => {
    const state = await fixture();
    const result = await state.commands.read(state.request);
    const bytes = await readFile(publicFixture);
    expect(bytes.byteLength).toBe(38_160);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(publicFixtureSha256);
    const rows = bytes.toString('utf8').trim().split('\n');
    expect(rows).toHaveLength(261);
    expect(result.comparison.blocks).toHaveLength(261);
    expect(result.comparison.target).toEqual({ id: 'NC_000913.3', length: 4_641_652 });
    expect(result.comparison.query).toEqual({ id: 'NC_004741.1', length: 4_599_354 });
    for (const [index, row] of rows.entries()) {
      const fields = row.split('\t');
      const cigar = fields.find((field) => field.startsWith('cg:Z:'))!.slice(5);
      const block = result.comparison.blocks[index];
      expect(block.id).toBe(`paf-${index + 1}`);
      expect(block.cigar).toBe(cigar);
      expect(block.segments).toHaveLength([...cigar.matchAll(/[1-9][0-9]*[M=XID]/gu)].length);
      expect(block.target).toEqual({
        referenceId: fields[5],
        start: Number(fields[7]),
        end: Number(fields[8]),
      });
      expect(block.query).toEqual({
        referenceId: fields[0],
        start: Number(fields[2]),
        end: Number(fields[3]),
      });
      expect(block.columnLength).toBe(block.alignmentColumns + block.ambiguousBases);
    }
    expect(result.comparison.blocks.some((block) => block.strand === '-')).toBe(true);
    for (const code of ['I', 'D']) {
      expect(
        result.comparison.blocks.some((block) =>
          block.segments.some((segment) => segment.code === code)
        )
      ).toBe(true);
    }
    expect(result).toMatchObject({
      projectionId: `comparison:${publicFixtureSha256}`,
      label: 'E. coli K-12 MG1655 ↔ Shigella flexneri 2457T',
      path: state.path,
      revision: publicFixtureSha256,
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

  it('refuses changed file bytes even when the replacement remains a valid PAF', async () => {
    const state = await fixture();
    await writeFile(state.path, `${await readFile(publicFixture, 'utf8')}\n`);
    await expect(state.commands.read(state.request)).rejects.toThrow('fingerprint');
  });

  it('refuses another version, another chromosome, or another length on either axis', async () => {
    const state = await fixture();
    for (const axis of ['targetReference', 'queryReference'] as const) {
      const original = state.request.source[axis];
      for (const change of [
        { id: 'another-reference.1', chrom: 'another-reference.1' },
        { length: original.length - 1 },
      ]) {
        await expect(
          state.commands.read({
            ...state.request,
            source: { ...state.request.source, [axis]: { ...original, ...change } },
          })
        ).rejects.toThrow('another reference');
      }
    }
  });

  it('refuses lexical traversal and file or parent symlinks outside the owning project', async () => {
    const state = await fixture();
    await expect(
      state.commands.read({
        ...state.request,
        source: { ...state.request.source, path: '../alignment.paf' },
      })
    ).rejects.toThrow('relative');
    const outside = await mkdtemp(join(tmpdir(), 'dnaforge-comparison-outside-'));
    folders.push(outside);
    await copyFile(publicFixture, join(outside, 'alignment.paf'));
    await symlink(join(outside, 'alignment.paf'), join(state.root, 'linked.paf'));
    await symlink(outside, join(state.root, 'linked-directory'));
    for (const path of ['linked.paf', 'linked-directory/alignment.paf']) {
      await expect(
        state.commands.read({
          ...state.request,
          source: { ...state.request.source, path },
        })
      ).rejects.toThrow('inside the owning workspace');
    }
  });

  it('refuses a source over 16 MiB before parsing or hashing its contents', async () => {
    const state = await fixture();
    const handle = await open(state.path, 'w');
    await handle.truncate(MAX_COMPARISON_SOURCE_BYTES + 1);
    await handle.close();
    await expect(state.commands.read(state.request)).rejects.toThrow('bounded read limit');
  });

  it('refuses missing, malformed or endpoint-inconsistent CIGAR despite a matching file hash', async () => {
    const state = await fixture();
    const row = (await readFile(publicFixture, 'utf8')).split('\n')[0];
    for (const content of [
      row.replace(/\tcg:Z:[^\t]+/u, ''),
      row.replace(/cg:Z:[^\t]+/u, 'cg:Z:100S'),
      row.replace(/cg:Z:[^\t]+/u, 'cg:Z:1M'),
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
      ).rejects.toThrow(/CIGAR/u);
    }
  });

  it('preserves secondary rows instead of silently filtering an exact source revision', async () => {
    const state = await fixture();
    const row = (await readFile(publicFixture, 'utf8')).split('\n')[0];
    const content = `${row}\n${row.replace('tp:A:P', 'tp:A:S')}\n`;
    await writeFile(state.path, content);
    const result = await state.commands.read({
      ...state.request,
      source: {
        ...state.request.source,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    });
    expect(result.comparison.blocks).toHaveLength(2);
    expect(result.comparison.blocks[0].segments).toEqual(result.comparison.blocks[1].segments);
  });

  it('refuses an empty source and read authority revoked before return', async () => {
    const state = await fixture();
    await writeFile(state.path, '');
    await expect(
      state.commands.read({
        ...state.request,
        source: { ...state.request.source, sha256: createHash('sha256').update('').digest('hex') },
      })
    ).rejects.toThrow('gapped alignment blocks');
    await copyFile(publicFixture, state.path);
    state.assertCurrent
      .mockReset()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error('PROJECT_READ_REVOKED');
      });
    await expect(state.commands.read(state.request)).rejects.toThrow('PROJECT_READ_REVOKED');
    expect(state.assertCurrent).toHaveBeenCalledTimes(3);
  });
});
