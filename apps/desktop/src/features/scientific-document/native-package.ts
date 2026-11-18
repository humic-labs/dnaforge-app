import {
  getCatalogEntityForFilePath,
  resolveCatalogEntityIdForWorkspace,
  resolveWorkspaceScope,
} from '../../db/workspace-catalog';
import type { NativeProtocolPackageSnapshot } from '../../shared/protocol-packages';
import { ProtocolOperationSession, type ProtocolOperation } from './protocol-operation-session';
import { platform } from '../../platform';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';
import { type ScientificPackageKind } from '../../shared/scientific-package';
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

async function projectScope(root: string): Promise<string> {
  const scope = await resolveWorkspaceScope(root);
  if (!scope) throw new Error('The owning project identity is unavailable.');
  return scope;
}
export async function readNativeScientificPackage(input: {
  workspaceRoot: string;
  metaPath: string;
}): Promise<NativeProtocolPackageSnapshot> {
  const project = await projectScope(input.workspaceRoot),
    entity = await getCatalogEntityForFilePath(input.metaPath);
  if (!entity) throw new Error('The scientific package is not registered in this project.');
  return platform().protocols.readPackage({ project, entityId: entity.id });
}
function operationSession(key: string) {
  return new ProtocolOperationSession(
    platform().protocols,
    typeof localStorage === 'undefined' ? null : localStorage,
    `dnaforge.protocol.compat.v1:${key}`
  );
}
async function completed(
  session: ProtocolOperationSession,
  operation: ProtocolOperation
): Promise<NativeProtocolPackageSnapshot> {
  const state = session.getSnapshot();
  if ('attempt' in state && state.attempt.request.requestId !== operation.request.requestId)
    throw new Error('Confirm the previous scientific operation before changing its intent.');
  const result = state.phase === 'editing' ? await session.begin(operation) : await session.retry();
  if (result?.kind !== 'ready')
    throw new Error(
      result && result.kind !== 'missing'
        ? result.message
        : 'The scientific operation needs confirmation. Retry the same operation.'
    );
  return result.package;
}
export async function saveNativeScientificPackage(input: {
  workspaceRoot: string;
  metaPath: string;
  document: ScientificDocument;
  expectedText: string;
}): Promise<string> {
  if (input.document.kind !== 'protocol' && input.document.kind !== 'protocol_run')
    throw new Error('Native scientific package save requires a Protocol or Protocol Run.');
  const project = await projectScope(input.workspaceRoot),
    text = serializeScientificDocument(input.document),
    requestId = `save:${await sha256Hex(JSON.stringify([input.expectedText, text]))}`,
    session = operationSession(JSON.stringify([project, input.metaPath, 'save'])),
    pending = session.getSnapshot();
  if ('attempt' in pending) {
    if (pending.attempt.request.requestId !== requestId)
      throw new Error('Confirm the previous save before changing this scientific document.');
    const result = await session.retry();
    if (result?.kind !== 'ready')
      throw new Error(
        result && result.kind !== 'missing'
          ? result.message
          : 'The original save needs confirmation.'
      );
    return result.package.originalText;
  }
  const saved = await readNativeScientificPackage(input);
  if (saved.originalText !== input.expectedText)
    throw new Error('The saved scientific source changed. Reload before saving.');
  return (
    await completed(session, {
      kind: 'save',
      request: {
        project,
        entityId: saved.entityId,
        requestId,
        expectedSourceSha256: saved.sourceSha256,
        originalText: text,
      },
    })
  ).originalText;
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
  const project = await projectScope(input.workspaceRoot),
    protocolId = await resolveCatalogEntityIdForWorkspace(
      input.workspaceRoot,
      input.protocol.rawId
    ),
    protocol = await platform().protocols.readSavedProtocol({ project, entityId: protocolId }),
    rawId = nativeRawId(input.rawId, 'protocol-run'),
    parent = input.packagePath.replace(/\\/gu, '/').split('/').slice(0, -1).join('/'),
    snapshot = await completed(operationSession(JSON.stringify([project, rawId, 'start'])), {
      kind: 'start',
      request: {
        project,
        requestId: `start:${rawId}`,
        protocolId: protocol.entityId,
        expectedSourceSha256: protocol.sourceSha256,
        title: requiredText(input.title, 'Run title'),
        ...(parent ? { parentPath: `${input.workspaceRoot}/${parent}` } : {}),
      },
    });
  const current = await platform().protocols.readPackage({ project, entityId: snapshot.entityId });
  return {
    rawId: snapshot.portableId,
    entityId: snapshot.entityId,
    metaPath: current.path,
    document: parseScientificDocument(current.path, current.originalText),
  };
}

async function persistNativeScientificPackage(
  input: CreateNativeProtocolInput,
  kind: ScientificPackageKind,
  rawId: string,
  title: string,
  rawDocument: JsonRecord
): Promise<CreatedNativeScientificPackage> {
  if (kind !== 'protocol') throw new Error('Run creation requires the native Start run owner.');
  if (!isSafeWorkspaceRelativePath(input.packagePath))
    throw new Error('Native scientific package path must be project-relative.');
  const project = await projectScope(input.workspaceRoot),
    parent = input.packagePath.replace(/\\/gu, '/').split('/').slice(0, -1).join('/'),
    initialProtocolText = `${JSON.stringify(rawDocument, null, 2)}\n`,
    intent = paperCreationIntent(rawDocument),
    requestId = `protocol:${rawId}:${await sha256Hex(stableStringify(intent))}`,
    snapshot = await completed(operationSession(JSON.stringify([project, rawId, 'create'])), {
      kind: 'create',
      request: {
        project,
        requestId,
        title,
        initialProtocolText,
        ...(parent ? { parentPath: `${input.workspaceRoot}/${parent}` } : {}),
      },
    });
  const current = await platform().protocols.readPackage({ project, entityId: snapshot.entityId });
  return {
    rawId: snapshot.portableId,
    entityId: snapshot.entityId,
    metaPath: current.path,
    document: parseScientificDocument(current.path, current.originalText),
  };
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
