// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { relinkByFileContentHash } from './content-relink';

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const git = (c: string) => `git:${c.repeat(40)}`;

describe('relinkByFileContentHash', () => {
  it('(a) one missing entity + one appeared file with the same byte-hash → an unambiguous relink', () => {
    const r = relinkByFileContentHash(
      [{ id: 'e1', oldPath: '/w/old.gb', fileContentHash: sha('a') }],
      [{ path: '/w/moved/new.gb', fileContentHash: sha('a') }]
    );
    expect(r.relinks).toEqual([
      { entityId: 'e1', oldPath: '/w/old.gb', newPath: '/w/moved/new.gb', contentHash: sha('a') },
    ]);
    expect(r.ambiguous).toEqual([]);
  });

  it('(b) two missing entities sharing a byte-hash → AMBIGUOUS, never auto-relinked', () => {
    const r = relinkByFileContentHash(
      [
        { id: 'e1', oldPath: '/w/a.gb', fileContentHash: sha('b') },
        { id: 'e2', oldPath: '/w/b.gb', fileContentHash: sha('b') },
      ],
      [{ path: '/w/moved.gb', fileContentHash: sha('b') }]
    );
    expect(r.relinks).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].entityIds.sort()).toEqual(['e1', 'e2']);
  });

  it('(c) two appeared files sharing a byte-hash → AMBIGUOUS (can’t tell which is the move)', () => {
    const r = relinkByFileContentHash(
      [{ id: 'e1', oldPath: '/w/old.gb', fileContentHash: sha('c') }],
      [
        { path: '/w/x.gb', fileContentHash: sha('c') },
        { path: '/w/y.gb', fileContentHash: sha('c') },
      ]
    );
    expect(r.relinks).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].paths.sort()).toEqual(['/w/x.gb', '/w/y.gb']);
  });

  it('(d) a byte-hash MISMATCH is refused even when a looser matcher would link — bytes are the only truth', () => {
    const r = relinkByFileContentHash(
      [{ id: 'e1', oldPath: '/w/old.gb', fileContentHash: sha('a') }],
      [{ path: '/w/reannotated.gb', fileContentHash: sha('d') }]
    );
    expect(r.relinks).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('(d2) an entity with NO fileContentHash (only normalized/accession identity) never relinks', () => {
    const r = relinkByFileContentHash(
      [{ id: 'e1', oldPath: '/w/old.gb', fileContentHash: null }],
      [{ path: '/w/new.gb', fileContentHash: sha('a') }]
    );
    expect(r.relinks).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('(e) git: and sha256: are separate namespaces — a cross-namespace pair is NEVER a move', () => {
    const r = relinkByFileContentHash(
      [{ id: 'e1', oldPath: '/w/old.gb', fileContentHash: git('a') }],
      [{ path: '/w/new.gb', fileContentHash: sha('a') }]
    );
    expect(r.relinks).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('(f) same-namespace hex is compared case-insensitively (git oid / sha are hex)', () => {
    const r = relinkByFileContentHash(
      [{ id: 'e1', oldPath: '/w/old.gb', fileContentHash: `sha256:${'A'.repeat(64)}` }],
      [{ path: '/w/new.gb', fileContentHash: `sha256:${'a'.repeat(64)}` }]
    );
    expect(r.relinks.map((p) => p.entityId)).toEqual(['e1']);
  });

  it('(g) a file re-appearing at its own old path is NOT a move (re-materialized in place)', () => {
    const r = relinkByFileContentHash(
      [{ id: 'e1', oldPath: '/w/same.gb', fileContentHash: sha('a') }],
      [{ path: '/w/same.gb', fileContentHash: sha('a') }]
    );
    expect(r.relinks).toEqual([]);
    expect(r.ambiguous).toEqual([]);
  });

  it('(h) malformed / empty hashes are ignored on both sides', () => {
    const r = relinkByFileContentHash(
      [
        { id: 'e1', oldPath: '/w/a.gb', fileContentHash: '' },
        { id: 'e2', oldPath: '/w/b.gb', fileContentHash: 'sha256:not-hex' },
        { id: 'e3', oldPath: '/w/c.gb', fileContentHash: sha('e') },
      ],
      [
        { path: '/w/x.gb', fileContentHash: undefined },
        { path: '/w/moved-c.gb', fileContentHash: sha('e') },
      ]
    );
    expect(r.relinks).toEqual([
      { entityId: 'e3', oldPath: '/w/c.gb', newPath: '/w/moved-c.gb', contentHash: sha('e') },
    ]);
  });
});
