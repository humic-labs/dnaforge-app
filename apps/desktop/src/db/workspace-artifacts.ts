import { platform } from '../platform';
import type { JSONContent } from '@tiptap/core';
import { trackRendererEvent } from '../lib/analytics';
import type { SequenceDesign } from '../features/design/types';
import {
  beginDesignArtifactPublication,
  confirmDesignArtifactPublication,
  designContentIdentity,
  DesignArtifactConflictError,
  DesignArtifactRetiredError,
} from '../features/design/design-recovery';
import { withRendererWorkspaceMutation } from '../services/workspace-mutation-transaction';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogEntityForFilePath,
  getCurrentCatalogFileForEntity,
  inferCatalogFileKind,
  recordCatalogEvent,
  rebindCatalogFilePath,
  registerCatalogEntity,
  resolveWorkspaceId,
  resolveWorkspaceScope,
  updateCatalogEntityName,
  type CatalogCreationContext,
  type DBCatalogEntity,
} from './workspace-catalog';
import { scopedProjectionId, stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import {
  WORKSPACE_FILE_RELOCATED_EVENT,
  type WorkspaceFileRelocatedDetail,
} from '../shared/workspace-relocate-types';
import {
  appendProjectMemoryEvent,
  createArtifactCreatedProjectMemoryEvent,
  createArtifactRenamedProjectMemoryEvent,
  createFileBindingRepairedProjectMemoryEvent,
  type ProjectMemoryEntityKind,
} from './project-memory';
import {
  buildNotebookPackageDocument,
  isNotebookPackageMetaPath,
  notebookPackagePaths,
  parseNotebookPackageDocument,
  parseNotebookPackageMetadata,
  NOTEBOOK_EMPTY_TIPTAP_DOC,
  NOTEBOOK_PACKAGE_FORMAT_VERSION,
  NOTEBOOK_PACKAGE_SCHEMA,
} from './notebook-package';
import { canonicalNotebookJson } from './notebook-markdown-codec';
import {
  NotebookExternalConflictError,
  prepareNotebookPackageRename,
  publishNotebookPackageV2,
  readNotebookPackageV2,
  recoverNotebookPackageRenameIfNeeded,
  migrateNotebookPackageAtPath,
  type NotebookMigrationSourceShape,
} from './notebook-package-migration';
import { contentFingerprint } from './entity-substrate/adapter';
import { ensureNotebookRegisteredInLims } from '../features/lims/register-notebook-entity';
import {
  MOLECULAR_DOCUMENT_SCHEMA,
  isMolecularDocumentSchema,
  parseMolecularDocument,
  serializeMolecularDocument,
  molecularDocumentSummary,
  validateMolecularDocumentCoordinates,
  type MolecularDocument,
} from '../shared/molecular-document';

export interface WorkspaceArtifactContext extends CatalogCreationContext {
  workspaceRoot?: string | null;
}

export interface WorkspaceArtifactResult {
  path: string;
  name: string;
  fileKind: string;
  sizeBytes: number;

  authorityFingerprint?: string;
}

export type NotebookArtifactWorkspaceOwner =
  | { status: 'unbound' }
  | { status: 'bound'; workspaceRoot: string }
  | { status: 'invalid-binding'; path: string };

export type ParsedWorkspaceArtifact =
  | {
      schema: typeof MOLECULAR_DOCUMENT_SCHEMA;
      kind: 'molecular-document';
      id: string;
      name: string;
      document: MolecularDocument;
      raw: Record<string, unknown>;
    }
  | {
      schema: 'waypoint.notebook.v1';
      kind: 'notebook';
      id: string;
      title: string;
      content: unknown;
      raw: Record<string, unknown>;
    }
  | {
      schema: 'waypoint.design.v1';
      kind: 'assembly-design';
      id: string;
      name: string;
      design: SequenceDesign | null;
      raw: Record<string, unknown>;
    };

export interface ResolvedWorkspaceArtifact {
  entity: DBCatalogEntity;
  artifact: ParsedWorkspaceArtifact;
  repaired: boolean;
}

export interface ResolvedWorkspaceArtifactSnapshot extends ResolvedWorkspaceArtifact {
  authorityFingerprint: string;

  sourceFingerprints: ReadonlyArray<{ path: string; fingerprint: string }>;
}

export async function workspaceArtifactSourcesMatch(
  sources: ResolvedWorkspaceArtifactSnapshot['sourceFingerprints']
): Promise<boolean> {
  if (sources.length === 0) return false;
  return (
    await Promise.all(
      sources.map(async (source) => {
        try {
          return (
            `sha256:${await sha256Text(await platform().fs.readTextFile(source.path))}` ===
            source.fingerprint
          );
        } catch {
          return false;
        }
      })
    )
  ).every(Boolean);
}

export type WorkspaceArtifactRepairPlan =
  | {
      kind: 'no-op';
      path: string;
      workspaceRoot: string | null;
      artifact: ParsedWorkspaceArtifact;
      entityId: string;
      reason: string;
    }
  | {
      kind: 'file-binding-repair';
      path: string;
      workspaceRoot: string | null;
      artifact: ParsedWorkspaceArtifact;
      entityId: string;
      beforePath: string;
      afterPath: string;
      confidence: 'confirmed';
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'catalog-recovery';
      path: string;
      workspaceRoot: string | null;
      artifact: ParsedWorkspaceArtifact;
      entityId: string;
      afterPath: string;
      confidence: 'confirmed';
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'conflict';
      path: string;
      workspaceRoot: string | null;
      artifact: ParsedWorkspaceArtifact;
      entityId: string;
      conflictingEntityId: string;
      reason: string;
      evidence: Record<string, unknown>;
    };

interface CreateNotebookArtifactInput {
  entityId: string;
  pageId: string;
  title: string;
  content?: unknown;
  fileName?: string | null;
  workspaceRoot?: string | null;
  context?: WorkspaceArtifactContext | null;
  mutationToken?: string;
  agentProvenance?: { actor: string; operationId: string };
}

export type DesignArtifactProvenanceSource =
  | 'file-explorer-new-menu'
  | 'agent-create-design'
  | 'deep-share'
  | 'interactive-draft';

interface CreateDesignArtifactInput {
  entityId: string;
  designId: string;
  name: string;
  design?: SequenceDesign | null;
  fileName?: string | null;
  workspaceRoot?: string | null;
  context?: WorkspaceArtifactContext | null;
  mutationToken?: string;
  provenanceSource?: DesignArtifactProvenanceSource;
}

export type WorkspaceArtifactFileType = 'notebook' | 'design';

const EMPTY_TIPTAP_DOC = NOTEBOOK_EMPTY_TIPTAP_DOC;

type NotebookMigrationTelemetry =
  | {
      readonly source: 'database-only' | 'json-authority-package';
      readonly outcome: 'started' | 'success' | 'recovered';
    }
  | {
      readonly source: 'database-only' | 'json-authority-package';
      readonly outcome: 'failed';
      readonly errorClass: 'parse_failed' | 'write_failed' | 'projection';
    };

function notebookMigrationTelemetry(input: NotebookMigrationTelemetry): void {
  trackRendererEvent('notebook_migration_result', {
    feature_area: 'reliability',
    workflow_status: input.outcome,
    version: String(NOTEBOOK_PACKAGE_FORMAT_VERSION),
    source: input.source,
    outcome: input.outcome,
    ...(input.outcome === 'started' ? {} : { success: input.outcome !== 'failed' }),
    ...(input.outcome === 'failed' ? { error_class: input.errorClass } : {}),
  });
}

function getArtifactParentPath(
  workspaceRoot: string | null | undefined,
  context: WorkspaceArtifactContext | null | undefined
): string | null {
  if (context?.targetKind === 'folder' && context.targetPath) return context.targetPath;
  if (context?.parentPath) return context.parentPath;
  return context?.workspaceRoot ?? workspaceRoot ?? null;
}

function sanitizeFileStem(value: string, fallback: string): string {
  const trimmed = value.trim();
  const stem = trimmed.length > 0 ? trimmed : fallback;
  return stem
    .replace(/[/:\\?%*"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function artifactExtension(type: WorkspaceArtifactFileType): string {
  return type === 'notebook' ? 'wpnote.json' : 'wpdesign.json';
}

export function isWorkspaceArtifactFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return (
    lowerPath.endsWith('.wpnote.json') ||
    lowerPath.endsWith('.wpdesign.json') ||
    isNotebookPackageMetaPath(path)
  );
}

export async function isNotebookPackageDirectory(path: string): Promise<boolean> {
  try {
    return await platform().fs.exists(notebookPackagePaths(path).metaPath);
  } catch {
    return false;
  }
}

export async function isWorkspaceNotebookArtifactPath(path: string): Promise<boolean> {
  if (path.toLowerCase().endsWith('.wpnote.json') || isNotebookPackageMetaPath(path)) {
    return true;
  }
  return isNotebookPackageDirectory(path);
}

function artifactFallbackStem(): string {
  return 'Untitled';
}

export function artifactStemFromFileName(
  fileName: string,
  type: WorkspaceArtifactFileType
): string {
  const extension = `.${artifactExtension(type)}`;
  return fileName.toLowerCase().endsWith(extension)
    ? fileName.slice(0, -extension.length)
    : fileName;
}

export function normalizeWorkspaceArtifactFileName(input: {
  fileName: string;
  type: WorkspaceArtifactFileType;
}): { fileName: string; stem: string } {
  const fallback = artifactFallbackStem();
  if (input.type === 'notebook') {
    const raw = input.fileName.replace(/\.wpnote\.json$/i, '').trim();
    const stem = sanitizeFileStem(raw, fallback);
    return { fileName: stem, stem };
  }
  const stem = sanitizeFileStem(artifactStemFromFileName(input.fileName, input.type), fallback);
  return {
    fileName: `${stem}.${artifactExtension(input.type)}`,
    stem,
  };
}

async function nextAvailableNotebookPackagePath(
  parentPath: string,
  stem: string,
  rawNotebookId?: string
): Promise<{ path: string; name: string; recovered: boolean }> {
  for (let index = 1; index <= 100; index++) {
    const suffix = index === 1 ? '' : ` ${index}`;
    const name = `${stem}${suffix}`;
    const path = `${parentPath}/${name}`;
    if (!(await platform().fs.exists(path))) {
      return { path, name, recovered: false };
    }

    if (rawNotebookId) {
      const metaPath = notebookPackagePaths(path).metaPath;
      if (await platform().fs.exists(metaPath)) {
        try {
          const raw = await platform().fs.readTextFile(metaPath);
          const record = JSON.parse(raw) as { id?: unknown };
          if (
            typeof record.id === 'string' &&
            stripWorkspaceScope(record.id) === stripWorkspaceScope(rawNotebookId)
          ) {
            return { path, name, recovered: true };
          }
        } catch {}
      }
    }
  }
  throw new Error(`Could not create a unique notebook package path in ${parentPath}`);
}

async function writeNotebookPackageFiles(
  packageRoot: string,
  document: ReturnType<typeof buildNotebookPackageDocument>,

  workspaceRoot?: string | null,
  options: {
    sourceShape?: NotebookMigrationSourceShape;
    existingMetadataRaw?: string | null;
    formerAuthorityRaw?: string | null;
    expectedCanonicalFingerprint?: string;
    expectedProjectionContent?: JSONContent;
  } = {},
  mutationToken?: string
): Promise<{
  paths: ReturnType<typeof notebookPackagePaths>;
  sizeBytes: number;
  authorityFingerprint: string;
}> {
  if (!workspaceRoot) {
    throw new Error('A notebook package must belong to a mounted workspace before it can be saved');
  }
  const paths = notebookPackagePaths(packageRoot);
  const published = await publishNotebookPackageV2(platform().fs, {
    packageRoot,
    workspaceRoot,
    id: document.id,
    title: document.title,
    content: document.content as JSONContent,
    sourceShape: options.sourceShape ?? 'new-package',

    existingMetadataRaw: options.existingMetadataRaw ?? JSON.stringify(document),
    formerAuthorityRaw: options.formerAuthorityRaw,
    expectedCanonicalFingerprint: options.expectedCanonicalFingerprint,
    expectedProjectionContent: options.expectedProjectionContent,
    updatedAt: document.updatedAt,
    mutationToken,
  });
  return {
    paths,
    sizeBytes: published.markdownBytes,
    authorityFingerprint: published.canonicalFingerprint,
  };
}

async function nextAvailableArtifactPath(
  parentPath: string,
  stem: string,
  extension: string
): Promise<{ path: string; name: string }> {
  for (let index = 1; index <= 100; index++) {
    const suffix = index === 1 ? '' : ` ${index}`;
    const name = `${stem}${suffix}.${extension}`;
    const path = `${parentPath}/${name}`;
    if (!(await platform().fs.exists(path))) {
      return { path, name };
    }
  }
  throw new Error(`Could not create a unique artifact path in ${parentPath}`);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isDesignSnapshot(value: unknown): value is SequenceDesign {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function claimLegacyNotebookAuthority(input: {
  path: string;
  raw: string;
  workspaceRoot: string;
  mutationToken?: string;
}): Promise<void> {
  try {
    await platform().fs.writeWorkspaceTextFileAtomic({
      workspaceRoot: input.workspaceRoot,
      path: input.path,
      content: input.raw,
      mode: 'replace',
      expectedContentHash: await sha256Text(input.raw),
      artifactNoun: 'legacy notebook',
      mutationToken: input.mutationToken,
    });
  } catch {
    throw new NotebookExternalConflictError(input.path);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

async function statArtifactFile(path: string): Promise<{
  sizeBytes: number | null;
  modifiedAt: number | null;
}> {
  try {
    const stat = await platform().fs.stat(path);
    return {
      sizeBytes: stat.size ?? null,
      modifiedAt: stat.mtime ?? null,
    };
  } catch {
    return { sizeBytes: null, modifiedAt: null };
  }
}

function workspaceRootFromBinding(binding: {
  path: string;
  relative_path: string | null;
}): string | null {
  if (binding.relative_path === null) return null;
  if (binding.relative_path === '') return binding.path;
  if (!isSafeWorkspaceRelativePath(binding.relative_path)) return null;
  const suffix = `/${binding.relative_path.replace(/\\/g, '/')}`;
  if (!binding.path.replace(/\\/g, '/').endsWith(suffix)) return null;
  let rootLength = binding.path.length - suffix.length;
  if (rootLength === 0 || /^[A-Za-z]:$/.test(binding.path.slice(0, rootLength))) {
    rootLength += 1;
  }
  return binding.path.slice(0, rootLength);
}

export async function resolveNotebookArtifactWorkspaceOwner(
  pageId: string
): Promise<NotebookArtifactWorkspaceOwner> {
  const binding = await getCurrentCatalogFileForEntity(pageId);
  if (!binding) return { status: 'unbound' };
  if (binding.file_kind !== 'waypoint-notebook') {
    return { status: 'invalid-binding', path: binding.path };
  }
  const workspaceRoot = workspaceRootFromBinding(binding);
  return workspaceRoot
    ? { status: 'bound', workspaceRoot }
    : { status: 'invalid-binding', path: binding.path };
}

function projectionEntityId(scope: string | null, artifact: ParsedWorkspaceArtifact): string {
  return artifact.schema === NOTEBOOK_PACKAGE_SCHEMA ||
    artifact.schema === MOLECULAR_DOCUMENT_SCHEMA
    ? scopedProjectionId(scope, artifact.id)
    : artifact.id;
}

async function registerCatalogEntityForArtifact(input: {
  artifact: ParsedWorkspaceArtifact;
  path: string;
  workspaceRoot?: string | null;
  catalogMetadata?: Record<string, unknown>;

  entityId: string;
}): Promise<DBCatalogEntity> {
  const existing =
    input.catalogMetadata === undefined ? await getCatalogEntity(input.entityId) : null;
  const catalogMetadata =
    input.catalogMetadata ?? objectValue(JSON.parse(existing?.metadata ?? '{}'));
  if (!catalogMetadata) throw new Error('Existing artifact catalog metadata is invalid.');
  if (input.artifact.schema === MOLECULAR_DOCUMENT_SCHEMA) {
    return registerCatalogEntity({
      id: input.entityId,
      type: 'molecular-document',
      name: input.artifact.name,
      locator: `entity://molecular-document/${input.entityId}`,
      storageType: 'file',
      workspaceRoot: input.workspaceRoot,
      metadata: {
        ...catalogMetadata,
        artifactSchema: input.artifact.schema,
        documentId: input.artifact.id,
        recoveredFrom: input.path,
        artifactFingerprint: contentFingerprint(
          serializeMolecularDocument(input.artifact.document)
        ),
        ...molecularDocumentSummary(input.artifact.document),
      },
    });
  }
  if (input.artifact.schema === 'waypoint.notebook.v1') {
    return registerCatalogEntity({
      id: input.entityId,
      type: 'notebook',
      name: input.artifact.title,
      locator: `entity://page/${input.entityId}`,
      storageType: 'database',
      workspaceRoot: input.workspaceRoot,
      metadata: {
        ...catalogMetadata,
        artifactSchema: input.artifact.schema,
        embeddedId: input.artifact.id,
        recoveredFrom: input.path,
      },
    });
  }

  return registerCatalogEntity({
    id: input.entityId,
    type: 'design',
    name: input.artifact.name,
    locator: `entity://design/${input.entityId}`,
    storageType: 'localStorage',
    workspaceRoot: input.workspaceRoot,
    metadata: {
      ...catalogMetadata,
      artifactSchema: input.artifact.schema,
      embeddedId: input.artifact.id,
      embeddedDesignAvailable: input.artifact.design !== null,
      recoveredFrom: input.path,
    },
  });
}

export function parseWorkspaceArtifact(content: string): ParsedWorkspaceArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid DNAForge artifact JSON');
  }

  const doc = objectValue(parsed);
  if (!doc) throw new Error('DNAForge artifact must be a JSON object');

  const schema = stringValue(doc.schema);
  if (isMolecularDocumentSchema(schema)) {
    const document = parseMolecularDocument(content);
    return {
      schema: document.schema,
      kind: 'molecular-document',
      id: document.id,
      name: document.name,
      document,
      raw: doc,
    };
  }
  const kind = stringValue(doc.kind);
  const rawEmbeddedId = stringValue(doc.id);
  if (!schema || !kind || !rawEmbeddedId) {
    throw new Error('DNAForge artifact is missing schema, kind, or id');
  }

  const id = stripWorkspaceScope(rawEmbeddedId);
  if (!id) {
    throw new Error('DNAForge artifact id is empty after stripping workspace scope');
  }
  if (id !== rawEmbeddedId) {
    console.warn(
      `[workspace-artifacts] stripped inherited workspace scope from embedded id: ${rawEmbeddedId} → ${id}`
    );
  }

  if (schema === 'waypoint.notebook.v1' && kind === 'notebook') {
    return {
      schema,
      kind,
      id,
      title: stringValue(doc.title) ?? 'Untitled',
      content: doc.content ?? EMPTY_TIPTAP_DOC,
      raw: doc,
    };
  }

  if (schema === 'waypoint.design.v1' && kind === 'assembly-design') {
    return {
      schema,
      kind,
      id,
      name: stringValue(doc.name) ?? 'Untitled',
      design: (objectValue(doc.design) as SequenceDesign | null) ?? null,
      raw: doc,
    };
  }

  throw new Error(`Unsupported DNAForge artifact schema: ${schema}/${kind}`);
}

async function writeArtifactFile(
  entityId: string,
  workspaceRoot: string | null | undefined,
  parentPath: string,
  stem: string,
  extension: string,
  document: Record<string, unknown>,
  event: {
    eventType: string;
    summary: string;
    payload: Record<string, unknown>;
  },
  fileName?: string | null,
  mutationToken?: string
): Promise<WorkspaceArtifactResult> {
  const { path, name } = fileName
    ? { path: `${parentPath}/${fileName}`, name: fileName }
    : await nextAvailableArtifactPath(parentPath, stem, extension);
  if (fileName && (await platform().fs.exists(path))) {
    throw new Error(`Artifact file already exists: ${path}`);
  }
  const content = `${JSON.stringify(document, null, 2)}\n`;
  await platform().fs.writeTextFile(path, content, undefined, mutationToken);

  const sizeBytes = byteLength(content);
  const fileKind = inferCatalogFileKind(path);
  await writeArtifactCreatedProjectMemory({
    entityId,
    workspaceRoot,
    path,
    fileKind,
    sizeBytes,
    document,
    mutationToken,
  });
  await bindCatalogEntityToFile({
    entityId,
    path,
    fileKind,
    workspaceRoot,
    sizeBytes,
    modifiedAt: Date.now(),
    mutationToken,
  });
  await recordCatalogEvent({
    entityId,
    eventType: event.eventType,
    summary: event.summary,
    payload: {
      ...event.payload,
      filePath: path,
      fileName: name,
      fileKind,
    },
  });

  return { path, name, fileKind, sizeBytes };
}

async function writeArtifactCreatedProjectMemory(input: {
  entityId: string;
  workspaceRoot: string | null | undefined;
  path: string;
  fileKind: string;
  sizeBytes: number;
  document: Record<string, unknown>;
  mutationToken?: string;
}): Promise<void> {
  if (!input.workspaceRoot) return;
  const schema = stringValue(input.document.schema);
  const isNotebook = schema === 'waypoint.notebook.v1';
  const isDesign = schema === 'waypoint.design.v1';
  if (!isNotebook && !isDesign) return;

  const entityKind: Extract<ProjectMemoryEntityKind, 'notebook' | 'design'> = isNotebook
    ? 'notebook'
    : 'design';
  const displayName =
    (isNotebook ? stringValue(input.document.title) : stringValue(input.document.name)) ??
    'Untitled';

  await appendProjectMemoryEvent({
    workspaceRoot: input.workspaceRoot,
    mutationToken: input.mutationToken,
    event: createArtifactCreatedProjectMemoryEvent({
      workspaceRoot: input.workspaceRoot,
      entityId: input.entityId,
      entityKind,
      displayName,
      filePath: input.path,
      fileKind: entityKind,
      sizeBytes: input.sizeBytes,
      artifactSchema: schema,
    }),
  });
}

async function writeArtifactRenamedProjectMemory(input: {
  entityId: string;
  workspaceRoot: string | null;
  oldPath: string;
  newPath: string;
  type: WorkspaceArtifactFileType;
  mutationToken?: string;
}): Promise<void> {
  if (!input.workspaceRoot) return;

  await appendProjectMemoryEvent({
    workspaceRoot: input.workspaceRoot,
    mutationToken: input.mutationToken,
    event: createArtifactRenamedProjectMemoryEvent({
      workspaceRoot: input.workspaceRoot,
      entityId: input.entityId,
      oldPath: input.oldPath,
      newPath: input.newPath,
      artifactSchema: input.type === 'notebook' ? 'waypoint.notebook.v1' : 'waypoint.design.v1',
    }),
  });
}

export async function recordWorkspaceArtifactFileRenameInProjectMemory(input: {
  oldPath: string;
  newPath: string;
  workspaceRoot: string | null;
  mutationToken?: string;
}): Promise<boolean> {
  if (!input.workspaceRoot) return false;
  if (!isWorkspaceArtifactFilePath(input.oldPath) && !isWorkspaceArtifactFilePath(input.newPath)) {
    return false;
  }

  const artifact = parseWorkspaceArtifact(await platform().fs.readTextFile(input.newPath));
  const type = artifact.schema === 'waypoint.notebook.v1' ? 'notebook' : 'design';
  await writeArtifactRenamedProjectMemory({
    entityId: artifact.id,
    workspaceRoot: input.workspaceRoot,
    oldPath: input.oldPath,
    newPath: input.newPath,
    type,
    mutationToken: input.mutationToken,
  });
  return true;
}

export async function createNotebookArtifactFile(
  input: CreateNotebookArtifactInput
): Promise<WorkspaceArtifactResult | null> {
  const workspaceRoot = input.context?.workspaceRoot ?? input.workspaceRoot ?? null;
  const parentPath = getArtifactParentPath(workspaceRoot, input.context);
  if (!parentPath) return null;

  const createdAt = new Date().toISOString();
  const normalizedFileName = input.fileName
    ? normalizeWorkspaceArtifactFileName({ fileName: input.fileName, type: 'notebook' })
    : null;
  const stem = normalizedFileName?.stem ?? sanitizeFileStem(input.title, 'Untitled');
  const allocation = normalizedFileName
    ? {
        path: `${parentPath}/${normalizedFileName.fileName}`,
        name: normalizedFileName.fileName,
        recovered: false,
      }
    : await nextAvailableNotebookPackagePath(parentPath, stem, stripWorkspaceScope(input.pageId));
  const { path: packageRoot, name } = allocation;

  if (await platform().fs.exists(packageRoot)) {
    if (allocation.recovered) {
      const resolved = await resolveArtifactFile({
        path: packageRoot,
        workspaceRoot,
        mutationToken: input.mutationToken,
      });
      const workspaceScope = await resolveWorkspaceScope(workspaceRoot);
      const canonicalEntityId = workspaceScope
        ? scopedProjectionId(workspaceScope, stripWorkspaceScope(input.pageId))
        : input.entityId;
      const portableInputEntityId = stripWorkspaceScope(input.entityId);
      const isLegacyUnscopedRecovery =
        input.entityId === portableInputEntityId &&
        portableInputEntityId === stripWorkspaceScope(input.pageId) &&
        resolved.entity.id === canonicalEntityId;
      if (resolved.entity.id !== input.entityId && !isLegacyUnscopedRecovery) {
        throw new Error(`Recovered notebook package belongs to another entity: ${packageRoot}`);
      }
      const stat = await statArtifactFile(notebookPackagePaths(packageRoot).markdownPath);
      await ensureNotebookRegisteredInLims({
        id: input.entityId,
        name: input.title,
        packagePath: packageRoot,
        workspaceId: await resolveWorkspaceId(workspaceRoot),
        mutationToken: input.mutationToken,
      });
      return {
        path: packageRoot,
        name,
        fileKind: 'waypoint-notebook',
        sizeBytes: stat.sizeBytes ?? 0,
      };
    }
    throw new Error(`Notebook package already exists: ${packageRoot}`);
  }

  const document = buildNotebookPackageDocument({
    id: stripWorkspaceScope(input.pageId),
    title: input.title,
    content: input.content ?? EMPTY_TIPTAP_DOC,
    updatedAt: createdAt,
    existing: {
      provenance: [
        {
          event: 'created',
          actor: input.agentProvenance?.actor ?? 'user',
          createdAt,
          source: input.agentProvenance ? 'agent-notebook' : 'file-explorer-new-menu',
          ...(input.agentProvenance ? { operationId: input.agentProvenance.operationId } : {}),
          workspaceRoot,
          creationContext: input.context ?? null,
        },
      ],
    },
  });

  await platform().fs.mkdir(packageRoot, { recursive: true }, input.mutationToken);
  const { sizeBytes, authorityFingerprint } = await writeNotebookPackageFiles(
    packageRoot,
    document,
    workspaceRoot,
    {},
    input.mutationToken
  );

  if (!(await getCatalogEntity(input.entityId))) {
    await registerCatalogEntity({
      id: input.entityId,
      type: 'notebook',
      name: input.title,
      locator: `entity://page/${input.entityId}`,
      storageType: 'database',
      workspaceRoot,
      metadata: { artifactSchema: NOTEBOOK_PACKAGE_SCHEMA, embeddedId: input.pageId },
    });
  }

  await writeArtifactCreatedProjectMemory({
    entityId: input.entityId,
    workspaceRoot,
    path: packageRoot,
    fileKind: 'waypoint-notebook',
    sizeBytes,
    document,
    mutationToken: input.mutationToken,
  });
  await bindCatalogEntityToFile({
    entityId: input.entityId,
    path: packageRoot,
    fileKind: 'waypoint-notebook',
    workspaceRoot,
    sizeBytes,
    modifiedAt: Date.now(),
    mutationToken: input.mutationToken,
  });
  await recordCatalogEvent({
    entityId: input.entityId,
    eventType: 'artifact_created',
    summary: 'Created notebook package',
    payload: {
      artifactSchema: NOTEBOOK_PACKAGE_SCHEMA,
      pageId: input.pageId,
      source: input.agentProvenance ? 'agent-notebook' : 'file-explorer-new-menu',
      ...(input.agentProvenance ?? {}),
      creationContext: input.context ?? null,
      filePath: packageRoot,
      fileName: name,
      fileKind: 'waypoint-notebook',
      packageFormat: 'vault-shaped',
    },
  });

  const canonicalPath = notebookPackagePaths(packageRoot).markdownPath;
  const canonicalAfterRegistration = await platform().fs.readTextFile(canonicalPath);
  if (contentFingerprint(canonicalAfterRegistration) !== authorityFingerprint) {
    throw new NotebookExternalConflictError(canonicalPath);
  }

  await ensureNotebookRegisteredInLims({
    id: input.entityId,
    name: input.title,
    packagePath: packageRoot,
    workspaceId: await resolveWorkspaceId(workspaceRoot),
    mutationToken: input.mutationToken,
  });

  return {
    path: packageRoot,
    name,
    fileKind: 'waypoint-notebook',
    sizeBytes,
    authorityFingerprint,
  };
}

export interface DatabaseOnlyNotebookMigrationReport {
  migrated: string[];
  recovered: string[];
  failed: Array<{ id: string; message: string }>;
}

async function archiveSupersededDatabaseOnlyNotebookProjection(input: {
  sourceEntityId: string;
  successorEntityId: string;
  workspaceId: number;
}): Promise<void> {
  await platform().db.archiveSupersededNotebookCatalog(input);
}

export async function migrateDatabaseOnlyNotebooksForWorkspace(
  workspaceRoot: string
): Promise<DatabaseOnlyNotebookMigrationReport> {
  const workspaceRows = await platform().db.select<Array<{ id: number }>>(
    'SELECT id FROM workspaces WHERE path = ?',
    [workspaceRoot]
  );
  if (!workspaceRows[0]) return { migrated: [], recovered: [], failed: [] };
  const workspaceId = workspaceRows[0].id;
  const workspaceScope = await resolveWorkspaceScope(workspaceRoot);
  if (!workspaceScope) return { migrated: [], recovered: [], failed: [] };
  const entities = await platform().db.select<Array<{ id: string }>>(
    'SELECT id FROM catalog_entities WHERE workspace_id = ? AND type = ? AND status = ?',
    [workspaceId, 'notebook', 'active']
  );
  const report: DatabaseOnlyNotebookMigrationReport = {
    migrated: [],
    recovered: [],
    failed: [],
  };
  for (const entity of entities) {
    try {
      const sourceBinding = await getCurrentCatalogFileForEntity(entity.id);
      if (sourceBinding) continue;
      const rows = await platform().db.select<
        Array<{ id: string; title: string; content: string }>
      >('SELECT id, title, content FROM pages WHERE id = ?', [entity.id]);
      const row = rows[0];
      if (!row) continue;
      notebookMigrationTelemetry({ source: 'database-only', outcome: 'started' });
      const canonicalEntityId = scopedProjectionId(workspaceScope, stripWorkspaceScope(entity.id));
      const canonicalBinding = await getCurrentCatalogFileForEntity(canonicalEntityId);
      if (canonicalEntityId !== entity.id && canonicalBinding) {
        await archiveSupersededDatabaseOnlyNotebookProjection({
          sourceEntityId: entity.id,
          successorEntityId: canonicalEntityId,
          workspaceId,
        });
        report.recovered.push(entity.id);
        notebookMigrationTelemetry({ source: 'database-only', outcome: 'recovered' });
        continue;
      }
      const content = JSON.parse(row.content) as JSONContent;
      const artifact = await createNotebookArtifactFile({
        entityId: row.id,
        pageId: row.id,
        title: row.title,
        content,
        workspaceRoot,
      });
      if (!artifact) throw new Error('Notebook has no writable workspace package location');
      const after = await getCurrentCatalogFileForEntity(canonicalEntityId);
      if (!after) throw new Error('Notebook package published without a current catalog binding');
      if (canonicalEntityId !== entity.id) {
        await archiveSupersededDatabaseOnlyNotebookProjection({
          sourceEntityId: entity.id,
          successorEntityId: canonicalEntityId,
          workspaceId,
        });
        report.recovered.push(entity.id);
        notebookMigrationTelemetry({ source: 'database-only', outcome: 'recovered' });
      } else {
        report.migrated.push(row.id);
        notebookMigrationTelemetry({ source: 'database-only', outcome: 'success' });
      }
    } catch (error) {
      notebookMigrationTelemetry({
        source: 'database-only',
        outcome: 'failed',
        errorClass: 'write_failed',
      });
      report.failed.push({
        id: entity.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

export async function createDesignArtifactFile(
  input: CreateDesignArtifactInput
): Promise<WorkspaceArtifactResult | null> {
  const workspaceRoot = input.context?.workspaceRoot ?? input.workspaceRoot ?? null;
  const parentPath = getArtifactParentPath(workspaceRoot, input.context);
  if (!parentPath) return null;

  const createdAt = new Date().toISOString();
  const provenanceSource = input.provenanceSource ?? 'file-explorer-new-menu';
  const normalizedFileName = input.fileName
    ? normalizeWorkspaceArtifactFileName({ fileName: input.fileName, type: 'design' })
    : null;
  const stem = normalizedFileName?.stem ?? sanitizeFileStem(input.name, 'Untitled');
  const document = {
    schema: 'waypoint.design.v1',
    kind: 'assembly-design',
    id: input.designId,
    name: input.name,
    storage: {
      type: 'localStorage',
      key: 'waypoint-designs',
      id: input.designId,
    },
    design: input.design ?? null,
    plannedOutputs: [
      {
        format: 'genbank',
        status: 'pending-sequence',
      },
    ],
    provenance: [
      {
        event: 'created',
        actor: 'user',
        createdAt,
        source: provenanceSource,
        workspaceRoot,
        creationContext: input.context ?? null,
      },
    ],
  };

  if (input.design) beginDesignArtifactPublication(input.design);
  const writeArtifact = (mutationToken?: string) =>
    writeArtifactFile(
      input.entityId,
      workspaceRoot,
      parentPath,
      stem,
      'wpdesign.json',
      document,
      {
        eventType: 'artifact_created',
        summary: 'Created assembly design artifact file',
        payload: {
          artifactSchema: 'waypoint.design.v1',
          designId: input.designId,
          source: provenanceSource,
          creationContext: input.context ?? null,
          plannedOutputs: ['genbank'],
        },
      },
      normalizedFileName?.fileName,
      mutationToken
    );
  const result = input.mutationToken
    ? await writeArtifact(input.mutationToken)
    : await withRendererWorkspaceMutation(workspaceRoot, writeArtifact, undefined, {
        waitForAvailability: true,
      });
  if (result && input.design) confirmDesignArtifactPublication(input.design);
  return result;
}

export async function resolveArtifactFile(input: {
  path: string;
  workspaceRoot?: string | null;
  recordProjectMemoryRepair?: boolean;
  mutationToken?: string;

  catalogMetadata?: Record<string, unknown>;
}): Promise<ResolvedWorkspaceArtifactSnapshot> {
  const resolvedPath = await resolveNotebookArtifactReadPath(input.path);
  if (resolvedPath.packageRoot && input.workspaceRoot) {
    let migrationAttempted = false;
    try {
      const raw = await platform().fs.readTextFile(
        notebookPackagePaths(resolvedPath.packageRoot).metaPath
      );
      const record = JSON.parse(raw) as { formatVersion?: unknown };
      migrationAttempted = record.formatVersion === undefined;
      if (migrationAttempted) {
        notebookMigrationTelemetry({ source: 'json-authority-package', outcome: 'started' });
      }
      const migrated = await migrateNotebookPackageAtPath(platform().fs, {
        packageRoot: resolvedPath.packageRoot,
        workspaceRoot: input.workspaceRoot,
        mutationToken: input.mutationToken,
      });
      if (migrated) {
        notebookMigrationTelemetry({
          source: 'json-authority-package',
          outcome: migrated.recovered ? 'recovered' : 'success',
        });
      }
    } catch (error) {
      if (migrationAttempted) {
        notebookMigrationTelemetry({
          source: 'json-authority-package',
          outcome: 'failed',
          errorClass: 'parse_failed',
        });
      }
      throw error;
    }
  }
  const { artifact, authorityPath, authorityFingerprint, sourceFingerprints } =
    await readResolvedWorkspaceArtifact(resolvedPath, input.workspaceRoot, input.mutationToken);
  const bindPath = resolvedPath.packageRoot ?? input.path;

  const scope = await resolveWorkspaceScope(input.workspaceRoot);
  const scopedId = projectionEntityId(scope, artifact);
  const existingAtPath = await getCatalogEntityForFilePath(bindPath);
  const existingCurrent = await getCurrentCatalogFileForEntity(scopedId);
  const stat = await statArtifactFile(authorityPath);

  const entity = await registerCatalogEntityForArtifact({
    artifact,
    path: bindPath,
    workspaceRoot: input.workspaceRoot,
    entityId: scopedId,
    ...(input.catalogMetadata ? { catalogMetadata: input.catalogMetadata } : {}),
  });

  const repaired = existingAtPath?.id !== entity.id;
  const movedFromPath =
    existingCurrent && existingCurrent.path !== bindPath ? existingCurrent.path : null;
  await bindCatalogEntityToFile({
    entityId: entity.id,
    path: bindPath,
    fileKind:
      artifact.schema === NOTEBOOK_PACKAGE_SCHEMA
        ? 'waypoint-notebook'
        : inferCatalogFileKind(bindPath),
    workspaceRoot: input.workspaceRoot,
    sizeBytes: stat.sizeBytes,
    modifiedAt: stat.modifiedAt,
    status: 'current',
    mutationToken: input.mutationToken,
  });

  await recordCatalogEvent({
    entityId: entity.id,
    eventType: repaired ? 'binding_repaired' : 'artifact_opened',
    summary: repaired ? 'Repaired DNAForge artifact file binding' : 'Opened DNAForge artifact file',
    payload: {
      filePath: bindPath,
      artifactSchema: artifact.schema,
      source: 'artifact-open',
      packageFormat: resolvedPath.packageRoot ? 'vault-shaped' : undefined,
    },
  });

  if (input.recordProjectMemoryRepair && movedFromPath && input.workspaceRoot) {
    await appendProjectMemoryEvent({
      workspaceRoot: input.workspaceRoot,
      event: createFileBindingRepairedProjectMemoryEvent({
        workspaceRoot: input.workspaceRoot,
        entityId: entity.id,
        oldPath: movedFromPath,
        newPath: bindPath,
        artifactSchema: artifact.schema,
      }),
    });
  }

  return { entity, artifact, repaired, authorityFingerprint, sourceFingerprints };
}

async function readResolvedWorkspaceArtifact(
  resolvedPath: {
    readPath: string;
    packageRoot: string | null;
  },
  workspaceRoot?: string | null,
  mutationToken?: string
): Promise<{
  artifact: ParsedWorkspaceArtifact;
  authorityPath: string;
  authorityFingerprint: string;
  sourceFingerprints: ReadonlyArray<{ path: string; fingerprint: string }>;
}> {
  const content = await platform().fs.readTextFile(resolvedPath.readPath);
  if (resolvedPath.packageRoot) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(content);
    } catch {
      candidate = null;
    }
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).formatVersion !== undefined
    ) {
      const { metadata, parsed, markdown } = await readNotebookPackageV2(
        platform().fs,
        resolvedPath.packageRoot,
        content,
        workspaceRoot
          ? { workspaceRoot, packageRoot: resolvedPath.packageRoot, mutationToken }
          : undefined
      );
      return {
        artifact: {
          schema: NOTEBOOK_PACKAGE_SCHEMA,
          kind: 'notebook',
          id: parsed.id,
          title: parsed.title,
          content: parsed.content,
          raw: metadata,
        },
        authorityPath: notebookPackagePaths(resolvedPath.packageRoot).markdownPath,
        authorityFingerprint: contentFingerprint(markdown),
        sourceFingerprints: [
          { path: resolvedPath.readPath, fingerprint: `sha256:${await sha256Text(content)}` },
          {
            path: notebookPackagePaths(resolvedPath.packageRoot).markdownPath,
            fingerprint: `sha256:${await sha256Text(markdown)}`,
          },
        ],
      };
    }
  }
  const artifact = parseWorkspaceArtifact(content);
  if (artifact.schema === MOLECULAR_DOCUMENT_SCHEMA)
    await validateMolecularDocumentCoordinates(artifact.document);
  return {
    artifact,
    authorityPath: resolvedPath.readPath,
    authorityFingerprint: contentFingerprint(content),
    sourceFingerprints: [
      { path: resolvedPath.readPath, fingerprint: `sha256:${await sha256Text(content)}` },
    ],
  };
}

async function resolveNotebookArtifactReadPath(path: string): Promise<{
  readPath: string;
  packageRoot: string | null;
}> {
  if (isNotebookPackageMetaPath(path)) {
    const packageRoot = path.replace(/[/\\]\.forge[/\\]notebook\.json$/i, '');
    return { readPath: path, packageRoot };
  }
  if (await isNotebookPackageDirectory(path)) {
    return { readPath: notebookPackagePaths(path).metaPath, packageRoot: path };
  }
  return { readPath: path, packageRoot: null };
}

export async function planWorkspaceArtifactRepair(input: {
  path: string;
  workspaceRoot?: string | null;
  mutationToken?: string;
}): Promise<WorkspaceArtifactRepairPlan> {
  const resolvedPath = await resolveNotebookArtifactReadPath(input.path);
  const { artifact } = await readResolvedWorkspaceArtifact(
    resolvedPath,
    input.workspaceRoot,
    input.mutationToken
  );
  const bindPath = resolvedPath.packageRoot ?? input.path;

  const scope = await resolveWorkspaceScope(input.workspaceRoot);
  const scopedId = projectionEntityId(scope, artifact);
  const existingAtPath = await getCatalogEntityForFilePath(bindPath);
  const existingCurrent = await getCurrentCatalogFileForEntity(scopedId);
  const workspaceRoot = input.workspaceRoot ?? null;

  if (existingAtPath && existingAtPath.id !== scopedId) {
    return {
      kind: 'conflict',
      path: bindPath,
      workspaceRoot,
      artifact,
      entityId: scopedId,
      conflictingEntityId: existingAtPath.id,
      reason: 'path-bound-to-different-entity',
      evidence: {
        path: bindPath,
        embeddedEntityId: artifact.id,
        catalogEntityId: existingAtPath.id,
      },
    };
  }

  if (existingCurrent && existingCurrent.path !== bindPath) {
    return {
      kind: 'file-binding-repair',
      path: bindPath,
      workspaceRoot,
      artifact,
      entityId: scopedId,
      beforePath: existingCurrent.path,
      afterPath: bindPath,
      confidence: 'confirmed',
      evidence: {
        source: 'embedded-artifact-id',
        embeddedEntityId: artifact.id,
        previousCurrentPath: existingCurrent.path,
        candidatePath: bindPath,
      },
    };
  }

  if (!existingAtPath && !existingCurrent) {
    return {
      kind: 'catalog-recovery',
      path: bindPath,
      workspaceRoot,
      artifact,
      entityId: scopedId,
      afterPath: bindPath,
      confidence: 'confirmed',
      evidence: {
        source: 'embedded-artifact-id',
        embeddedEntityId: artifact.id,
        candidatePath: bindPath,
      },
    };
  }

  return {
    kind: 'no-op',
    path: bindPath,
    workspaceRoot,
    artifact,
    entityId: scopedId,
    reason: 'catalog-binding-already-current',
  };
}

export async function applyAcceptedWorkspaceArtifactRepair(
  plan: WorkspaceArtifactRepairPlan,
  mutationToken?: string
): Promise<ResolvedWorkspaceArtifact> {
  if (plan.kind === 'conflict') {
    throw new Error(`Cannot apply conflicting artifact repair: ${plan.reason}`);
  }
  if (plan.kind === 'no-op') {
    const entity = await registerCatalogEntityForArtifact({
      artifact: plan.artifact,
      path: plan.path,
      workspaceRoot: plan.workspaceRoot,
      entityId: plan.entityId,
    });
    return { entity, artifact: plan.artifact, repaired: false };
  }

  const stat = await statArtifactFile(plan.afterPath);
  const entity = await registerCatalogEntityForArtifact({
    artifact: plan.artifact,
    path: plan.afterPath,
    workspaceRoot: plan.workspaceRoot,
    entityId: plan.entityId,
  });

  await bindCatalogEntityToFile({
    entityId: entity.id,
    path: plan.afterPath,
    fileKind: inferCatalogFileKind(plan.afterPath),
    workspaceRoot: plan.workspaceRoot,
    sizeBytes: stat.sizeBytes,
    modifiedAt: stat.modifiedAt,
    status: 'current',
    mutationToken,
  });

  await recordCatalogEvent({
    entityId: entity.id,
    eventType: plan.kind === 'file-binding-repair' ? 'binding_repaired' : 'binding_recovered',
    summary:
      plan.kind === 'file-binding-repair'
        ? 'Accepted DNAForge artifact file binding repair'
        : 'Recovered DNAForge artifact file binding from native artifact',
    payload: {
      filePath: plan.afterPath,
      artifactSchema: plan.artifact.schema,
      evidence: plan.evidence,
      source: 'accepted-artifact-repair',
    },
  });

  if (plan.kind === 'file-binding-repair' && plan.workspaceRoot) {
    await appendProjectMemoryEvent({
      workspaceRoot: plan.workspaceRoot,
      mutationToken,
      event: createFileBindingRepairedProjectMemoryEvent({
        workspaceRoot: plan.workspaceRoot,
        entityId: entity.id,
        oldPath: plan.beforePath,
        newPath: plan.afterPath,
        artifactSchema: plan.artifact.schema,
      }),
    });
  }

  return { entity, artifact: plan.artifact, repaired: true };
}

export async function trashNotebookArtifactForPage(
  pageId: string,
  mutationToken?: string
): Promise<boolean> {
  return platform().db.deleteNotebookPage(pageId, mutationToken);
}

type NotebookSnapshotInput = {
  pageId: string;
  title: string;
  content: unknown;
  recordEvent?: boolean;
  workspaceRoot?: string | null;
  expectedCanonicalFingerprint?: string;
  expectedProjectionContent?: JSONContent;
  mutationToken?: string;
  agentProvenance?: { actor: string; operationId: string };
};

type NotebookSnapshotAdmission =
  | { kind: 'missing' }
  | { kind: 'done'; result: WorkspaceArtifactResult }
  | {
      kind: 'continue';
      binding: NonNullable<Awaited<ReturnType<typeof getCurrentCatalogFileForEntity>>>;
    };

async function admitNotebookSnapshotBinding(
  input: NotebookSnapshotInput
): Promise<NotebookSnapshotAdmission> {
  const existing = await getCurrentCatalogFileForEntity(input.pageId);
  if (existing && existing.file_kind === 'waypoint-notebook') {
    return { kind: 'continue', binding: existing };
  }
  const workspaceRoot = input.workspaceRoot?.trim() || null;
  if (!workspaceRoot) return { kind: 'missing' };
  const created = await createNotebookArtifactFile({
    entityId: input.pageId,
    pageId: input.pageId,
    title: input.title,
    content: input.content,
    workspaceRoot,
    mutationToken: input.mutationToken,
  });
  if (!created) return { kind: 'missing' };

  if (created.authorityFingerprint) return { kind: 'done', result: created };
  const rebound = await getCurrentCatalogFileForEntity(input.pageId);
  if (!rebound || rebound.file_kind !== 'waypoint-notebook') return { kind: 'missing' };
  return { kind: 'continue', binding: rebound };
}

async function resolveNotebookSnapshotSourcePath(bindingPath: string): Promise<string> {
  const parkedLegacyPath = `${bindingPath}.legacy`;
  if (
    bindingPath.toLowerCase().endsWith('.wpnote.json') &&
    !(await platform().fs.exists(bindingPath)) &&
    (await platform().fs.exists(parkedLegacyPath))
  ) {
    return parkedLegacyPath;
  }
  return bindingPath;
}

function assertLegacyNotebookConflictFence(
  bindingPath: string,
  existing: { raw: string | null; sourceShape: string },
  input: NotebookSnapshotInput
): void {
  if (!existing.raw || existing.sourceShape !== 'legacy-wpnote') {
    throw new Error(`Legacy notebook authority is missing: ${bindingPath}`);
  }
  if (input.expectedCanonicalFingerprint !== undefined) {
    if (contentFingerprint(existing.raw) !== input.expectedCanonicalFingerprint) {
      throw new NotebookExternalConflictError(bindingPath);
    }
    return;
  }
  if (input.expectedProjectionContent === undefined) return;
  const legacy = parseNotebookPackageDocument(existing.raw);
  if (
    canonicalNotebookJson(legacy.content) !== canonicalNotebookJson(input.expectedProjectionContent)
  ) {
    throw new NotebookExternalConflictError(bindingPath);
  }
}

async function parkMigratedLegacyNotebook(args: {
  migratedLegacyPath: string;
  packageRoot: string;
  existingRaw: string | null;
  workspaceRoot: string;
  mutationToken?: string;
}): Promise<void> {
  if (await platform().fs.exists(args.migratedLegacyPath)) {
    try {
      await claimLegacyNotebookAuthority({
        path: args.migratedLegacyPath,
        raw: args.existingRaw ?? '',
        workspaceRoot: args.workspaceRoot,
        mutationToken: args.mutationToken,
      });
      await platform().fs.rename(
        args.migratedLegacyPath,
        `${args.migratedLegacyPath}.legacy`,
        args.mutationToken
      );
    } catch (error) {
      if (error instanceof NotebookExternalConflictError) throw error;
      const detail = error instanceof Error ? `: ${error.message}` : '';
      throw new Error(
        `Could not park legacy notebook after v2 publish: ${args.migratedLegacyPath}${detail}`
      );
    }
  } else if (!(await platform().fs.exists(`${args.migratedLegacyPath}.legacy`))) {
    throw new Error(
      `Legacy notebook disappeared before it could be parked: ${args.migratedLegacyPath}`
    );
  }
  const parkedPath = `${args.migratedLegacyPath}.legacy`;
  const parkedRaw = await platform().fs.readTextFile(parkedPath);
  if (parkedRaw !== args.existingRaw || (await platform().fs.exists(args.migratedLegacyPath))) {
    if (!(await platform().fs.exists(args.migratedLegacyPath))) {
      await platform().fs.rename(parkedPath, args.migratedLegacyPath, args.mutationToken);
    }
    throw new NotebookExternalConflictError(args.migratedLegacyPath);
  }
  const rebound = await rebindCatalogFilePath({
    oldPath: args.migratedLegacyPath,
    newPath: args.packageRoot,
    workspaceRoot: args.workspaceRoot,
    actor: 'notebook-format-migration',
    mutationToken: args.mutationToken,
  });
  if (rebound.missingOldPath || rebound.updated !== 1) {
    throw new Error(
      `Could not preserve the legacy notebook catalog binding: ${args.migratedLegacyPath}`
    );
  }
}

export async function writeNotebookArtifactSnapshot(
  input: NotebookSnapshotInput
): Promise<WorkspaceArtifactResult | null> {
  const admission = await admitNotebookSnapshotBinding(input);
  if (admission.kind === 'missing') return null;
  if (admission.kind === 'done') return admission.result;
  const binding = admission.binding;

  const workspaceRoot = workspaceRootFromBinding(binding);
  if (!workspaceRoot) {
    throw new Error(`Notebook ${input.pageId} has no owning workspace and cannot be saved safely`);
  }
  let packageRoot = binding.path;
  const parkedLegacyPath = `${binding.path}.legacy`;
  const existingSourcePath = await resolveNotebookSnapshotSourcePath(binding.path);
  const existing = await readNotebookPackageRaw(existingSourcePath);
  const legacyBinding = binding.path.toLowerCase().endsWith('.wpnote.json');
  if (legacyBinding) {
    assertLegacyNotebookConflictFence(binding.path, existing, input);
  }
  let migratedLegacyPath: string | null = null;

  if (legacyBinding) {
    const parentDir = binding.path.slice(0, binding.path.lastIndexOf('/'));
    const stem = sanitizeFileStem(
      artifactStemFromFileName(binding.path.split('/').pop() ?? 'Untitled', 'notebook'),
      'Untitled'
    );
    const next = await nextAvailableNotebookPackagePath(
      parentDir,
      stem,
      stripWorkspaceScope(input.pageId)
    );
    if (
      !(await platform().fs.exists(binding.path)) &&
      !(await platform().fs.exists(parkedLegacyPath))
    ) {
      throw new Error(`Legacy notebook authority is missing: ${binding.path}`);
    }
    packageRoot = next.path;
    migratedLegacyPath = binding.path;
  }

  const document = buildNotebookPackageDocument({
    id: input.pageId,
    title: input.title,
    content: input.content ?? EMPTY_TIPTAP_DOC,
    existing: {
      ...existing.record,
      ...(input.agentProvenance
        ? {
            provenance: [
              ...(Array.isArray(existing.record.provenance) ? existing.record.provenance : []),
              {
                event: 'updated',
                source: 'agent-notebook',
                ...input.agentProvenance,
                createdAt: new Date().toISOString(),
              },
            ],
          }
        : {}),
    },
  });
  const { sizeBytes, authorityFingerprint } = await writeNotebookPackageFiles(
    packageRoot,
    document,
    workspaceRoot,
    {
      sourceShape: existing.sourceShape,
      existingMetadataRaw: existing.raw,
      formerAuthorityRaw: existing.raw,
      expectedCanonicalFingerprint:
        existing.sourceShape === 'legacy-wpnote' ? undefined : input.expectedCanonicalFingerprint,
      expectedProjectionContent:
        existing.sourceShape === 'legacy-wpnote' ? undefined : input.expectedProjectionContent,
    },
    input.mutationToken
  );
  if (migratedLegacyPath) {
    await parkMigratedLegacyNotebook({
      migratedLegacyPath,
      packageRoot,
      existingRaw: existing.raw,
      workspaceRoot,
      mutationToken: input.mutationToken,
    });
  }
  await bindCatalogEntityToFile({
    entityId: input.pageId,
    path: packageRoot,
    fileKind: 'waypoint-notebook',
    workspaceRoot,
    sizeBytes,
    modifiedAt: Date.now(),
    status: 'current',
    mutationToken: input.mutationToken,
  });

  if (input.recordEvent) {
    await recordCatalogEvent({
      entityId: input.pageId,
      eventType: 'artifact_updated',
      summary: 'Updated notebook package snapshot',
      payload: {
        filePath: packageRoot,
        artifactSchema: NOTEBOOK_PACKAGE_SCHEMA,
        packageFormat: 'vault-shaped',
      },
    });
  }

  await ensureNotebookRegisteredInLims({
    id: input.pageId,
    name: input.title,
    packagePath: packageRoot,
    workspaceId: await resolveWorkspaceId(workspaceRoot),
    mutationToken: input.mutationToken,
  });

  if (migratedLegacyPath && typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('waypoint:workspace-files-changed', {
        detail: {
          path: packageRoot,
          workspaceRoot,
        },
      })
    );
  }

  return {
    path: packageRoot,
    name: packageRoot.split('/').pop() ?? packageRoot,
    fileKind: 'waypoint-notebook',
    sizeBytes,
    authorityFingerprint,
  };
}

async function readNotebookPackageRaw(packageRootOrLegacyPath: string): Promise<{
  raw: string | null;
  record: Record<string, unknown>;
  sourceShape: NotebookMigrationSourceShape;
}> {
  const lower = packageRootOrLegacyPath.toLowerCase();
  const legacy = lower.endsWith('.wpnote.json') || lower.endsWith('.wpnote.json.legacy');
  const readPath = legacy
    ? packageRootOrLegacyPath
    : notebookPackagePaths(packageRootOrLegacyPath).metaPath;
  if (!(await platform().fs.exists(readPath))) {
    return { raw: null, record: {}, sourceShape: 'new-package' };
  }
  const raw = await platform().fs.readTextFile(readPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Notebook metadata is malformed and was not overwritten: ${readPath}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Notebook metadata is not an object and was not overwritten: ${readPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (legacy) {
    parseNotebookPackageDocument(raw);
    return { raw, record, sourceShape: 'legacy-wpnote' };
  }
  if (record.formatVersion === undefined) {
    parseNotebookPackageDocument(raw);
    return { raw, record, sourceShape: 'v1-package' };
  }
  parseNotebookPackageMetadata(raw);
  return { raw, record, sourceShape: 'v2-package' };
}

export async function writeDesignArtifactSnapshot(input: {
  designId: string;
  name: string;
  design: SequenceDesign | null;
  recordEvent?: boolean;
  mutationToken?: string;
  recovery?: { base: string | null; attempted?: string; beforeWrite: () => void };
}): Promise<WorkspaceArtifactResult | null> {
  const initialBinding = await getCurrentCatalogFileForEntity(input.designId);
  if (input.recovery && initialBinding && initialBinding.file_kind !== 'waypoint-design') {
    throw new DesignArtifactRetiredError();
  }
  if (!initialBinding || initialBinding.file_kind !== 'waypoint-design') return null;
  const workspaceRoot = workspaceRootFromBinding(initialBinding);
  if (!workspaceRoot) return null;

  return withRendererWorkspaceMutation(
    workspaceRoot,
    async (mutationToken) => {
      const binding = await getCurrentCatalogFileForEntity(input.designId);
      if (input.recovery && binding && binding.file_kind !== 'waypoint-design') {
        throw new DesignArtifactRetiredError();
      }
      if (!binding || binding.file_kind !== 'waypoint-design') return null;
      if (
        binding.path !== initialBinding.path ||
        workspaceRootFromBinding(binding) !== workspaceRoot
      ) {
        throw new Error('DESIGN_ARTIFACT_BINDING_CHANGED_DURING_SNAPSHOT');
      }

      const updatedAt = new Date().toISOString();
      const existingRaw = await platform().fs.readTextFile(binding.path);
      const parsed: unknown = JSON.parse(existingRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('DESIGN_ARTIFACT_NOT_AN_OBJECT');
      }
      const existing = parsed as Record<string, unknown>;
      const diskDesign = isDesignSnapshot(existing.design) ? existing.design : null;
      const diskRevision = designContentIdentity(diskDesign);
      const revision = designContentIdentity(input.design);
      if (
        input.recovery &&
        diskRevision !== revision &&
        diskRevision !== input.recovery.base &&
        diskRevision !== input.recovery.attempted
      ) {
        throw new DesignArtifactConflictError(diskDesign);
      }
      const document = {
        ...existing,
        schema: 'waypoint.design.v1',
        kind: 'assembly-design',
        id: input.designId,
        name: input.name,
        storage: {
          type: 'localStorage',
          key: 'waypoint-designs',
          id: input.designId,
        },
        design: input.design ?? null,
        plannedOutputs: Array.isArray(existing.plannedOutputs)
          ? existing.plannedOutputs
          : [
              {
                format: 'genbank',
                status: 'pending-sequence',
              },
            ],
        updatedAt,
      };
      const serialized = `${JSON.stringify(document, null, 2)}\n`;
      const alreadyWritten = diskRevision === revision && existing.name === input.name;
      if (!alreadyWritten) {
        input.recovery?.beforeWrite();
        await platform().fs.writeWorkspaceTextFileAtomic({
          workspaceRoot,
          path: binding.path,
          content: serialized,
          mode: 'replace',
          expectedContentHash: await sha256Text(existingRaw),
          artifactNoun: 'assembly design',
          mutationToken,
        });
      }
      const sizeBytes = byteLength(alreadyWritten ? existingRaw : serialized);
      await bindCatalogEntityToFile({
        entityId: input.designId,
        path: binding.path,
        fileKind: 'waypoint-design',
        workspaceRoot,
        sizeBytes,
        modifiedAt: Date.now(),
        status: 'current',
        mutationToken,
      });

      if (input.recordEvent) {
        await recordCatalogEvent({
          entityId: input.designId,
          eventType: 'artifact_updated',
          summary: 'Updated assembly design artifact snapshot',
          payload: {
            filePath: binding.path,
            artifactSchema: 'waypoint.design.v1',
          },
        });
      }

      return {
        path: binding.path,
        name: binding.path.split('/').pop() ?? binding.path,
        fileKind: 'waypoint-design',
        sizeBytes,
      };
    },
    input.mutationToken
  );
}

async function renameWorkspaceArtifactFile(input: {
  entityId: string;
  type: WorkspaceArtifactFileType;
  nextName: string;
  expectedPath: string;
  expectedWorkspaceRoot: string | null;
  expectedNotebookContent?: JSONContent;
  mutationToken?: string;
}): Promise<{
  path: string;
  fileName: string;
  stem: string;
  authorityFingerprint?: string;
} | null> {
  const binding = await getCurrentCatalogFileForEntity(input.entityId);
  const expectedFileKind = input.type === 'notebook' ? 'waypoint-notebook' : 'waypoint-design';
  if (!binding || binding.file_kind !== expectedFileKind) return null;
  const workspaceRoot = workspaceRootFromBinding(binding);
  if (binding.path !== input.expectedPath || workspaceRoot !== input.expectedWorkspaceRoot) {
    throw new Error('ARTIFACT_BINDING_CHANGED_DURING_RENAME');
  }

  const normalized = normalizeWorkspaceArtifactFileName({
    fileName: input.nextName,
    type: input.type,
  });
  const oldPath = binding.path;
  const parentDir = oldPath.slice(0, oldPath.lastIndexOf('/'));
  const nextPath = `${parentDir}/${normalized.fileName}`;
  if (nextPath === oldPath) {
    return {
      path: oldPath,
      fileName: oldPath.split('/').pop() ?? oldPath,
      stem: normalized.stem,
    };
  }
  if (await platform().fs.exists(nextPath)) {
    throw new Error(`Artifact file already exists: ${nextPath}`);
  }

  const renamingNotebookPackage =
    input.type === 'notebook' && (await isNotebookPackageDirectory(oldPath));
  let renameAuthorityFingerprint: string | undefined;
  if (renamingNotebookPackage) {
    if (!workspaceRoot) {
      throw new Error('A notebook package must belong to a workspace before it can be renamed');
    }
    const beforeRename = await readNotebookPackageV2(platform().fs, oldPath, undefined, {
      workspaceRoot,
      packageRoot: oldPath,
      mutationToken: input.mutationToken,
    });
    if (
      input.expectedNotebookContent !== undefined &&
      canonicalNotebookJson(beforeRename.parsed.content) !==
        canonicalNotebookJson(input.expectedNotebookContent)
    ) {
      throw new NotebookExternalConflictError(notebookPackagePaths(oldPath).markdownPath);
    }
    renameAuthorityFingerprint = contentFingerprint(beforeRename.markdown);
    await prepareNotebookPackageRename(platform().fs, {
      packageRoot: oldPath,
      nextPackageRoot: nextPath,
      title: normalized.stem,
      workspaceRoot,
      expectedCanonicalFingerprint: renameAuthorityFingerprint,
      mutationToken: input.mutationToken,
    });
  }

  await platform().workspace.relocateEntityFile({
    workspaceRoot: workspaceRoot ?? null,
    oldPath,
    newPath: nextPath,
    mutationToken: input.mutationToken,
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<WorkspaceFileRelocatedDetail>(WORKSPACE_FILE_RELOCATED_EVENT, {
        detail: { oldPath, newPath: nextPath },
      })
    );
  }

  if (renamingNotebookPackage) {
    if (!workspaceRoot) {
      throw new Error('A notebook package must belong to a workspace before recovery');
    }
    const oldPaths = notebookPackagePaths(oldPath);
    const newPaths = notebookPackagePaths(nextPath);
    const oldMdName = oldPaths.markdownPath.split('/').pop();
    const newMdName = newPaths.markdownPath.split('/').pop();
    if (oldMdName && newMdName && oldMdName !== newMdName) {
      const staleMd = `${nextPath}/${oldMdName}`;
      if (await platform().fs.exists(staleMd)) {
        await platform().fs.rename(staleMd, newPaths.markdownPath, input.mutationToken);
      }
    }
    const recovered = await recoverNotebookPackageRenameIfNeeded(platform().fs, {
      workspaceRoot,
      packageRoot: nextPath,
      mutationToken: input.mutationToken,
    });
    if (!recovered) {
      throw new Error(`Notebook rename journal disappeared before recovery: ${nextPath}`);
    }
    if (
      input.expectedNotebookContent !== undefined &&
      canonicalNotebookJson(recovered.parsed.content) !==
        canonicalNotebookJson(input.expectedNotebookContent)
    ) {
      throw new NotebookExternalConflictError(notebookPackagePaths(nextPath).markdownPath);
    }
    renameAuthorityFingerprint = recovered.canonicalFingerprint;
  }

  await writeArtifactRenamedProjectMemory({
    entityId: input.entityId,
    workspaceRoot,
    oldPath,
    newPath: nextPath,
    type: input.type,
    mutationToken: input.mutationToken,
  });

  await updateCatalogEntityName(input.entityId, normalized.stem);
  await recordCatalogEvent({
    entityId: input.entityId,
    eventType: 'artifact_renamed',
    summary: 'Renamed DNAForge artifact file',
    payload: {
      oldPath,
      newPath: nextPath,
      artifactSchema: input.type === 'notebook' ? 'waypoint.notebook.v1' : 'waypoint.design.v1',
    },
  });

  return {
    path: nextPath,
    fileName: normalized.fileName,
    stem: normalized.stem,
    authorityFingerprint: renameAuthorityFingerprint,
  };
}

export async function renameDesignArtifactFile(input: {
  designId: string;
  name: string;
}): Promise<WorkspaceArtifactResult | null> {
  const binding = await getCurrentCatalogFileForEntity(input.designId);
  if (!binding || binding.file_kind !== 'waypoint-design') return null;
  const workspaceRoot = workspaceRootFromBinding(binding);
  return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
    const renamed = await renameWorkspaceArtifactFile({
      entityId: input.designId,
      type: 'design',
      nextName: input.name,
      expectedPath: binding.path,
      expectedWorkspaceRoot: workspaceRoot,
      mutationToken,
    });
    if (!renamed) return null;

    return {
      path: renamed.path,
      name: renamed.fileName,
      fileKind: 'waypoint-design',
      sizeBytes: byteLength(await platform().fs.readTextFile(renamed.path)),
    };
  });
}

export async function renameNotebookArtifactFile(input: {
  pageId: string;
  title: string;
  content: JSONContent;
  mutationToken?: string;
}): Promise<WorkspaceArtifactResult | null> {
  const binding = await getCurrentCatalogFileForEntity(input.pageId);
  if (!binding || binding.file_kind !== 'waypoint-notebook') return null;
  const workspaceRoot = workspaceRootFromBinding(binding);
  return withRendererWorkspaceMutation(
    workspaceRoot,
    async (mutationToken) => {
      const renamed = await renameWorkspaceArtifactFile({
        entityId: input.pageId,
        type: 'notebook',
        nextName: input.title,
        expectedPath: binding.path,
        expectedWorkspaceRoot: workspaceRoot,
        expectedNotebookContent: input.content,
        mutationToken,
      });
      if (!renamed) return null;

      return writeNotebookArtifactSnapshot({
        pageId: input.pageId,
        title: renamed.stem,
        content: input.content,
        recordEvent: true,
        expectedCanonicalFingerprint: renamed.authorityFingerprint,
        expectedProjectionContent: input.content,
        mutationToken,
      });
    },
    input.mutationToken
  );
}
