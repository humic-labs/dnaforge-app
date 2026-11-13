import { describe, expect, it, vi } from 'vitest';
import {
  parseGenBankFull,
  serializeGenBank,
  updateGenBankGeneticCodeComment,
} from '@waypoint/sequence-utils';
import { buildSequencePackageDocument, sequencePackagePaths } from '../../db/sequence-package';
import {
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME,
} from '../../db/sequence-package-contract';
import {
  createManagedSequenceRepository,
  updateGenBankLocusMetadata,
} from './managed-sequence-repository';

function fixtureFs(root = '/workspace/sequence-package') {
  const paths = sequencePackagePaths(root, { productFile: 'physical-file.gb' });
  const files = new Map<string, string>([
    [
      paths.metaPath,
      JSON.stringify(
        buildSequencePackageDocument({
          id: 'sequence-package-123',
          name: 'Biological sequence name',
          product: { file: 'physical-file.gb', topology: 'linear' },
        })
      ),
    ],
    [
      paths.productPath,
      'LOCUS       Physical old name        42 bp    DNA     linear\nORIGIN\n        1 acgt\n//\n',
    ],
  ]);
  const atomicFailures = new Set<string>();
  const fs = {
    exists: async (path: string) => files.has(path),
    readTextFile: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeTextFile: async (path: string, value: string) => {
      files.set(path, value);
    },
    writeWorkspaceTextFileAtomic: async (input: {
      path: string;
      content: string;
      mode: 'create' | 'replace';
    }) => {
      if (atomicFailures.has(input.path)) throw new Error(`atomic write failed: ${input.path}`);
      if (input.mode === 'create' && files.has(input.path)) throw new Error('already exists');
      if (input.mode === 'replace' && !files.has(input.path)) throw new Error('missing');
      files.set(input.path, input.content);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.content));
      return {
        path: input.path,
        contentHash: [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join(''),
      };
    },
    mkdir: async () => undefined,
    move: async (sourcePath: string, destinationDir: string) => ({
      destPath: `${destinationDir}/${sourcePath.split('/').pop() ?? ''}`,
    }),
    readFile: async (path: string) => new TextEncoder().encode(files.get(path) ?? ''),
    rename: async (oldPath: string, newPath: string) => {
      const value = files.get(oldPath);
      if (value === undefined) throw new Error(`ENOENT: ${oldPath}`);
      files.set(newPath, value);
      files.delete(oldPath);
    },
    readDir: async (path: string) => {
      if (path !== root) throw new Error(`ENOENT: ${path}`);
      return [
        { name: 'physical-file.gb', isDirectory: false, isFile: true },
        { name: '.forge', isDirectory: true, isFile: false },
      ];
    },
  };
  return { atomicFailures, files, fs, paths, root };
}

describe('ManagedSequenceRepository', () => {
  it('renames encoded native names without interpreting literal percent text', () => {
    const original = serializeGenBank({
      id: 'fixture',
      name: 'Original name',
      sequence: 'ACGT',
      length: 4,
      annotations: [],
    });
    const renamed = updateGenBankLocusMetadata(original, { name: 'New %20 name 🧬' });
    expect(parseGenBankFull(renamed).name).toBe('New %20 name 🧬');
    expect(renamed.split('\n')[0].split(/\s+/)).toHaveLength(8);
    const circular = updateGenBankLocusMetadata(renamed, { topology: 'circular' });
    expect(parseGenBankFull(circular)).toMatchObject({ name: 'New %20 name 🧬', circular: true });
    expect(circular.slice(circular.indexOf('ORIGIN'))).toBe(
      renamed.slice(renamed.indexOf('ORIGIN'))
    );
  });

  it('turns a package member path into stable package identity', async () => {
    const fixture = fixtureFs();
    const repository = createManagedSequenceRepository(() => fixture.fs);

    await expect(repository.findByMemberPath(fixture.paths.productPath)).resolves.toMatchObject({
      ref: {
        kind: 'managed-sequence',
        packageId: 'sequence-package-123',
        packageRoot: fixture.root,
      },
      productPath: fixture.paths.productPath,
      document: { name: 'Biological sequence name' },
    });
  });

  it('asks the main-owned Quick Look boundary to prepare a package before reading it', async () => {
    const fixture = fixtureFs();
    const preparePackage = vi.fn(async () => undefined);
    const repository = createManagedSequenceRepository(
      () => fixture.fs,
      async () => [],
      vi.fn(),
      preparePackage
    );

    await repository.openPackage(fixture.root);

    expect(preparePackage).toHaveBeenCalledOnce();
    expect(preparePackage).toHaveBeenCalledWith(fixture.root);
  });

  it('borrows the resolving mutation for a legacy package marker migration', async () => {
    const fixture = fixtureFs();
    const legacy = JSON.parse(fixture.files.get(fixture.paths.metaPath)!);
    legacy.formatVersion = 6;
    delete legacy.versionHistory;
    fixture.files.set(fixture.paths.metaPath, JSON.stringify(legacy));
    const write = vi.spyOn(fixture.fs, 'writeWorkspaceTextFileAtomic');
    const repository = createManagedSequenceRepository(() => fixture.fs);

    await repository.resolve(
      {
        kind: 'managed-sequence',
        packageId: 'sequence-package-123',
        packageRoot: fixture.root,
      },
      { mutationToken: 'mount-mutation' }
    );

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ path: fixture.paths.metaPath, mutationToken: 'mount-mutation' })
    );
    expect(JSON.parse(fixture.files.get(fixture.paths.metaPath)!).formatVersion).toBe(
      SEQUENCE_PACKAGE_FORMAT_VERSION
    );
  });

  it('refuses a stale ref that now points at a different package identity', async () => {
    const fixture = fixtureFs();
    const repository = createManagedSequenceRepository(() => fixture.fs);

    await expect(
      repository.resolve({
        kind: 'managed-sequence',
        packageId: 'wrong-package',
        packageRoot: fixture.root,
      })
    ).rejects.toThrow(/identity changed/i);
  });

  it('uses the current catalog package when a persisted tab points at a still-existing copy', async () => {
    const stale = fixtureFs('/other-profile/sequence-package');
    const current = fixtureFs('/workspace/sequence-package');
    const files = new Map([...stale.files, ...current.files]);
    const writes: Array<{ workspaceRoot: string; path: string }> = [];
    const fs = {
      ...current.fs,
      exists: async (path: string) => files.has(path),
      readTextFile: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      },
      readDir: async (path: string) => {
        if (path !== stale.root && path !== current.root) throw new Error(`ENOENT: ${path}`);
        return [
          { name: 'physical-file.gb', isDirectory: false, isFile: true },
          { name: '.forge', isDirectory: true, isFile: false },
        ];
      },
      writeWorkspaceTextFileAtomic: async (input: {
        workspaceRoot: string;
        path: string;
        content: string;
        mode: 'create' | 'replace';
      }) => {
        writes.push({ workspaceRoot: input.workspaceRoot, path: input.path });
        files.set(input.path, input.content);
        return { path: input.path, contentHash: 'written' };
      },
    };
    const repository = createManagedSequenceRepository(
      () => fs,
      async () => [],
      vi.fn(),
      async () => undefined,
      undefined,
      async () => current.root
    );
    const staleRef = {
      kind: 'managed-sequence' as const,
      packageId: 'sequence-package-123',
      packageRoot: stale.root,
    };

    await expect(repository.resolve(staleRef)).resolves.toMatchObject({
      ref: { packageRoot: current.root },
      productPath: current.paths.productPath,
    });
    await repository.updateMetadata(staleRef, (document) => ({
      ...document,
      name: 'Current copy',
    }));

    expect(writes).toEqual([{ workspaceRoot: current.root, path: current.paths.metaPath }]);
    expect(JSON.parse(files.get(current.paths.metaPath) ?? '{}').name).toBe('Current copy');
    expect(JSON.parse(files.get(stale.paths.metaPath) ?? '{}').name).toBe(
      'Biological sequence name'
    );
  });

  it('recovers a moved package by stable id from workspace artifact discovery', async () => {
    const fixture = fixtureFs('/workspace/renamed-folder');
    const repository = createManagedSequenceRepository(
      () => fixture.fs,
      async () => [fixture.paths.metaPath]
    );

    await expect(
      repository.findById('sequence-package-123', ['/workspace'])
    ).resolves.toMatchObject({
      ref: {
        packageId: 'sequence-package-123',
        packageRoot: '/workspace/renamed-folder',
      },
    });
  });

  it('updates metadata without changing the product filename or package id', async () => {
    const fixture = fixtureFs();
    const commitUpdate = vi.fn().mockResolvedValue(undefined);
    const repository = createManagedSequenceRepository(
      () => fixture.fs,
      async () => [],
      commitUpdate
    );
    const opened = await repository.openPackage(fixture.root);

    const next = await repository.updateMetadata(opened.ref, (current) => ({
      ...current,
      name: 'Renamed biological sequence',
      entity: {
        ...current.entity,
        fields: { description: 'A sparse optional field.' },
      },
      updatedAt: '2026-08-17T00:00:00.000Z',
    }));

    expect(next).toMatchObject({
      id: 'sequence-package-123',
      name: 'Renamed biological sequence',
      product: { file: 'physical-file.gb' },
      entity: { fields: { description: 'A sparse optional field.' } },
    });
    expect(parseGenBankFull(fixture.files.get(fixture.paths.productPath) ?? '').name).toBe(
      'Physical old name'
    );
    expect(fixture.files.get(fixture.paths.productPath)).toContain('ORIGIN\n        1 acgt');
    expect(commitUpdate).toHaveBeenCalledWith({
      packageRoot: fixture.root,
      metaPath: fixture.paths.metaPath,
      productPath: fixture.paths.productPath,
      productChanged: false,
      transactionPath: undefined,
      name: 'Renamed biological sequence',

      changes: ['name (Biological sequence name -> Renamed biological sequence)', 'fields'],
    });
  });

  it('rolls a crashed compound metadata update forward on the next package open', async () => {
    const fixture = fixtureFs();
    fixture.atomicFailures.add(fixture.paths.metaPath);
    const repository = createManagedSequenceRepository(
      () => fixture.fs,
      async () => [],
      vi.fn()
    );
    const opened = await repository.openPackage(fixture.root);

    await expect(
      repository.updateMetadata(opened.ref, (current) => ({
        ...current,
        entity: {
          ...current.entity,
          fields: { ...current.entity.fields, locus: 'Recovered locus' },
        },
      }))
    ).rejects.toThrow(/atomic write failed/i);

    const transactionPath = `${fixture.paths.metaDir}/${SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME}`;
    expect(parseGenBankFull(fixture.files.get(fixture.paths.productPath) ?? '').name).toBe(
      'Recovered locus'
    );
    expect(JSON.parse(fixture.files.get(fixture.paths.metaPath) ?? '{}').name).toBe(
      'Biological sequence name'
    );
    expect(JSON.parse(fixture.files.get(transactionPath) ?? '{}').state).toBe('pending');

    fixture.atomicFailures.clear();
    const reopened = await createManagedSequenceRepository(
      () => fixture.fs,
      async () => [],
      vi.fn()
    ).openPackage(fixture.root);

    expect(reopened.document.name).toBe('Biological sequence name');
    expect(reopened.document.entity.fields.locus).toBe('Recovered locus');
    expect(parseGenBankFull(fixture.files.get(fixture.paths.productPath) ?? '').name).toBe(
      'Recovered locus'
    );
    expect(JSON.parse(fixture.files.get(transactionPath) ?? '{}').state).toBe('complete');
  });

  it('persists topology to both package metadata and the GenBank LOCUS mirror', async () => {
    const fixture = fixtureFs();
    const commitUpdate = vi.fn().mockResolvedValue(undefined);
    const repository = createManagedSequenceRepository(
      () => fixture.fs,
      async () => [],
      commitUpdate
    );
    const opened = await repository.openPackage(fixture.root);

    const next = await repository.updateMetadata(opened.ref, (current) => ({
      ...current,
      product: { ...current.product, topology: 'circular' },
    }));

    expect(next.product.topology).toBe('circular');
    expect(parseGenBankFull(fixture.files.get(fixture.paths.productPath) ?? '')).toMatchObject({
      name: 'Physical old name',
      length: 42,
      circular: true,
    });
    expect(JSON.parse(fixture.files.get(fixture.paths.metaPath) ?? '{}').product.topology).toBe(
      'circular'
    );
    expect(commitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ productChanged: true, name: 'Biological sequence name' })
    );
  });
});

describe('genetic code through the metadata drawer ', () => {
  const CURATED = [
    'LOCUS       NC_001224              12 bp    DNA     circular PLN 03-APR-2023',
    'DEFINITION  Saccharomyces cerevisiae S288c mitochondrion, complete genome.',
    'ACCESSION   NC_001224',
    'REFERENCE   1  (bases 1 to 12)',
    '  AUTHORS   Foury,F.',
    'COMMENT     REVIEWED REFSEQ: curated by hand.',
    'FEATURES             Location/Qualifiers',
    '     source          1..12',
    '                     /organelle="mitochondrion"',
    'ORIGIN',
    '        1 atgtgaaaataa',
    '//',
    '',
  ].join('\n');

  it('inserts, replaces and removes the marker without touching anything else', () => {
    const withCode = updateGenBankGeneticCodeComment(CURATED, 3);
    expect(parseGenBankFull(withCode).chosenGeneticCode).toBe(3);

    for (const line of CURATED.split('\n')) {
      if (line) expect(withCode).toContain(line);
    }
    expect(withCode.slice(withCode.indexOf('FEATURES'))).toBe(
      CURATED.slice(CURATED.indexOf('FEATURES'))
    );

    const replaced = updateGenBankGeneticCodeComment(withCode, 4);
    expect(parseGenBankFull(replaced).chosenGeneticCode).toBe(4);
    expect(replaced.split('\n').filter((l) => l.includes('genetic-code'))).toHaveLength(1);

    const cleared = updateGenBankGeneticCodeComment(replaced, null);
    expect(parseGenBankFull(cleared).chosenGeneticCode).toBeUndefined();
    expect(cleared).toBe(CURATED);
  });

  it("does not disturb the record's own curated COMMENT", () => {
    const withCode = updateGenBankGeneticCodeComment(CURATED, 3);
    expect(withCode).toContain('COMMENT     REVIEWED REFSEQ: curated by hand.');
    expect(updateGenBankGeneticCodeComment(withCode, null)).toContain(
      'COMMENT     REVIEWED REFSEQ: curated by hand.'
    );
  });

  it('is a no-op when the file already says what was asked for', () => {
    const withCode = updateGenBankGeneticCodeComment(CURATED, 3);
    expect(updateGenBankGeneticCodeComment(withCode, 3)).toBe(withCode);
    expect(updateGenBankGeneticCodeComment(CURATED, null)).toBe(CURATED);
  });

  it('refuses text with no LOCUS to anchor to, instead of prepending a stray line', () => {
    expect(() => updateGenBankGeneticCodeComment('not a genbank file\n', 3)).toThrow(/LOCUS/);
  });

  it('writes the code into the product file through the crash-safe transaction', async () => {
    const fixture = fixtureFs();
    const repository = createManagedSequenceRepository(() => fixture.fs);
    const ref = (await repository.findByMemberPath(fixture.paths.productPath))!.ref;

    await repository.updateMetadata(ref, (current) => current, { geneticCode: 3 });

    const product = fixture.files.get(fixture.paths.productPath)!;
    expect(parseGenBankFull(product).chosenGeneticCode).toBe(3);

    expect(fixture.files.get(fixture.paths.metaPath)).not.toContain('geneticCode');

    const transaction = fixture.files.get(
      `${fixture.paths.metaDir}/${SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME}`
    );
    expect(transaction).toContain('"state": "complete"');
  });

  it('leaves the LOCUS line alone when only the genetic code changed', async () => {
    const fixture = fixtureFs();
    const repository = createManagedSequenceRepository(() => fixture.fs);
    const ref = (await repository.findByMemberPath(fixture.paths.productPath))!.ref;
    const locusBefore = fixture.files.get(fixture.paths.productPath)!.split('\n')[0];

    await repository.updateMetadata(ref, (current) => current, { geneticCode: 3 });

    const product = fixture.files.get(fixture.paths.productPath)!;
    expect(product.split('\n')[0]).toBe(locusBefore);
    expect(parseGenBankFull(product).chosenGeneticCode).toBe(3);
  });

  it('rewrites the LOCUS token only when the Locus field changes', async () => {
    const fixture = fixtureFs();
    const repository = createManagedSequenceRepository(() => fixture.fs);
    const ref = (await repository.findByMemberPath(fixture.paths.productPath))!.ref;

    await repository.updateMetadata(
      ref,
      (current) => ({
        ...current,
        name: 'Renamed record',
        entity: { ...current.entity, fields: { ...current.entity.fields, locus: 'SYN-NEW' } },
      }),
      { geneticCode: 3 }
    );

    const product = fixture.files.get(fixture.paths.productPath)!;
    expect(parseGenBankFull(product)).toMatchObject({
      name: 'SYN-NEW',
      chosenGeneticCode: 3,
    });
    expect(JSON.parse(fixture.files.get(fixture.paths.metaPath) ?? '{}').name).toBe(
      'Renamed record'
    );
  });

  it('names what changed in the commit subject, not just "metadata"', async () => {
    const fixture = fixtureFs();
    const commits: string[] = [];
    const repository = createManagedSequenceRepository(
      () => fixture.fs,
      undefined,
      async (input) => {
        commits.push(
          `Update ${input.changes?.length ? input.changes.join(', ') : 'metadata'} for ${input.name}`
        );
      }
    );
    const ref = (await repository.findByMemberPath(fixture.paths.productPath))!.ref;

    await repository.updateMetadata(ref, (current) => current, { geneticCode: 3 });
    expect(commits[0]).toContain('genetic code (3)');

    await repository.updateMetadata(ref, (current) => current, { geneticCode: null });
    expect(commits[1]).toContain('genetic code (cleared');

    await repository.updateMetadata(ref, (current) => ({ ...current, name: 'Renamed' }));
    expect(commits[2]).toContain('name (');
    expect(commits[2]).not.toContain('genetic code');
  });

  it('clears the code when asked, and leaves it alone when not', async () => {
    const fixture = fixtureFs();
    const repository = createManagedSequenceRepository(() => fixture.fs);
    const ref = (await repository.findByMemberPath(fixture.paths.productPath))!.ref;

    await repository.updateMetadata(ref, (current) => current, { geneticCode: 3 });
    expect(parseGenBankFull(fixture.files.get(fixture.paths.productPath)!).chosenGeneticCode).toBe(
      3
    );

    await repository.updateMetadata(ref, (current) => ({ ...current, name: 'Renamed' }));
    expect(parseGenBankFull(fixture.files.get(fixture.paths.productPath)!).chosenGeneticCode).toBe(
      3
    );

    await repository.updateMetadata(ref, (current) => current, { geneticCode: null });
    expect(
      parseGenBankFull(fixture.files.get(fixture.paths.productPath)!).chosenGeneticCode
    ).toBeUndefined();
  });
});
