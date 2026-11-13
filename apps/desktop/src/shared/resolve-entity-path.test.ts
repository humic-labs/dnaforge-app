// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  isAbsolutePath,
  looksLikeWorkspacePath,
  parseSequenceDbId,
  resolveWorkspaceEntityPath,
  workspacePathCandidates,
} from './resolve-entity-path';

describe('parseSequenceDbId', () => {
  it('extracts the row id from a `seq_<n>` @-mention (db-id, not a path)', () => {
    expect(parseSequenceDbId('seq_123')).toBe(123);
    expect(parseSequenceDbId('seq_1')).toBe(1);
  });
  it('returns null for a real workspace path (bundled/authored content)', () => {
    expect(parseSequenceDbId('sequences/kits/moclo-cidar/J23106_AB.gb')).toBeNull();
    expect(parseSequenceDbId('/abs/path/x.gb')).toBeNull();
    expect(parseSequenceDbId('seq_')).toBeNull();
    expect(parseSequenceDbId('seq_abc')).toBeNull();
  });
});

describe('resolveWorkspaceEntityPath', () => {
  const folders = [
    { path: '/dev/pinned', pinned: true },
    { path: '/Users/x/ws', pinned: false },
  ];

  it('passes an absolute path that is INSIDE an open workspace root', () => {
    expect(resolveWorkspaceEntityPath('/Users/x/ws/a/b.gb', folders)).toBe('/Users/x/ws/a/b.gb');
  });

  it('anchors a workspace-relative path to the primary (non-pinned) root', () => {
    expect(resolveWorkspaceEntityPath('sequences/circular/pUC19.gb', folders)).toBe(
      '/Users/x/ws/sequences/circular/pUC19.gb'
    );
  });

  it('falls back to the first folder when none are non-pinned', () => {
    expect(resolveWorkspaceEntityPath('a.gb', [{ path: '/only', pinned: true }])).toBe(
      '/only/a.gb'
    );
  });

  it('returns null for a relative id with no workspace open', () => {
    expect(resolveWorkspaceEntityPath('a.gb', [])).toBe(null);
  });

  it('returns null for an empty id', () => {
    expect(resolveWorkspaceEntityPath('', folders)).toBe(null);
  });

  it('does not double the separator when the root has a trailing slash', () => {
    expect(resolveWorkspaceEntityPath('a/b.gb', [{ path: '/ws/' }])).toBe('/ws/a/b.gb');
  });

  it('REJECTS a relative path with .. traversal', () => {
    expect(resolveWorkspaceEntityPath('../../../../.ssh/config', folders)).toBe(null);
    expect(resolveWorkspaceEntityPath('sequences/../../secret', folders)).toBe(null);
  });

  it('REJECTS a relative path with a . segment', () => {
    expect(resolveWorkspaceEntityPath('./a.gb', folders)).toBe(null);
  });

  it('REJECTS an absolute path OUTSIDE every open root', () => {
    expect(resolveWorkspaceEntityPath('/etc/passwd', folders)).toBe(null);
    expect(resolveWorkspaceEntityPath('/Users/x/other/a.gb', folders)).toBe(null);
  });

  it('does NOT treat a sibling dir with a shared prefix as contained', () => {
    expect(resolveWorkspaceEntityPath('/Users/x/ws-evil/a.gb', folders)).toBe(null);
  });

  it('REJECTS an absolute path with .. that textually prefixes a root', () => {
    expect(resolveWorkspaceEntityPath('/Users/x/ws/../../../.ssh/id_rsa', folders)).toBe(null);
  });

  it('handles Windows drive-letter absolute paths + roots', () => {
    expect(isAbsolutePath('C:\\Users\\user\\a.gb')).toBe(true);
    const win = [{ path: 'C:\\Users\\user' }];
    expect(resolveWorkspaceEntityPath('C:\\Users\\user\\a.gb', win)).toBe('C:\\Users\\user\\a.gb');
    expect(resolveWorkspaceEntityPath('sequences/a.gb', win)).toBe(
      'C:\\Users\\user\\sequences\\a.gb'
    );
    expect(resolveWorkspaceEntityPath('C:\\Windows\\system32', win)).toBe(null);
  });
});

describe('opaque ids must never be treated as paths', () => {
  const UUID = '031da8dc-8aad-4179-afe1-74ee0cb24579';
  const FOLDERS = [{ path: '/ws/alpha' }, { path: '/ws/beta' }];

  it('🟥 REFUSES a catalog uuid instead of joining it onto a root', () => {
    expect(resolveWorkspaceEntityPath(UUID, FOLDERS)).toBeNull();
  });

  it('refuses a `seq_` row id — the hazard the module doc already warned about', () => {
    expect(resolveWorkspaceEntityPath('seq_123', FOLDERS)).toBeNull();
  });

  it('refuses a bare filename when several projects could own it', () => {
    expect(resolveWorkspaceEntityPath('pUC19.gb', FOLDERS)).toBeNull();
  });

  it('refuses a nested relative path when several projects could own it', () => {
    expect(resolveWorkspaceEntityPath('sequences/pUC19.gb', FOLDERS)).toBeNull();
  });
});

describe('workspacePathCandidates', () => {
  const FOLDERS = [{ path: '/ws/alpha' }, { path: '/ws/beta' }, { path: '/dev', pinned: true }];

  it('offers the same relative path under EVERY open root, so the caller can find the file', () => {
    expect(workspacePathCandidates('seq/a.gb', FOLDERS)).toEqual([
      '/ws/alpha/seq/a.gb',
      '/ws/beta/seq/a.gb',
    ]);
  });

  it('🟥 puts the OWNING workspace first so a duplicate filename resolves to the right copy', () => {
    expect(workspacePathCandidates('seq/a.gb', FOLDERS, '/ws/beta')[0]).toBe('/ws/beta/seq/a.gb');
  });

  it('excludes PINNED dev roots — they are not real workspaces', () => {
    expect(workspacePathCandidates('seq/a.gb', FOLDERS)).not.toContain('/dev/seq/a.gb');
  });

  it('offers nothing for a traversal escape', () => {
    expect(workspacePathCandidates('../../etc/passwd', FOLDERS)).toEqual([]);
  });

  it('offers nothing for an absolute path', () => {
    expect(workspacePathCandidates('/etc/passwd', FOLDERS)).toEqual([]);
  });

  it('does not duplicate a root that is also the preferred root', () => {
    const out = workspacePathCandidates('a.gb', FOLDERS, '/ws/alpha');
    expect(out).toEqual(['/ws/alpha/a.gb', '/ws/beta/a.gb']);
  });
});
