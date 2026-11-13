import { computeChecksum } from '@waypoint/sequence-utils';
import {
  findConstructIdForAcceptedAssemblyVersion,
  getCatalogEntityByLocator,
  getCatalogEventsForEntity,
  getCurrentCatalogFileForEntity,
  type DBCatalogEntityEvent,
} from '../../db/workspace-catalog';
import {
  SEQUENCE_PACKAGE_SCHEMA,
  isSequencePackageFileKind,
  isSequencePackageMetaPath,
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
  sequencePackagePaths,
} from '../../db/sequence-package';
import { platform } from '../../platform';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useDesignStore } from '../design/public/store';
import type {
  AcceptedAssemblyCanonicalDraftInput,
  AcceptedAssemblySidecarPayload,
} from './accepted-types';
import { computeAcceptedDraftChecksum } from './accepted-canonical';
import {
  acceptedAssemblyVersionFromSidecar,
  parseAcceptedAssemblyPayload,
} from './accepted-reopen';

export interface AcceptedRecordSelector {
  constructId?: string;
  acceptedAssemblyVersionId?: string;
  locator?: string;
}

export interface ResolvedAcceptedAssemblyRecord {
  constructId: string;
  packageId: string;
  packageRoot: string;
  productPath: string;
  metaPath: string;
  acceptedAssemblyVersionId: string;
  accepted: AcceptedAssemblySidecarPayload;
  acceptedRecords: AcceptedAssemblySidecarPayload[];
  recordIsCurrent: boolean;
  integrity: {
    productGenBank: 'verified' | 'drifted' | 'unavailable' | 'historical';
    expectedChecksum: string | null;
    actualChecksum: string | null;
  };
  catalogEvents: Array<{
    id: string;
    eventType: string;
    actor: string;
    summary: string | null;
    payload: Record<string, unknown> | null;
    createdAt: number;
  }>;
}

export interface AcceptedRecordReaderDeps {
  getCurrentBinding(entityId: string): Promise<{ path: string; file_kind: string } | null>;
  getEntityByLocator(locator: string): Promise<{ id: string } | null>;
  getEvents(entityId: string): Promise<DBCatalogEntityEvent[]>;
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  findMetaPathForAcceptedVersion(acceptedAssemblyVersionId: string): string | null;
  findConstructIdForAcceptedVersion(acceptedAssemblyVersionId: string): Promise<string | null>;
  workspaceRoots(): readonly string[];
  validateWorkspacePath(input: {
    workspaceRoot: string;
    path: string;
    allowMissing?: boolean;
    artifactNoun?: string;
  }): Promise<boolean>;
}

const DEFAULT_DEPS: AcceptedRecordReaderDeps = {
  getCurrentBinding: getCurrentCatalogFileForEntity,
  getEntityByLocator: getCatalogEntityByLocator,
  getEvents: getCatalogEventsForEntity,
  exists: (path) => platform().fs.exists(path),
  readTextFile: (path) => platform().fs.readTextFile(path),
  findMetaPathForAcceptedVersion: findInMemoryAcceptedVersionMetaPath,
  findConstructIdForAcceptedVersion: findConstructIdForAcceptedAssemblyVersion,
  workspaceRoots: () =>
    useWorkspaceStore
      .getState()
      .folders.filter((folder) => !folder.pinned)
      .map((folder) => folder.path),
  validateWorkspacePath: (input) => platform().fs.validateWorkspacePath(input),
};

export async function resolveAcceptedAssemblyRecord(
  selector: AcceptedRecordSelector,
  deps: AcceptedRecordReaderDeps = DEFAULT_DEPS
): Promise<ResolvedAcceptedAssemblyRecord> {
  const target = await resolveRecordTarget(selector, deps);
  await assertWorkspaceOwnedPaths(target.packageRoot, [target.metaPath], deps, true);
  if (!(await deps.exists(target.metaPath))) {
    throw new Error(`Accepted assembly record does not exist: ${target.metaPath}`);
  }
  const content = await deps.readTextFile(target.metaPath);
  const packageDocument = parseSequencePackageDocument(content);
  const acceptedPayloads = [
    ...packageDocument.versionHistory.revisions
      .map((revision) => revision.state.acceptedAssembly)
      .filter((payload): payload is Record<string, unknown> => payload !== null),
    ...(packageDocument.assembly?.history ?? []),
    ...(packageDocument.assembly?.accepted ? [packageDocument.assembly.accepted] : []),
  ];
  const seenAcceptedIds = new Set<string>();
  const acceptedRecords = acceptedPayloads
    .map((payload) => parseAcceptedAssemblyPayload(payload, { packageRoot: target.packageRoot }))
    .filter((payload) => {
      const id = acceptedAssemblyVersionFromSidecar(payload).id;
      if (seenAcceptedIds.has(id)) return false;
      seenAcceptedIds.add(id);
      return true;
    });
  if (acceptedRecords.length === 0) {
    throw new Error('This sequence package has no accepted assembly record.');
  }
  const currentAcceptedId = packageDocument.assembly?.accepted
    ? acceptedAssemblyVersionFromSidecar(
        parseAcceptedAssemblyPayload(packageDocument.assembly.accepted, {
          packageRoot: target.packageRoot,
        })
      ).id
    : null;
  if (!selector.acceptedAssemblyVersionId && !currentAcceptedId) {
    throw new Error(
      'This sequence version has no current saved assembly. Choose a historical version in History.'
    );
  }
  const accepted = selector.acceptedAssemblyVersionId
    ? acceptedRecords.find(
        (candidate) =>
          acceptedAssemblyVersionFromSidecar(candidate).id === selector.acceptedAssemblyVersionId
      )
    : acceptedRecords.find(
        (candidate) => acceptedAssemblyVersionFromSidecar(candidate).id === currentAcceptedId
      );
  if (!accepted) {
    throw new Error(
      `Accepted assembly version mismatch: requested ${selector.acceptedAssemblyVersionId}, ` +
        'record does not contain it.'
    );
  }
  const acceptedAssemblyVersionId = acceptedAssemblyVersionFromSidecar(accepted).id;

  const constructId = selector.constructId ?? target.constructId ?? packageDocument.id;
  if (selector.constructId && packageDocument.id !== selector.constructId) {
    throw new Error(
      `Construct mismatch: requested ${selector.constructId}, package contains ${packageDocument.id}.`
    );
  }
  await assertAcceptedRecordIdentity(accepted, packageDocument.id, constructId);
  const productPath = sequencePackagePaths(target.packageRoot, {
    productFile: packageDocument.product.file,
  }).productPath;
  await assertWorkspaceOwnedPaths(target.packageRoot, [target.metaPath, productPath], deps);
  const recordIsCurrent = acceptedAssemblyVersionId === currentAcceptedId;
  const integrity = recordIsCurrent
    ? await verifyProductGenBank(productPath, accepted.artifacts.productGenBankChecksum, deps)
    : {
        productGenBank: 'historical' as const,
        expectedChecksum: accepted.artifacts.productGenBankChecksum ?? null,
        actualChecksum: null,
      };

  return {
    constructId,
    packageId: packageDocument.id,
    packageRoot: target.packageRoot,
    productPath,
    metaPath: target.metaPath,
    acceptedAssemblyVersionId,
    accepted,
    acceptedRecords,
    recordIsCurrent,
    integrity,
    catalogEvents: (await deps.getEvents(constructId)).map(projectCatalogEvent),
  };
}

async function resolveRecordTarget(
  selector: AcceptedRecordSelector,
  deps: AcceptedRecordReaderDeps
): Promise<{ constructId: string | null; packageRoot: string; metaPath: string }> {
  const uriConstructId = constructIdFromUri(selector.locator);
  const constructId = selector.constructId ?? uriConstructId;
  if (constructId) {
    const binding = await deps.getCurrentBinding(constructId);
    if (!binding) throw new Error(`Construct is not file-backed: ${constructId}`);
    if (!isSequencePackageFileKind(binding.file_kind)) {
      throw new Error(`Construct ${constructId} is not a finalized sequence package.`);
    }
    return {
      constructId,
      packageRoot: normalizePath(binding.path),
      metaPath: await resolveExistingMetaPath(normalizePath(binding.path), deps),
    };
  }

  if (selector.locator && !selector.locator.startsWith('waypoint://')) {
    const entity = await deps.getEntityByLocator(selector.locator);
    if (entity) {
      return resolveRecordTarget({ ...selector, constructId: entity.id, locator: undefined }, deps);
    }
    const path = normalizeLocatorPath(selector.locator);
    const packageRoot = packageRootFromLocator(path);
    return {
      constructId: null,
      packageRoot,
      metaPath: await resolveExistingMetaPath(packageRoot, deps),
    };
  }

  if (selector.acceptedAssemblyVersionId) {
    const durableConstructId = await deps.findConstructIdForAcceptedVersion(
      selector.acceptedAssemblyVersionId
    );
    if (durableConstructId) {
      return resolveRecordTarget({ ...selector, constructId: durableConstructId }, deps);
    }
    const metaPath = deps.findMetaPathForAcceptedVersion(selector.acceptedAssemblyVersionId);
    if (metaPath) {
      const packageRoot = packageRootFromMetaPath(metaPath);
      return { constructId: null, packageRoot, metaPath };
    }
  }

  throw new Error(
    'Could not resolve an accepted assembly. Provide constructId, a package/product locator, ' +
      'or an accepted version currently known to the app.'
  );
}

async function assertWorkspaceOwnedPaths(
  packageRoot: string,
  memberPaths: readonly string[],
  deps: Pick<AcceptedRecordReaderDeps, 'workspaceRoots' | 'validateWorkspacePath'>,
  allowMissing = false
): Promise<void> {
  const roots = deps.workspaceRoots().map((path) => ({ path }));
  const workspaceRoot = findContainingPathBoundary(roots, packageRoot)?.path ?? null;
  if (!workspaceRoot) {
    throw new Error('Accepted assembly is outside the active writable project.');
  }
  for (const path of [packageRoot, ...memberPaths]) {
    const valid = await deps.validateWorkspacePath({
      workspaceRoot,
      path,
      allowMissing,
      artifactNoun: 'accepted assembly',
    });
    if (!valid) throw new Error('Accepted assembly path escapes the active project.');
  }
}

async function assertAcceptedRecordIdentity(
  accepted: AcceptedAssemblySidecarPayload,
  packageId: string,
  constructId: string
): Promise<void> {
  const projection = accepted.projectionInput;
  const projectedConstructId =
    projection.constructId ?? accepted.constructId ?? projection.designId;
  const legacyVersionId = accepted.acceptedAssemblyVersionId ?? accepted.acceptedVersionId;
  const legacyVersionIdentifiesPackage =
    !projection.constructId &&
    !accepted.constructId &&
    legacyVersionId === packageId &&
    constructId === packageId;
  if (
    packageId !== constructId ||
    (projectedConstructId !== constructId && !legacyVersionIdentifiesPackage)
  ) {
    throw new Error('Accepted assembly construct identity does not match its package.');
  }
  if (
    accepted.designId !== projection.designId ||
    accepted.validationSnapshot.designId !== projection.designId
  ) {
    throw new Error('Accepted assembly design identity is internally inconsistent.');
  }
  const { canonicalDraftChecksum: claimed, ...canonicalDraft } = projection;
  const actual = await computeAcceptedDraftChecksum(
    canonicalDraft as AcceptedAssemblyCanonicalDraftInput
  );
  const claims = [
    claimed,
    accepted.construction.canonicalDraftChecksum,
    accepted.validationSnapshot.projectionInputChecksum,
    accepted.artifacts.canonicalDraftChecksum,
  ];
  if (claims.some((value) => value !== actual)) {
    throw new Error('Accepted assembly canonical draft checksum does not match its frozen recipe.');
  }
}

async function verifyProductGenBank(
  productPath: string,
  expectedChecksum: string | undefined,
  deps: Pick<AcceptedRecordReaderDeps, 'exists' | 'readTextFile'>
): Promise<ResolvedAcceptedAssemblyRecord['integrity']> {
  if (!expectedChecksum || !(await deps.exists(productPath))) {
    return {
      productGenBank: 'unavailable',
      expectedChecksum: expectedChecksum ?? null,
      actualChecksum: null,
    };
  }
  const actualChecksum = await computeChecksum(await deps.readTextFile(productPath));
  return {
    productGenBank: actualChecksum === expectedChecksum ? 'verified' : 'drifted',
    expectedChecksum,
    actualChecksum,
  };
}

function findInMemoryAcceptedVersionMetaPath(acceptedAssemblyVersionId: string): string | null {
  for (const design of Object.values(useDesignStore.getState().designs)) {
    const accepted = design.acceptedAssemblyVersions?.find(
      (version) => version.id === acceptedAssemblyVersionId
    );
    if (accepted?.artifacts?.sidecarJsonPath) return accepted.artifacts.sidecarJsonPath;
  }
  return null;
}

function constructIdFromUri(locator: string | undefined): string | null {
  if (!locator?.startsWith('waypoint://')) return null;
  try {
    const uri = new URL(locator);
    if (uri.protocol !== 'waypoint:') return null;
    if (uri.hostname !== 'construct' && uri.hostname !== 'design') return null;
    return decodeURIComponent(uri.pathname.replace(/^\/+/, '')) || null;
  } catch {
    return null;
  }
}

function normalizeLocatorPath(locator: string): string {
  if (locator.startsWith('file://')) {
    return decodeURIComponent(new URL(locator).pathname);
  }
  return normalizePath(locator);
}

async function resolveExistingMetaPath(
  packageRoot: string,
  deps: AcceptedRecordReaderDeps
): Promise<string> {
  for (const metaPath of sequencePackageMetaPaths(packageRoot)) {
    try {
      if (await deps.exists(metaPath)) return metaPath;
    } catch {}
  }
  return sequencePackagePaths(packageRoot).metaPath;
}

function packageRootFromLocator(path: string): string {
  if (isSequencePackageMetaPath(path)) return packageRootFromMetaPath(path);
  if (/\.(gb|gbk|gbff|genbank)$/i.test(path)) return dirname(path);
  return path;
}

function packageRootFromMetaPath(metaPath: string): string {
  const normalized = normalizePath(metaPath);
  for (const name of ['plasmid.json']) {
    const suffix = `/.forge/${name}`;
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length) || '/';
    }
  }
  throw new Error(`Not a ${SEQUENCE_PACKAGE_SCHEMA} metadata path: ${metaPath}`);
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : '/';
}

function projectCatalogEvent(event: DBCatalogEntityEvent) {
  return {
    id: event.id,
    eventType: event.event_type,
    actor: event.actor,
    summary: event.summary,
    payload: parseJsonRecord(event.payload),
    createdAt: event.created_at,
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
