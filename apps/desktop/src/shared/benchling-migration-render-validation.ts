import type { ProjectionKind } from './benchling-migration';
import { LIMS_ENTITY_KINDS, type LimsRegisterEntityInput } from './lims';
import { isPortableEntitySchemaRevisionSnapshot } from './entity-schema';

export const BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION = 1 as const;
export const BENCHLING_MIGRATION_RENDER_VALIDATION_REQUEST_CHANNEL =
  'benchling-migration:render-validation-request';
export const BENCHLING_MIGRATION_RENDER_VALIDATION_READY_CHANNEL =
  'benchling-migration:render-validation-ready';
export const BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS = 256;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MigrationRenderSurface =
  | 'sequence'
  | 'notebook'
  | 'protein'
  | 'scientific_document'
  | 'artifact'
  | 'html'
  | 'text'
  | 'lims_registry';

type MigrationRenderValidationItemBody = {
  sourceObjectId: string;
  destinationObjectId: string;
  projection: ProjectionKind;
  converterId: string;
  surface: MigrationRenderSurface;
};

export type MigrationRenderValidationItem = MigrationRenderValidationItemBody &
  (
    | { destinationPath: string; catalogRecord?: never }
    | {
        destinationPath?: never;
        surface: 'lims_registry';
        catalogRecord: Pick<LimsRegisterEntityInput, 'kind' | 'name' | 'fields' | 'schemaSnapshot'>;
      }
  );

export type MigrationRenderValidationRequest = {
  version: typeof BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION;
  requestId: string;
  runId: string;
  workspaceId: string;
  workspaceRoot: string;
  items: MigrationRenderValidationItem[];
};

export type MigrationRenderValidationCheck = {
  sourceObjectId: string;
  surface: MigrationRenderSurface;
  passed: boolean;
  message?: string;
};

export type MigrationRenderValidationResponse = {
  version: typeof BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION;
  requestId: string;
  runId: string;
  checks: MigrationRenderValidationCheck[];
};

export type BenchlingMigrationRenderValidationResponseChannel =
  `benchling-migration:render-validation-response:${string}`;

export function migrationRenderValidationResponseChannel(
  requestId: string
): BenchlingMigrationRenderValidationResponseChannel {
  if (!UUID_PATTERN.test(requestId)) {
    throw new Error('Migration render-validation request ID must be a UUID.');
  }
  return `benchling-migration:render-validation-response:${requestId}`;
}

export function parseMigrationRenderValidationRequest(
  value: unknown
): MigrationRenderValidationRequest {
  const request = record(value, 'Migration render-validation request must be an object.');
  if (request.version !== BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION) {
    throw new Error('Unsupported migration render-validation request version.');
  }
  const requestId = uuid(request.requestId, 'request ID');
  const runId = safeId(request.runId, 'run ID');
  const workspaceId = safeId(request.workspaceId, 'workspace ID');
  const workspaceRoot = boundedText(request.workspaceRoot, 'workspace root', 4_096);
  if (!Array.isArray(request.items)) {
    throw new Error('Migration render-validation items must be an array.');
  }
  if (request.items.length > BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS) {
    throw new Error(
      `Migration render-validation request exceeds ${BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS} items.`
    );
  }
  const items = request.items.map(parseItem);
  assertUnique(
    items.map((item) => item.sourceObjectId),
    'source object ID'
  );
  return {
    version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
    requestId,
    runId,
    workspaceId,
    workspaceRoot,
    items,
  };
}

export function parseMigrationRenderValidationResponse(
  value: unknown
): MigrationRenderValidationResponse {
  const response = record(value, 'Migration render-validation response must be an object.');
  if (response.version !== BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION) {
    throw new Error('Unsupported migration render-validation response version.');
  }
  const requestId = uuid(response.requestId, 'request ID');
  const runId = safeId(response.runId, 'run ID');
  if (!Array.isArray(response.checks)) {
    throw new Error('Migration render-validation checks must be an array.');
  }
  if (response.checks.length > BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS) {
    throw new Error(
      `Migration render-validation response exceeds ${BENCHLING_MIGRATION_RENDER_VALIDATION_MAX_ITEMS} checks.`
    );
  }
  const checks = response.checks.map((value, index) => {
    const check = record(
      value,
      `Migration render-validation check ${index + 1} must be an object.`
    );
    const parsed: MigrationRenderValidationCheck = {
      sourceObjectId: safeId(check.sourceObjectId, `check ${index + 1} source object ID`),
      surface: renderSurface(check.surface, `check ${index + 1} surface`),
      passed: booleanValue(check.passed, `check ${index + 1} passed`),
    };
    if (check.message !== undefined) {
      parsed.message = boundedText(check.message, `check ${index + 1} message`, 2_048);
    }
    return parsed;
  });
  assertUnique(
    checks.map((check) => check.sourceObjectId),
    'check source object ID'
  );
  return {
    version: BENCHLING_MIGRATION_RENDER_VALIDATION_VERSION,
    requestId,
    runId,
    checks,
  };
}

export function isSafeMigrationDestinationPath(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || value.trim() !== value) return false;
  if (value.includes('\0')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  const portable = decoded.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[a-z]:/i.test(portable)) return false;
  return portable
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':')
    );
}

function parseItem(value: unknown, index: number): MigrationRenderValidationItem {
  const item = record(value, `Migration render-validation item ${index + 1} must be an object.`);
  if (!isProjectionKind(item.projection)) {
    throw new Error(`Migration render-validation item ${index + 1} has an invalid projection.`);
  }
  const common: MigrationRenderValidationItemBody = {
    sourceObjectId: safeId(item.sourceObjectId, `item ${index + 1} source object ID`),
    destinationObjectId: safeId(
      item.destinationObjectId,
      `item ${index + 1} destination object ID`
    ),
    projection: item.projection,
    converterId: safeId(item.converterId, `item ${index + 1} converter ID`),
    surface: renderSurface(item.surface, `item ${index + 1} surface`),
  };
  if (item.catalogRecord !== undefined) {
    if (item.destinationPath !== undefined || common.surface !== 'lims_registry') {
      throw new Error('Catalog render targets must use only the native registry surface.');
    }
    const entity = record(item.catalogRecord, 'Catalog render target must be an object.');
    const kind = boundedText(entity.kind, 'catalog record kind', 256);
    const schema = entity.schemaSnapshot;
    if (
      schema !== undefined &&
      (!isPortableEntitySchemaRevisionSnapshot(schema) ||
        schema.name !== kind ||
        typeof schema.version !== 'number' ||
        !Number.isSafeInteger(schema.version) ||
        schema.version < 1)
    )
      throw new Error('Catalog render target has an invalid schema snapshot.');
    if (!LIMS_ENTITY_KINDS.some((builtin) => builtin === kind) && schema === undefined)
      throw new Error('Catalog render target has an unsupported entity kind.');
    return {
      ...common,
      surface: 'lims_registry',
      catalogRecord: {
        kind,
        name: boundedText(entity.name, 'catalog record name', 4_096),
        fields: record(entity.fields, 'Catalog render target fields must be an object.'),
        ...(isPortableEntitySchemaRevisionSnapshot(schema) && typeof schema.version === 'number'
          ? { schemaSnapshot: { ...schema, version: schema.version } }
          : {}),
      },
    };
  }
  const destinationPath = boundedText(
    item.destinationPath,
    `item ${index + 1} destination path`,
    4_096
  );
  if (!isSafeMigrationDestinationPath(destinationPath)) {
    throw new Error(`Migration render-validation item ${index + 1} has an unsafe path.`);
  }
  return { ...common, destinationPath };
}

function isProjectionKind(value: unknown): value is ProjectionKind {
  return (
    value === 'native' ||
    value === 'portable_file' ||
    value === 'adapter_staging' ||
    value === 'fallback' ||
    value === 'artifact'
  );
}

function renderSurface(value: unknown, label: string): MigrationRenderSurface {
  if (
    value === 'sequence' ||
    value === 'notebook' ||
    value === 'scientific_document' ||
    value === 'protein' ||
    value === 'artifact' ||
    value === 'html' ||
    value === 'text' ||
    value === 'lims_registry'
  ) {
    return value;
  }
  throw new Error(`Migration render-validation ${label} is unsupported.`);
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
  const parsed = boundedText(value, label, 64);
  if (!UUID_PATTERN.test(parsed)) {
    throw new Error(`Migration render-validation ${label} must be a UUID.`);
  }
  return parsed;
}

function safeId(value: unknown, label: string): string {
  const parsed = boundedText(value, label, 512);
  if (hasControlCharacter(parsed)) {
    throw new Error(`Migration render-validation ${label} contains unsupported characters.`);
  }
  return parsed;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new Error(`Migration render-validation ${label} is invalid.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Migration render-validation ${label} must be boolean.`);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Migration render-validation ${label}s must be unique.`);
  }
}
