import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runWorkspaceFileTrash as nativeFileTrash,
  workspaceMoveTreeDigest,
} from './workspace-file-trash';
import { randomUUID } from 'node:crypto';
import { realpath, rename } from 'node:fs/promises';
function runWorkspaceFileTrash(
  ...[request, check, documents, admit, owns]: Parameters<typeof nativeFileTrash>
) {
  return nativeFileTrash(request, check, documents, admit, owns ?? (() => false));
}

describe('native individual file recovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dnaforge-file-trash-'));
    await mkdir(join(root, '.git'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('restores exact bytes from the inspected entry and refuses a destination collision', async () => {
    const path = join(root, 'notes.csv');
    const bytes = '\uFEFFsample,note\r\nA1,"line one\nline two"\r\n';
    await writeFile(path, bytes);
    const inspected = await runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path });
    if (inspected.kind !== 'inspect') throw new Error('Expected source inspection');
    const trashed = await runWorkspaceFileTrash({
      kind: 'trash',
      workspaceRoot: root,
      path,
      expectedRevision: inspected.source.revision,
    });
    if (trashed.kind !== 'trash') throw new Error('Expected Trash entry');
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, 'new occupant');
    expect(
      await runWorkspaceFileTrash({
        kind: 'restore',
        workspaceRoot: root,
        entryId: trashed.entry.id,
        expectedRevision: trashed.entry.revision,
      })
    ).toMatchObject({ kind: 'failed', code: 'DESTINATION_EXISTS', stateChanged: false });
    expect(await readFile(path, 'utf8')).toBe('new occupant');
    await rm(path);
    await runWorkspaceFileTrash({
      kind: 'restore',
      workspaceRoot: root,
      entryId: trashed.entry.id,
      expectedRevision: trashed.entry.revision,
    });
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect(await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: root })).toMatchObject({
      kind: 'list',
      entries: [],
    });
  });

  it('refuses stale source bytes, internal metadata, package members and symbolic links', async () => {
    const path = join(root, 'draft.txt');
    await writeFile(path, 'before');
    const state = await runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path });
    if (state.kind !== 'inspect') throw new Error('Expected source inspection');
    await writeFile(path, 'new human bytes');
    expect(
      await runWorkspaceFileTrash({
        kind: 'trash',
        workspaceRoot: root,
        path,
        expectedRevision: state.source.revision,
      })
    ).toMatchObject({ kind: 'failed', code: 'STALE_FILE', stateChanged: false });
    expect(await readFile(path, 'utf8')).toBe('new human bytes');
    await expect(
      runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path: join(root, '.git') })
    ).rejects.toThrow('INTERNAL_PROJECT_PATH');
    const pkg = join(root, 'Sequence');
    await mkdir(join(pkg, '.forge'), { recursive: true });
    await writeFile(join(pkg, '.forge', 'sequence.json'), '{}');
    await writeFile(join(pkg, 'sequence.fa'), '>s\nACGT');
    await expect(
      runWorkspaceFileTrash({
        kind: 'inspect',
        workspaceRoot: root,
        path: join(pkg, 'sequence.fa'),
      })
    ).rejects.toThrow('PACKAGE_MEMBER');
    await symlink(path, join(root, 'alias.txt'));
    await expect(
      runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path: join(root, 'alias.txt') })
    ).rejects.toThrow();
  });

  it('purges only an exact current entry and preserves unrelated content', async () => {
    const runWithEmptyCatalog = (request: Parameters<typeof runWorkspaceFileTrash>[0]) =>
      runWorkspaceFileTrash(request, undefined, undefined, undefined, () => false);
    await writeFile(join(root, 'keep.txt'), 'keep');
    const path = join(root, 'disposable.txt');
    await writeFile(path, 'disposable');
    const inspected = await runWithEmptyCatalog({ kind: 'inspect', workspaceRoot: root, path });
    if (inspected.kind !== 'inspect') throw new Error('Expected source inspection');
    const trashed = await runWithEmptyCatalog({
      kind: 'trash',
      workspaceRoot: root,
      path,
      expectedRevision: inspected.source.revision,
    });
    if (trashed.kind !== 'trash') throw new Error('Expected Trash entry');
    expect(
      await runWithEmptyCatalog({
        kind: 'purge',
        workspaceRoot: root,
        entryId: trashed.entry.id,
        expectedRevision: 'stale',
      })
    ).toMatchObject({ kind: 'failed', code: 'STALE_TRASH_ENTRY', stateChanged: false });
    await runWithEmptyCatalog({
      kind: 'purge',
      workspaceRoot: root,
      entryId: trashed.entry.id,
      expectedRevision: trashed.entry.revision,
    });
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await runWithEmptyCatalog({ kind: 'list', workspaceRoot: root })).toMatchObject({
      entries: [],
    });
  });

  it('restores a whole native package with its identity and nested payloads intact', async () => {
    const path = join(root, 'Notebook');
    await mkdir(join(path, '.forge', 'blocks'), { recursive: true });
    await writeFile(join(path, '.forge', 'notebook.json'), '{"id":"original-native-identity"}');
    await writeFile(
      join(path, '.forge', 'blocks', 'payload.json'),
      '{"text":"preserved rich content"}'
    );
    await writeFile(join(path, 'Notebook.md'), '# Native notebook\n');
    const source = await runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path });
    if (source.kind !== 'inspect') throw new Error('Expected package inspection');
    const result = await runWorkspaceFileTrash({
      kind: 'trash',
      workspaceRoot: root,
      path,
      expectedRevision: source.source.revision,
    });
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'SAVED_ENTITY_CONTENT',
      stateChanged: false,
    });
    const entryId = randomUUID();
    const entryDir = join(root, '.git', 'dnaforge-file-trash', entryId);
    await mkdir(entryDir, { recursive: true });
    const contentDigest = await workspaceMoveTreeDigest(path);
    await rename(path, join(entryDir, 'payload'));
    await writeFile(
      join(entryDir, 'record.json'),
      JSON.stringify({
        schema: 'dnaforge.file-trash.v1',
        id: entryId,
        workspaceRoot: await realpath(root),
        originalPath: 'Notebook',
        trashedAt: new Date().toISOString(),
        type: 'directory',
        contentDigest,
      })
    );
    const old = await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: root });
    if (old.kind !== 'list' || old.entries.length !== 1) throw Error(JSON.stringify(old));
    const [entry] = old.entries;
    expect(
      await runWorkspaceFileTrash({
        kind: 'restore',
        workspaceRoot: root,
        entryId: entry.id,
        expectedRevision: entry.revision,
      })
    ).toMatchObject({ kind: 'restore' });
    expect(await readFile(join(path, '.forge', 'notebook.json'), 'utf8')).toBe(
      '{"id":"original-native-identity"}'
    );
    expect(await readFile(join(path, '.forge', 'blocks', 'payload.json'), 'utf8')).toBe(
      '{"text":"preserved rich content"}'
    );
    expect(await readFile(join(path, 'Notebook.md'), 'utf8')).toBe('# Native notebook\n');
  });

  it('revalidates authority before moving source bytes and retains a changed Trash payload', async () => {
    const path = join(root, 'protected.txt');
    await writeFile(path, 'accepted');
    const source = await runWorkspaceFileTrash({ kind: 'inspect', workspaceRoot: root, path });
    if (source.kind !== 'inspect') throw new Error('Expected source');
    const request = {
      kind: 'trash' as const,
      workspaceRoot: root,
      path,
      expectedRevision: source.source.revision,
    };
    expect(
      await runWorkspaceFileTrash(request, () => {
        throw new Error('Authority revoked');
      })
    ).toMatchObject({ kind: 'failed', stateChanged: false });
    expect(await readFile(path, 'utf8')).toBe('accepted');
    expect(await nativeFileTrash(request)).toMatchObject({
      kind: 'failed',
      code: 'RETENTION_UNVERIFIED',
      stateChanged: false,
    });
    let checks = 0;
    expect(
      await nativeFileTrash(request, undefined, undefined, undefined, () => ++checks === 2)
    ).toMatchObject({ kind: 'failed', code: 'SAVED_ENTITY_CONTENT', stateChanged: false });
    expect(checks).toBe(2);
    expect(await readFile(path, 'utf8')).toBe('accepted');
    expect(await nativeFileTrash({ kind: 'list', workspaceRoot: root })).toMatchObject({
      entries: [],
      errors: [],
    });
    const result = await runWorkspaceFileTrash(request);
    if (result.kind !== 'trash') throw new Error('Expected recovery entry');
    const payload = join(root, '.git', 'dnaforge-file-trash', result.entry.id, 'payload');
    await writeFile(payload, 'changed externally');
    expect(
      await runWorkspaceFileTrash({
        kind: 'restore',
        workspaceRoot: root,
        entryId: result.entry.id,
        expectedRevision: result.entry.revision,
      })
    ).toMatchObject({ kind: 'failed', code: 'STALE_TRASH_ENTRY', stateChanged: false });
    expect(await readFile(payload, 'utf8')).toBe('changed externally');
  });
});
