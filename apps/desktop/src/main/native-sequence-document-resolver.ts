import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { ManagedDocumentOperationTarget } from '@waypoint/domain-services';
import {
  parseSequencePackageDocument,
  resolveSequenceProductFile,
  isSequencePackageFileKind,
  sequencePackageRootForMetaPath,
  sequencePackagePaths,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
} from '../db/sequence-package';
import { assertLegacySequenceMetadataTransactionSettledInMain } from './sequence-package-legacy-metadata-journal';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { BoundedFileChangedError, readFileBoundedFromHandle } from './ipc/bounded-file-read';
import type { NativeAnnotationDocument } from './managed-annotation-document-command';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { ScientificObjectStore } from './scientific-object-store';
import { readAcceptedSequencePackage } from './scientific-sequence-package';
import { listWorkspaceResources, parseResourceId } from '@waypoint/workspace-revisions';
import {
  SEQUENCE_DOCUMENT_ENTITY_TYPES,
  type SequenceDocumentEntityType,
} from '../shared/catalog-entity';

const MAX_PACKAGE_METADATA_BYTES = 4 * 1024 * 1024;

interface EntityRow {
  catalog_type: SequenceDocumentEntityType;
  type: string;
  fields: string | null;
  tombstone: number | null;
  archived_at: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

export function createNativeSequenceDocumentResolver(options: {
  db(): Database.Database;
  workspaceRoots(): readonly string[];

  allowArchived?: boolean;
}): (target: ManagedDocumentOperationTarget) => Promise<NativeAnnotationDocument> {
  async function enrolledWorkspace(
    workspaceId: number | null
  ): Promise<{ root: string; recordedRoot: string; workspaceId: number }> {
    const workspace = options
      .db()
      .prepare(
        'SELECT id,path FROM workspaces WHERE id=? AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .get(workspaceId) as { id: number; path: string } | undefined;
    if (!workspace) throw new Error('The document has no active owning workspace.');
    const root = await realpath(workspace.path);
    for (const enrolled of options.workspaceRoots()) {
      try {
        if ((await realpath(enrolled)) === root)
          return { root, recordedRoot: workspace.path, workspaceId: workspace.id };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new Error('The document workspace is not enrolled with this native owner.');
  }

  async function currentPath(root: string, path: string): Promise<string> {
    return (
      await canonicalWorkspacePath({
        workspaceRoot: root,
        path,
        artifactNoun: 'document',
      })
    ).candidate;
  }

  async function readPackageMetadata(root: string, path: string): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return Buffer.from(
          await readFileBoundedFromHandle(path, MAX_PACKAGE_METADATA_BYTES)
        ).toString('utf8');
      } catch (error) {
        if (!(error instanceof BoundedFileChangedError) || attempt >= 2) throw error;
        if ((await currentPath(root, path)) !== path) {
          throw new Error('The package metadata path changed during native resolution.');
        }
      }
    }
  }

  return async (target) => {
    const db = options.db();
    const entity = db
      .prepare(
        `
      SELECT e.type,e.type AS catalog_type,l.fields,l.tombstone,l.archived_at
      FROM catalog_entities e LEFT JOIN lims_entity l ON l.id=e.id
      WHERE e.id=? AND e.type IN (${SEQUENCE_DOCUMENT_ENTITY_TYPES.map(() => '?').join(',')}) AND (e.status='active' OR (?=1 AND e.status='archived'))
    `
      )
      .get(
        target.targetDocumentId,
        ...SEQUENCE_DOCUMENT_ENTITY_TYPES,
        options.allowArchived ? 1 : 0
      ) as EntityRow | undefined;
    if (
      !entity ||
      (!options.allowArchived && (entity.tombstone === 1 || entity.archived_at != null))
    ) {
      throw new Error('The target sequence document is missing or archived.');
    }
    const fields = entity.fields === null ? {} : record(JSON.parse(entity.fields));
    if (!fields) throw new Error('The document has an invalid native catalog projection.');
    const managedProjection = Object.hasOwn(fields, MANAGED_SEQUENCE_DOCUMENT_FIELD);
    if (managedProjection) {
      const managed = readManagedSequenceDocumentRef(fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
      if (!managed || managed.packageId !== target.targetDocumentId) {
        throw new Error('The managed document locator does not match its catalog identity.');
      }
    }
    const files = db
      .prepare(
        `
      SELECT path,workspace_id,file_kind FROM catalog_entity_files
      WHERE entity_id=? AND status='current' LIMIT 2
    `
      )
      .all(target.targetDocumentId) as Array<{
      path: string;
      workspace_id: number | null;
      file_kind: string;
    }>;
    if (files.length !== 1) throw new Error('The document has no unique current catalog file.');
    if (entity.catalog_type === 'trace' && files[0].file_kind !== 'trace')
      throw new Error('The trace document has no matching trace file binding.');
    const packageBinding = isSequencePackageFileKind(files[0].file_kind);
    if (entity.catalog_type === 'construct' && !packageBinding)
      throw new Error('The construct sequence document has no matching package binding.');
    const { root, recordedRoot, workspaceId } = await enrolledWorkspace(files[0].workspace_id);
    const recordedRelative = relative(recordedRoot, files[0].path);
    const usesRecordedRoot =
      !isAbsolute(recordedRelative) &&
      recordedRelative !== '..' &&
      !recordedRelative.startsWith(`..${sep}`);
    const boundPath = await currentPath(usesRecordedRoot ? recordedRoot : root, files[0].path);
    const packageRootFromMetadata = sequencePackageRootForMetaPath(boundPath);

    const store = new ScientificObjectStore(db, workspaceId);
    const { graph, head, reader } = store.read();
    if (head !== null) {
      const identity = parseResourceId(target.targetDocumentId);
      const slots = listWorkspaceResources(graph, head);
      if (!identity.ok || !slots.ok) throw new Error('The accepted sequence namespace is invalid.');
      const slot = slots.value.find((candidate) => candidate.resourceId === identity.value);
      if (slot) {
        const snapshot = reader.current(identity.value);
        if (
          slot.tombstone ||
          !slot.path ||
          snapshot?.document.kind !== 'sequence' ||
          snapshot.representation?.format !== 'genbank-v1'
        )
          throw new Error('The accepted sequence is unavailable. Restore or reopen it explicitly.');
        const acceptedPath = await currentPath(root, join(root, slot.path));
        const metadata = readAcceptedSequencePackage({
          store,
          graph,
          head,
          sequenceId: identity.value,
          productPath: slot.path,
          productText: snapshot.representation.text,
        });
        if (managedProjection || packageRootFromMetadata || packageBinding) {
          if (!packageBinding || !metadata)
            throw new Error('The accepted managed sequence has no matching package metadata.');
          const packageRoot = packageRootFromMetadata ?? boundPath;

          const acceptedRoot = sequencePackageRootForMetaPath(join(root, metadata.path));
          if (!acceptedRoot || packageRoot !== (await currentPath(root, acceptedRoot)))
            throw new Error('The accepted package does not match its current catalog binding.');
        } else if (metadata || boundPath !== acceptedPath) {
          throw new Error('The accepted sequence does not match its current catalog binding.');
        }
        return {
          documentId: target.targetDocumentId,
          workspaceRoot: root,
          sourcePath: acceptedPath,
        };
      }
    }
    if (managedProjection || packageRootFromMetadata || packageBinding) {
      if (!packageBinding) {
        throw new Error('The managed document has no matching package metadata binding.');
      }

      const packageRoot = packageRootFromMetadata ?? boundPath;
      const paths = sequencePackagePaths(packageRoot);
      const metadataPath = packageRootFromMetadata
        ? boundPath
        : await currentPath(root, paths.metaPath);
      await assertLegacySequenceMetadataTransactionSettledInMain(root, packageRoot);
      const bytes = await readPackageMetadata(root, metadataPath);
      const raw = record(JSON.parse(bytes));
      if (raw?.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION) {
        throw new Error(
          'The sequence package requires its supported migration before native editing.'
        );
      }
      const document = parseSequencePackageDocument(bytes);
      if (document.id !== target.targetDocumentId) {
        throw new Error('The package on disk does not match the target document identity.');
      }
      const entries = await readdir(packageRoot, { withFileTypes: true });
      const product = resolveSequenceProductFile(
        document.product.file,
        entries.map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
        }))
      );
      return {
        documentId: document.id,
        workspaceRoot: root,
        sourcePath: await currentPath(
          root,
          sequencePackagePaths(packageRoot, { productFile: product }).productPath
        ),
      };
    }
    return {
      documentId: target.targetDocumentId,
      workspaceRoot: root,
      sourcePath: boundPath,
    };
  };
}
