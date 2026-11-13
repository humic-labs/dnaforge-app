import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import {
  MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH,
  buildMigrationDestinationLinkIndexWriterPayload,
  isSafeMigrationDestinationIdentifier,
  parseMigrationDestinationLinkIndex,
  serializeMigrationDestinationLinkIndex,
  type MigrationDestinationLinkIndexEntryInput,
  type MigrationDestinationLinkIndexV1,
  type MigrationDestinationLinkIndexWriterPayload,
  type MigrationDestinationTabType,
} from '../../shared/benchling-migration-destination-index';
import type { ProjectionReceipt, SourceObject } from '../../shared/benchling-migration';
import type { CollectionProjection } from './collection-projection';
import {
  nativeCollectionDocumentPath,
  type CollectionProjectionLayout,
} from './collection-projection-writer';
import { BENCHLING_REGISTRY_CONVERTER_ID } from './registry-projection';

export type MigrationDestinationIndexInput = {
  sourceObjects: readonly SourceObject[];
  receipts: readonly ProjectionReceipt[];
  collectionProjection?: CollectionProjection | null;
  collectionLayout?: CollectionProjectionLayout;
};

export function buildMigrationDestinationIndexEntries(
  input: MigrationDestinationIndexInput
): MigrationDestinationLinkIndexEntryInput[] {
  const receiptsBySourceId = new Map<string, ProjectionReceipt>();
  for (const receipt of input.receipts) {
    if (receiptsBySourceId.has(receipt.sourceObjectId)) {
      throw new Error(`Source object ${receipt.sourceObjectId} has multiple projection receipts.`);
    }
    receiptsBySourceId.set(receipt.sourceObjectId, receipt);
  }
  const registryIdCounts = new Map<string, number>();
  for (const sourceObject of input.sourceObjects) {
    if (sourceObject.registryId && isSafeMigrationDestinationIdentifier(sourceObject.registryId)) {
      registryIdCounts.set(
        sourceObject.registryId,
        (registryIdCounts.get(sourceObject.registryId) ?? 0) + 1
      );
    }
  }

  const entries = [...input.sourceObjects]
    .sort(
      (left, right) =>
        left.stableId.localeCompare(right.stableId) || left.id.localeCompare(right.id)
    )
    .map((sourceObject): MigrationDestinationLinkIndexEntryInput => {
      const receipt = receiptsBySourceId.get(sourceObject.id);
      if (!receipt) throw new Error(`Source object ${sourceObject.id} has no projection receipt.`);
      const sourceStableIds = uniqueSafeIdentifiers([
        sourceObject.id,
        sourceObject.stableId,
        ...(sourceObject.registryId && registryIdCounts.get(sourceObject.registryId) === 1
          ? [sourceObject.registryId]
          : []),
      ]).filter((identifier) => identifier !== receipt.destinationObjectId);
      if (sourceStableIds.length === 0) {
        throw new Error(`Source object ${sourceObject.id} has no distinct stable link identifier.`);
      }
      return {
        destinationObjectId: receipt.destinationObjectId,
        sourceStableIds,
        locator:
          receipt.destination?.kind === 'catalog-record' ||
          receipt.converterId === BENCHLING_REGISTRY_CONVERTER_ID
            ? { kind: 'lims_entity', entityId: receipt.destinationObjectId }
            : {
                kind: 'workspace_path',
                relativePath: receipt.destinationPath,
                tabType: destinationTabType(receipt),
              },
        title: sourceObject.name,
      };
    });

  const collections = input.collectionProjection?.collections ?? [];
  for (const collection of collections) {
    entries.push({
      destinationObjectId: collection.id,
      sourceStableIds: [collection.provenance.sourceFolderId],
      locator: {
        kind: 'workspace_path',
        relativePath: nativeCollectionDocumentPath(
          collection,
          input.collectionLayout ?? 'legacy-v1'
        ),
        tabType: 'scientific-document',
      },
      title: collection.title,
    });
  }
  return entries;
}

export async function persistMigrationDestinationLinkIndex(input: {
  workspacePath: string;
  sourceObjects: readonly SourceObject[];
  receipts: readonly ProjectionReceipt[];
  collectionProjection?: CollectionProjection | null;
  collectionLayout?: CollectionProjectionLayout;
}): Promise<MigrationDestinationLinkIndexV1> {
  const payload = buildMigrationDestinationLinkIndexWriterPayload(
    buildMigrationDestinationIndexEntries(input)
  );
  return persistMigrationDestinationLinkIndexPayload({
    workspacePath: input.workspacePath,
    payload,
  });
}

export async function persistMigrationDestinationLinkIndexPayload(input: {
  workspacePath: string;
  payload: MigrationDestinationLinkIndexWriterPayload;
}): Promise<MigrationDestinationLinkIndexV1> {
  const payload = buildMigrationDestinationLinkIndexWriterPayload(input.payload.index.entries);
  if (payload.relativePath !== input.payload.relativePath || payload.text !== input.payload.text) {
    throw new Error('Destination link index payload is not canonical.');
  }
  const workspacePath = resolve(input.workspacePath);
  const destinationPath = resolve(workspacePath, payload.relativePath);
  if (!destinationPath.startsWith(`${workspacePath}${sep}`)) {
    throw new Error('Destination link index escapes the migration workspace.');
  }
  await assertNoSymlinkSegments(workspacePath, dirname(payload.relativePath));
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, payload.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  const persisted = parseMigrationDestinationLinkIndex(await readFile(destinationPath, 'utf8'));
  if (serializeMigrationDestinationLinkIndex(persisted) !== payload.text) {
    throw new Error('Persisted destination link index failed deterministic read-back validation.');
  }
  return persisted;
}

export const migrationDestinationLinkIndexRelativePath =
  MIGRATION_DESTINATION_LINK_INDEX_RELATIVE_PATH;

function destinationTabType(receipt: ProjectionReceipt): MigrationDestinationTabType {
  const path = receipt.destinationPath.toLowerCase();
  if (path.endsWith('.wpnote.json') || path.endsWith('/.forge/notebook.json')) return 'page';
  if (path.endsWith('.gb') || path.endsWith('.gbk') || path.endsWith('.genbank')) {
    return 'sequence';
  }
  if (path.endsWith('.faa')) return 'protein';
  if (
    path.endsWith('.dnaforge-protocol.json') ||
    path.endsWith('.dnaforge-protocol-run.json') ||
    path.endsWith('/.forge/protocol.json') ||
    path.endsWith('/.forge/protocol-run.json') ||
    path.endsWith('.dnaforge-collection.json')
  ) {
    return 'scientific-document';
  }
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'html';
  if (path.endsWith('.md') || path.endsWith('.txt')) return 'text';
  if (path.endsWith('.csv') || path.endsWith('.tsv') || path.endsWith('.xlsx')) return 'table';
  if (/\.(?:png|jpe?g|gif|webp|svg|tiff?)$/u.test(path)) return 'image';
  return 'file';
}

function uniqueSafeIdentifiers(values: readonly string[]): string[] {
  return [...new Set(values.filter(isSafeMigrationDestinationIdentifier))].sort();
}

async function assertNoSymlinkSegments(workspacePath: string, relativeDirectory: string) {
  let current = workspacePath;
  for (const segment of relativeDirectory.split('/')) {
    if (!segment || segment === '.') continue;
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Destination link index path contains a symlink: ${segment}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Destination link index path contains a non-directory: ${segment}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
