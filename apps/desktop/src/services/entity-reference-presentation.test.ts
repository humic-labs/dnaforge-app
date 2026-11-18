import { beforeEach, describe, expect, it, vi } from 'vitest';
const owner = vi.hoisted(() => vi.fn());
vi.mock('../features/primers/primer-references', () => ({ getCanonicalOligoEntity: owner }));
import { resolveEntityReferenceIconContext } from './entity-reference-presentation';

beforeEach(() => {
  owner.mockReset();
  owner.mockResolvedValue({ id: 'oligo-id', kind: 'rna_oligo' });
});
describe('canonical saved reference presentation', () => {
  it('resolves old RNA references through the canonical owner without rewriting their snapshots', async () => {
    const reference = {
      entity_type: 'primer',
      locator: 'entity://primer/oligo-id',
      data: JSON.stringify({ registryEntityId: 'oligo-id', localOnly: true }),
    };
    const original = structuredClone(reference);
    expect(await resolveEntityReferenceIconContext(reference)).toEqual({ kind: 'rna_oligo' });
    expect(owner).toHaveBeenCalledWith('oligo-id');
    expect(reference).toEqual(original);
  });
  it('refuses a primer locator that disagrees with its canonical identity', async () => {
    expect(
      await resolveEntityReferenceIconContext({
        entity_type: 'primer',
        locator: 'entity://primer/other',
        data: JSON.stringify({ registryEntityId: 'oligo-id' }),
      })
    ).toBeUndefined();
    expect(owner).not.toHaveBeenCalled();
  });
  it('retains canonical owner refusals instead of accepting embedded entity kind claims', async () => {
    owner.mockRejectedValue(new Error('Canonical oligo unavailable'));
    await expect(
      resolveEntityReferenceIconContext({
        entity_type: 'primer',
        locator: 'entity://primer/oligo-id',
        data: JSON.stringify({ registryEntityId: 'oligo-id', entityKind: 'rna_oligo' }),
      })
    ).rejects.toThrow('Canonical oligo unavailable');
  });
});
