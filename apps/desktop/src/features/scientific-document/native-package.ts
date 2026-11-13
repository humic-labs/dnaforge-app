import {
  bindCatalogEntityToFile,
  getCatalogEntityForFilePath,
  recordCatalogEvent,
  registerCatalogEntity,
  resolveCatalogEntityIdForWorkspace,
  updateCatalogEntityName,
} from '../../db/workspace-catalog';
import { platform } from '../../platform';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import {
  scientificPackageKindForMetaPath,
  scientificPackageMetaPath,
  type ScientificPackageKind,
} from '../../shared/scientific-package';
import {
  parseScientificDocument,
  serializeScientificDocument,
  type ScientificDocument,
  type ScientificProtocolDocument,
} from './model';

type JsonRecord = Record<string, unknown>;

export type CreateNativeProtocolInput = {
  workspaceRoot: string;
  packagePath: string;
  title: string;
  rawId?: string;
  createdAt?: string;
};

export type CreateNativeProtocolRunInput = CreateNativeProtocolInput & {
  protocol: {
    rawId: string;
    name: string;
    pinnedVersionId: string;
    pinnedVersionHash: string;
  };
};

export type CreateNativePaperProtocolInput = {
  workspaceRoot: string;
  packagePath: string;
  document: ScientificProtocolDocument;
};

export type CreatedNativeScientificPackage = {
  rawId: string;
  entityId: string;
  metaPath: string;
  document: ScientificDocument;
};

export async function saveNativeScientificPackage(input: {
  workspaceRoot: string;
  metaPath: string;
  document: ScientificDocument;
  expectedText: string;
}): Promise<string> {
  if (input.document.kind !== 'protocol' && input.document.kind !== 'protocol_run') {
    throw new Error('Native scientific package save requires a Protocol or Protocol Run.');
  }
  const kind = input.document.kind === 'protocol' ? 'protocol' : 'protocol-run';
  const expectedKind = scientificPackageKindForMetaPath(input.metaPath);
  if (expectedKind !== kind)
    throw new Error('Native scientific package path and document do not match.');
  const entity = await getCatalogEntityForFilePath(input.metaPath);
  if (!entity)
    throw new Error('Native scientific package is not registered in the project catalog.');
  const text = serializeScientificDocument(input.document);
  await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot: input.workspaceRoot,
    path: input.metaPath,
    content: text,
    mode: 'replace',
    expectedContentHash: await sha256Hex(input.expectedText),
  });
  await updateCatalogEntityName(entity.id, input.document.title);
  await bindCatalogEntityToFile({
    entityId: entity.id,
    path: input.metaPath,
    fileKind: kind === 'protocol' ? 'waypoint-protocol' : 'waypoint-protocol-run',
    workspaceRoot: input.workspaceRoot,
    contentHash: `sha256:${await sha256Hex(text)}`,
    sizeBytes: new TextEncoder().encode(text).byteLength,
    status: 'current',
  });
  await recordCatalogEvent({
    entityId: entity.id,
    eventType: 'edited',
    actor: 'user',
    summary: `Edited ${kind === 'protocol' ? 'protocol' : 'protocol run'}`,
  });
  return text;
}

export async function createNativeProtocolPackage(
  input: CreateNativeProtocolInput
): Promise<CreatedNativeScientificPackage> {
  const rawId = nativeRawId(input.rawId, 'protocol');
  const title = requiredText(input.title, 'Protocol title');
  const createdAt = isoTimestamp(input.createdAt);
  const overview = emptyTipTapDocument();
  const steps = [
    {
      id: `${rawId}-step-1`,
      sourceStepId: 'local-step-1',
      ordinal: 1,
      title: 'Step 1',
      content: emptyTipTapDocument(),
    },
  ];
  const versionBody = { title, overview, steps, inputs: [], outputs: [], links: [] };
  const document: JsonRecord = {
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: rawId,
    title,
    editable: true,
    overview,
    steps,
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: 'local-v1',
      pinnedVersionHash: `sha256:${await sha256Hex(JSON.stringify(versionBody))}`,
      immutable: true,
      importedAt: createdAt,
    },
    provenance: {
      immutableSource: false,
      provider: 'dnaforge',
      capturedAt: createdAt,
    },
  };
  return persistNativeScientificPackage(input, 'protocol', rawId, title, document);
}

export async function createNativePaperProtocolPackage(
  input: CreateNativePaperProtocolInput
): Promise<CreatedNativeScientificPackage> {
  if (!input.document.paperProtocol) {
    throw new Error('Native paper protocol creation requires paper workflow metadata.');
  }
  if (input.document.paperProtocol.draft.state !== 'draft') {
    throw new Error('A paper protocol must be created as a draft before user finalization.');
  }
  const rawId = requiredText(input.document.raw.id, 'Paper protocol ID');
  const existing = await existingPaperProtocolPackage(input, rawId);
  if (existing) return existing;
  return persistNativeScientificPackage(
    {
      workspaceRoot: input.workspaceRoot,
      packagePath: input.packagePath,
      title: input.document.title,
      rawId,
    },
    'protocol',
    rawId,
    input.document.title,
    input.document.raw
  );
}

async function existingPaperProtocolPackage(
  input: CreateNativePaperProtocolInput,
  rawId: string
): Promise<CreatedNativeScientificPackage | null> {
  const workspaceRoot = input.workspaceRoot.replace(/[/\\]+$/u, '');
  const packagePath = input.packagePath.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (!isSafeWorkspaceRelativePath(packagePath)) {
    throw new Error('Native scientific package path must be project-relative.');
  }
  const metaPath = `${workspaceRoot}/${scientificPackageMetaPath(packagePath, 'protocol')}`;
  if (!(await platform().fs.exists(metaPath))) return null;

  const existing = parseScientificDocument(metaPath, await platform().fs.readTextFile(metaPath));
  if (
    existing.kind !== 'protocol' ||
    !existing.paperProtocol ||
    existing.raw.id !== rawId ||
    stableStringify(paperCreationIntent(existing.raw)) !==
      stableStringify(paperCreationIntent(input.document.raw))
  ) {
    throw new Error('Protocol package path already exists with a different candidate intent.');
  }
  const entity = await getCatalogEntityForFilePath(metaPath);
  if (!entity) {
    throw new Error('Existing Protocol package is not registered in the project catalog.');
  }
  return { rawId, entityId: entity.id, metaPath, document: existing };
}

function paperCreationIntent(value: JsonRecord): JsonRecord {
  const cloned = JSON.parse(JSON.stringify(value)) as JsonRecord;
  const version = objectRecord(cloned.version);
  if (version) delete version.importedAt;
  const provenance = objectRecord(cloned.provenance);
  if (provenance) delete provenance.capturedAt;
  const workflow = objectRecord(cloned.paperProtocol);
  const sources = Array.isArray(workflow?.sources) ? workflow.sources : [];
  for (const source of sources) {
    const sourceRecord = objectRecord(source);
    if (sourceRecord) delete sourceRecord.capturedAt;
  }
  return cloned;
}

export async function createNativeProtocolRunPackage(
  input: CreateNativeProtocolRunInput
): Promise<CreatedNativeScientificPackage> {
  const rawId = nativeRawId(input.rawId, 'protocol-run');
  const title = requiredText(input.title, 'Protocol run title');
  const createdAt = isoTimestamp(input.createdAt);
  const document: JsonRecord = {
    schema: 'dnaforge.protocol-run.v1',
    kind: 'protocol_run',
    id: rawId,
    title,
    status: 'in_progress',
    immutable: false,
    protocol: {
      sourceId: requiredText(input.protocol.rawId, 'Protocol ID'),
      destinationId: requiredText(input.protocol.rawId, 'Protocol destination ID'),
      name: requiredText(input.protocol.name, 'Protocol name'),
      pinnedVersionId: requiredText(input.protocol.pinnedVersionId, 'Protocol version ID'),
      pinnedVersionHash: requiredSha256(input.protocol.pinnedVersionHash),
    },
    inputs: [],
    outputs: [],
    measurements: [],
    tables: [],
    links: [],
    startedAt: createdAt,
    completedAt: null,
    amendments: [],
    provenance: {
      immutableSource: false,
      provider: 'dnaforge',
      capturedAt: createdAt,
    },
  };
  return persistNativeScientificPackage(input, 'protocol-run', rawId, title, document);
}

async function persistNativeScientificPackage(
  input: CreateNativeProtocolInput,
  kind: ScientificPackageKind,
  rawId: string,
  title: string,
  rawDocument: JsonRecord
): Promise<CreatedNativeScientificPackage> {
  const workspaceRoot = input.workspaceRoot.replace(/[/\\]+$/u, '');
  const packagePath = input.packagePath.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (!isSafeWorkspaceRelativePath(packagePath)) {
    throw new Error('Native scientific package path must be project-relative.');
  }
  const relativeMetaPath = scientificPackageMetaPath(packagePath, kind);
  const metaPath = `${workspaceRoot}/${relativeMetaPath}`;
  await platform().fs.mkdir(`${workspaceRoot}/${packagePath}/.forge`, { recursive: true });
  const text = `${JSON.stringify(rawDocument, null, 2)}\n`;
  const document = parseScientificDocument(metaPath, text);
  await platform().fs.writeWorkspaceTextFileAtomic({
    workspaceRoot,
    path: metaPath,
    content: text,
    mode: 'create',
  });

  const entityId = await resolveCatalogEntityIdForWorkspace(workspaceRoot, rawId);
  await registerCatalogEntity({
    id: entityId,
    type: kind === 'protocol' ? 'protocol' : 'protocol_run',
    name: title,
    locator: `file://${metaPath}`,
    storageType: 'file',
    workspaceRoot,
    metadata: { portableId: rawId, nativePackage: kind, relativePath: relativeMetaPath },
  });
  await bindCatalogEntityToFile({
    entityId,
    path: metaPath,
    fileKind: kind === 'protocol' ? 'waypoint-protocol' : 'waypoint-protocol-run',
    workspaceRoot,
    status: 'current',
  });
  await recordCatalogEvent({
    entityId,
    eventType: 'created',
    actor: 'user',
    summary: `Created ${kind === 'protocol' ? 'protocol' : 'protocol run'}`,
  });
  return { rawId, entityId, metaPath, document };
}

function nativeRawId(value: string | undefined, prefix: ScientificPackageKind): string {
  if (value !== undefined) return requiredText(value, 'Native scientific object ID');
  return `${prefix}-${crypto.randomUUID()}`;
}

function emptyTipTapDocument(): JsonRecord {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function isoTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Creation time must be ISO-8601.');
  return new Date(timestamp).toISOString();
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || containsControlCharacter(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function requiredSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error('Protocol version hash must be SHA-256.');
  }
  return normalized;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function objectRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as JsonRecord;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  const primitive = JSON.stringify(value);
  if (primitive === undefined) throw new Error('Paper protocol intent contains unsupported data.');
  return primitive;
}
