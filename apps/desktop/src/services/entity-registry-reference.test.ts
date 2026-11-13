import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsEntity } from '../shared/lims';
const mocks = vi.hoisted(() => ({ query: vi.fn(), catalog: vi.fn(), primer: vi.fn() }));
vi.mock('../platform', () => ({ platform: () => ({ lims: { queryEntities: mocks.query } }) }));
vi.mock('../db/workspace-catalog', () => ({ getCatalogEntityForFilePath: mocks.catalog }));
vi.mock('../db/primer-reference-search', () => ({ findPrimerRegistryEntityId: mocks.primer }));
import { resolveEntityRegistryReference } from './entity-registry-reference';
const entity = (id: string, status: LimsEntity['registrationStatus'] = 'registered') =>
  ({ id, registrationStatus: status }) as LimsEntity;
beforeEach(() => vi.resetAllMocks());
describe('exact Registry identity resolution', () => {
  it('uses the catalog identity for a file instead of its path or embedded raw ID', async () => {
    mocks.catalog.mockResolvedValue({ id: 'workspace::molecular-raw-id' });
    mocks.query.mockResolvedValue([entity('workspace::molecular-raw-id')]);
    expect(
      (await resolveEntityRegistryReference({ kind: 'file', path: '/project/view.json' }))?.id
    ).toBe('workspace::molecular-raw-id');
    expect(mocks.query).toHaveBeenCalledWith({
      id: 'workspace::molecular-raw-id',
      includeArchived: true,
      limit: 1,
    });
  });
  it('uses the explicit legacy-primer identity bridge', async () => {
    mocks.primer.mockResolvedValue('registry-primer-id');
    mocks.query.mockResolvedValue([entity('registry-primer-id')]);
    expect(
      (await resolveEntityRegistryReference({ kind: 'primer', primerId: 'legacy-primer-id' }))?.id
    ).toBe('registry-primer-id');
  });
  it('does not treat an allocated ID on a tracked projection as registration', async () => {
    mocks.query.mockResolvedValue([entity('tracked', 'tracked')]);
    expect(
      await resolveEntityRegistryReference({ kind: 'entity', entityId: 'tracked' })
    ).toBeNull();
    expect(
      (await resolveEntityRegistryReference({ kind: 'entity', entityId: 'tracked' }, true))?.id
    ).toBe('tracked');
  });
  it('prefers the actual registration over the document’s tracked projection', async () => {
    mocks.query.mockImplementation(async (input) =>
      input.id ? [entity('document-id', 'tracked')] : [entity('registered-file-id')]
    );
    expect(
      (await resolveEntityRegistryReference({ kind: 'sequence', documentId: 'document-id' }, true))
        ?.id
    ).toBe('registered-file-id');
  });
  it('rejects competing registrations instead of choosing by name or recency', async () => {
    mocks.query.mockImplementation(async (input) =>
      input.id ? [] : [entity('first'), entity('second')]
    );
    await expect(
      resolveEntityRegistryReference({ kind: 'sequence', documentId: 'document-id' })
    ).rejects.toThrow('More than one');
  });
  it('handles a synchronous native-query failure without an orphaned rejected promise', async () => {
    mocks.query.mockImplementation(() => {
      throw new Error('Native query unavailable');
    });
    await expect(
      resolveEntityRegistryReference({ kind: 'sequence', documentId: 'document-id' })
    ).rejects.toThrow('Native query unavailable');
  });
});
