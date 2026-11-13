import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import type { RestoreCatalogProviderBindingInput } from '../shared/catalog-associations';
import { loadCatalogManifestEntity, requireCatalogEntity } from './catalog-source-authority';
import { upsertProviderBinding } from './catalog-provider-bindings';

export function restoreCatalogProviderBindingInDb(
  db: Database.Database,
  input: RestoreCatalogProviderBindingInput
): void {
  if (!input || typeof input !== 'object') throw new Error('Catalog provider identity is invalid.');
  db.transaction(() => {
    const entity = requireCatalogEntity(db, input.entityId);
    const source = loadCatalogManifestEntity(db, entity);
    const identity = source?.portable.sourceIdentities?.find((identity) =>
      isDeepStrictEqual(
        {
          provider: identity.provider,
          stableObjectId: identity.stableObjectId,
          objectClass: identity.objectClass,
          bindingKind: identity.bindingKind,
          providerAccountHint: identity.providerAccountHint ?? null,
          canonicalUrl: identity.canonicalUrl ?? null,
        },
        {
          provider: input.provider,
          stableObjectId: input.stableObjectId,
          objectClass: input.objectClass,
          bindingKind: input.bindingKind,
          providerAccountHint: input.providerAccountHint ?? null,
          canonicalUrl: input.canonicalUrl ?? null,
        }
      )
    );
    if (!source || !identity)
      throw new Error('Catalog provider identity does not match its authoritative project source.');
    upsertProviderBinding(db, {
      reference: {
        provider: identity.provider,
        stableObjectId: identity.stableObjectId,
        objectClass: identity.objectClass,
        providerAccountHint: identity.providerAccountHint ?? null,
        canonicalUrl: identity.canonicalUrl ?? null,
      },
      entityId: entity.id,
      bindingKind: identity.bindingKind,
      evidence: { source: '.forge/catalog.json' },
    });
  })();
}
