import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { ScientificDocumentSnapshot } from '@waypoint/domain-services';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import { parseSavedResidueSelectionDocument } from '@waypoint/workspace-editor';
import {
  isNotebookPackageMetaPath,
  NOTEBOOK_PACKAGE_SCHEMA,
  NotebookPackageContractError,
} from '../db/notebook-package';
import { NotebookMarkdownCodecError } from '../db/notebook-markdown-codec';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import {
  isSequencePackageSchema,
  parseSequencePackageDocument,
  resolveSequenceProductFile,
  sequencePackagePaths,
  sequencePackageRootForMetaPath,
  sequenceProductExtensionForPath,
  SequencePackageFormatError,
} from '../db/sequence-package';
import { objectValue, parseWorkspaceArtifact } from '../db/workspace-artifact-parser';
import { normalizeAssemblySlots } from '../features/design/assembly-slots';
import { parseScientificDocument } from '../features/scientific-document/model';
import { buildGenomeAssembly } from '../features/sequence/reference-catalog';
import { savedReferenceContentIdentity } from '../features/sequence/reference-view-compatibility';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import { DocumentReadError, documentReadError } from '../shared/document-read-failure';
import {
  ENTITY_ARTIFACT_CURRENT_SCHEMA,
  entityArtifactSchemaSnapshot,
  parseEntityArtifact,
  type EntityArtifactV1,
} from '../shared/entity-artifact';
import { notebookDocumentModelSchema } from '../shared/notebook-model/document';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  PRIMER_ARTIFACT_SCHEMA,
  PRIMER_ARTIFACT_SCHEMA_VERSION,
  readBoundPrimerArtifact,
  validatePrimerArtifactPath,
} from '../shared/primers/primer-artifact';
import { registryRepresentationForEntity } from '../shared/registry-entity-opening';
import {
  parseTablePackageHead,
  TABLE_PACKAGE_MAX_BYTES,
  TABLE_PACKAGE_SCHEMA,
  TablePackageError,
  tablePackageRevisionPath,
} from '../shared/table-package';
import { parseTrackViewDocument, TRACK_VIEW_SCHEMA } from '../shared/track-view';
import { stripWorkspaceScope, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  canonicalEntityArtifactValue,
  entityArtifactProjectionFingerprint,
} from '../shared/entity-artifact-projection';
import { limsEntityFromRow, parseLimsSchemaFields, type LimsEntityRow } from '../shared/lims';
import { normalizePathForBoundary, pathRelativeToBoundary } from '../shared/path-boundary';
import type { DocumentOpenSource } from './document-open-source';
import { resolveEntityArtifactAuthority } from './entity-artifact-mutations';
import {
  inspectLimsEntityFromVerifiedAuditInDb,
  UnverifiedLimsHistoryError,
} from './lims-projection-rebuild';
import { registrySchemaSnapshotForEntity } from './lims-registry-projection';
import { WorkspaceFilePreconditionError } from './primer-artifact-files';
import {
  developerImportSourceRootsInDb,
  registrySourceEligibilitySql,
} from './registry-source-eligibility';
import { readScientificDocumentInMain } from './scientific-document-reader';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';
import {
  legacySequenceMetadataTransactionPath,
  parseLegacySequenceMetadataTransaction,
} from './sequence-package-legacy-metadata-journal';
import { readTablePackageInMain } from './table-package';
import {
  assertWorkspaceWriteAllowed,
  WorkspaceWriteAdmissionError,
} from './workspace-write-admission';

export type PortableDocumentKind =
  | 'notebook'
  | 'design'
  | 'primer'
  | 'entity'
  | 'selection'
  | 'sequence-package'
  | 'table-package'
  | 'protocol'
  | 'protocol-run'
  | 'track-view';

export interface ReadySequencePackage {
  documentId: string;
  name: string;
  productPath: string;
  schemaName?: string;
}

export interface RendererDesignRecovery {
  kind: 'design-draft';
  designId: string;
}

const METADATA_LIMIT = 4 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  const { code } = documentReadError(error);
  return code === 'missing' || code === 'missing-asset';
}

function jsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new DocumentReadError('malformed', false, { cause });
  }
  const raw = objectValue(value);
  if (!raw) throw new DocumentReadError('unsupported-format');
  return raw;
}

function schemaFamily(raw: Record<string, unknown>, currentSchema: string): boolean {
  const separator = currentSchema.lastIndexOf('.v');
  const prefix = currentSchema.slice(0, separator + 2);
  if (typeof raw.schema !== 'string' || !raw.schema.startsWith(prefix)) return false;
  const version = raw.schema.slice(prefix.length);
  if (!/^\d+$/u.test(version)) return false;
  if (Number(version) > Number(currentSchema.slice(prefix.length)))
    throw new DocumentReadError('newer-format', true);
  return true;
}

function decode<T>(recognized: boolean, reader: () => T): T {
  try {
    return reader();
  } catch (cause) {
    if (cause instanceof DocumentReadError || !(cause instanceof Error)) throw cause;
    if (cause instanceof EvalError || cause instanceof ReferenceError) throw cause;
    throw new DocumentReadError(recognized ? 'malformed' : 'unsupported-format', recognized, {
      cause,
    });
  }
}

async function dependency<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (isMissing(cause)) throw new DocumentReadError('missing-asset', true, { cause });
    throw cause;
  }
}

function scientificAuthority(source: DocumentOpenSource) {
  const id = scientificWorkspaceIdForRoot(source.db, source.workspaceRoot);
  if (id === null) return null;
  const row = source.db.prepare('SELECT repo_uuid FROM workspaces WHERE id=?').get(id) as
    | {
        repo_uuid: string | null;
      }
    | undefined;
  const workspace = row && workspaceScopeKey(row.repo_uuid, id);
  if (!workspace) return null;
  const head = source.db
    .prepare('SELECT head FROM scientific_revision_refs WHERE workspace_id=? AND ref_name=?')
    .get(id, 'accepted') as { head: string | null } | undefined;
  return { workspace, head: head?.head ?? null };
}

async function captureScientificAuthority(source: DocumentOpenSource) {
  await source.observeRevision('scientific-workspace', () =>
    JSON.stringify(scientificAuthority(source))
  );
  return scientificAuthority(source);
}

async function readScientific(
  source: DocumentOpenSource,
  path: string,
  authority: NonNullable<ReturnType<typeof scientificAuthority>>,
  limit = HARD_CAP_BYTES
): Promise<ScientificDocumentSnapshot> {
  await source.observe(path);
  let readFailure: unknown;
  const result = await readScientificDocumentInMain(
    {
      workspaceRoot: source.workspaceRoot,
      workspace: parseWorkspaceIdentity(authority.workspace),
      document: parseScientificDocumentIdentity(
        relative(source.workspaceRoot, path).replaceAll('\\', '/')
      ),
      ...(authority.head ? { acceptedHead: authority.head } : {}),
    },
    {
      database: source.db,
      read: async () => {
        try {
          return await source.readBytes(path, limit);
        } catch (error) {
          readFailure = error;
          throw error;
        }
      },
    }
  );
  if (readFailure) throw readFailure;
  if (result.ok) {
    if (result.document.byteLength > limit) throw new DocumentReadError('too-large');
    return result.document;
  }
  switch (result.error.code) {
    case 'DOCUMENT_NOT_FOUND':
      throw new DocumentReadError('missing');
    case 'INVALID_ENCODING':
      throw new DocumentReadError('malformed');
    case 'ACCESS_DENIED':
      throw new DocumentReadError('permission');
    case 'INVALID_WORKSPACE_IDENTITY':
      throw new DocumentReadError('project');
    case 'INVALID_DOCUMENT_IDENTITY':
      throw new DocumentReadError('unsupported-format');
    case 'UNSUPPORTED_FORMAT':
      throw new DocumentReadError('too-large');
    case 'CANCELLED':
      throw new DocumentReadError('changed');
    case 'SERVICE_UNAVAILABLE':
      throw new DocumentReadError('unknown');
  }
}

async function readProjectScientific(source: DocumentOpenSource) {
  const authority = await captureScientificAuthority(source);
  if (!authority) throw new DocumentReadError('project');
  return readScientific(source, source.path, authority);
}

async function inspectNotebook(source: DocumentOpenSource) {
  const text = await source.readText(source.path);
  const raw = jsonObject(text);
  const recognized = schemaFamily(raw, NOTEBOOK_PACKAGE_SCHEMA);
  const packageRoot = isNotebookPackageMetaPath(source.path) ? dirname(dirname(source.path)) : null;
  let content: unknown;
  if (packageRoot && raw.formatVersion !== undefined) {
    try {
      const notebook = await readCanonicalNotebookPackage(
        {
          exists: (path) =>
            dependency(async () => {
              await source.observe(path);
              await lstat(path);
              return true;
            }),
          readTextFile: (path) => dependency(() => source.readText(path)),
        },
        packageRoot,
        text
      );
      content = notebook.parsed.content;
    } catch (cause) {
      if (cause instanceof NotebookPackageContractError) {
        const code = cause.code === 'NOTEBOOK_PACKAGE_NEWER_FORMAT' ? 'newer-format' : 'malformed';
        throw new DocumentReadError(code, recognized, { cause });
      }
      if (cause instanceof NotebookMarkdownCodecError)
        throw new DocumentReadError('malformed', recognized, { cause });
      throw cause;
    }
  } else {
    const notebook = decode(recognized, () => parseWorkspaceArtifact(text));
    if (notebook.kind !== 'notebook') throw new DocumentReadError('unsupported-format');
    content = notebook.content;
  }
  decode(recognized, () => notebookDocumentModelSchema().nodeFromJSON(content).check());
  if (packageRoot) {
    const status = () => {
      try {
        // The normal package opener calls rename recovery and migration before it can present a notebook.
        assertWorkspaceWriteAllowed(source.db, [packageRoot]);
        return 'writable';
      } catch (error) {
        if (!(error instanceof WorkspaceWriteAdmissionError)) throw error;
        return error.code;
      }
    };
    await source.observeRevision('notebook-package-access', status);
    const access = status();
    if (access !== 'writable')
      throw new DocumentReadError(
        access === 'WORKSPACE_READ_ONLY' ? 'permission' : 'project',
        true
      );
  }
}

async function inspectDesign(source: DocumentOpenSource): Promise<void | RendererDesignRecovery> {
  const text = await source.readText(source.path);
  const recognized = schemaFamily(jsonObject(text), 'waypoint.design.v1');
  const artifact = decode(recognized, () => parseWorkspaceArtifact(text));
  if (artifact.kind !== 'assembly-design') throw new DocumentReadError('unsupported-format');
  const { design } = artifact;
  if (!design) {
    if (artifact.raw.design != null) throw new DocumentReadError('malformed', true);
    const storage = objectValue(artifact.raw.storage);
    if (
      storage?.type !== 'localStorage' ||
      storage.key !== 'waypoint-designs' ||
      typeof storage.id !== 'string' ||
      stripWorkspaceScope(storage.id) !== artifact.id
    )
      throw new DocumentReadError('missing-asset', true);

    // Design IDs are not scoped to the project by the normal workspace artifact opener.
    const binding = () =>
      source.db
        .prepare('SELECT entity_id FROM catalog_entity_files WHERE path=?')
        .get(source.path) as { entity_id: string } | undefined;
    await source.observeRevision(`design-file-binding:${source.path}`, () =>
      JSON.stringify(binding() ?? null)
    );
    const attached = binding();
    if (attached && attached.entity_id !== artifact.id)
      throw new DocumentReadError('project', true);
    return { kind: 'design-draft', designId: artifact.id };
  }
  if (typeof design.id !== 'string' || !design.id.trim())
    throw new DocumentReadError('malformed', true);
  decode(true, () => normalizeAssemblySlots(design));
}

function catalogBindings(source: DocumentOpenSource, field: 'path' | 'entity_id', key: string) {
  return source.db
    .prepare(
      `SELECT path,entity_id,workspace_id,file_kind FROM catalog_entity_files WHERE ${field}=? AND status='current' ORDER BY id`
    )
    .all(key) as {
    path: string;
    entity_id: string;
    workspace_id: number | null;
    file_kind: string;
  }[];
}

function readLegacyRegistryAuthority(source: DocumentOpenSource, entityId: string) {
  const { db } = source;
  const eligibility = registrySourceEligibilitySql(db);
  const row = db
    .prepare(`SELECT * FROM lims_entity WHERE id=? AND (${eligibility})`)
    .get(entityId) as LimsEntityRow | undefined;
  const recovered =
    !row && !db.prepare('SELECT 1 FROM lims_entity WHERE id=?').get(entityId)
      ? inspectLimsEntityFromVerifiedAuditInDb(db, entityId)
      : null;
  const entity = row ? limsEntityFromRow(row) : recovered?.entity;
  if (!entity) return null;
  const restored = recovered?.restoredSchema;
  const definition = restored && parseLimsSchemaFields(restored.revision.fields);
  const schemaSnapshot =
    restored && definition
      ? entityArtifactSchemaSnapshot({
          schemaId: restored.schema.id,
          currentRevisionId: restored.revision.id,
          entityKind: restored.schema.name,
          displayName: restored.schema.display_name,
          description: restored.schema.description,
          baseKind: definition.baseKind ?? restored.schema.name,
          version: restored.revision.version,
          builtin: restored.schema.builtin === 1,
          fields: definition.fields,
        })
      : registrySchemaSnapshotForEntity(db, entity);
  return { entity, schemaSnapshot };
}

async function inspectLegacyRecord(source: DocumentOpenSource, file: EntityArtifactV1) {
  const workspaceId = scientificWorkspaceIdForRoot(source.db, source.workspaceRoot);
  const relativePath = pathRelativeToBoundary(source.path, source.workspaceRoot);
  if (workspaceId == null || !relativePath) throw new DocumentReadError('project', true);

  const readAuthority = () => {
    const authority = readLegacyRegistryAuthority(source, file.id);
    if (
      !authority ||
      authority.entity.kind !== file.kind ||
      authority.entity.workspaceId !== workspaceId
    )
      return null;
    const binding = resolveEntityArtifactAuthority(source.db, authority.entity);
    const base = source.db
      .prepare(
        `SELECT synchronized_fingerprint FROM entity_projection_sources
      WHERE adapter_kind='lims-entity' AND entity_id=? AND workspace_key=? AND relative_path=? AND projection_version=1`
      )
      .get(file.id, `workspace:${workspaceId}`, relativePath) as
      | { synchronized_fingerprint: string }
      | undefined;
    return { ...authority, binding, base: base?.synchronized_fingerprint ?? null };
  };
  const checkedAuthority = () => {
    try {
      return { authority: readAuthority() };
    } catch (cause) {
      if (!(cause instanceof UnverifiedLimsHistoryError)) throw cause;
      return { failure: 'unverified-history' as const, cause };
    }
  };
  let checked: ReturnType<typeof checkedAuthority> | undefined;
  await source.observeRevision(`legacy-record:${file.id}`, () => {
    const current = checkedAuthority();
    checked ??= current;
    return JSON.stringify('failure' in current ? current.failure : current.authority);
  });
  if (checked && 'failure' in checked)
    throw new DocumentReadError('unknown', true, { cause: checked.cause });
  const authority = checked?.authority;
  if (
    !authority ||
    authority.schemaSnapshot.name !== file.kind ||
    normalizePathForBoundary(
      resolve(authority.binding.workspacePath, authority.binding.relativePath)
    ) !== normalizePathForBoundary(source.path)
  )
    throw new DocumentReadError('project', true);

  const projection = entityArtifactProjectionFingerprint({
    ...authority.entity,
    archived: authority.entity.tombstone,
  });
  const saved = entityArtifactProjectionFingerprint({
    ...file,
    schemaRevisionId: authority.schemaSnapshot.schemaRevisionId,
    archived: authority.entity.tombstone,
  });
  if (saved !== projection && authority.base !== projection)
    throw new DocumentReadError('unknown', true);
}

async function inspectEntity(source: DocumentOpenSource) {
  const importSource = isDeveloperImportSourcePath(
    source.path,
    developerImportSourceRootsInDb(source.db)
  );
  const snapshot = importSource ? null : await readProjectScientific(source);
  const text = snapshot?.content ?? (await source.readText(source.path));
  const recognized = schemaFamily(jsonObject(text), ENTITY_ARTIFACT_CURRENT_SCHEMA);
  const entity = decode(recognized, () => parseEntityArtifact(text));
  if (importSource) return;
  if (entity.schema !== ENTITY_ARTIFACT_CURRENT_SCHEMA) {
    if (snapshot?.revision.kind !== 'accepted-object') await inspectLegacyRecord(source, entity);
    return;
  }

  const readProjection = () => {
    const row = source.db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id) as
      | LimsEntityRow
      | undefined;
    return row ? limsEntityFromRow(row) : null;
  };
  const bindings = () => catalogBindings(source, 'entity_id', entity.id);
  await source.observeRevision(`record:${entity.id}`, () =>
    JSON.stringify([readProjection(), bindings()])
  );
  const projection = readProjection();
  if (!projection || registryRepresentationForEntity(projection).openTarget.kind !== 'record_file')
    return;
  const files = bindings();
  if (files.length > 1 || files.some((file) => file.workspace_id !== projection.workspaceId))
    throw new DocumentReadError('project', true);
  if (files[0] && resolve(files[0].path) !== resolve(source.path)) {
    await source.observe(files[0].path);
    const available = await lstat(files[0].path).then(
      () => true,
      (error: unknown) => {
        if (!isMissing(error)) throw error;
        return false;
      }
    );
    if (available) throw new DocumentReadError('project', true);
  }
  if (snapshot?.revision.kind === 'accepted-object') {
    const schema = () => registrySchemaSnapshotForEntity(source.db, projection);
    const canonical = (value: typeof entity.schemaSnapshot) =>
      JSON.stringify(
        canonicalEntityArtifactValue({ ...value, description: value.description ?? null })
      );
    await source.observeRevision(`record-schema:${entity.id}`, () => canonical(schema()));
    if (
      canonical(schema()) !== canonical(entity.schemaSnapshot) ||
      entityArtifactProjectionFingerprint({ ...projection, archived: projection.tombstone }) !==
        entityArtifactProjectionFingerprint(entity)
    )
      throw new DocumentReadError('project', true);
  }
}

async function inspectPrimer(source: DocumentOpenSource) {
  const location = validatePrimerArtifactPath(source.path, source.workspaceRoot);
  if (!location.valid) throw new DocumentReadError('project');
  const bindings = () => catalogBindings(source, 'path', source.path);
  await source.observeRevision('primer-file-binding', () => JSON.stringify(bindings()));
  const files = bindings();
  if (files.length > 1) throw new DocumentReadError('project');

  const isEnrolled = (id: string) =>
    Boolean(
      source.db
        .prepare('SELECT 1 FROM org_registry_local_records WHERE entity_id=? LIMIT 1')
        .get(id)
    );
  const inspectEnrollment = async (entityId: string) => {
    await source.observeRevision(`primer-enrollment:${entityId}`, () =>
      String(isEnrolled(entityId))
    );
    if (!isEnrolled(entityId)) return false;
    await source.observe(source.path);
    const { getSelectedAccountContext } = await import('./auth/session-store');
    const { readPrimerArtifactRevisionStateInMain } = await import('./primer-artifact-mutations');
    await source.observeRevision(`primer-authority:${entityId}`, async () => {
      const state = await readPrimerArtifactRevisionStateInMain({
        db: source.db,
        runDatabase: (read) => read(),
        entityId,
        getActiveAccountId: async () => {
          const selected = await getSelectedAccountContext();
          return selected.kind === 'account' ? selected.accountId : null;
        },
      });
      if (state.state === 'pending') throw new DocumentReadError('unknown', true);
      if (
        state.state !== 'ready' ||
        state.workspaceId !== scientificWorkspaceIdForRoot(source.db, source.workspaceRoot) ||
        state.relativePath !== location.relativePath
      )
        throw new DocumentReadError('project', true);
      return JSON.stringify(state);
    });
    return true;
  };

  const bound = files[0];
  if (bound?.file_kind === 'primer-artifact' && (await inspectEnrollment(bound.entity_id))) return;
  const { content: text } = await readProjectScientific(source);
  const raw = jsonObject(text);
  const recognized = raw.schema === PRIMER_ARTIFACT_SCHEMA;
  if (
    recognized &&
    typeof raw.schemaVersion === 'number' &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion > PRIMER_ARTIFACT_SCHEMA_VERSION
  )
    throw new DocumentReadError('newer-format', true);
  const primer = decode(recognized, () =>
    readBoundPrimerArtifact(text, location.relativePath, bound?.entity_id)
  );
  if (primer.id !== bound?.entity_id || bound?.file_kind !== 'primer-artifact')
    await inspectEnrollment(primer.id);
}

async function inspectSequencePackage(source: DocumentOpenSource): Promise<ReadySequencePackage> {
  const packageRoot = sequencePackageRootForMetaPath(source.path);
  if (!packageRoot) throw new DocumentReadError('unsupported-format');
  const markerPath = sequencePackagePaths(packageRoot).metaPath;
  const authority = await captureScientificAuthority(source);
  const marker = authority && (await readScientific(source, markerPath, authority, METADATA_LIMIT));
  const text = marker?.content ?? (await source.readText(markerPath, METADATA_LIMIT));
  const raw = jsonObject(text);
  schemaFamily(raw, 'waypoint.sequence.v1');
  schemaFamily(raw, 'waypoint.plasmid.v1');
  const recognized = isSequencePackageSchema(raw.schema);
  const metadata = decode(recognized, () => {
    try {
      return parseSequencePackageDocument(text);
    } catch (cause) {
      if (cause instanceof SequencePackageFormatError)
        throw new DocumentReadError('newer-format', recognized, { cause });
      throw cause;
    }
  });
  let productPath: string;
  let productText: string;
  if (marker?.revision.kind === 'accepted-object' && authority) {
    productPath = join(packageRoot, metadata.product.file);
    const product = await dependency(() => readScientific(source, productPath, authority));
    if (
      product.revision.kind !== 'accepted-object' ||
      product.revision.resourceId !== metadata.id ||
      product.revision.workspaceVersionId !== marker.revision.workspaceVersionId ||
      (metadata.product.genBankChecksum &&
        metadata.product.genBankChecksum !== `sha256:${product.revision.contentSha256}`)
    )
      throw new DocumentReadError('project', true);
    productText = product.content;
  } else {
    const journalPath = legacySequenceMetadataTransactionPath(packageRoot);
    const journalText = await source
      .readText(journalPath, METADATA_LIMIT)
      .catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return null;
      });
    if (journalText !== null) {
      const journal = decode(true, () => parseLegacySequenceMetadataTransaction(journalText));
      if (journal.packageId !== metadata.id) throw new DocumentReadError('project', true);
    }
    await source.observe(packageRoot);
    const entries = await readdir(packageRoot, { withFileTypes: true });
    const files = entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
    const names = files.filter((entry) => entry.isFile).map((entry) => entry.name);
    if (!names.includes(metadata.product.file)) {
      await source.observe(join(packageRoot, metadata.product.file));
      if (!names.some(sequenceProductExtensionForPath))
        throw new DocumentReadError('missing-asset', true);
    }
    const productFile = decode(true, () =>
      resolveSequenceProductFile(metadata.product.file, files)
    );
    productPath = join(packageRoot, productFile);
    productText = await dependency(() => source.readText(productPath, HARD_CAP_BYTES));
  }
  decode(true, () => parseSequenceFileAsDocument(productText, productPath));
  return {
    documentId: metadata.id,
    name: metadata.name,
    productPath,
    schemaName: metadata.entity.schema.name,
  };
}

async function inspectTablePackage(source: DocumentOpenSource) {
  const text = await source.readText(source.path, TABLE_PACKAGE_MAX_BYTES);
  const recognized = schemaFamily(jsonObject(text), TABLE_PACKAGE_SCHEMA);
  const head = decode(recognized, () => parseTablePackageHead(text));
  const packageRoot = dirname(dirname(source.path));
  const snapshotPath = tablePackageRevisionPath(packageRoot, head.snapshotSha256);
  await source.observe(snapshotPath);
  try {
    const checked = await readTablePackageInMain({
      workspaceRoot: source.workspaceRoot,
      packageRoot,
    });
    if (checked.headText !== text) throw new DocumentReadError('changed', true);
    if (checked.head.status === 'pending-promotion') throw new DocumentReadError('unknown', true);
  } catch (cause) {
    if (isMissing(cause)) throw new DocumentReadError('missing-asset', true, { cause });
    if (cause instanceof WorkspaceFilePreconditionError)
      throw new DocumentReadError('changed', true, { cause });
    if (!(cause instanceof TablePackageError)) throw cause;
    if (cause.code === 'TABLE_PACKAGE_TOO_LARGE')
      throw new DocumentReadError('too-large', true, { cause });
    if (cause.code === 'TABLE_PACKAGE_UNSUPPORTED_SCHEMA')
      throw new DocumentReadError('unsupported-format', true, { cause });
    throw new DocumentReadError('malformed', true, { cause });
  }
}

async function inspectProtocol(source: DocumentOpenSource, kind: 'protocol' | 'protocol-run') {
  const { content } = await readProjectScientific(source);
  const recognized = schemaFamily(jsonObject(content), `dnaforge.${kind}.v1`);
  const parsed = decode(recognized, () => parseScientificDocument(source.path, content));
  if (
    (kind === 'protocol' && parsed.kind !== 'protocol') ||
    (kind === 'protocol-run' && parsed.kind !== 'protocol_run')
  )
    throw new DocumentReadError('unsupported-format');
}

async function inspectTrackView(source: DocumentOpenSource) {
  await source.observe(source.path);
  const entry = await lstat(source.path).catch((error: unknown) => {
    throw documentReadError(error);
  });
  if (entry.isSymbolicLink()) throw new DocumentReadError('permission');
  if (!entry.isFile()) throw new DocumentReadError('unsupported-format');
  const text = await source.readText(source.path, METADATA_LIMIT);
  const recognized = schemaFamily(jsonObject(text), TRACK_VIEW_SCHEMA);
  const view = decode(recognized, () => parseTrackViewDocument(text));
  const reference = view.portableReference;
  const referenceIds =
    reference?.kind === 'workspace-reference'
      ? [reference.entityId, reference.assemblyId]
      : [reference?.catalogId ?? view.reference.assemblyId];
  const { listTrackViewReferences } = await import('./features/reference-assets');
  await source.observeRevision('track-view-reference', async () => {
    let references;
    try {
      references = await listTrackViewReferences();
    } catch (cause) {
      throw new DocumentReadError('runtime', true, { cause });
    }
    const found = references.find((entry) => referenceIds.includes(entry.id));
    if (!found) throw new DocumentReadError('missing-asset', true);
    if (!reference) {
      const assembly = buildGenomeAssembly(found, (path) => path);
      const chromosomes = assembly.chromosomes.map(({ chrom, length }) => ({ chrom, length }));
      const previous = savedReferenceContentIdentity(
        view.reference,
        'referenceVersionHistory' in found ? found.referenceVersionHistory : undefined
      );
      const current = 'referenceIdentity' in found ? found.referenceIdentity : undefined;
      if (
        JSON.stringify(chromosomes) !== JSON.stringify(view.reference.chromosomes) ||
        (previous && current && previous.sequenceIdentity !== current.sequenceIdentity)
      )
        throw new DocumentReadError('missing-asset', true);
    }
    return JSON.stringify(found);
  });
}

const inspectors: Record<
  PortableDocumentKind,
  (source: DocumentOpenSource) => Promise<void | ReadySequencePackage | RendererDesignRecovery>
> = {
  notebook: inspectNotebook,
  design: inspectDesign,
  primer: inspectPrimer,
  entity: inspectEntity,
  selection: async (source) => {
    const text = await source.readText(source.path);
    const recognized = schemaFamily(jsonObject(text), 'waypoint.residue-selection.v1');
    decode(recognized, () => parseSavedResidueSelectionDocument(text));
  },
  'sequence-package': inspectSequencePackage,
  'table-package': inspectTablePackage,
  protocol: (source) => inspectProtocol(source, 'protocol'),
  'protocol-run': (source) => inspectProtocol(source, 'protocol-run'),
  'track-view': inspectTrackView,
};

export function inspectPortableDocument(
  kind: PortableDocumentKind,
  source: DocumentOpenSource
): Promise<void | ReadySequencePackage | RendererDesignRecovery> {
  return inspectors[kind](source);
}
