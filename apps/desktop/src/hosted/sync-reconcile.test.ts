// @vitest-environment node
import type { WorkspaceSessionFile, WorkspaceSessionSnapshot } from '@waypoint/domain-services';
import { defineBlob } from '@waypoint/workspace-revisions';
import { describe, expect, it, vi } from 'vitest';

import {
  reconcileWorkspaceSessionSnapshots,
  type WorkspaceSessionReconcileResult,
} from './sync-reconcile';

const bytesByHash = new Map<string, Uint8Array>();
const encode = (value: string) => new TextEncoder().encode(value);

function file(
  path: string,
  content: string | Uint8Array,
  resourceId: string | null = `resource:${path}`
): WorkspaceSessionFile {
  const bytes = typeof content === 'string' ? encode(content) : content;
  const contentRevision = defineBlob(bytes).hash;
  const contentSha256 = contentRevision.slice('sha256:'.length);
  bytesByHash.set(contentSha256, bytes);
  return {
    path,
    resourceId,
    contentRevision,
    contentSha256,
    sizeBytes: bytes.length,
    contentType: path.endsWith('.json')
      ? 'application/json'
      : path.endsWith('.gb')
        ? 'application/genbank'
        : 'application/octet-stream',
  };
}

function pkg(
  root = 'sequences/construct',
  bases = 'acgtacgt',
  options: {
    id?: string;
    memberId?: string;
    attachment?: string;
    omitAttachment?: boolean;
    formatVersion?: number;
  } = {}
) {
  const marker = {
    schema: 'waypoint.sequence.v1',
    kind: 'sequence',
    formatVersion: options.formatVersion ?? 4,
    id: options.id ?? 'construct-stable-id',
    name: 'Construct',
    product: { file: 'construct.gb', topology: 'circular' },
    members: [
      { id: options.memberId ?? 'trace-stable-id', path: 'contents/trace.ab1', role: 'data' },
    ],
  };
  return [
    file(
      `${root}/.forge/plasmid.json`,
      JSON.stringify(marker),
      `marker:${options.id ?? 'construct-stable-id'}`
    ),
    file(
      `${root}/construct.gb`,
      `LOCUS       construct 8 bp DNA circular\nORIGIN\n        1 ${bases}\n//\n`,
      `product:${options.id ?? 'construct-stable-id'}`
    ),
    ...(options.omitAttachment
      ? []
      : [
          file(
            `${root}/contents/trace.ab1`,
            options.attachment ?? 'original trace',
            `attachment:${options.id ?? 'construct-stable-id'}`
          ),
        ]),
  ];
}

function snapshot(
  files: readonly WorkspaceSessionFile[],
  revisionId = 'revision'
): WorkspaceSessionSnapshot {
  return { workspaceId: 'workspace', revisionId, revisionNumber: 1, files };
}

async function readBytes(_snapshot: WorkspaceSessionSnapshot, entry: WorkspaceSessionFile) {
  const bytes = bytesByHash.get(entry.contentSha256 ?? '');
  if (!bytes) throw new Error(`Missing frozen bytes: ${entry.path}`);
  return bytes.slice();
}

function merged(result: WorkspaceSessionReconcileResult) {
  expect(result.kind).toBe('merged');
  if (result.kind !== 'merged') throw new Error(JSON.stringify(result));
  return result;
}

function conflicts(result: WorkspaceSessionReconcileResult) {
  expect(result.kind).toBe('conflict');
  if (result.kind !== 'conflict') throw new Error(JSON.stringify(result));
  return result;
}

describe('browser-safe whole-package three-way reconciliation', () => {
  it('combines different ordinary resources and writes only the local delta against remote', async () => {
    const base = snapshot([
      file('notes.txt', 'before', 'notes-id'),
      file('table.csv', 'before', 'table-id'),
    ]);
    const local = snapshot([file('notes.txt', 'my notes', 'notes-id'), base.files[1]!]);
    const remote = snapshot([base.files[0]!, file('table.csv', 'their table', 'table-id')]);
    const before = JSON.stringify({ base, local, remote });
    const result = merged(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
    );
    expect(
      result.writes.map((write) => [
        write.path,
        new TextDecoder().decode(write.bytes),
        write.resourceId,
      ])
    ).toEqual([['notes.txt', 'my notes', 'notes-id']]);
    expect(result.removePaths).toEqual([]);
    expect(JSON.stringify({ base, local, remote })).toBe(before);
  });

  it.each(['local', 'remote'] as const)(
    'combines a package folder move on %s with the other side’s content edit',
    async (moving) => {
      const base = snapshot(pkg());
      const move = snapshot(pkg('sequences/moved'));
      const edit = snapshot(pkg('sequences/construct', 'ttttacgt'));
      const local = moving === 'local' ? move : edit;
      const remote = moving === 'local' ? edit : move;
      const result = merged(
        await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
      );
      const product = result.writes.find((write) => write.path === 'sequences/moved/construct.gb');
      expect(new TextDecoder().decode(product?.bytes)).toContain('ttttacgt');
      expect(product?.resourceId).toBe('product:construct-stable-id');
      if (moving === 'local') {
        expect(result.removePaths).toEqual(remote.files.map((entry) => entry.path).sort());
        expect(result.writes).toHaveLength(3);
      } else {
        expect(result.removePaths).toEqual([]);
        expect(result.writes).toHaveLength(1);
      }
    }
  );

  it('reads the remote frozen payload when equal edits accompany a local move', async () => {
    const base = snapshot([file('before.txt', 'before', 'note-id')], 'base');
    const local = snapshot([file('after.txt', 'agreed', 'note-id')], 'local');
    const remote = snapshot([file('before.txt', 'agreed', 'note-id')], 'remote');
    const read = vi.fn(readBytes);
    const result = merged(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes: read })
    );
    expect(
      result.writes.map((write) => [write.path, new TextDecoder().decode(write.bytes)])
    ).toEqual([['after.txt', 'agreed']]);
    expect(result.removePaths).toEqual(['before.txt']);
    expect(read).toHaveBeenCalledExactlyOnceWith(remote, remote.files[0]);
  });

  it('conflicts the entire sequence package when different scientific members change', async () => {
    const base = snapshot(pkg());
    const local = snapshot(pkg(undefined, 'ttttacgt'));
    const remote = snapshot(pkg(undefined, 'acgtacgt', { attachment: 'new remote trace' }));
    const result = conflicts(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      resourceId: 'seq:construct-stable-id',
      kind: 'sequence-package',
      reason: 'edit-edit',
    });
    expect(result.conflicts[0]!.local?.files).toHaveLength(3);
    expect('writes' in result).toBe(false);
  });

  it('chooses reviewed exact package bytes, but asks again if that package changes', async () => {
    const base = snapshot(pkg());
    const local = snapshot(pkg(undefined, 'ttttacgt'));
    const remote = snapshot(pkg(undefined, 'ccccacgt'));
    const first = conflicts(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
    );
    const item = first.conflicts[0]!;
    const choices = {
      [item.resourceId]: { choice: 'mine' as const, reviewFingerprint: item.reviewFingerprint },
    };
    const selected = merged(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes, choices })
    );
    expect(new TextDecoder().decode(selected.writes[0]!.bytes)).toContain('ttttacgt');
    const changedLocal = snapshot(pkg(undefined, 'ggggacgt'));
    const refreshed = conflicts(
      await reconcileWorkspaceSessionSnapshots({
        base,
        local: changedLocal,
        remote,
        readBytes,
        choices,
      })
    );
    expect(refreshed.conflicts[0]!.reviewFingerprint).not.toBe(item.reviewFingerprint);
  });

  it('preserves an exact reviewed package choice when only an unrelated ordinary file changes', async () => {
    const base = snapshot([...pkg(), file('notes.txt', 'before', 'notes-id')]);
    const local = snapshot([
      ...pkg(undefined, 'ttttacgt'),
      file('notes.txt', 'before', 'notes-id'),
    ]);
    const remote = snapshot([
      ...pkg(undefined, 'ccccacgt'),
      file('notes.txt', 'before', 'notes-id'),
    ]);
    const item = conflicts(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
    ).conflicts[0]!;
    const result = merged(
      await reconcileWorkspaceSessionSnapshots({
        base,
        local: snapshot([
          ...local.files.slice(0, 3),
          file('notes.txt', 'new unrelated note', 'notes-id'),
        ]),
        remote,
        readBytes,
        choices: {
          [item.resourceId]: { choice: 'theirs', reviewFingerprint: item.reviewFingerprint },
        },
      })
    );
    expect(result.writes).toHaveLength(1);
    expect(new TextDecoder().decode(result.writes[0]!.bytes)).toBe('new unrelated note');
  });

  it('offers deletion explicitly and does not mistake delete-versus-edit for a safe merge', async () => {
    const base = snapshot(pkg());
    const local = snapshot([]);
    const remote = snapshot(pkg(undefined, 'ccccacgt'));
    const item = conflicts(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
    ).conflicts[0]!;
    expect(item).toMatchObject({ reason: 'delete-edit', local: null });
    const result = merged(
      await reconcileWorkspaceSessionSnapshots({
        base,
        local,
        remote,
        readBytes,
        choices: {
          [item.resourceId]: { choice: 'mine', reviewFingerprint: item.reviewFingerprint },
        },
      })
    );
    expect(result.writes).toEqual([]);
    expect(result.removePaths).toEqual(remote.files.map((entry) => entry.path).sort());
  });

  it('treats a new-ID package copy as separate but refuses a copy with reused package identity', async () => {
    const base = snapshot(pkg());
    const copied = snapshot([
      ...pkg(),
      ...pkg('sequences/copy', 'acgtacgt', { id: 'copy-stable-id' }),
    ]);
    expect(
      merged(
        await reconcileWorkspaceSessionSnapshots({ base, local: copied, remote: base, readBytes })
      ).writes
    ).toHaveLength(3);
    const duplicate = snapshot([...pkg(), ...pkg('sequences/copy')]);
    expect(
      await reconcileWorkspaceSessionSnapshots({ base, local: duplicate, remote: base, readBytes })
    ).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/duplicate.*identity/i) });
  });

  it.each([
    'missing-member',
    'future-format',
    'missing-file-id',
    'duplicate-file-id',
    'case-collision',
    'ambiguous-package-placement',
    'file-ancestor',
    'nested-package',
  ] as const)('fails closed for %s rather than emitting destructive writes', async (mode) => {
    const base = snapshot(pkg());
    let files: readonly WorkspaceSessionFile[];
    switch (mode) {
      case 'missing-member':
        files = pkg(undefined, undefined, { omitAttachment: true });
        break;
      case 'future-format':
        files = pkg(undefined, undefined, { formatVersion: 99 });
        break;
      case 'missing-file-id':
        files = [file('notes.txt', 'note', null)];
        break;
      case 'duplicate-file-id':
        files = [file('one.txt', 'one', 'reused'), file('two.txt', 'two', 'reused')];
        break;
      case 'case-collision':
        files = [file('Notes.txt', 'one'), file('notes.txt', 'two')];
        break;
      case 'ambiguous-package-placement':
        files = [...pkg('Sequences/Construct'), file('sequences/construct/extra.txt', 'ambiguous')];
        break;
      case 'file-ancestor':
        files = [file('notes', 'one'), file('notes/detail.txt', 'two')];
        break;
      case 'nested-package':
        files = [...pkg(), ...pkg('sequences/construct/nested', 'acgtacgt', { id: 'nested' })];
        break;
    }
    expect(
      await reconcileWorkspaceSessionSnapshots({
        base,
        local: snapshot(files),
        remote: base,
        readBytes,
      })
    ).toMatchObject({ kind: 'invalid' });
  });

  it('surfaces a destination collision across resources instead of overwriting the remote file', async () => {
    const base = snapshot([
      file('mine.txt', 'mine', 'mine-id'),
      file('theirs.txt', 'theirs', 'theirs-id'),
    ]);
    const local = snapshot([file('shared.txt', 'mine', 'mine-id'), base.files[1]!]);
    const remote = snapshot([base.files[0]!, file('shared.txt', 'theirs', 'theirs-id')]);
    const result = conflicts(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
    );
    expect(result.conflicts.map((item) => item.reason)).toEqual(['path-conflict', 'path-conflict']);
    const selected = merged(
      await reconcileWorkspaceSessionSnapshots({
        base,
        local,
        remote,
        readBytes,
        choices: Object.fromEntries(
          result.conflicts.map((item) => [
            item.resourceId,
            { choice: 'mine' as const, reviewFingerprint: item.reviewFingerprint },
          ])
        ),
      })
    );
    expect(selected.writes.map((write) => [write.path, write.resourceId])).toEqual([
      ['shared.txt', 'mine-id'],
      ['theirs.txt', 'theirs-id'],
    ]);
  });

  it('does not silently adopt an unrelated resource when a package is moved over its directory', async () => {
    const base = snapshot([...pkg(), file('notes.txt', 'my independent notes', 'notes-id')]);
    const local = snapshot([...pkg('sequences/moved'), base.files[3]!]);
    const remote = snapshot([
      ...base.files.slice(0, 3),
      file('sequences/moved/notes.txt', 'my independent notes', 'notes-id'),
    ]);
    const result = conflicts(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote, readBytes })
    );
    expect(result.conflicts.map((item) => item.reason)).toEqual(['path-conflict', 'path-conflict']);
    const selected = merged(
      await reconcileWorkspaceSessionSnapshots({
        base,
        local,
        remote,
        readBytes,
        choices: Object.fromEntries(
          result.conflicts.map((item) => [
            item.resourceId,
            { choice: 'mine' as const, reviewFingerprint: item.reviewFingerprint },
          ])
        ),
      })
    );
    expect(
      selected.writes.some((write) => write.path === 'notes.txt' && write.resourceId === 'notes-id')
    ).toBe(true);
    expect(selected.writes.some((write) => write.path === 'sequences/moved/notes.txt')).toBe(false);
  });

  it('rejects read bytes that do not match their immutable manifest identity', async () => {
    const base = snapshot([file('notes.txt', 'before', 'notes-id')]);
    const local = snapshot([file('notes.txt', 'after', 'notes-id')]);
    const corrupted = vi.fn(async () => encode('wrong'));
    expect(
      await reconcileWorkspaceSessionSnapshots({ base, local, remote: base, readBytes: corrupted })
    ).toMatchObject({
      kind: 'invalid',
      reason: expect.stringMatching(/integrity|frozen|hash|size/i),
    });
  });
});
