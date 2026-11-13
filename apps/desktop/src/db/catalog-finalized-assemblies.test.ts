import { describe, expect, it, vi } from 'vitest';
import {
  createCatalogRepository,
  type CatalogDatabase,
  type CatalogRepositoryDependencies,
} from './catalog-repository';

const unused = (name: string) => () => {
  throw new Error(`${name} is not used by this test`);
};

function repositoryWith(select: CatalogDatabase['select']) {
  const db: CatalogDatabase = {
    select,
    execute: unused('execute'),
    bindCatalogEntityFile: unused('bindCatalogEntityFile'),
    refreshCatalogFileFingerprints: unused('refreshCatalogFileFingerprints'),
    ensureWorkspaceOwner: unused('ensureWorkspaceOwner'),
    releaseMissingCatalogFilePath: unused('releaseMissingCatalogFilePath'),
    writeCatalogWorkspacePlacement: unused('writeCatalogWorkspacePlacement'),
    removeCatalogWorkspacePlacement: unused('removeCatalogWorkspacePlacement'),
    registerCatalogEntity: unused('registerCatalogEntity'),
    registerWorkspaceFile: unused('registerWorkspaceFile'),
    linkCatalogEntities: unused('linkCatalogEntities'),
    recordCatalogEvent: unused('recordCatalogEvent'),
    updateCatalogEntityPresentation: unused('updateCatalogEntityPresentation'),
    setCatalogFileState: unused('setCatalogFileState'),
    rebindCatalogFiles: unused('rebindCatalogFiles'),
    clearCatalogProjection: unused('clearCatalogProjection'),
    deleteCatalogEntityIfUnbound: unused('deleteCatalogEntityIfUnbound'),
    deleteCatalogEntityWithExactBinding: unused('deleteCatalogEntityWithExactBinding'),
  };
  const dependencies: CatalogRepositoryDependencies = {
    db: () => db,
    stat: vi.fn(),
    isHosted: () => false,
    withMutation: vi.fn(),
  };
  return createCatalogRepository(dependencies);
}

describe('listing finalized assembly constructs', () => {
  it('uses the finalization events and does not scan every package', async () => {
    const seen: string[] = [];
    const repository = repositoryWith(async (sql) => {
      seen.push(sql.includes('catalog_entity_events') ? 'events' : 'files');
      return sql.includes('catalog_entity_events')
        ? [{ entity_id: 'construct-b' }, { entity_id: 'construct-a' }]
        : [{ entity_id: 'every-other-package' }];
    });

    expect(await repository.listFinalizedAssemblyConstructIds()).toEqual([
      'construct-b',
      'construct-a',
    ]);
    expect(seen).toEqual(['events']);
  });

  it('keeps each construct once when several events name it', async () => {
    const repository = repositoryWith(async (sql) =>
      sql.includes('catalog_entity_events')
        ? [{ entity_id: 'construct-a' }, { entity_id: 'construct-a' }, { entity_id: 'construct-b' }]
        : []
    );

    expect(await repository.listFinalizedAssemblyConstructIds()).toEqual([
      'construct-a',
      'construct-b',
    ]);
  });

  it('falls back to current sequence packages on a clone with no event rows', async () => {
    const seen: string[] = [];
    const repository = repositoryWith(async (sql) => {
      seen.push(sql.includes('catalog_entity_events') ? 'events' : 'files');
      return sql.includes('catalog_entity_events') ? [] : [{ entity_id: 'construct-from-files' }];
    });

    expect(await repository.listFinalizedAssemblyConstructIds()).toEqual(['construct-from-files']);
    expect(seen).toEqual(['events', 'files']);
  });

  it('returns nothing when neither source knows of an assembly', async () => {
    const repository = repositoryWith(async () => []);
    expect(await repository.listFinalizedAssemblyConstructIds()).toEqual([]);
  });
});
