import {
  SEQUENCE_PACKAGE_FILE_KIND,
  parseSequencePackageDocument,
  sequencePackageRootForMetaPath,
} from '../db/sequence-package';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogEntityForFilePath,
  linkCatalogEntities,
  registerCatalogEntity,
  type DBCatalogEntity,
  type CatalogEntityType,
} from '../db/workspace-catalog';
import { platform } from '../platform';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  type ManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { pathIsAtOrUnder } from '../shared/path-boundary';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';

export interface ReconciledSequencePackageCatalogEntity {
  entityId: string;
  name: string;
  packageRoot: string;
}

function existingMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sequence package catalog metadata is not an object.');
  }
  return parsed as Record<string, unknown>;
}

function packageCatalogType(existingType: CatalogEntityType | undefined): CatalogEntityType {
  if (!existingType) return 'sequence';
  if (existingType === 'sequence' || existingType === 'construct') return existingType;
  throw new Error(`Sequence package identity is already owned by a ${existingType} entity.`);
}

function acceptedDesignId(
  document: ReturnType<typeof parseSequencePackageDocument>
): string | null {
  const value = document.assembly?.accepted?.designId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isAdoptableLegacyRootBinding(
  document: ReturnType<typeof parseSequencePackageDocument>,
  boundAtRoot: DBCatalogEntity
): boolean {
  return boundAtRoot.type === 'file' || acceptedDesignId(document) === boundAtRoot.id;
}

function adoptedLooseFilePath(
  existingLocator: string | undefined,
  packageRoot: string
): string | undefined {
  if (!existingLocator?.startsWith('file://')) return undefined;
  const path = existingLocator.slice('file://'.length);
  return path === packageRoot ? undefined : path;
}

export async function reconcileSequencePackageCatalogEntity(input: {
  metaPath: string;
  workspaceRoot: string;
  mutationToken?: string;
  expectedEntityId?: string;
  contentHash?: string;
}): Promise<ReconciledSequencePackageCatalogEntity> {
  const packageRoot = sequencePackageRootForMetaPath(input.metaPath);
  if (!packageRoot || !pathIsAtOrUnder(packageRoot, input.workspaceRoot)) {
    throw new Error(`Sequence package metadata is outside its workspace: ${input.metaPath}`);
  }

  const document = parseSequencePackageDocument(await platform().fs.readTextFile(input.metaPath));
  if (input.expectedEntityId !== undefined && document.id !== input.expectedEntityId) {
    throw new Error('The saved sequence package identity changed before reconstruction.');
  }
  if (isDeveloperImportSourcePath(packageRoot)) {
    return { entityId: document.id, name: document.name, packageRoot };
  }
  const existing = await getCatalogEntity(document.id);
  const boundAtRoot = await getCatalogEntityForFilePath(packageRoot);
  if (
    boundAtRoot &&
    boundAtRoot.id !== document.id &&
    !isAdoptableLegacyRootBinding(document, boundAtRoot)
  ) {
    throw new Error(`Sequence package root is already bound to another entity: ${packageRoot}`);
  }

  const looseFilePath = adoptedLooseFilePath(existing?.locator, packageRoot);
  const managedDocument: ManagedSequenceDocumentRef = {
    kind: 'managed-sequence',
    packageId: document.id,
    packageRoot,
  };
  const entity = await registerCatalogEntity({
    id: document.id,
    type: packageCatalogType(existing?.type),
    name: document.name,
    locator: existing?.locator ?? `entity://sequence/${encodeURIComponent(document.id)}`,
    storageType: existing?.storage_type ?? 'file',
    workspaceRoot: input.workspaceRoot,
    metadata: {
      ...existingMetadata(existing?.metadata ?? null),
      [MANAGED_SEQUENCE_DOCUMENT_FIELD]: { ...managedDocument, productFile: document.product.file },
      packageKind: 'sequence',
    },
  });
  if (entity.id !== document.id) {
    throw new Error(`Sequence package locator is already owned by another entity: ${entity.id}`);
  }

  await bindCatalogEntityToFile({
    entityId: document.id,
    path: packageRoot,
    fileKind: SEQUENCE_PACKAGE_FILE_KIND,
    workspaceRoot: input.workspaceRoot,
    contentHash: input.contentHash,
    supersedesMovedPath: looseFilePath,
    status: 'current',
    mutationToken: input.mutationToken,
  });

  const legacyDesignId = acceptedDesignId(document);
  if (boundAtRoot && boundAtRoot.id !== document.id && boundAtRoot.id === legacyDesignId) {
    await linkCatalogEntities({
      sourceEntityId: boundAtRoot.id,
      relation: 'produces',
      targetEntityId: document.id,
      confidence: 'confirmed',
      evidence: {
        source: 'sequence-package-root-binding-migration',
        packageId: document.id,
        packageRoot,
      },
    });
  }

  return {
    entityId: document.id,
    name: document.name,
    packageRoot,
  };
}
