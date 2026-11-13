import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalog = vi.hoisted(() => ({
  getCatalogEntity: vi.fn(),
  getCurrentCatalogFileForEntity: vi.fn(),
  getCurrentSequenceFileForDocumentId: vi.fn(),
}));
vi.mock('../../db/workspace-catalog', () => catalog);
vi.mock('../sequence/public/sequence-document-repository', () => ({
  assertCanonicalSequenceSource: vi.fn(),
}));

import { resolveAcceptedSourceIdentity } from './accepted-source-identity';

describe('accepted source identity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    catalog.getCatalogEntity.mockResolvedValue(null);
    catalog.getCurrentCatalogFileForEntity.mockResolvedValue(null);
    catalog.getCurrentSequenceFileForDocumentId.mockResolvedValue(null);
  });

  it('pins a logical source document through its authoritative catalog binding', async () => {
    catalog.getCurrentSequenceFileForDocumentId.mockResolvedValue({
      entity_id: 'package-entity',
      path: '/project/source-package',
    });
    catalog.getCatalogEntity.mockImplementation(async (id: string) =>
      id === 'package-entity' ? { id } : null
    );
    await expect(
      resolveAcceptedSourceIdentity('logical-document', 'sha256:bases')
    ).resolves.toEqual({
      sourceConstructId: 'package-entity',
      sourceSequenceVersionId: 'sha256:bases',
      sourceLocator: 'waypoint://sequence/package-entity',
    });
  });

  it('retains direct catalog identity', async () => {
    catalog.getCatalogEntity.mockResolvedValue({ id: 'direct-entity' });
    await expect(
      resolveAcceptedSourceIdentity('direct-entity', 'sha256:bases')
    ).resolves.toMatchObject({
      sourceConstructId: 'direct-entity',
      sourceSequenceVersionId: 'sha256:bases',
    });
  });

  it('never invents a stable identity for an unregistered source', async () => {
    await expect(resolveAcceptedSourceIdentity('unregistered', 'sha256:bases')).resolves.toBeNull();
  });
});
