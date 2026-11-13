import { getSchema } from '@tiptap/core';
import { parseWorkspaceArtifact } from '../../db/workspace-artifacts';
import { notebookPackageRootForMetaPath } from '../../db/notebook-package';
import { readCanonicalNotebookPackage } from '../../db/notebook-package-migration';
import { parseFastaAminoAcidSequence } from '../../shared/amino-acid-sequence';
import { resolveLimsEntityOpenTargetFromEntity } from '../lims/public/open-target';
import { parseScientificDocument } from '../scientific-document/public/model';
import {
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from '../sequence/public/parse-sequence-file';
import { getBaseExtensions, MentionExtension, EmbedNode } from '../page/public/editor/extensions';
import { platform, type PlatformBridge } from '../../platform';
import {
  BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
  isSafeMigrationDestinationPath,
  parseMigrationRenderValidationRequest,
  type MigrationRenderSurface,
  type MigrationRenderValidationItem,
  type MigrationRenderValidationRequest,
  type MigrationRenderValidationResponse,
} from '../../shared/benchling-migration-render-validation';
import {
  validateLimsEntityFields,
  classifyLimsEntityFieldIssues,
  isLimsFieldType,
  type LimsEntity,
  type LimsFieldDefinition,
  type LimsRegisterEntityInput,
} from '../../shared/lims';
import { getTabTypeForFile } from '../../utils/fileTypes';

type RendererValidationDeps = {
  fs: Pick<PlatformBridge['fs'], 'readFile' | 'readTextFile'>;
  renderSandboxedHtml?: (html: string) => Promise<void>;
};

const RENDER_VALIDATION_CONCURRENCY = 16;
let notebookSchema: ReturnType<typeof getSchema> | null = null;

export function installMigrationRenderValidationProbe(): () => void {
  const bridge = platform().benchlingMigration;
  const activeRequests = new Set<string>();
  return bridge.onRenderValidationRequest((payload) => {
    let request: MigrationRenderValidationRequest;
    try {
      request = parseMigrationRenderValidationRequest(payload);
    } catch {
      return;
    }
    if (activeRequests.has(request.requestId)) return;
    activeRequests.add(request.requestId);
    void (async () => {
      let response: MigrationRenderValidationResponse;
      try {
        response = await validateMigrationRenderRequest(request, { fs: platform().fs });
      } catch (error) {
        response = failedResponse(request, error);
      }
      await bridge.respondRenderValidation(request.requestId, response);
    })()
      .catch((error: unknown) => {
        console.error('[BenchlingMigration] renderer validation response failed', error);
      })
      .finally(() => activeRequests.delete(request.requestId));
  });
}

export async function validateMigrationRenderRequest(
  input: MigrationRenderValidationRequest,
  deps: RendererValidationDeps
): Promise<MigrationRenderValidationResponse> {
  const request = parseMigrationRenderValidationRequest(input);
  const checks: MigrationRenderValidationResponse['checks'] = new Array(request.items.length);
  let nextIndex = 0;
  const validateNext = async (): Promise<void> => {
    while (nextIndex < request.items.length) {
      const index = nextIndex++;
      const item = request.items[index];
      try {
        await validateOne(request, item, deps);
        checks[index] = {
          sourceObjectId: item.sourceObjectId,
          surface: item.surface,
          passed: true,
        };
      } catch (error) {
        checks[index] = {
          sourceObjectId: item.sourceObjectId,
          surface: item.surface,
          passed: false,
          message: error instanceof Error ? error.message : 'Destination could not be rendered.',
        };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(RENDER_VALIDATION_CONCURRENCY, request.items.length) },
      validateNext
    )
  );
  return {
    version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
    requestId: request.requestId,
    runId: request.runId,
    checks,
  };
}

async function validateOne(
  request: MigrationRenderValidationRequest,
  item: MigrationRenderValidationItem,
  deps: RendererValidationDeps
): Promise<void> {
  if (item.catalogRecord) {
    validateNativeCatalogRecord(item);
    return;
  }
  if (!isSafeMigrationDestinationPath(item.destinationPath)) {
    throw new Error('Projection path is unsafe.');
  }
  const path = joinWorkspacePath(request.workspaceRoot, item.destinationPath);

  switch (item.surface) {
    case 'sequence':
      assertProductRoute(path, 'sequence');
      await validateSequence(path, deps);
      return;
    case 'notebook':
      assertProductRoute(path, 'page');
      await validateNotebook(path, deps);
      return;
    case 'protein':
      assertProductRoute(path, 'protein');
      await validateProtein(path, deps);
      return;
    case 'scientific_document':
      assertProductRoute(path, 'scientific-document');
      await validateScientificDocument(path, deps);
      return;
    case 'artifact':
      assertProductRoute(path, 'text');
      await validateArtifact(path, item, deps);
      return;
    case 'html':
      assertProductRoute(path, 'html');
      await validateHtml(path, deps);
      return;
    case 'text':
      assertProductRoute(path, 'text');
      await validateText(path, deps);
      return;
    case 'lims_registry':
      await validateStagedLimsRecord(request, item, path, deps);
      return;
  }
}

function validateNativeCatalogRecord(
  item: Extract<MigrationRenderValidationItem, { catalogRecord: object }>
): void {
  const record = item.catalogRecord;
  const fields: LimsFieldDefinition[] = (record.schemaSnapshot?.fields ?? []).map((field) => {
    if (!isLimsFieldType(field.type))
      throw new Error(`Unsupported catalog field type: ${field.type}`);
    return {
      ...field,
      type: field.type,
      ...(field.enumOptions ? { enumOptions: [...field.enumOptions] } : {}),
    };
  });
  const errors = classifyLimsEntityFieldIssues(record.kind, record.fields, fields).malformed;
  if (errors.length) throw new Error(`Native catalog fields are invalid: ${errors.join('; ')}`);
  const target = resolveLimsEntityOpenTargetFromEntity({
    id: item.destinationObjectId,
    ...record,
    schemaId: null,
    schemaRevisionId: '',
    registryId: null,
    registrationStatus: 'unresolved',
    domainStatus: null,
    workspaceId: null,
    actor: null,
    eventSeq: null,
    tombstone: false,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  });
  if (target.kind !== 'record_detail' || target.entityId !== item.destinationObjectId) {
    throw new Error('The native catalog target does not open in the record-detail surface.');
  }
}

async function validateProtein(path: string, deps: RendererValidationDeps): Promise<void> {
  const sequence = parseFastaAminoAcidSequence(await deps.fs.readTextFile(path));
  if (!sequence)
    throw new Error('The protein viewer parser returned an empty amino-acid sequence.');
}

async function validateSequence(path: string, deps: RendererValidationDeps): Promise<void> {
  const lower = path.toLowerCase();
  const parsed =
    lower.endsWith('.dna') || lower.endsWith('.ab1') || lower.endsWith('.abi')
      ? parseBinarySequenceFileAsAnnotated(await deps.fs.readFile(path), path)
      : parseTextSequenceFileAsAnnotated(await deps.fs.readTextFile(path), path);
  if (parsed.sequence.length <= 0 || parsed.sequence.sequence.length !== parsed.sequence.length) {
    throw new Error('The sequence editor parser returned empty or inconsistent sequence content.');
  }
}

async function validateNotebook(path: string, deps: RendererValidationDeps): Promise<void> {
  const raw = await deps.fs.readTextFile(path);
  const artifact = parseWorkspaceArtifact(raw);
  if (artifact.kind !== 'notebook' || artifact.schema !== 'waypoint.notebook.v1') {
    throw new Error('The page route did not resolve a native notebook artifact.');
  }
  let content = artifact.content;
  const metadata = jsonRecord(raw, 'Notebook metadata is invalid.');
  if (metadata.formatVersion === 2) {
    const packageRoot = notebookPackageRootForMetaPath(path);
    if (!packageRoot) throw new Error('Native notebook metadata is outside a package.');
    const canonical = await readCanonicalNotebookPackage(
      {
        exists: async () => true,
        readTextFile: (path) => deps.fs.readTextFile(path),
      },
      packageRoot,
      raw
    );
    content = canonical.parsed.content;
  }
  notebookSchema ??= getSchema([...getBaseExtensions(), MentionExtension, EmbedNode] as never);
  const schema = notebookSchema;
  const documentNode = schema.nodeFromJSON(content);
  if (documentNode.type.name !== 'doc') {
    throw new Error('The page editor did not produce a document root.');
  }
}

async function validateScientificDocument(
  path: string,
  deps: RendererValidationDeps
): Promise<void> {
  const document = parseScientificDocument(path, await deps.fs.readTextFile(path));
  if (!document.title.trim()) {
    throw new Error('The scientific document editor parsed an empty title.');
  }
}

async function validateArtifact(
  path: string,
  item: MigrationRenderValidationItem,
  deps: RendererValidationDeps
): Promise<void> {
  const text = await deps.fs.readTextFile(path);
  if (!text.trim()) throw new Error('The artifact text surface parsed empty content.');
  if (
    (item.projection !== 'artifact' && item.projection !== 'fallback') ||
    !text.includes('Native conversion exception')
  ) {
    throw new Error('Artifact fallback is missing its Native conversion exception badge.');
  }
}

async function validateHtml(path: string, deps: RendererValidationDeps): Promise<void> {
  const html = await deps.fs.readTextFile(path);
  if (!html.trim()) throw new Error('The HTML viewer parsed empty content.');
  await (deps.renderSandboxedHtml ?? renderSandboxedHtml)(html);
}

async function validateText(path: string, deps: RendererValidationDeps): Promise<void> {
  if (!(await deps.fs.readTextFile(path)).trim()) {
    throw new Error('The text editor parsed empty content.');
  }
}

async function validateStagedLimsRecord(
  request: MigrationRenderValidationRequest,
  item: MigrationRenderValidationItem,
  path: string,
  deps: RendererValidationDeps
): Promise<void> {
  const document = jsonRecord(await deps.fs.readTextFile(path), 'Registry projection is not JSON.');
  if (
    document.kind !== 'waypoint.benchling-registry-projection' ||
    document.converterId !== 'benchling-registry-v1' ||
    (document.version !== 1 && document.version !== 2)
  ) {
    throw new Error('The staged LIMS registry projection has an unsupported contract.');
  }
  if (document.version === 2 && document.destinationWorkspaceId !== request.workspaceId) {
    throw new Error('The staged LIMS record belongs to another destination project.');
  }
  if (!Array.isArray(document.records) || !Array.isArray(document.schemas)) {
    throw new Error('The staged LIMS projection is missing records or schemas.');
  }
  const matches = document.records
    .map((value) => record(value, 'Staged LIMS record must be an object.'))
    .filter(
      (record) =>
        record.sourceObjectId === item.sourceObjectId &&
        record.destinationEntityId === item.destinationObjectId
    );
  if (matches.length !== 1) {
    throw new Error(
      `The staged LIMS projection contains ${matches.length} matching records; exactly one is required.`
    );
  }
  const projectedRecord = matches[0];
  const schemaMatches = document.schemas
    .map((value) => record(value, 'Staged LIMS schema must be an object.'))
    .filter((schema) => schema.sourceRevisionId === projectedRecord.sourceSchemaRevisionId);
  if (schemaMatches.length !== 1) {
    throw new Error('The staged LIMS record does not resolve to exactly one schema revision.');
  }
  const schemaMaterialization = record(
    schemaMatches[0].materialization,
    'Staged LIMS schema is missing materialization.'
  );
  const defineSchema = record(
    schemaMaterialization.defineSchema,
    'Staged LIMS schema is missing its native definition.'
  );
  if (!Array.isArray(defineSchema.fields)) {
    throw new Error('Staged LIMS schema fields must be an array.');
  }
  const materialization = record(
    projectedRecord.materialization,
    'Staged LIMS record is missing materialization.'
  );
  const registerEntity = record(
    materialization.registerEntity,
    'Staged LIMS record is missing its native registration input.'
  ) as unknown as LimsRegisterEntityInput;
  if (
    typeof registerEntity.kind !== 'string' ||
    typeof registerEntity.name !== 'string' ||
    !registerEntity.name.trim() ||
    !registerEntity.fields ||
    typeof registerEntity.fields !== 'object' ||
    Array.isArray(registerEntity.fields)
  ) {
    throw new Error('Staged LIMS native registration input is incomplete.');
  }
  const fieldErrors = validateLimsEntityFields(
    registerEntity.kind,
    registerEntity.fields,
    defineSchema.fields as LimsFieldDefinition[]
  );
  if (fieldErrors.length > 0) {
    throw new Error(`Staged LIMS fields are invalid: ${fieldErrors.join('; ')}`);
  }

  const entity: LimsEntity = {
    id: item.destinationObjectId,
    kind: registerEntity.kind,
    schemaId:
      typeof defineSchema.id === 'string'
        ? defineSchema.id
        : typeof schemaMatches[0].destinationSchemaId === 'string'
          ? schemaMatches[0].destinationSchemaId
          : null,
    schemaRevisionId:
      typeof registerEntity.schemaRevisionId === 'string'
        ? registerEntity.schemaRevisionId
        : String(schemaMatches[0].destinationSchemaRevisionId ?? ''),
    name: registerEntity.name,
    registryId:
      typeof projectedRecord.desiredRegistryId === 'string'
        ? projectedRecord.desiredRegistryId
        : null,
    fields: registerEntity.fields,
    registrationStatus: registerEntity.registrationStatus ?? 'registered',
    domainStatus: registerEntity.domainStatus ?? null,
    workspaceId: null,
    actor: null,
    eventSeq: null,
    tombstone: false,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
  const target = resolveLimsEntityOpenTargetFromEntity(entity);
  if (target.kind === 'missing_entity' || target.entityId !== item.destinationObjectId) {
    throw new Error('The LIMS open-target resolver rejected the staged native record.');
  }
}

function assertProductRoute(path: string, expected: ReturnType<typeof getTabTypeForFile>): void {
  const actual = getTabTypeForFile(path);
  if (actual !== expected) {
    throw new Error(`Product routing selected ${actual}, not ${expected}.`);
  }
}

function joinWorkspacePath(workspaceRoot: string, destinationPath: string): string {
  const separator = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/';
  const root = workspaceRoot.replace(/[/\\]+$/, '');
  return `${root}${separator}${destinationPath.replace(/\//g, separator)}`;
}

async function renderSandboxedHtml(html: string): Promise<void> {
  if (!globalThis.document?.body) throw new Error('The HTML renderer is unavailable.');
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.left = '-10000px';
  iframe.srcdoc = html;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = globalThis.setTimeout(
        () => rejectPromise(new Error('The sandboxed HTML viewer timed out.')),
        2_000
      );
      iframe.addEventListener(
        'load',
        () => {
          globalThis.clearTimeout(timer);
          resolvePromise();
        },
        { once: true }
      );
      iframe.addEventListener(
        'error',
        () => {
          globalThis.clearTimeout(timer);
          rejectPromise(new Error('The sandboxed HTML viewer failed to load.'));
        },
        { once: true }
      );
      document.body.append(iframe);
    });
  } finally {
    iframe.remove();
  }
}

function jsonRecord(text: string, message: string): Record<string, unknown> {
  try {
    return record(JSON.parse(text), message);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(message);
    throw error;
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function failedResponse(
  request: MigrationRenderValidationRequest,
  error: unknown
): MigrationRenderValidationResponse {
  const message = error instanceof Error ? error.message : 'Renderer validation failed.';
  return {
    version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
    requestId: request.requestId,
    runId: request.runId,
    checks: request.items.map((item) => ({
      sourceObjectId: item.sourceObjectId,
      surface: item.surface,
      passed: false,
      message,
    })),
  };
}

const _allRenderSurfaces: Record<MigrationRenderSurface, true> = {
  sequence: true,
  notebook: true,
  protein: true,
  scientific_document: true,
  artifact: true,
  html: true,
  text: true,
  lims_registry: true,
};
void _allRenderSurfaces;
