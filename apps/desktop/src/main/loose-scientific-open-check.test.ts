import { accessSync, constants, type Stats } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildIndexedGenomePaths,
  CURRENT_INDEXED_GENOME_SCHEMA,
  extensionForPath,
} from '../features/sequence/indexed-genome-paths';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { createTestDb } from './__tests__/test-db';
import { registerWorkspaceFileInDb } from './catalog-entity-registration';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { createDocumentOpenSource } from './document-open-source';
import { prepareIndexedGenomeSession } from './ipc/indexed-genome-session-prep';
import {
  inspectLooseScientificDocument,
  type LooseScientificKind,
} from './loose-scientific-open-check';
import * as nativeIndexerProcess from './reference-assets/dna-indexer-process';
import { resolveDnaIndexerHelperPath } from './reference-assets/local-reference-asset-authority';
import { ensureSchema } from './schema';

const runtime = vi.hoisted(() => ({ state: 'ready', generation: 1 }));
vi.mock('./sidecar-session-runtime', () => ({
  sidecarSessionAuthority: { snapshot: () => ({ ...runtime }) },
  sidecarFetch: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? homedir() : tmpdir()),
    getAppPath: () => process.cwd(),
    isPackaged: false,
    getVersion: () => 'test',
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));

const fasta = '>toy\nACGTACGT\n';
const protein = '>toy\nMKTWXBZJOU-\n';
const fastq = '@toy\nACGT\n+\n!!!!\n';
const genbank = [
  'LOCUS       TOY                        8 bp    DNA     linear   SYN 01-JAN-2024',
  'FEATURES             Location/Qualifiers',
  'ORIGIN',
  '        1 acgtacgt',
  '//',
  '',
].join('\n');
const gff = '##gff-version 3\ntoy\tsynthetic\tgene\t1\t4\t.\t+\t.\tID=test\n';
const badGff = '##gff-version 3\ntoy\tsynthetic\tgene\t4\t1\t.\t+\t.\tID=test\n';

let root: string;
let db: ReturnType<typeof createTestDb>;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dnaforge-loose-open-test-')));
  db = createTestDb();
  ensureSchema(db, ':memory:');
  ensureWorkspaceOwnerInDb(db, root);
});
afterEach(() => {
  runtime.state = 'ready';
  runtime.generation = 1;
  vi.unstubAllEnvs();
});
afterAll(async () => {
  db?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

function openCheck(kind: LooseScientificKind, path: string) {
  const captured = createDocumentOpenSource(db, root, path, root);
  return {
    ...captured,
    read: () => inspectLooseScientificDocument(kind, captured.forPath(path)),
  };
}

function minimalSnapGene() {
  const cookie = Buffer.alloc(19);
  cookie[0] = 0x09;
  cookie.writeUInt32BE(14, 1);
  cookie.write('SnapGene', 5);
  const dnaPacket = Buffer.alloc(10);
  dnaPacket.writeUInt32BE(5, 1);
  dnaPacket.write('ACGT', 6);
  return Buffer.concat([cookie, dnaPacket]);
}

function minimalAbif() {
  const bytes = Buffer.alloc(128);
  bytes.write('ABIF');
  bytes.writeInt16BE(101, 4);
  bytes.writeInt32BE(1, 18);
  bytes.writeInt32BE(32, 26);
  bytes.write('PBAS', 32);
  bytes.writeInt32BE(2, 36);
  bytes.writeInt16BE(2, 40);
  bytes.writeInt16BE(1, 42);
  bytes.writeInt32BE(4, 44);
  bytes.writeInt32BE(4, 48);
  bytes.write('ACGT', 52);
  return bytes;
}

describe('loose scientific Open reads real files', () => {
  it.each(['gb', 'gbk', 'gbff', 'genbank'])(
    'checks complete and cut .%s records',
    async (extension) => {
      const good = await write(`valid.${extension}`, genbank);
      const bad = await write(`truncated.${extension}`, genbank.slice(0, -3));
      await expect(openCheck('sequence', good).read()).resolves.toBeUndefined();
      await expect(openCheck('sequence', bad).read()).rejects.toMatchObject({
        code: 'malformed',
        recognized: true,
      });
      expect(await readFile(bad, 'utf8')).toBe(genbank.slice(0, -3));
    }
  );

  it('reads .gbff.gz without the indexer and rejects both a cut stream and cut GenBank record', async () => {
    runtime.state = 'error';
    const bytes = gzipSync(genbank);
    const good = await write('valid.gbff.gz', bytes);
    await expect(openCheck('sequence', good).read()).resolves.toBeUndefined();
    const truncatedGzip = await write('truncated-container.gbff.gz', bytes.subarray(0, -8));
    const truncatedRecord = await write('truncated-record.gbff.gz', gzipSync(genbank.slice(0, -3)));
    await expect(openCheck('sequence', truncatedGzip).read()).rejects.toMatchObject({
      code: 'malformed',
    });
    await expect(openCheck('sequence', truncatedRecord).read()).rejects.toMatchObject({
      code: 'malformed',
      recognized: true,
    });
    expect(await readFile(good)).toEqual(bytes);
  });

  it.each(['fa', 'fasta', 'fas', 'fna', 'ffn', 'dnas'])(
    'checks valid and invalid .%s sequences',
    async (extension) => {
      await expect(
        openCheck('sequence', await write(`valid.${extension}`, fasta)).read()
      ).resolves.toBeUndefined();
      await expect(
        openCheck('sequence', await write(`bad.${extension}`, '>toy\n?!\n')).read()
      ).rejects.toMatchObject({ code: 'malformed', recognized: true });
    }
  );

  it.each(['fq', 'fastq'])('checks .%s quality data and truncation', async (extension) => {
    await expect(
      openCheck('sequence', await write(`valid.${extension}`, fastq)).read()
    ).resolves.toBeUndefined();
    await expect(
      openCheck('sequence', await write(`bad.${extension}`, '@toy\nACGT\n+\n!!\n')).read()
    ).rejects.toMatchObject({ code: 'malformed', recognized: true });
  });

  it('checks a .seq sequence without assuming a header is required', async () => {
    await expect(
      openCheck('sequence', await write('valid.seq', ';synthetic\nacgt\n')).read()
    ).resolves.toBeUndefined();
    await expect(
      openCheck('sequence', await write('bad.seq', ';synthetic\nZZZZ\n')).read()
    ).rejects.toMatchObject({ code: 'malformed' });
  });

  it.each(['ab1', 'abi'])(
    'reads .%s directory data and refuses an incomplete header or a newer version',
    async (extension) => {
      const source = minimalAbif();
      await expect(
        openCheck('sequence', await write(`valid.${extension}`, source)).read()
      ).resolves.toBeUndefined();
      await expect(
        openCheck('sequence', await write(`bad.${extension}`, source.subarray(0, 36))).read()
      ).rejects.toMatchObject({ code: 'malformed', recognized: true });
      source.writeInt16BE(201, 4);
      await expect(
        openCheck('sequence', await write(`future.${extension}`, source)).read()
      ).rejects.toMatchObject({ code: 'newer-format', recognized: true });
    }
  );

  it('requires the DNA packet after the SnapGene cookie', async () => {
    const source = minimalSnapGene();
    await expect(
      openCheck('sequence', await write('valid.dna', source)).read()
    ).resolves.toBeUndefined();
    await expect(
      openCheck('sequence', await write('bad.dna', source.subarray(0, 21))).read()
    ).rejects.toMatchObject({ code: 'malformed', recognized: true });
  });

  it('uses the single-protein reader for .FAA and reports multiple records distinctly', async () => {
    await expect(
      openCheck('protein', await write('valid.FAA', protein)).read()
    ).resolves.toBeUndefined();
    await expect(
      openCheck('protein', await write('empty.faa', '>toy\n')).read()
    ).rejects.toMatchObject({ code: 'malformed', recognized: true });
    await expect(
      openCheck('protein', await write('bad.faa', '>toy\nA8!!\n')).read()
    ).rejects.toMatchObject({ code: 'malformed', recognized: true });
    await expect(
      openCheck('protein', await write('multi.faa', `${protein}>next\nMKT\n`)).read()
    ).rejects.toMatchObject({ code: 'unsupported-format', recognized: true });
  });

  it('uses the project’s stored protein reading even for a neutral FASTA suffix', async () => {
    const path = await write('project-protein.fasta', `${protein}>next\nMKT\n`);
    registerWorkspaceFileInDb(db, {
      path,
      workspaceRoot: root,
      entityType: 'protein',
      fileKind: 'fasta',
      metadata: { discoveredFrom: 'git-indexer' },
    });
    await expect(openCheck('sequence', path).read()).rejects.toMatchObject({
      code: 'unsupported-format',
      recognized: true,
    });
    await writeFile(path, protein);
    await expect(openCheck('sequence', path).read()).resolves.toBeUndefined();
  });

  it.each(['pdb', 'cif', 'mmcif', 'mcif', 'bcif'])(
    'loads .%s coordinates into a real model and refuses invalid coordinates',
    async (extension) => {
      const fixtureExtension = extension === 'pdb' || extension === 'bcif' ? extension : 'cif';
      const bytes = await readFile(
        new URL(
          `../../../../test-fixtures/structure-complexes/rcsb/1FS0.${fixtureExtension}`,
          import.meta.url
        )
      );
      const broken =
        extension === 'pdb'
          ? 'HEADER    SYNTHETIC\nEND\n'
          : extension === 'bcif'
            ? bytes.subarray(0, 60)
            : 'data_empty\n_entry.id empty\n';
      await expect(
        openCheck('structure', await write(`valid.${extension}`, bytes)).read()
      ).resolves.toBeUndefined();
      await expect(
        openCheck('structure', await write(`bad.${extension}`, broken)).read()
      ).rejects.toMatchObject({ code: 'coordinates' });
    }
  );

  it('preserves filesystem, size, and change outcomes separately from format errors', async () => {
    await expect(openCheck('sequence', join(root, 'missing.ab1')).read()).rejects.toMatchObject({
      code: 'missing',
    });
    const large = await write('oversize.ab1', minimalAbif());
    await truncate(large, HARD_CAP_BYTES + 1);
    await expect(openCheck('sequence', large).read()).rejects.toMatchObject({ code: 'too-large' });
    const path = await write('changed.fa', fasta);
    const attempt = openCheck('sequence', path);
    await attempt.read();
    await writeFile(path, '>other\nAT\n');
    await expect(attempt.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
  });

  it('leaves permission errors distinct even when a filesystem alias names a valid sequence', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dnaforge-other-project-test-'));
    try {
      const external = join(outside, 'valid.fa');
      await writeFile(external, fasta);
      const path = join(root, 'alias.fa');
      await symlink(external, path, 'file');
      await expect(openCheck('sequence', path).read()).rejects.toMatchObject({
        code: 'permission',
      });
      expect(await readFile(external, 'utf8')).toBe(fasta);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('distinguishes an indexed source without a project from a broken source', async () => {
    const path = await write('unowned.gff', gff);
    const source = createDocumentOpenSource(db, root, path, root).forPath(path);
    await expect(
      inspectLooseScientificDocument('sequence', { ...source, workspaceRoot: '' })
    ).rejects.toMatchObject({ code: 'project', recognized: false });
  });
});

const nativeIndexer = resolveDnaIndexerHelperPath({
  appPath: resolve(import.meta.dirname, '../..'),
  resourcesPath: '',
  isPackaged: false,
  explicitPath: process.env.DNA_INDEXER_PATH,
});
const nativeIndexerAvailable = (() => {
  try {
    accessSync(nativeIndexer, constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!nativeIndexerAvailable)(
  'indexed source checks use the installed normal parser and data reader',
  () => {
    it.each(['fa.gz', 'fasta.gz', 'fna.gz'])(
      'decodes %s bytes and detects a damaged compression stream',
      async (extension) => {
        const bytes = gzipSync(fasta);
        const path = await write(`valid.${extension}`, bytes);
        await expect(openCheck('sequence', path).read()).resolves.toBeUndefined();
        const short = await write(`truncated.${extension}`, bytes.subarray(0, -8));
        await expect(openCheck('sequence', short).read()).rejects.toMatchObject({
          code: 'malformed',
        });
        expect(await readFile(path)).toEqual(bytes);
      }
    );

    it.each(['gff', 'gff3', 'gff.gz', 'gff3.gz'])(
      'requires both the .%s source and its real companion',
      async (extension) => {
        const encode = (value: string) => (extension.endsWith('.gz') ? gzipSync(value) : value);
        const folder = `companions-${extension}`;
        const path = await write(`${folder}/toy.${extension}`, encode(gff));
        await expect(openCheck('sequence', path).read()).rejects.toMatchObject({
          code: 'missing-asset',
        });
        await write(`${folder}/toy.fna.gz`, gzipSync(fasta));
        const open = openCheck('sequence', path);
        await expect(open.read()).resolves.toBeUndefined();
        await write(`${folder}/toy.fa`, fasta);
        await expect(open.verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
        await writeFile(path, encode(badGff));
        await expect(openCheck('sequence', path).read()).rejects.toMatchObject({
          code: 'malformed',
          recognized: true,
        });
      }
    );

    it('checks parallel indexed sources without reporting a busy reader as unavailable', async () => {
      // These are different real files with the same display stem. GFF uses the paired FASTA.
      const folder = 'parallel-indexing';
      const sources = await Promise.all([
        ...['fa.gz', 'fasta.gz', 'fna.gz'].map((suffix) =>
          write(`${folder}/sample.${suffix}`, gzipSync(fasta))
        ),
        ...['gff', 'gff3', 'gff.gz', 'gff3.gz'].map((suffix) =>
          write(`${folder}/sample.${suffix}`, suffix.endsWith('.gz') ? gzipSync(gff) : gff)
        ),
      ]);
      const malformed = await write(`${folder}/malformed.fa.gz`, gzipSync(fasta).subarray(0, -8));
      const checks = [...sources, malformed].map((path) => openCheck('sequence', path));
      const exec = nativeIndexerProcess.execDnaIndexerFile;
      let active = 0;
      let peak = 0;
      const outputs = new Set<string>();
      const probe = vi
        .spyOn(nativeIndexerProcess, 'execDnaIndexerFile')
        .mockImplementation(async (...args) => {
          const flags = args[1];
          outputs.add(flags[flags.indexOf('--out-dir') + 1]);
          active += 1;
          peak = Math.max(peak, active);
          try {
            return await exec(...args);
          } finally {
            active -= 1;
          }
        });
      try {
        const results = await Promise.allSettled(checks.map((check) => check.read()));
        expect(results.slice(0, sources.length)).toEqual(
          sources.map(() => ({ status: 'fulfilled', value: undefined }))
        );
        expect(results.at(-1)).toMatchObject({ status: 'rejected', reason: { code: 'malformed' } });
        expect(peak).toBe(1);
        expect(outputs.size).toBe(checks.length);
        await Promise.all(
          [...outputs].map((path) => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }))
        );
        await Promise.all(checks.slice(0, sources.length).map((check) => check.verifyCurrent()));
      } finally {
        probe.mockRestore();
      }
    });

    it('keeps unsupported multi-record indexed FASTA separate from a missing runtime', async () => {
      const multi = await write('multi.fa.gz', gzipSync(`${fasta}>second\nTTTT\n`));
      await expect(openCheck('sequence', multi).read()).rejects.toMatchObject({
        code: 'unsupported-format',
        recognized: true,
      });
      const good = await write('no-runtime.fa.gz', gzipSync(fasta));
      runtime.state = 'error';
      await expect(openCheck('sequence', good).read()).rejects.toMatchObject({
        code: 'runtime',
        recognized: false,
      });
      runtime.state = 'ready';
      vi.stubEnv('DNA_INDEXER_PATH', join(root, 'missing-installed-indexer'));
      await expect(openCheck('sequence', good).read()).rejects.toMatchObject({
        code: 'runtime',
        recognized: false,
      });
      await expect(stat(join(root, '.waypoint', 'genome-index'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('reports a matching companion distinct from valid FASTA with the wrong reference', async () => {
      const path = await write('paired/paired.gff3', gff);
      const companion = await write('paired/paired.fa', fasta.replace('>toy', '>unrelated'));
      await expect(openCheck('sequence', path).read()).rejects.toMatchObject({
        code: 'missing-asset',
        recognized: true,
      });
      await writeFile(companion, fasta);
      await expect(openCheck('sequence', path).read()).resolves.toBeUndefined();
    });

    it('keeps separate catalog identities and reuses the corresponding existing indexes', async () => {
      const fixtures = [
        ['fa.gz', 'ACGTACGT'],
        ['fasta.gz', 'TCGATCGA'],
        ['fna.gz', 'CGTACGTA'],
      ] as const;
      const prepared = await Promise.all(
        fixtures.map(async ([suffix, expected]) => {
          const input = await write(`prepared/sample.${suffix}`, gzipSync(`>toy\n${expected}\n`));
          const metadata = await stat(input);
          const paths = buildIndexedGenomePaths({
            sourcePath: input,
            workspaceRoot: root,
            sizeBytes: metadata.size,
            sourceMtimeMs: metadata.mtimeMs,
            sourceCtimeMs: metadata.ctimeMs,
          });
          const entity = registerWorkspaceFileInDb(db, {
            path: input,
            name: 'sample',
            workspaceRoot: root,
            entityType: 'sequence',
            fileKind: 'gz',
          });
          await mkdir(paths.outputDir, { recursive: true });
          await nativeIndexerProcess.execDnaIndexerFile(
            nativeIndexer,
            ['index', '--in', input, '--out-dir', paths.outputDir, '--name', paths.chrom],
            5000
          );
          await writeFile(
            paths.metadataPath,
            JSON.stringify(persistedIndexMetadata(input, paths.chrom, metadata))
          );
          return { input, metadata, paths, entity, expected };
        })
      );
      expect(new Set(prepared.map(({ paths }) => paths.chrom))).toEqual(new Set(['sample']));
      expect(new Set(prepared.map(({ paths }) => paths.outputDir)).size).toBe(fixtures.length);
      expect(new Set(prepared.map(({ entity }) => entity.id)).size).toBe(fixtures.length);
      runtime.state = 'error';
      const checks = await Promise.all(
        prepared.map(async ({ input, metadata, paths, expected }) => {
          const check = openCheck('sequence', input);
          await expect(check.read()).resolves.toBeUndefined();
          const result = await prepareIndexedGenomeSession({
            source: {
              sourcePath: input,
              workspaceRoot: root,
              intent: { kind: 'reference-single' },
            },
            stat: metadata,
            workspaceRoot: root,
            loadChromosomeLength: async (manifest) => {
              const reader = new LocalIndexedGenomeDataSource(manifest);
              try {
                const length = await reader.getChromosomeLength(manifest.chrom);
                expect((await reader.getSequence(manifest.chrom, 0, length)).toUpperCase()).toBe(
                  expected
                );
                return length;
              } finally {
                await reader.close();
              }
            },
          });
          expect(result).toMatchObject({
            reusedExistingIndex: true,
            tabState: {
              sourcePath: input,
              manifest: { fastaPath: paths.manifest.fastaPath, length: expected.length },
            },
          });
          return check;
        })
      );
      await writeFile(prepared[0].paths.manifest.faiPath, 'changed\n');
      await expect(checks[0].verifyCurrent()).rejects.toMatchObject({ code: 'changed' });
      await expect(checks[1].verifyCurrent()).resolves.toEqual(expect.any(String));
      await expect(checks[2].verifyCurrent()).resolves.toEqual(expect.any(String));
    });
  }
);

function persistedIndexMetadata(source: string, chrom: string, metadata: Stats) {
  return {
    length: 8,
    circular: false,
    featureCount: 0,
    chrom,
    sourcePath: source,
    sourceSizeBytes: metadata.size,
    sourceMtimeMs: metadata.mtimeMs,
    sourceCtimeMs: metadata.ctimeMs,
    sourceExt: extensionForPath(source),
    indexedAt: Date.now(),
    schemaVersion: CURRENT_INDEXED_GENOME_SCHEMA,
  };
}
