import { withUserMessage } from '@waypoint/user-messages';
import { getCatalogEntity, getCatalogFileForPath } from '../db/workspace-catalog';
import { platform } from '../platform';
import {
  createMigrationDestinationResolver,
  migrationDestinationLinkIndexPath,
  readMigrationDestinationLinkIndex,
} from '../shared/benchling-migration-destination-index';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import type {
  LegacyMigrationFastaRead,
  LegacyMigrationFastaTarget,
} from '../shared/legacy-migration-read';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import {
  resolveNativeFastaSourceAuthority,
  resolveExactNativeCatalogDestination,
} from './native-catalog-destination';

async function requireContainedFile(workspaceRoot: string, path: string) {
  const [contained, stats] = await Promise.all([
    platform().fs.validateWorkspacePath({
      workspaceRoot,
      path,
      artifactNoun: 'legacy migration read',
    }),
    platform().fs.stat(path),
  ]);
  if (!contained || !stats?.isFile)
    throw new Error(
      'The legacy migration source is outside its project or is no longer a regular file.'
    );
  return stats;
}

export async function resolveLegacyMigrationFastaRead(
  input: LegacyMigrationFastaTarget
): Promise<LegacyMigrationFastaRead> {
  await requireContainedFile(
    input.workspaceRoot,
    migrationDestinationLinkIndexPath(input.workspaceRoot)
  );
  const index = await readMigrationDestinationLinkIndex(
    input.workspaceRoot,
    async (path, maxBytes) => {
      const bytes = await platform().fs.readFileBounded(path, maxBytes);
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        bytesRead: bytes.byteLength,
      };
    }
  );
  const destination = createMigrationDestinationResolver(
    index,
    input.workspaceRoot
  )(input.targetId);
  if (
    !destination ||
    destination.locator.kind !== 'workspace_path' ||
    (destination.locator.tabType !== 'sequence' && destination.locator.tabType !== 'protein') ||
    inferCatalogFileKind(destination.locator.absolutePath) !== 'fasta'
  )
    throw new Error('The legacy index has no matching FASTA read destination.');
  const stats = await requireContainedFile(input.workspaceRoot, destination.locator.absolutePath);
  if (stats.size <= 0 || stats.size > HARD_CAP_BYTES)
    throw new Error(
      `The complete legacy FASTA is unavailable for this reader (${stats.size} bytes; limit ${HARD_CAP_BYTES}).`
    );
  const binding = await getCatalogFileForPath(destination.locator.absolutePath);
  const entity = binding ? await getCatalogEntity(binding.entity_id) : null;
  if (entity?.type === 'file') {
    const exact = await resolveExactNativeCatalogDestination({
      workspaceRoot: input.workspaceRoot,
      entityId: entity.id,
    });
    if (
      !exact ||
      exact.entityId !== binding?.entity_id ||
      exact.entityType !== 'file' ||
      exact.locator.kind !== 'workspace_path' ||
      exact.locator.absolutePath !== destination.locator.absolutePath
    )
      throw new Error('The native generic file no longer matches its exact project and source.');
  } else {
    const authority = await resolveNativeFastaSourceAuthority(
      destination.locator.absolutePath,
      input.workspaceRoot
    );
    if (authority?.status === 'declared' && authority.kind !== destination.locator.tabType)
      throw new Error(
        `The native source is declared as ${authority.kind}; its legacy index requests a ${destination.locator.tabType} read view.`
      );
  }
  return {
    source: 'migration-index',
    workspaceRoot: input.workspaceRoot,
    targetId: input.targetId,
    destinationId: destination.destinationObjectId,
    path: destination.locator.absolutePath,
    readView: destination.locator.tabType,
    title: destination.title,
    readOnly: true,
  };
}

function sameReadSource(left: LegacyMigrationFastaRead, right: LegacyMigrationFastaRead): boolean {
  return (
    left.workspaceRoot === right.workspaceRoot &&
    left.targetId === right.targetId &&
    left.destinationId === right.destinationId &&
    left.path === right.path &&
    left.readView === right.readView
  );
}

export async function revalidateLegacyMigrationFastaRead(
  expected: LegacyMigrationFastaRead
): Promise<LegacyMigrationFastaRead> {
  const read = await resolveLegacyMigrationFastaRead(expected);
  if (!sameReadSource(read, expected))
    throw withUserMessage(
      new Error('The legacy migration destination changed. Open its current index entry again.'),
      'legacySource.changed'
    );
  return read;
}

export async function readLegacyMigrationFastaSource(
  expected: LegacyMigrationFastaRead
): Promise<{ read: LegacyMigrationFastaRead; bytes: Uint8Array }> {
  const read = await revalidateLegacyMigrationFastaRead(expected);
  const bytes = await platform().fs.readFileBounded(read.path, HARD_CAP_BYTES);
  const current = await resolveLegacyMigrationFastaRead(expected);
  if (!sameReadSource(current, read))
    throw withUserMessage(
      new Error('The legacy migration destination changed during its source read.'),
      'legacySource.changed'
    );
  return { read, bytes };
}
