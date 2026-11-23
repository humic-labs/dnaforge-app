import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const search = vi.hoisted(() => vi.fn());
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: { search } }) }));
import { getEntityCategoryIcon, getEntityIcon, searchEntities } from './search';
function page(items: unknown[]) {
  return {
    items,
    nextCursor: null,
    generation: 'generation',
    coverage: { catalog: 1, registry: 0, primers: 0, excluded: 0 },
  };
}
beforeEach(() => {
  search.mockReset().mockResolvedValue(page([]));
});

describe('@ search carries the native portable reference', () => {
  it('uses the real file path for code and preserves the selected type for a named file', () => {
    const { container } = render(getEntityIcon({ type: 'file', path: 'analysis.py' }));
    expect(container.querySelector('svg')).toHaveAttribute('data-entity-color-family', 'code');
    expect(container.querySelector('[data-reference-icon]')).toHaveAttribute(
      'data-reference-icon',
      'code'
    );
    const { container: named } = render(
      getEntityIcon({
        type: 'file',
        path: 'analysis.py',
        namedTypeKey: 'type:table',
        iconKind: 'table',
      })
    );
    expect(named.querySelector('[data-reference-icon]')).toHaveAttribute(
      'data-reference-icon',
      'table'
    );
  });

  it('retains the canonical RNA color on the matching primer result and the named type', async () => {
    search.mockResolvedValue(
      page([
        {
          id: 'rna-primer',
          type: 'primer',
          name: 'RNA primer',
          path: 'primer.primer.json',
          registryKind: 'rna_oligo',
          iconKind: 'primer',
          namedTypeKey: 'type:rna_oligo',
          iconContext: { kind: 'rna_oligo' },
        },
      ])
    );
    const [result] = (await searchEntities('RNA', '/ws/beta')).primers;
    expect(result.registryKind).toBe('rna_oligo');
    for (const icon of [
      getEntityIcon(result),
      getEntityCategoryIcon({
        key: 'type:rna_oligo',
        label: 'RNA oligos',
        terms: [],
        filter: { namedTypeKey: 'type:rna_oligo' },
        iconKind: 'primer',
      }),
    ]) {
      expect(render(icon).container.querySelector('svg')).toHaveAttribute(
        'data-entity-color-family',
        'rna'
      );
    }
  });
  it('returns a sequence path and hash without synthesizing a different identity', async () => {
    search.mockResolvedValue(
      page([
        {
          id: 'ent-1',
          type: 'sequence',
          name: 'pUC19',
          path: 'sequences/pUC19.gb',
          contentHash: `sha256:${'a'.repeat(64)}`,
          projectId: 'repo-beta',
          projectRoot: '/ws/beta',
          projectName: 'Beta',
        },
      ])
    );
    const [item] = (await searchEntities('pUC', '/ws/beta')).sequences;
    expect(item).toMatchObject({
      id: 'ent-1',
      path: 'sequences/pUC19.gb',
      contentHash: `sha256:${'a'.repeat(64)}`,
      projectId: 'repo-beta',
    });
    expect(item.id).not.toMatch(/^seq_/);
  });
  it('uses the owning root for ranking and leaves cross-project search unrestricted', async () => {
    await searchEntities('pUC', '/ws/beta');
    expect(search).toHaveBeenCalledWith({ query: 'pUC', preferredProjectRoot: '/ws/beta' });
  });
  it('returns a primer artifact path and exact canonical ID', async () => {
    search.mockResolvedValue(
      page([
        {
          id: 'p1',
          type: 'primer',
          name: 'M13-fwd',
          path: 'primers/M13-fwd.primer.json',
          localOnly: false,
        },
      ])
    );
    expect((await searchEntities('M13')).primers[0]).toMatchObject({
      id: 'p1',
      path: 'primers/M13-fwd.primer.json',
      localOnly: false,
    });
  });
  it('retains a local-only primer with no invented path', async () => {
    search.mockResolvedValue(
      page([{ id: 'p2', type: 'primer', name: 'hand-entered', path: null, localOnly: true }])
    );
    expect((await searchEntities('hand')).primers[0]).toMatchObject({
      id: 'p2',
      path: null,
      localOnly: true,
    });
  });
  it('keeps each sequence own project path without a notebook root', async () => {
    search.mockResolvedValue(
      page([
        {
          id: 'ent-7',
          type: 'sequence',
          name: 'legacy',
          path: 'legacy.gb',
          projectId: 'repo-alpha',
        },
      ])
    );
    expect((await searchEntities('leg', null)).sequences[0]).toMatchObject({
      id: 'ent-7',
      path: 'legacy.gb',
      projectId: 'repo-alpha',
    });
    expect(search).toHaveBeenCalledWith({ query: 'leg' });
  });
});
