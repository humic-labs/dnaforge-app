import { FinalizationPreconditionError } from './finalization-error';
import { computeChecksum, decodeSequenceDocument } from '@waypoint/sequence-utils';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSequenceStore } from '../sequence/public/store';
import { useDesignStore } from '../design/public/store';
import type { SequenceDesign } from '../design/public/types';
import type { AcceptedAssemblyPrimerOligo } from './accepted-types';
import { canonicalizeAcceptedAssemblyValue } from './accepted-canonical';
import { resolveAcceptedSourceIdentity } from './accepted-source-identity';
import {
  acceptedAssemblyWriteTargetFromProductPath,
  defaultAcceptedAssemblyProductPath,
  mergeLoadedSourceSequencesForAcceptedProvenance,
  prepareAcceptedAssemblyDraft,
  workspaceFoldersToAcceptedAssemblyMap,
  type PrepareAcceptedAssemblyDraftResult,
} from './accepted-service';
import { deriveAssemblyIssues } from './issues/assembly-issues';
import { readMatchingExistingSequencePackageDocument } from './accepted-writer';
import {
  getCurrentCatalogFileForEntity,
  type DBCatalogEntityFile,
} from '../../db/workspace-catalog';
import {
  isSequencePackageFileKind,
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
  sequencePackagePaths,
  type SequencePackageDocument,
} from '../../db/sequence-package';
import { resolveConstructIdForFinalize } from './accepted-construct-id';
import {
  assertReplaceProductAllowed,
  expectedAcceptedProductGenBankChecksum,
  inspectAcceptedProductIntegrity,
} from './accepted-product-integrity';
import { platform } from '../../platform';
import { findContainingPathBoundary, pathRelativeToBoundary } from '../../shared/path-boundary';
import { soleWritableProjectRoot } from '../../shared/project-root-selection';
import { loadSourceSequenceForKey } from '../junction-workbench/public/SourceContextRegistry';
import { resolveSequenceDocumentById } from '../sequence/public/sequence-document-repository';
import { readAcceptedScientificFile } from '../../services/read-accepted-scientific-file';
import { getLimsSchemas } from '../lims/public/operations';
import { createSequenceEntityMetadataForSchema } from '../../shared/sequence-entity-schema';

export class FinalizationProjectError extends Error {
  constructor(
    public readonly code: 'DESIGN_PROJECT_NOT_OPEN' | 'FINALIZATION_PROJECT_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'FinalizationProjectError';
  }
}

const PREVIEW_TTL_MS = 10 * 60 * 1000;

export interface PrepareFinalizationCandidateInput {
  designId: string;
  expectedDesignVersion: number;
  targetProductPath?: string;
  overwrite?: boolean;
  replaceProduct?: boolean;
  constructId?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  createId?: () => string;
  agentOperation?: { idempotencyKey: string; previewFingerprint: string };
}

export interface PreparedFinalizationCandidate {
  design: SequenceDesign;
  constructId: string;
  targetProductPath: string;
  overwrite: boolean;
  replaceProduct: boolean;
  workspaceFolderMap: ReturnType<typeof workspaceFoldersToAcceptedAssemblyMap>;
  prepared: PrepareAcceptedAssemblyDraftResult;
  signature: string;
  warnings: ReturnType<typeof deriveAssemblyIssues>;
}

export interface FinalizationPreview {
  createsNewConstruct: boolean;
  designId: string;
  expectedDesignVersion: number;
  constructId: string;
  previewFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  targetProductPath: string;
  packageRoot: string;
  productPath: string;
  metaPath: string;
  canonicalDraftChecksum: string;
  productSequenceChecksum: string;
  productGenBankChecksum: string;
  sources: Array<{
    regionId: string;
    sourceSequenceId: string;
    sourceConstructId: string | null;
    sourceSequenceVersionId: string | null;
    sourceLocator: string;
    checksum: string | null;
  }>;
  blockers: [];
  warnings: ReturnType<typeof deriveAssemblyIssues>;
}

export interface StoredPreview {
  preview: FinalizationPreview;
  signature: string;
  overwrite: boolean;
  replaceProduct: boolean;
}

const previews = new Map<string, StoredPreview>();

async function currentSavedPrimerOligos(
  design: SequenceDesign
): Promise<readonly AcceptedAssemblyPrimerOligo[]> {
  const links = design.savedPrimerLinks ?? [];
  if (links.length === 0) return [];
  try {
    const { primerIdsWithCurrentSavedOligo } = await import('./saved-primer-oligo-service');
    const current = await primerIdsWithCurrentSavedOligo(design.id);
    return links
      .filter((link) => current.has(link.primerId))
      .map((link) => ({
        primerId: link.primerId,
        oligoId: link.oligoId,
        artifactRevision: link.artifactRevision,
        sequenceContentHash: link.sequenceContentHash,
      }));
  } catch (error) {
    console.warn('[AcceptedAssembly] Saved oligo links could not be read for acceptance:', error);
    return [];
  }
}

export async function prepareFinalizationCandidate(
  input: PrepareFinalizationCandidateInput
): Promise<PreparedFinalizationCandidate> {
  const design = useDesignStore.getState().designs[input.designId];
  if (!design) throw new Error(`Design not found: ${input.designId}`);
  if (design.version !== input.expectedDesignVersion) {
    throw new FinalizationPreconditionError(
      'stale_design',
      `Design version is stale: expected ${input.expectedDesignVersion}, current ${design.version}. ` +
        'Re-read get_design and preview finalization again.'
    );
  }
  const workspace = useWorkspaceStore.getState();
  const boundPackage = await resolveBoundAcceptedPackageForDesign(design, workspace.folders);
  const requestedProductPath =
    input.targetProductPath ??
    (await defaultProductPathFor(design, workspace.activeWorkspaceFile, workspace.folders));
  if (!requestedProductPath && !boundPackage) {
    throw new FinalizationProjectError(
      'FINALIZATION_PROJECT_REQUIRED',
      `Design "${design.name}" has no saved project binding and no unique writable destination. Open its saved assembly document, or create a durable design with destinationProject set to the exact project name.`
    );
  }
  const existingPackage =
    boundPackage ??
    (requestedProductPath
      ? await resolveExistingAcceptedPackage(platform().fs, requestedProductPath)
      : null);
  const targetProductPath = existingPackage?.productPath ?? requestedProductPath;
  if (!targetProductPath) {
    throw new Error('Open or save a project before previewing finalization.');
  }
  const existingPackageDocument = existingPackage?.document ?? null;
  const constructId = resolveConstructIdForFinalize({
    requestedConstructId: input.constructId,
    designConstructId: design.constructId,
    existingPackageId: existingPackageDocument?.id,
  });
  let overwrite = input.overwrite ?? false;
  const replaceProduct = input.replaceProduct ?? false;
  if (existingPackageDocument && existingPackageDocument.id !== constructId) {
    throw new Error(
      `Refusing to overwrite construct ${existingPackageDocument.id} with design ${constructId}.`
    );
  }
  if (existingPackageDocument) {
    const integrity = await inspectAcceptedProductIntegrity({
      productPath: targetProductPath,
      expectedGenBankChecksum: expectedAcceptedProductGenBankChecksum(existingPackageDocument),
      exists: (path) => platform().fs.exists(path),
      readTextFile: (path) => platform().fs.readTextFile(path),
    });
    assertReplaceProductAllowed({ constructId, integrity, replaceProduct });
    overwrite = true;
  }
  const workspaceFolderMap = workspaceFoldersToAcceptedAssemblyMap(workspace.folders);
  const sequenceCache = await mergeLoadedSourceSequencesForAcceptedProvenance(
    design,
    useSequenceStore.getState().sequences,
    loadSourceSequenceForAcceptedProvenance
  );
  const currentPlasmidSchema = existingPackageDocument
    ? null
    : (await getLimsSchemas()).find((schema) => schema.entityKind === 'plasmid');
  if (!existingPackageDocument && !currentPlasmidSchema) {
    throw new Error('The current Plasmid Registry schema is unavailable.');
  }
  const entityMetadata = currentPlasmidSchema
    ? createSequenceEntityMetadataForSchema(currentPlasmidSchema)
    : undefined;
  const prepared = await prepareAcceptedAssemblyDraft({
    design: { ...design, constructId },
    constructId,
    writeTarget: acceptedAssemblyWriteTargetFromProductPath(targetProductPath, {
      overwrite,
      parentIsExistingPackage: existingPackageDocument !== null,
    }),
    workspaceFolders: workspaceFolderMap,
    sequenceCache,
    acceptedAt: input.acceptedAt,
    acceptedBy: input.acceptedBy,
    createId: input.createId,
    existingPackageDocument: existingPackageDocument ?? undefined,
    entityMetadata,
    sourceIdentityResolver: resolveAcceptedSourceIdentity,
    agentOperation: input.agentOperation,
    savedPrimerOligos: await currentSavedPrimerOligos(design),
  });
  const writableFolders = workspace.folders.filter((folder) => !folder.pinned);
  const workspaceRoot = findContainingPathBoundary(
    writableFolders,
    prepared.files.packageRoot
  )?.path;
  if (!workspaceRoot) {
    throw new Error('Finalization output must be inside an open writable project.');
  }
  for (const path of [prepared.files.packageRoot, prepared.files.productGenBankPath]) {
    if (
      !(await platform().fs.validateWorkspacePath({
        workspaceRoot,
        path,
        allowMissing: true,
        artifactNoun: 'accepted assembly output',
      }))
    ) {
      throw new Error('Finalization output escapes the active project.');
    }
  }
  const signature = await computeCandidateSignature(
    design,
    constructId,
    targetProductPath,
    overwrite,
    prepared
  );
  return {
    design,
    constructId,
    targetProductPath,
    overwrite,
    replaceProduct,
    workspaceFolderMap,
    prepared,
    signature,
    warnings: deriveAssemblyIssues({ design }).filter((issue) => issue.severity === 'warning'),
  };
}

export interface BoundAcceptedPackage {
  packageRoot: string;
  productPath: string;
  document: SequencePackageDocument;
  bindingSource: 'construct' | 'legacy-design';
}

export async function resolveBoundAcceptedPackageForDesign(
  design: SequenceDesign,
  folders: Array<{ path: string; pinned?: boolean }>
): Promise<BoundAcceptedPackage | null> {
  const constructBinding = design.constructId
    ? await getCurrentCatalogFileForEntity(design.constructId)
    : null;
  const designBinding = await getCurrentCatalogFileForEntity(design.id);

  if (constructBinding && !isSequencePackageFileKind(constructBinding.file_kind)) {
    throw new Error(
      `Construct "${design.constructId}" is bound to catalog kind "${constructBinding.file_kind}", not a sequence package.`
    );
  }

  const legacyDesignBinding =
    designBinding && isSequencePackageFileKind(designBinding.file_kind) ? designBinding : null;
  if (
    constructBinding &&
    legacyDesignBinding &&
    normalizePath(constructBinding.path) !== normalizePath(legacyDesignBinding.path)
  ) {
    throw new Error(
      `Design "${design.id}" has conflicting accepted package bindings: ${legacyDesignBinding.path} and ${constructBinding.path}.`
    );
  }

  if (constructBinding) {
    return readBoundAcceptedPackage({
      design,
      binding: constructBinding,
      bindingSource: 'construct',
      folders,
    });
  }
  if (legacyDesignBinding) {
    return readBoundAcceptedPackage({
      design,
      binding: legacyDesignBinding,
      bindingSource: 'legacy-design',
      folders,
    });
  }
  return null;
}

async function readBoundAcceptedPackage(input: {
  design: SequenceDesign;
  binding: DBCatalogEntityFile;
  bindingSource: BoundAcceptedPackage['bindingSource'];
  folders: Array<{ path: string; pinned?: boolean }>;
}): Promise<BoundAcceptedPackage> {
  const packageRoot = normalizePath(input.binding.path);
  const writableFolders = input.folders.filter((folder) => !folder.pinned);
  const workspaceRoot = findContainingPathBoundary(writableFolders, packageRoot)?.path;
  if (!workspaceRoot) {
    throw new Error(
      `The accepted sequence package for design "${input.design.id}" is outside an open writable workspace: ${packageRoot}`
    );
  }

  const fs = platform().fs;
  let metaPath: string | null = null;
  for (const candidate of sequencePackageMetaPaths(packageRoot)) {
    if (await fs.exists(candidate)) {
      metaPath = candidate;
      break;
    }
  }
  if (!metaPath) {
    throw new Error(
      `The accepted sequence package bound to design "${input.design.id}" is missing its metadata: ${packageRoot}`
    );
  }

  let document: SequencePackageDocument;
  try {
    document = parseSequencePackageDocument(await fs.readTextFile(metaPath));
  } catch (error) {
    throw new Error(
      `The accepted sequence package bound to design "${input.design.id}" cannot be opened: ${errorMessage(error)}`
    );
  }

  if (
    input.bindingSource === 'construct' &&
    input.design.constructId &&
    document.id !== input.design.constructId
  ) {
    throw new Error(
      `Construct mismatch: design expects ${input.design.constructId}, package contains ${document.id}.`
    );
  }
  if (input.bindingSource === 'legacy-design') {
    const acceptedDesignId = readAcceptedDesignId(document);
    if (acceptedDesignId !== input.design.id) {
      throw new Error(
        `Legacy package design mismatch: catalog binds ${input.design.id}, package records ${acceptedDesignId ?? 'no design id'}.`
      );
    }
  }

  const productPath = sequencePackagePaths(packageRoot, {
    productFile: document.product.file,
  }).productPath;
  for (const path of [packageRoot, metaPath, productPath]) {
    if (
      !(await fs.validateWorkspacePath({
        workspaceRoot,
        path,
        allowMissing: false,
        artifactNoun: 'accepted sequence package',
      }))
    ) {
      throw new Error(`Accepted sequence package path escapes the active project: ${path}`);
    }
  }
  if (!(await fs.exists(productPath))) {
    throw new Error(`The accepted sequence package is missing its product: ${productPath}`);
  }

  return { packageRoot, productPath, document, bindingSource: input.bindingSource };
}

function readAcceptedDesignId(document: SequencePackageDocument): string | null {
  const accepted = document.assembly?.accepted;
  return accepted && typeof accepted.designId === 'string' ? accepted.designId : null;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || '/';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function previewFinalizeDesignAssembly(input: {
  designId: string;
  expectedDesignVersion: number;
  targetProductPath?: string;
  overwrite?: boolean;
  replaceProduct?: boolean;
  now?: Date;
}): Promise<FinalizationPreview> {
  const issuedAt = input.now ?? new Date();
  const candidate = await prepareFinalizationCandidate({
    ...input,
    acceptedAt: issuedAt.toISOString(),
    createId: () => 'preview-only',
  });
  pruneExpiredPreviews(issuedAt.getTime());
  const previewFingerprint = await computeChecksum(
    canonicalizeAcceptedAssemblyValue({
      signature: candidate.signature,
      issuedAt: issuedAt.toISOString(),
      nonce: crypto.randomUUID(),
    })
  );
  const expiresAt = new Date(issuedAt.getTime() + PREVIEW_TTL_MS);
  const preview: FinalizationPreview = {
    createsNewConstruct: !candidate.overwrite,
    designId: candidate.design.id,
    expectedDesignVersion: candidate.design.version,
    constructId: candidate.constructId,
    previewFingerprint,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    targetProductPath: candidate.targetProductPath,
    packageRoot: candidate.prepared.files.packageRoot,
    productPath: candidate.prepared.files.productGenBankPath,
    metaPath: candidate.prepared.files.metaPath,
    canonicalDraftChecksum: candidate.prepared.acceptedVersion.canonicalDraftChecksum,
    productSequenceChecksum: candidate.prepared.files.productSequenceChecksum,
    productGenBankChecksum: candidate.prepared.files.productGenBankChecksum,
    sources: candidate.prepared.acceptedVersion.projectionInput.sourceProvenance.map((source) => ({
      regionId: source.regionId,
      sourceSequenceId: source.sourceSequenceId,
      sourceConstructId: source.sourceConstructId ?? null,
      sourceSequenceVersionId: source.sourceSequenceVersionId ?? null,
      sourceLocator: source.sourceLocator ?? source.sourceSequenceId,
      checksum: source.sourceSequenceChecksum ?? null,
    })),
    blockers: [],
    warnings: candidate.warnings,
  };
  previews.set(previewFingerprint, {
    preview,
    signature: candidate.signature,
    overwrite: candidate.overwrite,
    replaceProduct: candidate.replaceProduct,
  });
  return preview;
}

export function getStoredFinalizationPreview(
  previewFingerprint: string,
  now: Date = new Date()
): StoredPreview {
  const stored = previews.get(previewFingerprint);
  if (!stored) throw new Error('Finalization preview is missing or expired. Preview again.');
  if (Date.parse(stored.preview.expiresAt) <= now.getTime()) {
    previews.delete(previewFingerprint);
    throw new Error('Finalization preview expired. Preview again.');
  }
  return stored;
}

export function clearFinalizationPreviewsForTests(): void {
  previews.clear();
}

async function computeCandidateSignature(
  design: SequenceDesign,
  constructId: string,
  targetProductPath: string,
  overwrite: boolean,
  prepared: PrepareAcceptedAssemblyDraftResult
): Promise<string> {
  return computeChecksum(
    canonicalizeAcceptedAssemblyValue({
      designId: design.id,
      constructId,
      designVersion: design.version,
      targetProductPath,
      overwrite,
      canonicalDraftChecksum: prepared.acceptedVersion.canonicalDraftChecksum,
      productSequenceChecksum: prepared.files.productSequenceChecksum,
      productGenBankChecksum: prepared.files.productGenBankChecksum,
      sources: prepared.acceptedVersion.projectionInput.sourceProvenance.map((source) => ({
        regionId: source.regionId,
        sourceSequenceId: source.sourceSequenceId,
        sourceConstructId: source.sourceConstructId,
        sourceSequenceVersionId: source.sourceSequenceVersionId,
        sourceLocator: source.sourceLocator,
        sourceSequenceChecksum: source.sourceSequenceChecksum,
        selectedSourceRange: source.selectedSourceRange,
        copiedDirection: source.copiedDirection,
      })),
    })
  );
}

function pruneExpiredPreviews(nowMs: number): void {
  for (const [fingerprint, stored] of previews) {
    if (Date.parse(stored.preview.expiresAt) <= nowMs) previews.delete(fingerprint);
  }
}

async function defaultProductPathFor(
  design: SequenceDesign,
  activeWorkspaceFile: string | null,
  folders: Array<{ path: string; pinned?: boolean }>
): Promise<string | null> {
  const binding = await getCurrentCatalogFileForEntity(design.id);
  if (binding?.file_kind === 'waypoint-design') {
    const project = findContainingPathBoundary(
      folders.filter((folder) => !folder.pinned),
      binding.path
    );
    if (!project) {
      throw new FinalizationProjectError(
        'DESIGN_PROJECT_NOT_OPEN',
        `Design "${design.name}" belongs to a saved project that is not open for writing. Open the project containing this assembly document with workspace_projects, then preview again. Making another project current does not change the design's destination.`
      );
    }
    return defaultAcceptedAssemblyProductPath(design, project.path);
  }
  const baseDirectory =
    savedWorkspaceDirectory(activeWorkspaceFile) ?? soleWritableProjectRoot(folders)?.path;
  return baseDirectory ? defaultAcceptedAssemblyProductPath(design, baseDirectory) : null;
}

function savedWorkspaceDirectory(activeWorkspaceFile: string | null): string | null {
  if (!activeWorkspaceFile) return null;
  return parentDirectoryOf(activeWorkspaceFile) || null;
}

function parentDirectoryOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : '';
}

async function resolveExistingAcceptedPackage(
  fs: {
    exists: (path: string) => Promise<boolean>;
    readTextFile: (path: string) => Promise<string>;
  },
  logicalProductPath: string
): Promise<{
  productPath: string;
  document: NonNullable<Awaited<ReturnType<typeof readMatchingExistingSequencePackageDocument>>>;
} | null> {
  const parent = parentDirectoryOf(logicalProductPath);
  const filename = logicalProductPath.replace(/\\/g, '/').slice(parent.length + 1);
  if (!parent || !filename) return null;

  const direct = await readMatchingExistingSequencePackageDocument(fs, parent, logicalProductPath);
  if (direct) return { productPath: logicalProductPath, document: direct };

  const stem = filename.replace(/\.(gb|gbk|genbank)$/i, '');
  if (!stem) return null;
  const mintedProductPath = `${parent}/${stem}/${filename}`;
  const minted = await readMatchingExistingSequencePackageDocument(
    fs,
    `${parent}/${stem}`,
    mintedProductPath
  );
  if (minted) return { productPath: mintedProductPath, document: minted };
  return null;
}

async function loadSourceSequenceForAcceptedProvenance(sourceSequenceId: string) {
  const folders = useWorkspaceStore.getState().folders;
  let resolved;
  try {
    resolved = await resolveSequenceDocumentById(
      sourceSequenceId,
      folders.map((folder) => folder.path)
    );
  } catch {
    return loadSourceSequenceForKey(sourceSequenceId);
  }
  const folder = findContainingPathBoundary(folders, resolved.sourcePath);
  const relative = folder ? pathRelativeToBoundary(resolved.sourcePath, folder.path) : null;
  const accepted =
    folder && relative
      ? await readAcceptedScientificFile(folder.path, relative, Number.MAX_SAFE_INTEGER)
      : null;
  const content = accepted
    ? new TextDecoder('utf-8', { fatal: true }).decode(accepted.bytes)
    : /\.(?:ab1|abi|dna)$/iu.test(resolved.sourcePath)
      ? await platform().fs.readFile(resolved.sourcePath)
      : await platform().fs.readTextFile(resolved.sourcePath);
  return {
    ...decodeSequenceDocument(content, { path: resolved.sourcePath }).sequence,
    id: sourceSequenceId,
  };
}
