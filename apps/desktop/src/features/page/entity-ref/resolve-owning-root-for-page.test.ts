// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { resolveOwningRootForPage } from './resolve-owning-root-for-page';

const A = '/managed/2bac7aad-aaaa/repo';
const B = '/managed/9837e3f9-bbbb/repo';

function scopeResolver(map: Record<string, string | null>) {
  return vi.fn(async (root: string) => map[root] ?? null);
}

describe('resolveOwningRootForPage', () => {
  it('🟥 picks the workspace that OWNS the page, not the first non-pinned one', async () => {
    const resolveScope = scopeResolver({ [A]: '2bac7aad-aaaa', [B]: '9837e3f9-bbbb' });

    const root = await resolveOwningRootForPage({
      pageId: '9837e3f9-bbbb::example-moclo-golden-gate',
      roots: [{ path: A }, { path: B }],
      resolveScope,
    });

    expect(root, 'must be B — A is merely first').toBe(B);
  });

  it('still picks correctly when the owner is listed FIRST', async () => {
    const resolveScope = scopeResolver({ [A]: '2bac7aad-aaaa', [B]: '9837e3f9-bbbb' });

    const root = await resolveOwningRootForPage({
      pageId: '2bac7aad-aaaa::some-note',
      roots: [{ path: A }, { path: B }],
      resolveScope,
    });

    expect(root).toBe(A);
  });

  it('🟥 returns NULL rather than guessing when no root owns the page', async () => {
    const resolveScope = scopeResolver({ [A]: '2bac7aad-aaaa', [B]: '9837e3f9-bbbb' });

    const root = await resolveOwningRootForPage({
      pageId: 'ffffffff-cccc::orphan',
      roots: [{ path: A }, { path: B }],
      resolveScope,
    });

    expect(root).toBeNull();
  });

  it('ignores PINNED dev roots as candidates', async () => {
    const PINNED = '/repo/test-fixtures';
    const resolveScope = scopeResolver({ [PINNED]: 'pinned-scope', [B]: '9837e3f9-bbbb' });

    const root = await resolveOwningRootForPage({
      pageId: '9837e3f9-bbbb::note',
      roots: [{ path: PINNED, pinned: true }, { path: B }],
      resolveScope,
    });

    expect(root).toBe(B);
    expect(resolveScope, 'a pinned root should not even be probed').not.toHaveBeenCalledWith(
      PINNED
    );
  });

  it('falls back to the SOLE root for a bare (pre- page id', async () => {
    const resolveScope = scopeResolver({ [B]: '9837e3f9-bbbb' });

    const root = await resolveOwningRootForPage({
      pageId: 'page-1784179046653-7yx2fda',
      roots: [{ path: B }],
      resolveScope,
    });

    expect(root).toBe(B);
  });

  it('🟥 refuses a bare page id when SEVERAL roots could match', async () => {
    const resolveScope = scopeResolver({ [A]: 'a', [B]: 'b' });

    const root = await resolveOwningRootForPage({
      pageId: 'page-1784179046653-7yx2fda',
      roots: [{ path: A }, { path: B }],
      resolveScope,
    });

    expect(root).toBeNull();
  });

  it('returns null with no roots at all', async () => {
    const root = await resolveOwningRootForPage({
      pageId: 'x::y',
      roots: [],
      resolveScope: scopeResolver({}),
    });
    expect(root).toBeNull();
  });

  it('survives a scope lookup that throws for one root', async () => {
    const resolveScope = vi.fn(async (root: string) => {
      if (root === A) throw new Error('workspace row missing');
      return '9837e3f9-bbbb';
    });

    const root = await resolveOwningRootForPage({
      pageId: '9837e3f9-bbbb::note',
      roots: [{ path: A }, { path: B }],
      resolveScope,
    });

    expect(root).toBe(B);
  });

  it('probes each root at most once', async () => {
    const resolveScope = scopeResolver({ [A]: 'a', [B]: '9837e3f9-bbbb' });

    await resolveOwningRootForPage({
      pageId: '9837e3f9-bbbb::note',
      roots: [{ path: A }, { path: B }, { path: A }],
      resolveScope,
    });

    const probed = resolveScope.mock.calls.map((c) => c[0]);
    expect(new Set(probed).size).toBe(probed.length);
  });
});
