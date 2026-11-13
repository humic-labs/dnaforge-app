// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { resolveItemRecord } from './resolve-item-record';
import type { ReferenceContext } from './reference-context';

const CTX: ReferenceContext = { owningRoot: '/ws/beta', workspaceScopeKey: 'scope-beta' };
const HASH = `sha256:${'a'.repeat(64)}`;

function deps(over: Partial<Parameters<typeof resolveItemRecord>[2]> = {}) {
  return {
    lookupCatalogFile: vi.fn().mockResolvedValue(null),
    contentHash: vi.fn().mockResolvedValue(HASH),
    ...over,
  };
}

const SEQ = { entityType: 'sequence', entityId: 'ent-1', label: 'pUC19' };

describe('resolveItemRecord', () => {
  it('resolves a catalog entity to its workspace-relative path and hashes it', async () => {
    const d = deps({
      lookupCatalogFile: vi.fn().mockResolvedValue({
        path: '/ws/beta/sequences/pUC19.gb',
        relative_path: 'sequences/pUC19.gb',
        content_hash: null,
      }),
    });

    const record = await resolveItemRecord(SEQ, CTX, d);

    expect(record).toEqual({ path: 'sequences/pUC19.gb', contentHash: HASH });
  });

  it('falls back to a legacy path-shaped id the catalog does not know', async () => {
    const d = deps();

    const record = await resolveItemRecord(
      { ...SEQ, entityId: 'sequences/cidar/BBa_J23100.gb' },
      CTX,
      d
    );

    expect(d.lookupCatalogFile).toHaveBeenCalled();
    expect(record.path).toBe('sequences/cidar/BBa_J23100.gb');
  });

  it('does NOT treat a bare entity id as a file path', async () => {
    const record = await resolveItemRecord({ ...SEQ, entityId: 'ent-1' }, CTX, deps());

    expect(record.path).toBeNull();
  });

  it('re-hashes a git: catalog value rather than copying it', async () => {
    const d = deps({
      lookupCatalogFile: vi.fn().mockResolvedValue({
        path: '/ws/beta/a.gb',
        relative_path: 'a.gb',
        content_hash: 'git:deadbeef',
      }),
    });

    const record = await resolveItemRecord(SEQ, CTX, d);

    expect(d.contentHash).toHaveBeenCalled();
    expect(record.contentHash).toBe(HASH);
  });

  it('returns an empty record for a PAGE, which is not a workspace file', async () => {
    const d = deps();

    const record = await resolveItemRecord(
      { entityType: 'page', entityId: 'page-1', label: 'Notes' },
      CTX,
      d
    );

    expect(record).toEqual({ path: null, contentHash: null });
    expect(d.lookupCatalogFile).not.toHaveBeenCalled();
  });

  it('returns an empty record when there is no owning root', async () => {
    const record = await resolveItemRecord(SEQ, null, deps());
    expect(record).toEqual({ path: null, contentHash: null });
  });

  it('returns an empty record when the catalog knows nothing', async () => {
    const record = await resolveItemRecord(SEQ, CTX, deps());
    expect(record).toEqual({ path: null, contentHash: null });
  });

  it('refuses a catalog file that lives OUTSIDE the owning root', async () => {
    const d = deps({
      lookupCatalogFile: vi.fn().mockResolvedValue({
        path: '/ws/alpha/a.gb',
        relative_path: 'a.gb',
        content_hash: null,
      }),
    });

    const record = await resolveItemRecord(SEQ, CTX, d);

    expect(record.path).toBeNull();
  });

  it('does not let a sibling root with a shared prefix pass', async () => {
    const d = deps({
      lookupCatalogFile: vi.fn().mockResolvedValue({
        path: '/ws/beta-archive/a.gb',
        relative_path: 'a.gb',
        content_hash: null,
      }),
    });

    expect((await resolveItemRecord(SEQ, CTX, d)).path).toBeNull();
  });

  it('refuses a traversal in a legacy path-shaped id', async () => {
    const record = await resolveItemRecord({ ...SEQ, entityId: '../../etc/passwd' }, CTX, deps());
    expect(record.path).toBeNull();
  });

  it('degrades to an empty record when the catalog lookup throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({ lookupCatalogFile: vi.fn().mockRejectedValue(new Error('db gone')) });

    const record = await resolveItemRecord(SEQ, CTX, d);

    expect(record).toEqual({ path: null, contentHash: null });
    error.mockRestore();
  });

  it('keeps the path when only hashing fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({
      lookupCatalogFile: vi.fn().mockResolvedValue({
        path: '/ws/beta/a.gb',
        relative_path: 'a.gb',
        content_hash: null,
      }),
      contentHash: vi.fn().mockRejectedValue(new Error('gone')),
    });

    const record = await resolveItemRecord(SEQ, CTX, d);

    expect(record.path).toBe('a.gb');
    expect(record.contentHash).toBeNull();
    error.mockRestore();
  });
});
