import { createHash } from 'node:crypto';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import git from 'isomorphic-git';
import * as nativeGit from './native';
import {
  initManagedRepo,
  hasWorkingChanges,
  commitAllIfDirty,
  commitOwnedPathsIfDirty,
  commitPathsIfDirty,
  flushManagedCommitDurably,
  listFilesAtHead,
  readBlobOidAtHead,
  readBlobOidAtCommit,
  readBlobContentIdentityAtCommit,
  restoreManagedHeadAndIndex,
  resolveHeadCommit,
  resolveHeadCommitSync,
} from './index';

describe('workspace-git wrappers (S0)', () => {
  let dir: string;

  it('refuses history retry when staged owned bytes differ from the acknowledged write', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.txt'), 'before');
    const expectedHead = await commitAllIfDirty(dir, 'seed');
    const originalIndex = fs.readFileSync(join(dir, '.git', 'index'));
    writeFileSync(join(dir, 'owned.txt'), 'external change after Save');
    await expect(
      commitOwnedPathsIfDirty(dir, 'Retry saved history', {
        paths: ['owned.txt'],
        expectedHead,
        expectedContentSha256: {
          'owned.txt': createHash('sha256').update('saved revision').digest('hex'),
        },
      })
    ).rejects.toThrow('MANAGED_GIT_OWNED_CONTENT_CHANGED');
    expect(await resolveHeadCommit(dir)).toBe(expectedHead);
    expect(fs.readFileSync(join(dir, '.git', 'index'))).toEqual(originalIndex);
    expect(fs.readFileSync(join(dir, 'owned.txt'), 'utf8')).toBe('external change after Save');
  });

  it('commits acknowledged bytes once and preserves later working changes after staging', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.txt'), 'before');
    const expectedHead = await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, 'owned.txt'), 'saved revision');
    const hash = createHash('sha256').update('saved revision').digest('hex');
    const committed = await commitOwnedPathsIfDirty(
      dir,
      'Retry saved history',
      {
        paths: ['owned.txt'],
        expectedHead,
        expectedContentSha256: { 'owned.txt': hash },
      },
      {
        beforeHeadCompareAndSet: () => {
          writeFileSync(join(dir, 'owned.txt'), 'later external edit');
        },
      }
    );
    expect(committed).toMatch(/^[a-f0-9]{40}$/);
    const blob = await git.readBlob({ fs, dir, oid: committed!, filepath: 'owned.txt' });
    expect(Buffer.from(blob.blob).toString('utf8')).toBe('saved revision');
    expect(fs.readFileSync(join(dir, 'owned.txt'), 'utf8')).toBe('later external edit');
    expect(await hasWorkingChanges(dir)).toBe(true);
  });
  it('commits an acknowledged owned deletion once while preserving unrelated staged work', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.txt'), 'before deletion');
    const expectedHead = await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, 'unrelated.txt'), 'unrelated staged');
    await nativeGit.executeManagedGit(dir, ['add', '--', 'unrelated.txt']);
    fs.unlinkSync(join(dir, 'owned.txt'));
    const committed = await commitOwnedPathsIfDirty(dir, 'Retry exact deletion', {
      paths: ['owned.txt'],
      expectedHead,
      expectedContentSha256: { 'owned.txt': null },
    });
    expect(committed).not.toBe(expectedHead);
    expect(
      (
        await nativeGit.executeManagedGit(dir, [
          'rev-list',
          '--count',
          `${expectedHead}..${committed}`,
        ])
      ).trim()
    ).toBe('1');
    expect(
      await commitOwnedPathsIfDirty(dir, 'Retry exact deletion', {
        paths: ['owned.txt'],
        expectedHead: committed,
        expectedContentSha256: { 'owned.txt': null },
      })
    ).toBeNull();
    expect(
      await nativeGit.executeManagedGit(dir, ['ls-tree', '-z', 'HEAD', '--', 'owned.txt'])
    ).toBe('');
    expect(await nativeGit.executeManagedGit(dir, ['diff', '--cached', '--name-only'])).toContain(
      'unrelated.txt'
    );
    await expect(
      nativeGit.executeManagedGit(dir, ['show', 'HEAD:unrelated.txt'])
    ).rejects.toThrow();
  });

  it('refuses recreated owned bytes when an acknowledged deletion requires staged absence', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.txt'), 'before deletion');
    const expectedHead = await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, 'owned.txt'), 'unrelated replacement after deletion');
    const index = fs.readFileSync(join(dir, '.git', 'index'));
    await expect(
      commitOwnedPathsIfDirty(dir, 'Retry exact deletion', {
        paths: ['owned.txt'],
        expectedHead,
        expectedContentSha256: { 'owned.txt': null },
      })
    ).rejects.toThrow('MANAGED_GIT_OWNED_CONTENT_CHANGED');
    expect(await resolveHeadCommit(dir)).toBe(expectedHead);
    expect(fs.readFileSync(join(dir, '.git', 'index'))).toEqual(index);
    expect(fs.readFileSync(join(dir, 'owned.txt'), 'utf8')).toBe(
      'unrelated replacement after deletion'
    );
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wpgit-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inits an empty repo with an unborn HEAD', async () => {
    await initManagedRepo(dir);
    expect(await resolveHeadCommit(dir)).toBeNull();
    expect(resolveHeadCommitSync(dir)).toBeNull();
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it.each(['actions/action-one', 'undo/operation-one'])(
    'never stages private %s snapshots even when workspace ignore rules re-include them',
    async (privateRoot) => {
      await initManagedRepo(dir);
      writeFileSync(join(dir, '.gitignore'), '!*\n');
      const privatePath = `.dnaforge/migration/${privateRoot}/before.v1.json`;
      fs.mkdirSync(join(dir, '.dnaforge/migration', privateRoot), { recursive: true });
      writeFileSync(join(dir, privatePath), 'private original data');
      writeFileSync(join(dir, 'notes.txt'), 'public workspace data');
      await commitAllIfDirty(dir, 'normal save');
      expect(await listFilesAtHead(dir)).toEqual(['.gitignore', 'notes.txt']);
      expect(await hasWorkingChanges(dir)).toBe(false);
      await expect(
        commitAllIfDirty(dir, 'forced private save', { forceInclude: [privatePath] })
      ).rejects.toThrow(/PRIVATE_IMPORT/);
      expect(fs.readFileSync(join(dir, privatePath), 'utf8')).toBe('private original data');
    }
  );

  it('commits a file, lists it at HEAD, and skips an empty re-commit', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'pUC19.gb'), 'LOCUS pUC19 2686 bp\n');
    expect(await hasWorkingChanges(dir)).toBe(true);

    const first = await commitAllIfDirty(dir, 'initial import');
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(resolveHeadCommitSync(dir)).toBe(first);
    expect(resolveHeadCommitSync(dir)).toBe(await resolveHeadCommit(dir));
    expect(await listFilesAtHead(dir)).toContain('pUC19.gb');

    expect(await commitAllIfDirty(dir, 'noop reconcile')).toBeNull();
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('stores a large streamed blob without compression work and preserves its committed bytes', async () => {
    await initManagedRepo(dir);
    await git.setConfig({ fs, dir, path: 'pack.compression', value: 9 });
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65);
    writeFileSync(join(dir, 'large.fasta'), bytes);
    const commit = await commitAllIfDirty(dir, 'large import');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    const packDir = join(dir, '.git', 'objects', 'pack');
    const packs = fs.readdirSync(packDir).filter((name) => name.endsWith('.pack'));
    expect(packs).toHaveLength(1);
    const pack = fs.readFileSync(join(packDir, packs[0]!));
    expect(pack.subarray(0, 4).toString()).toBe('PACK');
    expect(pack.readUInt32BE(8)).toBe(1);
    expect((pack[12]! >> 4) & 7).toBe(3);
    let payloadOffset = 12;
    while (pack[payloadOffset++]! & 0x80) {
      continue;
    }
    expect(pack[payloadOffset + 2]! & 0b110).toBe(0);
    expect(inflateSync(pack.subarray(payloadOffset, -20)).equals(bytes)).toBe(true);
    await expect(
      readBlobContentIdentityAtCommit(dir, commit!, 'large.fasta', bytes.length, 0)
    ).resolves.toEqual({
      sizeBytes: bytes.length,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('commits raw bytes without executing repository-defined clean filters', async () => {
    await initManagedRepo(dir);
    const marker = join(dir, 'filter-executed');
    writeFileSync(join(dir, '.gitattributes'), '*.gb filter=untrusted\n');
    await git.setConfig({
      fs,
      dir,
      path: 'filter.untrusted.clean',
      value: `touch '${marker}'; cat`,
    });
    await git.setConfig({ fs, dir, path: 'filter.untrusted.required', value: 'true' });
    writeFileSync(join(dir, 'sequence.gb'), 'LOCUS exact 4 bp\n');
    const commit = await commitAllIfDirty(dir, 'raw scientific data');
    expect(fs.existsSync(marker)).toBe(false);
    expect(await nativeGit.hashManagedGitBlob(dir, commit!, 'sequence.gb')).toEqual({
      sha256: createHash('sha256').update('LOCUS exact 4 bp\n').digest('hex'),
      sizeBytes: Buffer.byteLength('LOCUS exact 4 bp\n'),
    });
  });

  it('preserves exact working bytes when imported Git attributes request line-ending conversion', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, '.gitattributes'), '*.gb text eol=lf ident\n');
    const bytes = 'LOCUS exact 4 bp\r\nCOMMENT $Id: original scientific bytes $\r\n';
    writeFileSync(join(dir, 'sequence.gb'), bytes);
    const commit = await commitAllIfDirty(dir, 'exact imported scientific data');
    expect(await nativeGit.hashManagedGitBlob(dir, commit!, 'sequence.gb')).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: Buffer.byteLength(bytes),
    });
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('preserves raw encoded bytes despite nested and local attributes, and still detects later edits', async () => {
    await initManagedRepo(dir);
    fs.mkdirSync(join(dir, 'nested'));
    const localAttributes = '*.gb text ident working-tree-encoding=UTF-16LE\n';
    fs.mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), localAttributes);
    writeFileSync(join(dir, 'nested', '.gitattributes'), localAttributes);
    await git.setConfig({ fs, dir, path: 'core.autocrlf', value: 'true' });
    const bytes = Buffer.from('LOCUS encoded\r\nCOMMENT $Id: exact original $\r\n', 'utf16le');
    writeFileSync(join(dir, 'nested', 'sequence.gb'), bytes);
    const commit = await commitAllIfDirty(dir, 'encoded source data');
    expect(await nativeGit.hashManagedGitBlob(dir, commit!, 'nested/sequence.gb')).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    });
    expect(await hasWorkingChanges(dir)).toBe(false);
    expect(fs.readFileSync(join(dir, '.git', 'info', 'attributes'), 'utf8')).toContain(
      localAttributes
    );
    writeFileSync(join(dir, 'nested', 'sequence.gb'), Buffer.from('changed\r\n', 'utf16le'));
    expect(await hasWorkingChanges(dir)).toBe(true);
  });

  it('flushes a managed commit and its nested operation objects durably', async () => {
    await initManagedRepo(dir);
    fs.mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'design.wpdesign.json'), '{"name":"durable"}\n');
    const head = await commitAllIfDirty(dir, 'durable commit');

    await expect(
      flushManagedCommitDurably(dir, head!, ['nested/design.wpdesign.json'])
    ).resolves.toBeUndefined();
    await expect(
      flushManagedCommitDurably(dir, 'not-a-commit', ['nested/design.wpdesign.json'])
    ).rejects.toThrow('MANAGED_GIT_INVALID_COMMIT_OID');
  });

  it('flushes each managed Git directory at most once without reaching the filesystem root', async () => {
    await initManagedRepo(dir);
    fs.mkdirSync(join(dir, 'nested'), { recursive: true });
    const operationPaths = Array.from({ length: 24 }, (_, index) => {
      const relativePath = join('nested', `design-${index}.wpdesign.json`);
      writeFileSync(join(dir, relativePath), `{"index":${index}}\n`);
      return relativePath;
    });
    const head = await commitAllIfDirty(dir, 'many durable objects');
    const flushedFiles: string[] = [];
    const flushedDirectories: string[] = [];

    await flushManagedCommitDurably(dir, head!, operationPaths, {
      flushFile: (path) => flushedFiles.push(path),
      flushDirectory: (path) => flushedDirectories.push(path),
    });

    const gitDir = join(dir, '.git');
    expect(flushedFiles.length).toBeGreaterThan(operationPaths.length);
    expect(new Set(flushedFiles).size).toBe(flushedFiles.length);
    expect(new Set(flushedDirectories).size).toBe(flushedDirectories.length);
    expect(flushedDirectories.length).toBeLessThanOrEqual(flushedFiles.length + 2);
    expect(
      flushedDirectories.every((path) => path === gitDir || path.startsWith(`${gitDir}${sep}`))
    ).toBe(true);
  });

  it('readBlobOidAtHead returns the git blob SHA — content-addressed and stable', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'seq.gb'), 'LOCUS x 10 bp\n');
    await commitAllIfDirty(dir, 'add');
    const oid1 = await readBlobOidAtHead(dir, 'seq.gb');
    expect(oid1).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(dir, 'seq.gb'), 'LOCUS x 10 bp\nORIGIN\n');
    await commitAllIfDirty(dir, 'edit');
    const oid2 = await readBlobOidAtHead(dir, 'seq.gb');
    expect(oid2).not.toBe(oid1);
  });

  it('the blob oid equals real git hash-object (proves it IS the git blob SHA)', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    await commitAllIfDirty(dir, 'add');
    expect(await readBlobOidAtHead(dir, 'a.txt')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('reads a nested regular file identity from the named commit without reading its blob', async () => {
    await initManagedRepo(dir);
    fs.mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'a.txt'), 'hello\n');
    fs.symlinkSync('a.txt', join(dir, 'nested', 'linked.txt'));
    const original = await commitAllIfDirty(dir, 'original nested file');
    writeFileSync(join(dir, 'nested', 'a.txt'), 'world\n');
    const changedAt = new Date(Date.now() + 2000);
    fs.utimesSync(join(dir, 'nested', 'a.txt'), changedAt, changedAt);
    const current = await commitAllIfDirty(dir, 'edited nested file');
    if (!original || !current) throw new Error('Expected both managed commits.');
    const readBlob = vi.spyOn(git, 'readBlob').mockRejectedValue(new Error('Unexpected blob read'));

    expect(await readBlobOidAtCommit(dir, original, 'nested/a.txt')).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a'
    );
    const currentBlobOid = createHash('sha1').update('blob 6\0world\n').digest('hex');
    expect(await readBlobOidAtCommit(dir, current, join(dir, 'nested', 'a.txt'))).toBe(
      currentBlobOid
    );
    expect(readBlob).not.toHaveBeenCalled();
    for (const invalidPath of [
      'nested',
      'nested/missing.txt',
      'nested/linked.txt',
      'nested/a.txt/x',
    ]) {
      await expect(readBlobOidAtCommit(dir, original, invalidPath)).rejects.toThrow(
        'MANAGED_GIT_COMMIT_FILE_NOT_FOUND'
      );
    }
    await expect(readBlobOidAtCommit(dir, 'HEAD', 'nested/a.txt')).rejects.toThrow(
      'MANAGED_GIT_INVALID_COMMIT_OID'
    );
    await expect(readBlobOidAtCommit(dir, original, '../outside.txt')).rejects.toThrow(
      'MANAGED_GIT_FORCE_INCLUDE_OUTSIDE_REPO'
    );
  });

  it('checks actual committed bytes and rejects a corrupted or missing loose blob', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    const head = await commitAllIfDirty(dir, 'blob integrity');
    if (!head) throw new Error('Expected a managed commit.');
    const oid = await readBlobOidAtCommit(dir, head, 'a.txt');
    const objectPath = join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    await expect(readBlobContentIdentityAtCommit(dir, head, 'a.txt', 6, 32)).resolves.toEqual({
      sizeBytes: 6,
      contentSha256: createHash('sha256').update('hello\n').digest('hex'),
    });
    fs.chmodSync(objectPath, 0o600);
    writeFileSync(objectPath, 'corrupt compressed contents');
    await expect(readBlobContentIdentityAtCommit(dir, head, 'a.txt', 6, 32)).rejects.toThrow();
    fs.unlinkSync(objectPath);
    await expect(readBlobContentIdentityAtCommit(dir, head, 'a.txt', 6, 32)).rejects.toThrow();
  });

  it('verifies packed files above the inline cap without buffering their contents', async () => {
    await initManagedRepo(dir);
    const bytes = Buffer.alloc(8192, 65);
    writeFileSync(join(dir, 'a.txt'), bytes);
    const head = await commitAllIfDirty(dir, 'packed content');
    if (!head) throw new Error('Expected a managed commit.');
    const oid = await readBlobOidAtCommit(dir, head, 'a.txt');
    const { filename } = await git.packObjects({ fs, dir, oids: [oid], write: true });
    await git.indexPack({ fs, dir, filepath: `.git/objects/pack/${filename}` });
    fs.unlinkSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    await expect(
      readBlobContentIdentityAtCommit(dir, head, 'a.txt', bytes.length, 8192)
    ).resolves.toEqual({
      sizeBytes: bytes.length,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const readBlob = vi
      .spyOn(git, 'readBlob')
      .mockRejectedValue(new Error('Unsafe whole-blob read'));
    await expect(
      readBlobContentIdentityAtCommit(dir, head, 'a.txt', bytes.length, 4096)
    ).resolves.toEqual({
      sizeBytes: bytes.length,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await expect(
      readBlobContentIdentityAtCommit(dir, head, 'a.txt', bytes.length - 1, 4096)
    ).rejects.toThrow('MANAGED_GIT_BLOB_EXCEEDS_CAPTURE');
    expect(readBlob).not.toHaveBeenCalled();
  });

  it('stages and commits a deletion (HEAD-absent files do not linger)', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'keep.gb'), 'LOCUS keep 1 bp\n');
    writeFileSync(join(dir, 'drop.gb'), 'LOCUS drop 1 bp\n');
    await commitAllIfDirty(dir, 'two files');
    expect(await listFilesAtHead(dir)).toEqual(expect.arrayContaining(['keep.gb', 'drop.gb']));

    rmSync(join(dir, 'drop.gb'));
    expect(await hasWorkingChanges(dir)).toBe(true);
    await commitAllIfDirty(dir, 'remove drop');
    const files = await listFilesAtHead(dir);
    expect(files).toContain('keep.gb');
    expect(files).not.toContain('drop.gb');
  });

  it('force-includes only an explicitly named generated file that gitignore matches', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '*.gb\n');
    writeFileSync(join(dir, 'package.gb'), 'LOCUS package 1 bp\n');
    writeFileSync(join(dir, 'user-backup.gb'), 'LOCUS backup 1 bp\n');

    await commitAllIfDirty(dir, 'generated package', {
      forceInclude: [join(dir, 'package.gb')],
    });

    expect(await listFilesAtHead(dir)).toEqual(
      expect.arrayContaining(['.gitignore', 'package.gb'])
    );
    expect(await listFilesAtHead(dir)).not.toContain('user-backup.gb');
  });

  it('rebuilds a truncated managed index without losing working-tree changes', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'notebook.json'), '{"title":"before"}\n');
    const first = await commitAllIfDirty(dir, 'initial');
    writeFileSync(join(dir, 'notebook.json'), '{"title":"after"}\n');
    writeFileSync(join(dir, '.git', 'index'), Buffer.from([0x44, 0x49, 0x52, 0x43]));

    const repaired = await commitAllIfDirty(dir, 'recover interrupted write');

    expect(repaired).toMatch(/^[0-9a-f]{40}$/);
    expect(repaired).not.toBe(first);
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('resumes when a prior repair stopped after writing a valid empty index', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'notebook.json'), '{"title":"before"}\n');
    const first = await commitAllIfDirty(dir, 'initial');
    writeFileSync(join(dir, 'notebook.json'), '{"title":"after"}\n');
    writeFileSync(join(dir, 'new-sequence.gb'), 'LOCUS recovered 4 bp\n');

    const header = Buffer.alloc(12);
    header.write('DIRC', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(0, 8);
    const checksum = createHash('sha1').update(header).digest();
    writeFileSync(join(dir, '.git', 'index'), Buffer.concat([header, checksum]));

    const repaired = await commitAllIfDirty(dir, 'resume interrupted index repair');

    expect(repaired).toMatch(/^[0-9a-f]{40}$/);
    expect(repaired).not.toBe(first);
    expect(await listFilesAtHead(dir)).toEqual(
      expect.arrayContaining(['notebook.json', 'new-sequence.gb'])
    );
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('stages more than one bounded add batch into one complete commit', async () => {
    await initManagedRepo(dir);
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(dir, `entity-${index}.json`), `{"index":${index}}\n`);
    }

    await commitAllIfDirty(dir, 'large bounded batch');

    expect(await listFilesAtHead(dir)).toHaveLength(300);
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('keeps force-included generated files in bounded sequential add batches', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '*.gb\n');
    const forceInclude: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const path = join(dir, `generated-${index}.gb`);
      writeFileSync(path, `LOCUS generated_${index} 1 bp\n`);
      forceInclude.push(path);
    }
    const addSpy = vi.spyOn(nativeGit, 'executeManagedGit');

    await commitAllIfDirty(dir, 'large generated package', { forceInclude });

    const filepathBatches = addSpy.mock.calls
      .map(([, args]) => args)
      .filter((args) => args[0] === 'add')
      .map((args) => args.slice(args.indexOf('--') + 1));
    expect(filepathBatches.length).toBeGreaterThan(1);
    expect(filepathBatches.every((batch) => batch.length <= 256)).toBe(true);
    expect(
      addSpy.mock.calls.filter(([, args]) => args[0] === 'add' && args.includes('-f')).length
    ).toBeGreaterThan(1);
    expect(await listFilesAtHead(dir)).toHaveLength(301);
    expect(await hasWorkingChanges(dir)).toBe(false);
  }, 15_000);

  it('commits only operation-owned paths and leaves unrelated edits uncommitted', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'remote.gb'), 'LOCUS remote 1 bp\n');
    writeFileSync(join(dir, 'local.txt'), 'local v1\n');
    await commitAllIfDirty(dir, 'seed');
    const localBlobBefore = await readBlobOidAtHead(dir, 'local.txt');

    writeFileSync(join(dir, 'remote.gb'), 'LOCUS remote 2 bp\n');
    writeFileSync(join(dir, 'local.txt'), 'local version two\n');
    await commitPathsIfDirty(dir, 'pull remote', { paths: ['remote.gb'] });

    expect(await readBlobOidAtHead(dir, 'remote.gb')).not.toBeNull();
    expect(await readBlobOidAtHead(dir, 'local.txt')).toBe(localBlobBefore);
    expect(await hasWorkingChanges(dir)).toBe(true);
    await commitAllIfDirty(dir, 'capture local edit');
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('refuses to sweep an unrelated pre-staged path into a scoped managed commit', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'remote.gb'), 'LOCUS remote 1 bp\n');
    writeFileSync(join(dir, 'local.txt'), 'local v1\n');
    await commitAllIfDirty(dir, 'seed');
    const localBlobBefore = await readBlobOidAtHead(dir, 'local.txt');

    writeFileSync(join(dir, 'local.txt'), 'staged user edit\n');
    await git.add({ fs, dir, filepath: 'local.txt' });
    writeFileSync(join(dir, 'remote.gb'), 'LOCUS remote 2 bp\n');

    await expect(commitPathsIfDirty(dir, 'pull remote', { paths: ['remote.gb'] })).rejects.toThrow(
      'MANAGED_GIT_STAGED_PATH_NOT_SELECTED'
    );
    expect(await readBlobOidAtHead(dir, 'local.txt')).toBe(localBlobBefore);
  });

  it('commits owned paths while preserving unrelated staged and unstaged states', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.gb'), 'LOCUS owned 1 bp\n');
    writeFileSync(join(dir, 'staged.txt'), 'staged v1\n');
    writeFileSync(join(dir, 'unstaged.txt'), 'unstaged v1\n');
    await commitAllIfDirty(dir, 'seed');
    const stagedHeadBlob = await readBlobOidAtHead(dir, 'staged.txt');
    const unstagedHeadBlob = await readBlobOidAtHead(dir, 'unstaged.txt');

    writeFileSync(join(dir, 'staged.txt'), 'staged v2\n');
    await git.add({ fs, dir, filepath: 'staged.txt' });
    writeFileSync(join(dir, 'unstaged.txt'), 'unstaged version two\n');
    writeFileSync(join(dir, 'owned.gb'), 'LOCUS owned 2 bp\n');

    const committed = await commitOwnedPathsIfDirty(dir, 'migration action', {
      paths: ['owned.gb'],
      expectedHead: await resolveHeadCommit(dir),
    });

    expect(committed).toMatch(/^[0-9a-f]{40}$/u);
    expect(await readBlobOidAtHead(dir, 'staged.txt')).toBe(stagedHeadBlob);
    expect(await readBlobOidAtHead(dir, 'unstaged.txt')).toBe(unstagedHeadBlob);
    const matrix = Object.fromEntries(
      (await git.statusMatrix({ fs, dir })).map(([path, head, workdir, stage]) => [
        path,
        { head, workdir, stage },
      ])
    );
    expect(matrix['owned.gb']).toEqual({ head: 1, workdir: 1, stage: 1 });
    expect(matrix['staged.txt']).toEqual({ head: 1, workdir: 2, stage: 2 });
    expect(matrix['unstaged.txt']).toEqual({ head: 1, workdir: 2, stage: 1 });
  });

  it('publishes an owned commit on Windows without flushing directories', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.txt'), 'before');
    const expectedHead = await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, 'owned.txt'), 'after');
    const open = fs.promises.open;
    const fileSyncs: string[] = [];
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      if (fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory()) {
        throw Object.assign(new Error('Windows directory handles cannot be flushed'), {
          code: 'EPERM',
          syscall: 'fsync',
        });
      }
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        fileSyncs.push(String(args[0]));
        await sync();
      });
      return handle;
    });

    const committed = await commitOwnedPathsIfDirty(dir, 'Windows import', {
      paths: ['owned.txt'],
      expectedHead,
    });

    expect(committed).toMatch(/^[0-9a-f]{40}$/u);
    expect(await resolveHeadCommit(dir)).toBe(committed);
    expect(fileSyncs).toContain(join(dir, '.git', 'refs', 'heads', 'main.lock'));
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('fails closed when HEAD moves before an owned-path compare-and-set', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'owned.gb'), 'LOCUS owned 1 bp\n');
    const originalHead = await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, 'concurrent.txt'), 'concurrent\n');
    const concurrentHead = await commitAllIfDirty(dir, 'concurrent head move');
    await git.writeRef({
      fs,
      dir,
      ref: 'refs/heads/main',
      value: originalHead!,
      force: true,
    });
    writeFileSync(join(dir, 'owned.gb'), 'LOCUS owned 2 bp\n');

    await expect(
      commitOwnedPathsIfDirty(
        dir,
        'migration action',
        { paths: ['owned.gb'], expectedHead: originalHead },
        {
          beforeHeadCompareAndSet: () => {
            return git.writeRef({
              fs,
              dir,
              ref: 'refs/heads/main',
              value: concurrentHead!,
              force: true,
            });
          },
        }
      )
    ).rejects.toThrow('MANAGED_GIT_HEAD_CHANGED');
    expect(await listFilesAtHead(dir)).toContain('concurrent.txt');
    expect(await readBlobOidAtHead(dir, 'owned.gb')).toBe(
      await git.hashBlob({ object: Buffer.from('LOCUS owned 1 bp\n') }).then((result) => result.oid)
    );
    expect(fs.readFileSync(join(dir, 'owned.gb'), 'utf8')).toBe('LOCUS owned 2 bp\n');
  });

  it('batches a large owned commit without rebuilding the index per file', async () => {
    await initManagedRepo(dir);
    fs.mkdirSync(join(dir, 'owned'));
    writeFileSync(join(dir, 'staged.txt'), 'base\n');
    writeFileSync(join(dir, 'unstaged.txt'), 'base\n');
    writeFileSync(join(dir, 'deleted.txt'), 'delete this\n');
    await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, 'staged.txt'), 'staged\n');
    await git.add({ fs, dir, filepath: 'staged.txt' });
    writeFileSync(join(dir, 'staged.txt'), 'unstaged over staged\n');
    writeFileSync(join(dir, 'unstaged.txt'), 'unstaged\n');
    fs.unlinkSync(join(dir, 'deleted.txt'));
    const paths = Array.from({ length: 300 }, (_, index) => `owned/entity-${index}.txt`);
    for (const path of paths) writeFileSync(join(dir, path), path);
    const indexWrites = vi.spyOn(fs.promises, 'writeFile');

    await commitOwnedPathsIfDirty(dir, 'owned batch', {
      expectedHead: await resolveHeadCommit(dir),
      paths: [...paths, 'deleted.txt'],
    });

    const writes = indexWrites.mock.calls.filter(
      ([path]) => String(path) === join(dir, '.git', 'index')
    );
    expect(writes.length).toBeLessThanOrEqual(10);
    const matrix = new Map(
      (await git.statusMatrix({ fs, dir })).map(([path, ...state]) => [path, state])
    );
    for (const path of paths) expect(matrix.get(path)).toEqual([1, 1, 1]);
    expect(matrix.has('deleted.txt')).toBe(false);
    expect(matrix.get('staged.txt')).toEqual([1, 2, 3]);
    expect(matrix.get('unstaged.txt')).toEqual([1, 2, 1]);
    expect(await readBlobOidAtHead(dir, 'staged.txt')).toBe(
      (await git.hashBlob({ object: Buffer.from('base\n') })).oid
    );
  });

  it('restores an operation-owned commit without disturbing an unrelated staged edit', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'remote.gb'), 'LOCUS remote 1 bp\n');
    writeFileSync(join(dir, 'local.txt'), 'local v1\n');
    const originalHead = await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, 'remote.gb'), 'LOCUS remote 22 bp\nORIGIN\n');
    const pulledHead = await commitPathsIfDirty(dir, 'pull remote', { paths: ['remote.gb'] });
    writeFileSync(join(dir, 'local.txt'), 'staged user edit\n');
    await git.add({ fs, dir, filepath: 'local.txt' });
    writeFileSync(join(dir, 'remote.gb'), 'LOCUS remote 1 bp\n');

    await restoreManagedHeadAndIndex(dir, {
      restoreHead: originalHead!,
      expectedCurrentHead: pulledHead!,
      paths: ['remote.gb'],
    });

    expect(await resolveHeadCommit(dir)).toBe(originalHead);
    expect(await readBlobOidAtHead(dir, 'remote.gb')).toBe(
      await git
        .hashBlob({ object: Buffer.from('LOCUS remote 1 bp\n') })
        .then((result) => result.oid)
    );
    expect(await hasWorkingChanges(dir)).toBe(true);
  });

  it('preserves nested siblings and one-character directories in an owned commit', async () => {
    await initManagedRepo(dir);
    fs.mkdirSync(join(dir, 'a', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'a', 'keep.txt'), 'keep');
    await commitAllIfDirty(dir, 'seed');
    const paths = Array.from({ length: 20 }, (_, index) => `a/nested/${index}.txt`);
    for (const path of paths) writeFileSync(join(dir, path), path);
    await commitOwnedPathsIfDirty(dir, 'nested batch', {
      paths,
      expectedHead: await resolveHeadCommit(dir),
    });
    expect(await listFilesAtHead(dir)).toEqual(['a/keep.txt', ...paths].sort());
    expect(await hasWorkingChanges(dir)).toBe(false);
  });

  it('does not publish ignored pre-staged bytes unless explicitly force-included', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'ignored.txt'), 'base');
    await commitAllIfDirty(dir, 'seed');
    writeFileSync(join(dir, '.gitignore'), 'ignored*.txt\n');
    await commitAllIfDirty(dir, 'ignore');
    writeFileSync(join(dir, 'ignored.txt'), 'staged');
    writeFileSync(join(dir, 'ignored-new.txt'), 'staged new');
    await git.add({ fs, dir, filepath: ['ignored.txt', 'ignored-new.txt'], force: true });
    writeFileSync(join(dir, 'ignored.txt'), 'working');
    writeFileSync(join(dir, 'ignored-new.txt'), 'working new');
    writeFileSync(join(dir, 'owned.txt'), 'owned');
    await commitOwnedPathsIfDirty(dir, 'owned only', {
      paths: ['owned.txt', 'ignored.txt', 'ignored-new.txt'],
      expectedHead: await resolveHeadCommit(dir),
    });
    expect(await readBlobOidAtHead(dir, 'ignored.txt')).toBe(
      (await git.hashBlob({ object: Buffer.from('base') })).oid
    );
    expect(await listFilesAtHead(dir)).not.toContain('ignored-new.txt');
    await commitOwnedPathsIfDirty(dir, 'force selected', {
      paths: ['ignored.txt', 'ignored-new.txt'],
      forceInclude: ['ignored.txt', 'ignored-new.txt'],
      expectedHead: await resolveHeadCommit(dir),
    });
    expect(await readBlobOidAtHead(dir, 'ignored.txt')).toBe(
      (await git.hashBlob({ object: Buffer.from('working') })).oid
    );
    expect(await readBlobOidAtHead(dir, 'ignored-new.txt')).toBe(
      (await git.hashBlob({ object: Buffer.from('working new') })).oid
    );
  });

  it('preserves concurrent index edits and refuses publication', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'other.txt'), 'base');
    await commitAllIfDirty(dir, 'seed');
    const expectedHead = await resolveHeadCommit(dir);
    writeFileSync(join(dir, 'owned.txt'), 'owned');
    writeFileSync(join(dir, 'other.txt'), 'concurrent stage');
    await expect(
      commitOwnedPathsIfDirty(
        dir,
        'owned',
        { paths: ['owned.txt'], expectedHead },
        {
          beforeHeadCompareAndSet: () => git.add({ fs, dir, filepath: 'other.txt' }),
        }
      )
    ).rejects.toThrow('MANAGED_GIT_INDEX_CHANGED');
    expect(await resolveHeadCommit(dir)).toBe(expectedHead);
    const matrix = new Map(
      (await git.statusMatrix({ fs, dir })).map(([path, ...state]) => [path, state])
    );
    expect(matrix.get('other.txt')).toEqual([1, 2, 2]);
    expect(matrix.get('owned.txt')).toEqual([0, 2, 0]);
  });

  it('restores the index and HEAD if prepared index publication fails', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, 'other.txt'), 'base');
    await commitAllIfDirty(dir, 'seed');
    const expectedHead = await resolveHeadCommit(dir);
    writeFileSync(join(dir, 'other.txt'), 'staged');
    await git.add({ fs, dir, filepath: 'other.txt' });
    writeFileSync(join(dir, 'owned.txt'), 'owned');
    const indexPath = join(dir, '.git', 'index');
    const originalIndex = fs.readFileSync(indexPath);
    await expect(
      commitOwnedPathsIfDirty(
        dir,
        'owned',
        { paths: ['owned.txt'], expectedHead },
        {
          beforeHeadCompareAndSet: () => {
            vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(
              new Error('index write interrupted')
            );
          },
        }
      )
    ).rejects.toThrow('index write interrupted');
    expect(await resolveHeadCommit(dir)).toBe(expectedHead);
    expect(fs.readFileSync(indexPath)).toEqual(originalIndex);
    expect(fs.readFileSync(join(dir, 'owned.txt'), 'utf8')).toBe('owned');
  });

  it('refuses to force-include a file outside the operation-owned path set', async () => {
    await initManagedRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '*.gb\n');
    writeFileSync(join(dir, 'owned.gb'), 'LOCUS owned 1 bp\n');
    writeFileSync(join(dir, 'unrelated.gb'), 'LOCUS unrelated 1 bp\n');

    await expect(
      commitPathsIfDirty(dir, 'scoped operation', {
        paths: ['owned.gb'],
        forceInclude: ['unrelated.gb'],
      })
    ).rejects.toThrow('MANAGED_GIT_FORCE_INCLUDE_NOT_SELECTED');
  });
});
