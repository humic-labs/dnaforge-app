// @vitest-environment node
import { createHash } from 'node:crypto';

import type { WorkspaceSyncBundle, WorkspaceSyncFile } from '@waypoint/share-bundle';
import { describe, expect, it } from 'vitest';
import { buildSequencePackageDocument, type SequencePackageMember } from '../db/sequence-package';

import {
  groupBundleResources,
  reconcileWithChoices,
  reconcileWorkspaceBundles,
  type ReconcileOutcome,
} from './workspace-sync-reconcile';

function textFile(relativePath: string, text: string): WorkspaceSyncFile {
  const bytes = Buffer.from(text, 'utf8');
  return {
    id: `id:${relativePath}`,
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    kind: relativePath.endsWith('.gb') ? 'genbank' : 'design',
    contentType: 'text/plain',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content: text,
  };
}

function bundle(files: Record<string, string>): WorkspaceSyncBundle {
  return {
    schemaVersion: 2,
    capturedAt: '2026-09-08T00:00:00.000Z',
    workspace: { id: 'workspace-a', name: 'Project A' },
    files: Object.entries(files).map(([path, text]) => textFile(path, text)),
  } as unknown as WorkspaceSyncBundle;
}

function contents(outcome: ReconcileOutcome): Record<string, string> {
  if (outcome.kind !== 'merged') throw new Error(`expected merged, got ${JSON.stringify(outcome)}`);
  return Object.fromEntries(
    outcome.files.map((file) => [file.relativePath, Buffer.from(file.content, 'utf8').toString()])
  );
}

function conflicts(outcome: ReconcileOutcome) {
  if (outcome.kind !== 'conflicts')
    throw new Error(`expected conflicts, got ${JSON.stringify(outcome)}`);
  return outcome.conflicts;
}

const PKG = 'plasmids/pUC19';
const MARKER = `${PKG}/.forge/plasmid.json`;
const MEMBER = `${PKG}/sequence.gb`;
const NOTES = `${PKG}/notes.md`;

function marker(id = 'seq-1', members: SequencePackageMember[] = []): string {
  return JSON.stringify(
    buildSequencePackageDocument({
      id,
      name: id,
      product: { file: 'sequence.gb' },
      members,
      updatedAt: '2026-10-05T00:00:00.000Z',
    })
  );
}

function pkg(overrides: Record<string, string> = {}, root = PKG): Record<string, string> {
  const files: Record<string, string> = {
    [`${root}/.forge/plasmid.json`]: marker(),
    [`${root}/sequence.gb`]: 'LOCUS pUC19',
    [`${root}/notes.md`]: 'notes',
  };
  for (const [path, text] of Object.entries(overrides)) files[`${root}/${path}`] = text;
  return files;
}

describe('groupBundleResources', () => {
  it('treats a sequence package as one resource keyed by its marker id', () => {
    const resources = groupBundleResources(bundle({ ...pkg(), 'loose.txt': 'x' }));
    expect([...resources.keys()].sort()).toEqual(['file:loose.txt', 'seq:seq-1']);
    const sequence = resources.get('seq:seq-1');
    expect(sequence?.kind).toBe('sequence-package');
    expect(sequence?.path).toBe(PKG);
    expect(sequence?.files.map((file) => file.relativePath).sort()).toEqual(
      [MARKER, NOTES, MEMBER].sort()
    );
  });

  it('rejects a managed package without its stable identity instead of inventing a path identity', () => {
    expect(() =>
      groupBundleResources(bundle({ 'nb/lab/.forge/notebook.json': '{}', 'nb/lab/page.md': 'p' }))
    ).toThrow(/id|identity/i);
  });

  it('rejects a copied package that still claims the original identity', () => {
    const copied = bundle({ ...pkg(), ...pkg({}, 'plasmids/copied') });
    expect(() => groupBundleResources(copied)).toThrow(/duplicate.*seq-1/i);
    const input = { workspaceId: 'workspace-a', base: null, local: copied, remote: copied };
    expect(reconcileWorkspaceBundles(input)).toMatchObject({ kind: 'failed' });
    expect(reconcileWithChoices(input, {})).toMatchObject({ kind: 'failed' });
  });

  it('keeps an intentionally copied package with a new identity as a separate resource', () => {
    const copied = pkg({}, 'plasmids/copied');
    copied['plasmids/copied/.forge/plasmid.json'] = marker('seq-2');
    const resources = groupBundleResources(bundle({ ...pkg(), ...copied }));
    expect([...resources.keys()].sort()).toEqual(['seq:seq-1', 'seq:seq-2']);
    expect(resources.get('seq:seq-1')?.path).toBe(PKG);
    expect(resources.get('seq:seq-2')?.path).toBe('plasmids/copied');
  });

  it('returns nothing for a missing base', () => {
    expect(groupBundleResources(null).size).toBe(0);
  });

  it('preserves a declared attachment identity when its filename changes', () => {
    const member = {
      id: 'attachment-stable-id',
      role: 'data',
      path: 'contents/original.csv',
      replaceable: false,
      createdAt: '2026-10-05T00:00:00.000Z',
    };
    const original = groupBundleResources(
      bundle(
        pkg({
          '.forge/plasmid.json': marker('seq-1', [member]),
          'contents/original.csv': 'scientific measurements',
        })
      )
    ).get('seq:seq-1')!;
    const renamed = groupBundleResources(
      bundle(
        pkg({
          '.forge/plasmid.json': marker('seq-1', [{ ...member, path: 'contents/renamed.csv' }]),
          'contents/renamed.csv': 'scientific measurements',
        })
      )
    ).get('seq:seq-1')!;
    expect(original.memberIds?.get('contents/original.csv')).toBe('member:attachment-stable-id');
    expect(renamed.memberIds?.get('contents/renamed.csv')).toBe(
      original.memberIds?.get('contents/original.csv')
    );
  });

  it('rejects a sequence package with a missing declared member rather than treating it as an edit', () => {
    const incomplete = bundle(
      pkg({
        '.forge/plasmid.json': marker('seq-1', [
          {
            id: 'missing-member',
            role: 'data',
            path: 'contents/missing.csv',
            replaceable: false,
            createdAt: '2026-10-05T00:00:00.000Z',
          },
        ]),
      })
    );
    expect(() => groupBundleResources(incomplete)).toThrow(/incomplete.*missing/i);
  });

  it('namespaces declared member identities away from implicit marker and product identities', () => {
    const sequence = groupBundleResources(
      bundle(
        pkg({
          '.forge/plasmid.json': marker('seq-1', [
            {
              id: 'implicit:sequence-product',
              role: 'data',
              path: 'contents/trace.ab1',
              replaceable: false,
              createdAt: '2026-10-05T00:00:00.000Z',
            },
          ]),
          'contents/trace.ab1': 'trace bytes',
        })
      )
    ).get('seq:seq-1')!;
    expect(sequence.memberIds?.get('sequence.gb')).toBe('implicit:sequence-product');
    expect(sequence.memberIds?.get('contents/trace.ab1')).toBe('member:implicit:sequence-product');
    expect(
      reconcileWorkspaceBundles({
        workspaceId: 'workspace-a',
        base: null,
        local: bundle(pkg()),
        remote: bundle(pkg()),
      }).kind
    ).toBe('merged');
  });
});

describe('reconcileWorkspaceBundles', () => {
  it('does not interpret a legacy snapshot omission as deletion of a private resource', () => {
    const base = bundle({ 'sequence.gb': 'original', 'notes.txt': 'keep these notes' });
    base.files[1].kind = 'workspace-resource';
    const remote = { ...base, files: base.files.map((file) => ({ ...file })) };
    remote.files[0] = textFile('sequence.gb', 'browser edit');
    const local = bundle({ 'sequence.gb': 'desktop edit' });
    const before = JSON.stringify({ base, local, remote });
    const input = { workspaceId: 'workspace-a', base, local, remote };
    for (const outcome of [reconcileWorkspaceBundles(input), reconcileWithChoices(input, {})]) {
      expect(outcome).toMatchObject({
        kind: 'failed',
        reason: expect.stringContaining('cannot safely reconcile ordinary project files'),
      });
    }
    expect(JSON.stringify({ base, local, remote })).toBe(before);
  });

  it('composes ordinary admitted resources only with an explicitly complete local capture', () => {
    const privateBundle = (files: Record<string, string>) => {
      const value = bundle(files);
      value.files.forEach((file) => {
        file.kind = 'workspace-resource';
      });
      return value;
    };
    const input = {
      workspaceId: 'workspace-a',
      localCaptureComplete: true,
      base: privateBundle({ 'notes.txt': 'original', 'table.csv': 'original' }),
      local: privateBundle({ 'notes.txt': 'local notes', 'table.csv': 'original' }),
      remote: privateBundle({ 'notes.txt': 'original', 'table.csv': 'browser table' }),
    };
    expect(contents(reconcileWorkspaceBundles(input))).toEqual({
      'notes.txt': 'local notes',
      'table.csv': 'browser table',
    });
    input.local.excludedSummary = {
      unsupported: { count: 0, bytesApprox: 0 },
      'private-raw-data': { count: 0, bytesApprox: 0 },
      'reference-pointer': { count: 0, bytesApprox: 0 },
      'file-too-large': { count: 1, bytesApprox: 100 },
      'bundle-too-large': { count: 0, bytesApprox: 0 },
    };
    expect(reconcileWorkspaceBundles(input)).toMatchObject({
      kind: 'failed',
      reason: expect.stringMatching(/incomplete|could not be captured/i),
    });
  });

  it('composes edits to different files from both sides', () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle({ 'a.txt': '1', 'b.txt': '1' }),
      local: bundle({ 'a.txt': 'local', 'b.txt': '1' }),
      remote: bundle({ 'a.txt': '1', 'b.txt': 'remote' }),
    });
    expect(contents(outcome)).toEqual({ 'a.txt': 'local', 'b.txt': 'remote' });
    expect(outcome.kind === 'merged' && outcome.summary.takenFromLocal).toContain('a.txt');
    expect(outcome.kind === 'merged' && outcome.summary.takenFromRemote).toContain('b.txt');
  });

  it("keeps this computer's edit when the shared side is unchanged", () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle({ 'a.txt': '1' }),
      local: bundle({ 'a.txt': 'local' }),
      remote: bundle({ 'a.txt': '1' }),
    });
    expect(contents(outcome)).toEqual({ 'a.txt': 'local' });
  });

  it('adopts additions from both sides and a deletion from one side', () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle({ 'a.txt': '1', 'gone.txt': 'g' }),
      local: bundle({ 'a.txt': '1', 'gone.txt': 'g', 'mine.txt': 'm' }),
      remote: bundle({ 'a.txt': '1', 'theirs.txt': 't' }),
    });
    expect(contents(outcome)).toEqual({ 'a.txt': '1', 'mine.txt': 'm', 'theirs.txt': 't' });
    expect(outcome.kind === 'merged' && outcome.summary.deleted).toContain('gone.txt');
  });

  it('never picks a winner when both sides edited the same file', () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle({ 'a.txt': '1' }),
      local: bundle({ 'a.txt': 'local' }),
      remote: bundle({ 'a.txt': 'remote' }),
    });
    const items = conflicts(outcome);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      resourceId: 'file:a.txt',
      kind: 'file',
      reason: 'edit-edit',
      path: 'a.txt',
      canKeepBoth: true,
    });
    expect(items[0]?.local?.files[0]?.content).toBe('local');
    expect(items[0]?.remote?.files[0]?.content).toBe('remote');
  });

  it('flags a file deleted here but edited elsewhere', () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle({ 'a.txt': '1', 'keep.txt': 'k' }),
      local: bundle({ 'keep.txt': 'k' }),
      remote: bundle({ 'a.txt': 'remote', 'keep.txt': 'k' }),
    });
    const items = conflicts(outcome);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ resourceId: 'file:a.txt', canKeepBoth: false });
    expect(['delete-edit', 'move-delete']).toContain(items[0]?.reason);
  });

  it('moves a whole sequence package together when the shared side edited a member', () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle(pkg()),
      local: bundle(pkg()),
      remote: bundle(pkg({ 'sequence.gb': 'LOCUS pUC19 edited' })),
    });
    expect(contents(outcome)[MEMBER]).toBe('LOCUS pUC19 edited');
    expect(Object.keys(contents(outcome)).sort()).toEqual([MARKER, NOTES, MEMBER].sort());
  });

  it('treats edits to different members of one package as a package-level conflict', () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle(pkg()),
      local: bundle(pkg({ 'notes.md': 'local notes' })),
      remote: bundle(pkg({ 'sequence.gb': 'LOCUS pUC19 remote' })),
    });
    const items = conflicts(outcome);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      resourceId: 'seq:seq-1',
      kind: 'sequence-package',
      reason: 'edit-edit',
      canKeepBoth: false,
    });
  });

  it('follows a package rename from the shared side', () => {
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle(pkg()),
      local: bundle(pkg()),
      remote: bundle(pkg({}, 'plasmids/pUC19-renamed')),
    });
    expect(Object.keys(contents(outcome)).sort()).toEqual(
      [
        'plasmids/pUC19-renamed/.forge/plasmid.json',
        'plasmids/pUC19-renamed/notes.md',
        'plasmids/pUC19-renamed/sequence.gb',
      ].sort()
    );
  });

  it('combines a folder rename with an edit without changing the package identity', () => {
    const renamed = 'plasmids/renamed';
    const outcome = reconcileWorkspaceBundles({
      workspaceId: 'workspace-a',
      base: bundle(pkg()),
      local: bundle(pkg({}, renamed)),
      remote: bundle(pkg({ 'sequence.gb': 'LOCUS pUC19 edited' })),
    });
    expect(contents(outcome)[`${renamed}/sequence.gb`]).toBe('LOCUS pUC19 edited');
    expect(JSON.parse(contents(outcome)[`${renamed}/.forge/plasmid.json`]).id).toBe('seq-1');
    expect(Object.keys(contents(outcome)).some((path) => path.startsWith(`${PKG}/`))).toBe(false);
  });

  it('reconciles without a common base when both sides agree, and conflicts when they differ', () => {
    expect(
      contents(
        reconcileWorkspaceBundles({
          workspaceId: 'workspace-a',
          base: null,
          local: bundle({ 'a.txt': 'same' }),
          remote: bundle({ 'a.txt': 'same', 'b.txt': 'b' }),
        })
      )
    ).toEqual({ 'a.txt': 'same', 'b.txt': 'b' });

    const items = conflicts(
      reconcileWorkspaceBundles({
        workspaceId: 'workspace-a',
        base: null,
        local: bundle({ 'a.txt': 'local' }),
        remote: bundle({ 'a.txt': 'remote' }),
      })
    );
    expect(items.map((item) => item.resourceId)).toEqual(['file:a.txt']);
  });
});

describe('reconcileWithChoices', () => {
  const input = {
    workspaceId: 'workspace-a',
    base: bundle({ 'a.txt': '1', 'b.txt': '1' }),
    local: bundle({ 'a.txt': 'local', 'b.txt': 'local-b' }),
    remote: bundle({ 'a.txt': 'remote', 'b.txt': '1' }),
    remoteAuthorLabel: 'Alice',
  };

  it('keeps this computer\'s copy for "mine" and leaves other items composed as before', () => {
    expect(contents(reconcileWithChoices(input, { 'file:a.txt': 'mine' }))).toEqual({
      'a.txt': 'local',
      'b.txt': 'local-b',
    });
  });

  it('takes the shared copy for "theirs"', () => {
    expect(contents(reconcileWithChoices(input, { 'file:a.txt': 'theirs' }))).toEqual({
      'a.txt': 'remote',
      'b.txt': 'local-b',
    });
  });

  it('keeps both copies under a labeled name for "both"', () => {
    expect(contents(reconcileWithChoices(input, { 'file:a.txt': 'both' }))).toEqual({
      'a.txt': 'local',
      "a (Alice's version).txt": 'remote',
      'b.txt': 'local-b',
    });
  });

  it('sanitizes the label used for the second copy', () => {
    const outcome = reconcileWithChoices(
      { ...input, remoteAuthorLabel: 'Ali/ce: <x>' },
      { 'file:a.txt': 'both' }
    );
    expect(Object.keys(contents(outcome))).toContain("a (Ali ce x's version).txt");
  });

  it('refuses "both" for a package, which carries a single identity', () => {
    const outcome = reconcileWithChoices(
      {
        workspaceId: 'workspace-a',
        base: bundle(pkg()),
        local: bundle(pkg({ 'notes.md': 'local notes' })),
        remote: bundle(pkg({ 'sequence.gb': 'remote' })),
      },
      { 'seq:seq-1': 'both' }
    );
    expect(outcome.kind).toBe('failed');
  });

  it('resolves a delete-versus-edit by choice', () => {
    const deleteInput = {
      workspaceId: 'workspace-a',
      base: bundle({ 'a.txt': '1', 'keep.txt': 'k' }),
      local: bundle({ 'keep.txt': 'k' }),
      remote: bundle({ 'a.txt': 'remote', 'keep.txt': 'k' }),
    };
    expect(contents(reconcileWithChoices(deleteInput, { 'file:a.txt': 'mine' }))).toEqual({
      'keep.txt': 'k',
    });
    expect(contents(reconcileWithChoices(deleteInput, { 'file:a.txt': 'theirs' }))).toEqual({
      'a.txt': 'remote',
      'keep.txt': 'k',
    });
  });

  describe('path disputes between two different resources', () => {
    const RENAMED = 'plasmids/renamed';
    const other = (root: string): Record<string, string> => ({
      [`${root}/.forge/plasmid.json`]: marker('seq-2'),
      [`${root}/sequence.gb`]: 'LOCUS other',
    });
    const input = {
      workspaceId: 'workspace-a',
      base: bundle(pkg()),
      local: bundle(pkg({}, RENAMED)),
      remote: bundle({ ...pkg(), ...other(RENAMED) }),
      remoteAuthorLabel: 'Alice',
      localAuthorLabel: 'Bob',
    };

    it('shows the real occupant of the path on each side', () => {
      const items = conflicts(reconcileWorkspaceBundles(input));
      const dispute = items.find((item) => item.reason === 'path-conflict');
      expect(dispute).toBeTruthy();
      expect(dispute?.path).toBe(RENAMED);
      expect(dispute?.local?.id).toBe('seq:seq-1');
      expect(dispute?.remote?.id).toBe('seq:seq-2');
      expect(dispute?.canKeepBoth).toBe(true);
    });

    it('keeps both packages whichever side wins the name', () => {
      const items = conflicts(reconcileWorkspaceBundles(input));
      const dispute = items.find((item) => item.reason === 'path-conflict')!;
      const mine = contents(reconcileWithChoices(input, { [dispute.resourceId]: 'mine' }));
      expect(mine[`${RENAMED}/sequence.gb`]).toBe('LOCUS pUC19');
      expect(mine[`plasmids/renamed (Alice's version)/sequence.gb`]).toBe('LOCUS other');
      expect(Object.keys(mine).some((path) => path.startsWith('plasmids/pUC19/'))).toBe(false);

      const theirs = contents(reconcileWithChoices(input, { [dispute.resourceId]: 'theirs' }));
      expect(theirs[`${RENAMED}/sequence.gb`]).toBe('LOCUS other');
      expect(theirs[`plasmids/renamed (Bob's version)/sequence.gb`]).toBe('LOCUS pUC19');
    });
  });

  it('treats a file both sides created with the same name as one file', () => {
    const same = contents(
      reconcileWorkspaceBundles({
        workspaceId: 'workspace-a',
        base: bundle({ 'keep.txt': 'k' }),
        local: bundle({ 'keep.txt': 'k', 'new.txt': 'same' }),
        remote: bundle({ 'keep.txt': 'k', 'new.txt': 'same' }),
      })
    );
    expect(same).toEqual({ 'keep.txt': 'k', 'new.txt': 'same' });

    const differ = conflicts(
      reconcileWorkspaceBundles({
        workspaceId: 'workspace-a',
        base: bundle({ 'keep.txt': 'k' }),
        local: bundle({ 'keep.txt': 'k', 'new.txt': 'mine' }),
        remote: bundle({ 'keep.txt': 'k', 'new.txt': 'theirs' }),
      })
    );
    expect(differ.map((item) => [item.resourceId, item.reason, item.canKeepBoth])).toEqual([
      ['file:new.txt', 'edit-edit', true],
    ]);
  });
});
