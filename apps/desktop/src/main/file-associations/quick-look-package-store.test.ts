import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeSequenceDocument, parseGenBankFull } from '@waypoint/sequence-utils';
import { parseSequencePackageDocument } from '../../db/sequence-package';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../../db/sequence-package-contract';
import { BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT } from '../../shared/sequence-entity-schema';
import {
  createQuickLookPackageStore,
  QUICK_LOOK_MAX_GENBANK_RECORDS,
  QUICK_LOOK_MAX_SOURCE_BYTES,
  type VerifiedQuickLookGenerationSnapshot,
} from './quick-look-package-store';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    total += entry.isDirectory()
      ? await directoryBytes(entryPath)
      : (await fs.stat(entryPath)).size;
  }
  return total;
}

function generationRootFor(packageRoot: string): string {
  return resolve(packageRoot, '../../..');
}

describe('createQuickLookPackageStore', () => {
  let root: string;
  let userDataRoot: string;
  let sourceRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'fixture-quick-look-'));
    userDataRoot = join(root, 'user-data');
    sourceRoot = join(root, 'external');
    await fs.mkdir(sourceRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('adopts a former generation from its cached original without rebinding an existing project copy', async () => {
    const path = join(sourceRoot, 'old.gb');
    const bytes = Buffer.from(
      'LOCUS       old      4 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n'
    );
    await fs.writeFile(path, bytes);
    const store = createQuickLookPackageStore(userDataRoot);
    const current = await store.materialize({ sourcePath: path, familyId: 'genbank' });
    const currentRoot = generationRootFor(current.packageRoot);
    const legacyKey = createHash('sha256')
      .update('genbank\0' + current.sourcePath + '\0' + current.contentHash)
      .digest('hex');
    const oldRoot = join(dirname(currentRoot), legacyKey);
    await fs.rename(currentRoot, oldRoot);
    const originalInput = JSON.stringify(current);
    const legacy = JSON.parse(originalInput.replaceAll(currentRoot, oldRoot));
    const previousId = JSON.parse(
      await fs.readFile(join(legacy.packageRoot, '.forge', 'plasmid.json'), 'utf8')
    ).id;
    await fs.unlink(path);
    const adopted = await store.recoverReceipt(legacy);
    expect(adopted.contentHash).toBe(current.contentHash);
    expect(adopted.packageRoot).toBe(current.packageRoot);
    expect(await fs.readFile(await store.originalPath(adopted))).toEqual(bytes);
    const newId = JSON.parse(
      await fs.readFile(join(adopted.packageRoot, '.forge', 'plasmid.json'), 'utf8')
    ).id;
    expect(newId).not.toBe(previousId);
    await fs.appendFile(adopted.productPath, 'tampered');
    await expect(store.originalPath(adopted)).rejects.toThrow(/incomplete or changed/);
  });

  it('copies exact GenBank bytes into one persistent package without changing the source', async () => {
    const sourcePath = join(sourceRoot, 'pUC19.gb');
    const sourceBytes = Buffer.from(
      'LOCUS       pUC19       12 bp    DNA     circular SYN 01-JAN-2000\nORIGIN\n        1 acgtacgtac gt\n//\n',
      'utf8'
    );
    await fs.writeFile(sourcePath, sourceBytes);
    const before = await fs.readFile(sourcePath);
    const store = createQuickLookPackageStore(userDataRoot);

    const [first, concurrent] = await Promise.all([
      store.materialize({ sourcePath, familyId: 'genbank' }),
      store.materialize({ sourcePath, familyId: 'genbank' }),
    ]);

    expect(concurrent).toEqual(first);
    expect(await fs.readFile(first.productPath)).toEqual(sourceBytes);
    expect(await fs.readFile(sourcePath)).toEqual(before);
    await expect(fs.stat(join(first.packageRoot, '.forge', 'plasmid.json'))).resolves.toMatchObject(
      {
        isFile: expect.any(Function),
      }
    );

    const reopened = await store.materialize({ sourcePath, familyId: 'genbank' });
    expect(reopened).toEqual(first);
    expect(first.records).toHaveLength(1);
  });

  it('keeps a one-record GenBank preamble and trailer in the exact ordinary product', async () => {
    const sourcePath = join(sourceRoot, 'transport-wrapped.gb');
    const sourceBytes = Buffer.from(
      'download header\r\nLOCUS       wrapped      4 bp    DNA     linear\r\nORIGIN\r\n        1 acgt\r\n//\r\ntransport trailer\r\n',
      'utf8'
    );
    await fs.writeFile(sourcePath, sourceBytes);

    const receipt = await createQuickLookPackageStore(userDataRoot).materialize({
      sourcePath,
      familyId: 'genbank',
    });

    expect(receipt.records).toHaveLength(1);
    expect(await fs.readFile(receipt.productPath)).toEqual(sourceBytes);
  });

  it('rejects pathological GenBank record amplification before creating packages', async () => {
    const sourcePath = join(sourceRoot, 'too-many-records.gbk');
    const record = (ordinal: number): string =>
      `LOCUS       record_${ordinal}       1 bp    DNA     linear\nORIGIN\n        1 a\n//\n`;
    await fs.writeFile(
      sourcePath,
      Array.from({ length: QUICK_LOOK_MAX_GENBANK_RECORDS + 1 }, (_, index) => record(index)).join(
        ''
      ),
      'utf8'
    );

    await expect(
      createQuickLookPackageStore(userDataRoot).materialize({ sourcePath, familyId: 'genbank' })
    ).rejects.toThrow(`more than ${QUICK_LOOK_MAX_GENBANK_RECORDS.toLocaleString()} records`);
    expect(await fs.readdir(join(userDataRoot, 'quick-look-packages')).catch(() => [])).toEqual([]);
  });

  it.each([
    ['2 aa', 'mf', 'nucleotide LOCUS'],
    ['3 bp', 'ac', 'length'],
    ['2 bp', 'ef', 'nucleotide alphabet'],
  ])(
    'rejects the whole external set when a later record has unsupported %s / %s',
    async (locus, sequence, reason) => {
      const path = join(sourceRoot, 'mixed.gb');
      const text =
        'LOCUS       repeat   2 bp DNA\nORIGIN\n        1 ac\n//\n' +
        `LOCUS       repeat   ${locus}\nORIGIN\n        1 ${sequence}\n//\n`;
      await fs.writeFile(path, text);
      await expect(
        createQuickLookPackageStore(userDataRoot).materialize({
          sourcePath: path,
          familyId: 'genbank',
        })
      ).rejects.toThrow(reason);
      expect(await fs.readFile(path, 'utf8')).toBe(text);
      expect(await fs.readdir(join(userDataRoot, 'quick-look-packages'))).toEqual([]);
    }
  );

  it('creates one ordinary package per GenBank record and preserves the complete source once', async () => {
    const sourcePath = join(sourceRoot, 'assembly.gbk');
    const firstRecord =
      'LOCUS       chromosome_one       4 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n';
    const secondRecord =
      'LOCUS       chromosome_two       6 bp    DNA     linear\nORIGIN\n        1 ttgcaa\n//\n';
    const sourceBytes = Buffer.from(`${firstRecord}\n${secondRecord}`, 'utf8');
    await fs.writeFile(sourcePath, sourceBytes);
    const store = createQuickLookPackageStore(userDataRoot);

    const receipt = await store.materialize({ sourcePath, familyId: 'genbank' });

    expect(
      receipt.records.map(({ displayName, sequenceLength }) => ({ displayName, sequenceLength }))
    ).toEqual([
      { displayName: 'chromosome_one', sequenceLength: 4 },
      { displayName: 'chromosome_two', sequenceLength: 6 },
    ]);
    expect(await fs.readFile(receipt.records[0].productPath, 'utf8')).toBe(firstRecord);
    expect(await fs.readFile(receipt.records[1].productPath, 'utf8')).toBe(secondRecord);
    expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
    const firstPackageRoot = dirname(receipt.records[0].productPath);
    expect(await fs.readFile(join(firstPackageRoot, 'contents', 'assembly.gbk'))).toEqual(
      sourceBytes
    );
    await expect(
      fs.stat(join(dirname(receipt.records[1].productPath), 'contents', 'assembly.gbk'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rebuilds a cached generation whose product bytes were modified', async () => {
    const sourcePath = join(sourceRoot, 'tamper.gb');
    const sourceBytes = await fs.readFile(
      join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb')
    );
    await fs.writeFile(sourcePath, sourceBytes);
    const store = createQuickLookPackageStore(userDataRoot);
    const first = await store.materialize({ sourcePath, familyId: 'genbank' });
    await fs.writeFile(first.productPath, 'tampered cache bytes');

    const rebuilt = await store.materialize({ sourcePath, familyId: 'genbank' });

    expect(rebuilt).toEqual(first);
    expect(await fs.readFile(rebuilt.productPath)).toEqual(sourceBytes);
  });

  it('rebuilds a cached generation whose package record was corrupted', async () => {
    const sourcePath = join(sourceRoot, 'marker-tamper.gb');
    const sourceBytes = await fs.readFile(
      join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb')
    );
    await fs.writeFile(sourcePath, sourceBytes);
    const store = createQuickLookPackageStore(userDataRoot);
    const first = await store.materialize({ sourcePath, familyId: 'genbank' });
    const markerPath = join(first.packageRoot, '.forge', 'plasmid.json');
    await fs.writeFile(markerPath, '{"truncated":true}', 'utf8');

    const rebuilt = await store.materialize({ sourcePath, familyId: 'genbank' });

    expect(rebuilt).toEqual(first);
    const rebuiltMarker = await fs.readFile(markerPath, 'utf8');
    expect(() => parseSequencePackageDocument(rebuiltMarker)).not.toThrow();
    expect(await fs.readFile(rebuilt.productPath)).toEqual(sourceBytes);
  });

  it('migrates a protected v4 cache in main and preserves it after the source disappears', async () => {
    const sourcePath = join(sourceRoot, 'upgrade-cache.gb');
    const sourceBytes = await fs.readFile(
      join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb')
    );
    await fs.writeFile(sourcePath, sourceBytes);
    const store = createQuickLookPackageStore(userDataRoot);
    const receipt = await store.materialize({ sourcePath, familyId: 'genbank' });
    const markerPath = join(receipt.packageRoot, '.forge', 'plasmid.json');
    const generationRoot = generationRootFor(receipt.packageRoot);
    const manifestPath = join(generationRoot, 'quick-look.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Record<string, unknown>;
    marker.formatVersion = 4;
    delete marker.entity;
    const v4Marker = JSON.stringify(marker, null, 2);
    await fs.writeFile(markerPath, v4Marker, 'utf8');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      records: Array<{ files: Array<{ relativePath: string; sha256: string }> }>;
    };
    const markerFile = manifest.records[0]?.files.find(
      (file) => file.relativePath === '.forge/plasmid.json'
    );
    if (!markerFile) throw new Error('Quick Look fixture manifest omitted package metadata.');
    markerFile.sha256 = createHash('sha256').update(v4Marker).digest('hex');
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await fs.rm(sourcePath);

    await expect(store.preparePackage(receipt.packageRoot)).resolves.toBe(true);

    const migratedMarker = await fs.readFile(markerPath, 'utf8');
    expect(parseSequencePackageDocument(migratedMarker).formatVersion).toBe(
      SEQUENCE_PACKAGE_FORMAT_VERSION
    );
    expect(JSON.parse(migratedMarker)).toMatchObject({
      formatVersion: SEQUENCE_PACKAGE_FORMAT_VERSION,
      entity: {
        schema: {
          schemaRevisionId: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.schemaRevisionId,
          version: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT.version,
        },
      },
    });
    expect(await fs.readFile(receipt.productPath)).toEqual(sourceBytes);
    const importer = vi.fn(async (snapshot: VerifiedQuickLookGenerationSnapshot) => ({
      destPath: '/workspace/upgrade-cache/upgrade-cache.gb',
      relPath: 'upgrade-cache/upgrade-cache.gb',
      committed: true,
      records: snapshot.records.map((record) => ({
        recordId: record.recordId,
        destPath: '/workspace/upgrade-cache/upgrade-cache.gb',
        relPath: 'upgrade-cache/upgrade-cache.gb',
      })),
    }));
    await expect(
      store.promote({ receipt, targetRoot: '/workspace' }, importer)
    ).resolves.toMatchObject({ committed: true });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('publishes a new immutable generation when source content changes', async () => {
    const sourcePath = join(sourceRoot, 'changed.gb');
    const firstBytes = Buffer.from(
      'LOCUS       changed       4 bp    DNA     linear SYN 01-JAN-2000\nORIGIN\n        1 acgt\n//\n',
      'utf8'
    );
    const secondBytes = Buffer.from(
      'LOCUS       changed       8 bp    DNA     linear SYN 01-JAN-2000\nORIGIN\n        1 acgtacgt\n//\n',
      'utf8'
    );
    await fs.writeFile(sourcePath, firstBytes);
    const store = createQuickLookPackageStore(userDataRoot);
    const first = await store.materialize({ sourcePath, familyId: 'genbank' });

    await fs.writeFile(sourcePath, secondBytes);
    const second = await store.materialize({ sourcePath, familyId: 'genbank' });

    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.packageRoot).not.toBe(first.packageRoot);
    expect(await fs.readFile(first.productPath)).toEqual(firstBytes);
    expect(await fs.readFile(second.productPath)).toEqual(secondBytes);
  });

  it('decodes SnapGene into an ordinary GenBank package and leaves the binary untouched', async () => {
    const fixture = join(REPO_ROOT, 'test-fixtures/sequences/snapgene/sample-f.dna');
    const sourcePath = join(sourceRoot, 'sample-f.dna');
    const sourceBytes = await fs.readFile(fixture);
    const sourceDocument = decodeSequenceDocument(sourceBytes, {
      format: 'snapgene',
      filename: 'sample-f.dna',
      path: sourcePath,
    });
    await fs.writeFile(sourcePath, sourceBytes);
    const store = createQuickLookPackageStore(userDataRoot);

    const receipt = await store.materialize({ sourcePath, familyId: 'snapgene' });

    expect(receipt.productPath.endsWith('.gb')).toBe(true);
    expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
    const product = await fs.readFile(receipt.productPath, 'utf8');
    expect(() => parseGenBankFull(product)).not.toThrow();
    const parsedProduct = parseGenBankFull(product);
    expect(parsedProduct.sequence).toBe(sourceDocument.sequence.sequence);
    expect(parsedProduct.circular).toBe(sourceDocument.sequence.circular);
    expect(parsedProduct.annotations.map((annotation) => annotation.name)).toEqual(
      expect.arrayContaining(
        sourceDocument.sequence.annotations.map((annotation) => annotation.name)
      )
    );
    expect(await fs.readFile(join(receipt.packageRoot, 'contents', 'sample-f.dna'))).toEqual(
      sourceBytes
    );
    const packageDocument = parseSequencePackageDocument(
      await fs.readFile(join(receipt.packageRoot, '.forge', 'plasmid.json'), 'utf8')
    );
    expect(packageDocument.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          path: 'contents/sample-f.dna',
          replaceable: false,
        }),
      ])
    );
  });

  it('rejects relative paths, directories, and mismatched family extensions', async () => {
    const store = createQuickLookPackageStore(userDataRoot);
    await expect(
      store.materialize({ sourcePath: 'relative.gb', familyId: 'genbank' })
    ).rejects.toThrow('absolute');
    await expect(
      store.materialize({ sourcePath: sourceRoot, familyId: 'genbank' })
    ).rejects.toThrow('file');
    const sourcePath = join(sourceRoot, 'wrong.dna');
    await fs.writeFile(sourcePath, 'not snapgene');
    await expect(store.materialize({ sourcePath, familyId: 'genbank' })).rejects.toThrow(
      'does not match'
    );
    const malformedPath = join(sourceRoot, 'malformed.gb');
    await fs.writeFile(malformedPath, 'not genbank');
    await expect(
      store.materialize({ sourcePath: malformedPath, familyId: 'genbank' })
    ).rejects.toThrow();
    expect(
      (await fs.readdir(join(userDataRoot, 'quick-look-packages'))).filter(
        (entry) => !entry.startsWith('.staging-')
      )
    ).toEqual([]);
  });

  it.each([
    { familyId: 'genbank' as const, extension: '.gb' },
    { familyId: 'snapgene' as const, extension: '.dna' },
  ])('rejects oversized $familyId sources before creating cache state', async (input) => {
    const sourcePath = join(sourceRoot, `oversized${input.extension}`);
    const handle = await fs.open(sourcePath, 'w');
    await handle.truncate(QUICK_LOOK_MAX_SOURCE_BYTES[input.familyId] + 1);
    await handle.close();
    const store = createQuickLookPackageStore(userDataRoot);

    await expect(store.materialize({ sourcePath, familyId: input.familyId })).rejects.toThrow(
      'too large for Quick Look'
    );
    await expect(fs.stat(join(userDataRoot, 'quick-look-packages'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fs.stat(sourcePath)).size).toBe(QUICK_LOOK_MAX_SOURCE_BYTES[input.familyId] + 1);
  });

  it('rejects a sparse 10 GiB drop from metadata without creating cache state', async () => {
    const sourcePath = join(sourceRoot, 'accidental-10-gib.gb');
    const handle = await fs.open(sourcePath, 'w');
    await handle.truncate(10 * 1024 * 1024 * 1024);
    await handle.close();
    const store = createQuickLookPackageStore(userDataRoot);

    await expect(store.materialize({ sourcePath, familyId: 'genbank' })).rejects.toThrow(
      'too large for Quick Look'
    );
    await expect(fs.stat(join(userDataRoot, 'quick-look-packages'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await fs.stat(sourcePath)).size).toBe(10 * 1024 * 1024 * 1024);
  });

  it('uses the established in-memory parser boundary for GenBank admission', () => {
    expect(QUICK_LOOK_MAX_SOURCE_BYTES.genbank).toBe(20 * 1024 * 1024 - 1);
    expect(QUICK_LOOK_MAX_SOURCE_BYTES.snapgene).toBe(64 * 1024 * 1024);
  });

  it('deduplicates concurrent materialization before publishing a generation', async () => {
    const sourcePath = join(sourceRoot, 'concurrent.gb');
    await fs.copyFile(join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb'), sourcePath);
    const store = createQuickLookPackageStore(userDataRoot);

    const [first, second] = await Promise.all([
      store.materialize({ sourcePath, familyId: 'genbank' }),
      store.materialize({ sourcePath, familyId: 'genbank' }),
    ]);

    expect(second).toEqual(first);
    expect(
      (await fs.readdir(join(userDataRoot, 'quick-look-packages'))).filter(
        (entry) => !entry.startsWith('.staging-')
      )
    ).toEqual([basename(resolve(first.packageRoot, '../../..'))]);
  });

  it('removes crash-stranded staging directories before materializing', async () => {
    const sourcePath = join(sourceRoot, 'after-crash.gb');
    await fs.copyFile(join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb'), sourcePath);
    const storeRoot = join(userDataRoot, 'quick-look-packages');
    const staleRoot = join(storeRoot, '.staging-abandoned');
    await fs.mkdir(staleRoot, { recursive: true });
    await fs.writeFile(join(staleRoot, 'partial.gb'), 'partial');

    const receipt = await createQuickLookPackageStore(userDataRoot).materialize({
      sourcePath,
      familyId: 'genbank',
    });

    await expect(fs.stat(staleRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.stat(receipt.productPath)).toMatchObject({ size: expect.any(Number) });
  });

  it('restores a quarantined generation when replacement crashed before publication', async () => {
    const sourcePath = join(sourceRoot, 'quarantine-recovery.gb');
    await fs.copyFile(join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb'), sourcePath);
    const store = createQuickLookPackageStore(userDataRoot);
    const first = await store.materialize({ sourcePath, familyId: 'genbank' });
    const generationRoot = dirname(first.packageRoot);
    const generationKey = basename(generationRoot);
    const quarantineRoot = join(
      userDataRoot,
      'quick-look-packages',
      `.invalid-${generationKey}-interrupted`
    );
    await fs.rename(generationRoot, quarantineRoot);

    const recovered = await store.materialize({ sourcePath, familyId: 'genbank' });

    expect(recovered).toEqual(first);
    await expect(fs.stat(first.productPath)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    await expect(fs.stat(quarantineRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds promotion to the verified complete package snapshot', async () => {
    const sourcePath = join(sourceRoot, 'promote.dna');
    await fs.copyFile(join(REPO_ROOT, 'test-fixtures/sequences/snapgene/sample-f.dna'), sourcePath);
    const store = createQuickLookPackageStore(userDataRoot);
    const receipt = await store.materialize({ sourcePath, familyId: 'snapgene' });
    const importer = vi.fn(async (snapshot: VerifiedQuickLookGenerationSnapshot) => {
      expect(snapshot.records[0]?.files.map((file) => file.relativePath)).toEqual(
        expect.arrayContaining(['.forge/plasmid.json', 'promote.gb', 'contents/promote.dna'])
      );
      return {
        destPath: '/workspace/promote/promote.gb',
        relPath: 'promote/promote.gb',
        committed: true,
        records: [
          {
            recordId: snapshot.records[0]!.recordId,
            destPath: '/workspace/promote/promote.gb',
            relPath: 'promote/promote.gb',
          },
        ],
      };
    });

    await expect(
      store.promote({ receipt, targetRoot: '/workspace' }, importer)
    ).resolves.toMatchObject({ destPath: '/workspace/promote/promote.gb' });
    expect(importer).toHaveBeenCalledTimes(1);

    await fs.writeFile(receipt.productPath, 'changed after the tab opened');
    await expect(store.promote({ receipt, targetRoot: '/workspace' }, importer)).rejects.toThrow(
      'snapshot changed or is incomplete'
    );
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('bounds total persistent Quick Look storage without evicting existing packages', async () => {
    const firstPath = join(sourceRoot, 'first.gb');
    const secondPath = join(sourceRoot, 'second.gb');
    const fixture = join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb');
    await fs.copyFile(fixture, firstPath);
    await fs.copyFile(fixture, secondPath);
    const first = await createQuickLookPackageStore(userDataRoot).materialize({
      sourcePath: firstPath,
      familyId: 'genbank',
    });
    const firstBytes = await fs.readFile(first.productPath);
    const publishedBytes = await directoryBytes(generationRootFor(first.packageRoot));
    const measurementRoot = join(root, 'measurement');
    const measuredSecond = await createQuickLookPackageStore(measurementRoot).materialize({
      sourcePath: secondPath,
      familyId: 'genbank',
    });
    const secondGenerationBytes = await directoryBytes(
      generationRootFor(measuredSecond.packageRoot)
    );
    const boundedStore = createQuickLookPackageStore(userDataRoot, {
      maxStoreBytes: publishedBytes + secondGenerationBytes - 1,
    });

    await expect(
      boundedStore.materialize({ sourcePath: secondPath, familyId: 'genbank' })
    ).rejects.toThrow('Quick Look storage is full');
    expect(await fs.readFile(first.productPath)).toEqual(firstBytes);
    expect(
      (await fs.readdir(join(userDataRoot, 'quick-look-packages'))).filter(
        (entry) => !entry.startsWith('.staging-')
      )
    ).toHaveLength(1);
  });

  it('rejects a generation larger than an empty store quota', async () => {
    const sourcePath = join(sourceRoot, 'larger-than-quota.gb');
    await fs.copyFile(join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb'), sourcePath);

    await expect(
      createQuickLookPackageStore(userDataRoot, { maxStoreBytes: 1 }).materialize({
        sourcePath,
        familyId: 'genbank',
      })
    ).rejects.toThrow('Quick Look storage is full');
    expect(
      (await fs.readdir(join(userDataRoot, 'quick-look-packages'))).filter(
        (entry) => !entry.startsWith('.staging-')
      )
    ).toEqual([]);
  });

  it.each([
    {
      label: 'SnapGene',
      familyId: 'snapgene' as const,
      fileName: 'exact-fit.dna',
      source: async (): Promise<Uint8Array> =>
        fs.readFile(join(REPO_ROOT, 'test-fixtures/sequences/snapgene/sample-f.dna')),
    },
    {
      label: 'multi-record GenBank',
      familyId: 'genbank' as const,
      fileName: 'exact-fit.gbk',
      source: async (): Promise<Uint8Array> =>
        Buffer.from(
          'LOCUS       exact_one       4 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n' +
            'LOCUS       exact_two       6 bp    DNA     linear\nORIGIN\n        1 ttgcaa\n//\n',
          'utf8'
        ),
    },
  ])('accepts an exact final-generation quota for $label', async (input) => {
    const sourcePath = join(sourceRoot, input.fileName);
    await fs.writeFile(sourcePath, await input.source());
    const measurementRoot = join(root, `measure-${input.familyId}`);
    const measured = await createQuickLookPackageStore(measurementRoot).materialize({
      sourcePath,
      familyId: input.familyId,
    });
    const exactGenerationBytes = await directoryBytes(generationRootFor(measured.packageRoot));
    const exactRoot = join(root, `exact-${input.familyId}`);

    const receipt = await createQuickLookPackageStore(exactRoot, {
      maxStoreBytes: exactGenerationBytes,
    }).materialize({ sourcePath, familyId: input.familyId });

    expect(receipt.records.length).toBe(input.familyId === 'genbank' ? 2 : 1);
    expect(await directoryBytes(join(exactRoot, 'quick-look-packages'))).toBe(exactGenerationBytes);
  });

  it('serializes distinct sources so only one can consume the remaining quota', async () => {
    const fixture = join(REPO_ROOT, 'test-fixtures/sequences/circular/pUC19.gb');
    const firstPath = join(sourceRoot, 'quota-race-a.gb');
    const secondPath = join(sourceRoot, 'quota-race-b.gb');
    await Promise.all([fs.copyFile(fixture, firstPath), fs.copyFile(fixture, secondPath)]);

    const measureA = await createQuickLookPackageStore(join(root, 'measure-a')).materialize({
      sourcePath: firstPath,
      familyId: 'genbank',
    });
    const measureB = await createQuickLookPackageStore(join(root, 'measure-b')).materialize({
      sourcePath: secondPath,
      familyId: 'genbank',
    });
    const maxStoreBytes = Math.max(
      await directoryBytes(generationRootFor(measureA.packageRoot)),
      await directoryBytes(generationRootFor(measureB.packageRoot))
    );
    const store = createQuickLookPackageStore(userDataRoot, { maxStoreBytes });

    const results = await Promise.allSettled([
      store.materialize({ sourcePath: firstPath, familyId: 'genbank' }),
      store.materialize({ sourcePath: secondPath, familyId: 'genbank' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await directoryBytes(join(userDataRoot, 'quick-look-packages'))).toBeLessThanOrEqual(
      maxStoreBytes
    );
  });
});
