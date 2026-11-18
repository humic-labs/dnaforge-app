import { FinalizationPreconditionError } from './finalization-error';
import {
  computeChecksum,
  ensureManagedGenBankAnnotationIds,
  serializeGenBank,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import type {
  AcceptedAssemblyPrimerOligo,
  AcceptedAssemblyProjectionInput,
  AcceptedAssemblySidecarPayload,
  AcceptedAssemblyValidationSnapshot,
  AcceptedAssemblyWriteTarget,
} from './accepted-types';
import { projectAcceptedAssemblyProductAnnotations } from './accepted-annotation-projection';
import { requireConstructId } from './accepted-construct-id';
import type { AssemblyMethod } from '../design/public/types';
import {
  buildSequencePackageDocument,
  createDefaultPlasmidEntityMetadata,
  fromPackageRelative,
  parseSequencePackageDocument,
  sequenceProductExtensionForPath,
  sequencePackageMetaPaths,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  stripSequenceProductExtension,
  toPackageRelative,
  type SequencePackageDocument,
  type SchemaBoundSequenceEntityMetadata,
  type SequenceProductExtension,
} from '../../db/sequence-package';
import {
  loadSequencePackageDocument,
  type SequencePackageIoFs,
} from '../../db/sequence-package-io';
import { prepareSequencePackageRevision } from '../../db/sequence-package-versioning';
import type {
  AcceptedAssemblyRevisionPublicationRequest,
  AcceptedAssemblyRevisionPublicationResult,
} from '../../shared/sequence-package-revision';
import {
  buildPrimerArtifactRows,
  serializePrimerRowsCsv,
  serializePrimerRowsFasta,
} from './primer-artifacts';
import type {
  PackageScratchLease,
  PackageScratchLeaseSet,
} from '../../shared/package-scratch-capability';

export type AcceptedAssemblyWorkspaceFolder = {
  path: string;
  name: string;
};

export type AcceptedAssemblyWorkspaceFolderMap = Record<string, AcceptedAssemblyWorkspaceFolder>;

export type AcceptedAssemblyResolvedWritePaths = {
  packageRoot: string;
  productGenBankPath: string;
  metaPath: string;
  metaDir: string;
  primersDir: string;
  primerCsvPath: string;
  primerFastaPath: string;
  basename: string;
  overwrite: boolean;
};

export type PreparedAcceptedAssemblyFiles = AcceptedAssemblyResolvedWritePaths & {
  productGenBankContent: string;
  sidecarJsonContent: string;
  primerCsvContent: string;
  primerFastaContent: string;
  productSequenceChecksum: string;
  productGenBankChecksum: string;
  primerCsvChecksum: string;
  primerFastaChecksum: string;
  sidecarChecksum: string;
  canonicalDraftChecksum: string;
  expectedExistingPackageChecksum?: string;
  snapshotFiles?: ReadonlyArray<{ path: string; content: string; sha256: string }>;
};

export type AcceptedAssemblyFileOps = {
  exists(path: string): Promise<boolean>;
  readTextFile?(path: string): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
  writeWorkspaceTextFileAtomic?: SequencePackageIoFs['writeWorkspaceTextFileAtomic'];
  publishAcceptedAssemblyRevision?: (
    input: Omit<AcceptedAssemblyRevisionPublicationRequest, 'workspaceRoot' | 'mutationToken'>
  ) => Promise<AcceptedAssemblyRevisionPublicationResult>;
  rename(from: string, to: string): Promise<void>;
  unlink?(path: string): Promise<void>;
  createScratch?(packageRoot: string): Promise<PackageScratchLeaseSet>;
  removeScratch?(lease: PackageScratchLease): Promise<void>;
  renameScratch?(lease: PackageScratchLease, from: string, to: string): Promise<void>;
};

export type AcceptedAssemblyWriteReceipt = {
  migratedPaths: string[];
  publicationPaths?: string[];
};

export type SequencePackageIdentityFileOps = {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
};

export async function prepareAcceptedAssemblyFiles(params: {
  projectionInput: AcceptedAssemblyProjectionInput;
  validationSnapshot: AcceptedAssemblyValidationSnapshot;
  savedPrimerOligos?: readonly AcceptedAssemblyPrimerOligo[];
  writeTarget: AcceptedAssemblyWriteTarget;
  workspaceFolders: AcceptedAssemblyWorkspaceFolderMap;
  acceptedAt?: string;
  productDate?: Date;
  acceptedBy?: string;
  acceptedVersionId?: string;
  packageId?: string;
  existingPackageDocument?: SequencePackageDocument;
  entityMetadata?: SchemaBoundSequenceEntityMetadata;
  agentOperation?: {
    idempotencyKey: string;
    previewFingerprint: string;
  };
}): Promise<PreparedAcceptedAssemblyFiles> {
  const intendedPackageId = requireConstructId(
    params.packageId ?? params.projectionInput.constructId,
    'Plasmid package'
  );
  if (params.existingPackageDocument && params.existingPackageDocument.id !== intendedPackageId) {
    throw new Error(
      `Refusing to replace plasmid package ${params.existingPackageDocument.id} with construct ${intendedPackageId}.`
    );
  }
  const basePaths = resolveAcceptedAssemblyWritePaths(params.writeTarget, params.workspaceFolders);
  const acceptedVersionId = params.acceptedVersionId ?? globalThis.crypto.randomUUID();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(acceptedVersionId)) {
    throw new Error('Accepted assembly version identity is not a safe package filename.');
  }
  const contentsDir = sequencePackagePaths(basePaths.packageRoot).contentsDir;
  const paths = {
    ...basePaths,
    primerCsvPath: `${contentsDir}/${basePaths.basename}.${acceptedVersionId}.primers.csv`,
    primerFastaPath: `${contentsDir}/${basePaths.basename}.${acceptedVersionId}.primers.fasta`,
  };
  const productSequence = projectionInputToAnnotatedSequence(params.projectionInput, {
    outputPath: paths.productGenBankPath,
  });
  const rawProductContent = serializeGenBank(productSequence, { date: params.productDate });
  const annotationSeed = await computeChecksum(
    JSON.stringify(['accepted-product-annotations.v1', intendedPackageId, rawProductContent])
  );
  const annotationIds = await Promise.all(
    productSequence.annotations.map(async (_annotation, ordinal) => {
      const hex = (await computeChecksum(`${annotationSeed}:${ordinal}`)).slice(7, 39);
      const variant = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    })
  );
  let nextAnnotation = 0;
  const productGenBankContent = ensureManagedGenBankAnnotationIds(rawProductContent, () => {
    const id = annotationIds[nextAnnotation++];
    if (!id)
      throw new Error('Accepted product has more managed features than projected annotations.');
    return id;
  });
  const primerRows = buildPrimerArtifactRows(params.projectionInput.designPrimers);
  const primerCsvContent = serializePrimerRowsCsv(primerRows);
  const primerFastaContent = serializePrimerRowsFasta(primerRows);
  const productSequenceChecksum = await computeChecksum(params.projectionInput.productSequence);
  const productGenBankChecksum = await computeChecksum(productGenBankContent);
  const primerCsvChecksum = await computeChecksum(primerCsvContent);
  const primerFastaChecksum = await computeChecksum(primerFastaContent);

  const sidecarPayload: AcceptedAssemblySidecarPayload = {
    type: 'accepted_assembly',
    schemaVersion: params.projectionInput.schemaVersion,
    acceptedAssemblyVersionId: acceptedVersionId,
    lifecycleState: 'written',
    acceptedAt: params.acceptedAt ?? new Date().toISOString(),
    acceptedBy: params.acceptedBy,
    designId: params.projectionInput.designId,
    constructId: intendedPackageId,
    agentOperation: params.agentOperation,
    designName: params.projectionInput.designName,
    construction: {
      method: params.projectionInput.assemblyMethod,
      topology: params.projectionInput.topology,
      canonicalDraftChecksum: params.projectionInput.canonicalDraftChecksum,
      optimizationFingerprint: params.projectionInput.optimizationFingerprint,
      regionCount: params.projectionInput.regions.length,
      spacerCount: params.projectionInput.spacers.length,
    },
    projectionInput: params.projectionInput,
    validationSnapshot: params.validationSnapshot,
    ...(params.savedPrimerOligos?.length ? { savedPrimerOligos: params.savedPrimerOligos } : {}),
    artifacts: {
      productGenBankPath: toPackageRelative(paths.productGenBankPath, paths.packageRoot),
      sidecarJsonPath: toPackageRelative(paths.metaPath, paths.packageRoot),
      primerCsvPath: toPackageRelative(paths.primerCsvPath, paths.packageRoot),
      primerFastaPath: toPackageRelative(paths.primerFastaPath, paths.packageRoot),
      productSequenceChecksum,
      productGenBankChecksum,
      primerCsvChecksum,
      primerFastaChecksum,
      canonicalDraftChecksum: params.projectionInput.canonicalDraftChecksum,
    },
  };

  const existingEntity =
    params.existingPackageDocument?.entity ??
    params.entityMetadata ??
    createDefaultPlasmidEntityMetadata();
  const packageDocument = buildSequencePackageDocument({
    id: params.existingPackageDocument?.id ?? intendedPackageId,
    name: params.projectionInput.designName,
    product: {
      file: toPackageRelative(paths.productGenBankPath, paths.packageRoot),
      topology: params.projectionInput.topology,
      sequenceChecksum: productSequenceChecksum,
      genBankChecksum: productGenBankChecksum,
    },
    members: [
      ...(params.existingPackageDocument?.members ?? []),
      {
        id: `primer-export:${acceptedVersionId}:csv`,
        role: 'primer-export',
        path: toPackageRelative(paths.primerCsvPath, paths.packageRoot),
        replaceable: false,
        createdAt: params.acceptedAt ?? new Date().toISOString(),
      },
      {
        id: `primer-export:${acceptedVersionId}:fasta`,
        role: 'primer-export',
        path: toPackageRelative(paths.primerFastaPath, paths.packageRoot),
        replaceable: false,
        createdAt: params.acceptedAt ?? new Date().toISOString(),
      },
    ],
    assembly: {
      accepted: sidecarPayload,
      history: acceptedHistoryForWrite(params.existingPackageDocument, sidecarPayload),
    },
    entity: {
      ...existingEntity,
      fields: { ...existingEntity.fields },
      registrationStatus: params.existingPackageDocument
        ? existingEntity.registrationStatus
        : 'registered',
    },
    updatedAt: params.acceptedAt,
    existing: params.existingPackageDocument,
  });
  const sidecarJsonContent = serializeSequencePackageDocument(packageDocument);
  const sidecarChecksum = await computeChecksum(sidecarJsonContent);
  const expectedExistingPackageChecksum = params.existingPackageDocument
    ? await computeChecksum(
        serializeSequencePackageDocument(
          parseSequencePackageDocument(JSON.stringify(params.existingPackageDocument))
        )
      )
    : undefined;

  return {
    ...paths,
    productGenBankContent,
    sidecarJsonContent,
    primerCsvContent,
    primerFastaContent,
    productSequenceChecksum,
    productGenBankChecksum,
    primerCsvChecksum,
    primerFastaChecksum,
    sidecarChecksum,
    canonicalDraftChecksum: params.projectionInput.canonicalDraftChecksum,
    expectedExistingPackageChecksum,
  };
}

function acceptedHistoryForWrite(
  existing: SequencePackageDocument | undefined,
  next: AcceptedAssemblySidecarPayload
): Record<string, unknown>[] | undefined {
  const previous = existing?.assembly?.accepted;
  const existingHistory = existing?.assembly?.history ?? [];
  const candidates = previous ? [...existingHistory, previous] : existingHistory;
  const nextId = acceptedPayloadVersionId(next);
  const seen = new Set<string>();
  const history = candidates.filter((candidate) => {
    const id = acceptedPayloadVersionId(candidate);
    if (!id || id === nextId || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return history.length > 0 ? history : undefined;
}

function acceptedPayloadVersionId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = record.acceptedAssemblyVersionId ?? record.acceptedVersionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function resolveAcceptedAssemblyWritePaths(
  target: AcceptedAssemblyWriteTarget,
  workspaceFolders: AcceptedAssemblyWorkspaceFolderMap
): AcceptedAssemblyResolvedWritePaths {
  if ('absoluteProductPath' in target) {
    return resolveAbsoluteAcceptedAssemblyWritePaths(target.absoluteProductPath, {
      overwrite: target.overwrite ?? false,
      parentIsExistingPackage: target.parentIsExistingPackage ?? false,
    });
  }

  const folder = workspaceFolders[target.workspaceFolderId];
  if (!folder) {
    throw new Error(`Unknown accepted assembly project folder: ${target.workspaceFolderId}.`);
  }

  const relativeDirectory = normalizeSafeRelativeDirectory(target.relativeDirectory);
  const basename = normalizeSafeBasename(target.basename);
  const root = stripTrailingSlashes(folder.path);
  const parentDirectory = relativeDirectory ? `${root}/${relativeDirectory}` : root;

  return packageWritePaths({
    packageRoot: `${parentDirectory}/${basename}`,
    basename,
    productExtension: '.gb',
    overwrite: target.overwrite ?? false,
  });
}

function packageWritePaths(input: {
  packageRoot: string;
  basename: string;
  productExtension: string;
  overwrite: boolean;
}): AcceptedAssemblyResolvedWritePaths {
  const productFile = `${input.basename}${input.productExtension}`;
  const paths = sequencePackagePaths(input.packageRoot, { productFile });
  return {
    packageRoot: paths.root,
    productGenBankPath: paths.productPath,
    metaPath: paths.metaPath,
    metaDir: paths.metaDir,
    primersDir: paths.primersDir,
    primerCsvPath: `${paths.contentsDir}/${input.basename}.primers.csv`,
    primerFastaPath: `${paths.contentsDir}/${input.basename}.primers.fasta`,
    basename: input.basename,
    overwrite: input.overwrite,
  };
}

function resolveAbsoluteAcceptedAssemblyWritePaths(
  productPath: string,
  options: { overwrite: boolean; parentIsExistingPackage?: boolean }
): AcceptedAssemblyResolvedWritePaths {
  const normalized = productPath.trim().replace(/\\/g, '/');
  if (!normalized) {
    throw new Error('absoluteProductPath must be a non-empty file path.');
  }
  if (!isAbsolutePath(normalized)) {
    throw new Error('absoluteProductPath must be absolute.');
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0 || lastSlash === normalized.length - 1) {
    throw new Error('absoluteProductPath must include a file name.');
  }

  const parentDirectory = stripTrailingSlashes(normalized.slice(0, lastSlash));
  const rawFilename = normalized.slice(lastSlash + 1);
  const extension = acceptedGenBankExtension(rawFilename);
  const basename = normalizeSafeBasename(rawFilename);

  const packageRoot = options.parentIsExistingPackage
    ? parentDirectory
    : `${parentDirectory}/${basename}`;

  return packageWritePaths({
    packageRoot,
    basename,
    productExtension: extension,
    overwrite: options.overwrite,
  });
}

export async function isMatchingExistingSequencePackageProduct(
  fs: SequencePackageIdentityFileOps,
  directory: string,
  selectedProductPath: string
): Promise<boolean> {
  return (
    (await matchingExistingSequencePackageGeneratedMembers(fs, directory, selectedProductPath)) !==
    null
  );
}

export async function readMatchingExistingSequencePackageDocument(
  fs: SequencePackageIdentityFileOps,
  directory: string,
  selectedProductPath: string
): Promise<SequencePackageDocument | null> {
  const normalizedDirectory = stripTrailingSlashes(directory.replace(/\\/g, '/'));
  const normalizedProduct = selectedProductPath.replace(/\\/g, '/');
  const lastSlash = normalizedProduct.lastIndexOf('/');
  if (!normalizedDirectory || lastSlash <= 0) return null;
  if (normalizedProduct.slice(0, lastSlash) !== normalizedDirectory) return null;

  const selectedFilename = normalizedProduct.slice(lastSlash + 1);
  try {
    let record: SequencePackageDocument | null = null;
    for (const metaPath of sequencePackageMetaPaths(normalizedDirectory)) {
      if (!(await fs.exists(metaPath))) continue;
      record = parseSequencePackageDocument(await fs.readTextFile(metaPath));
      break;
    }
    if (!record) return null;
    if (record.product.file !== selectedFilename || !(await fs.exists(selectedProductPath))) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function matchingExistingSequencePackageGeneratedMembers(
  fs: SequencePackageIdentityFileOps,
  directory: string,
  selectedProductPath: string
): Promise<Set<string> | null> {
  const normalizedDirectory = stripTrailingSlashes(directory.replace(/\\/g, '/'));
  const record = await readMatchingExistingSequencePackageDocument(
    fs,
    directory,
    selectedProductPath
  );
  if (!record) return null;
  try {
    const metaPath =
      sequencePackageMetaPaths(normalizedDirectory)[0] ??
      sequencePackagePaths(normalizedDirectory).metaPath;
    const generatedMembers = new Set<string>([
      ...sequencePackageMetaPaths(normalizedDirectory).map((path) => normalizeMemberPath(path)),
      normalizeMemberPath(metaPath),
      normalizeMemberPath(fromPackageRelative(record.product.file, normalizedDirectory)),
    ]);
    for (const member of record.members) {
      if (member.replaceable !== true) continue;
      generatedMembers.add(
        normalizeMemberPath(fromPackageRelative(member.path, normalizedDirectory))
      );
    }
    return generatedMembers;
  } catch {
    return null;
  }
}

export async function writeAcceptedAssemblyFiles(
  files: PreparedAcceptedAssemblyFiles,
  fs: AcceptedAssemblyFileOps
): Promise<AcceptedAssemblyWriteReceipt> {
  const packageExists = await fs.exists(files.packageRoot);
  const migratedPaths = new Set<string>();
  const recordMigration = (from: string, to?: string): void => {
    migratedPaths.add(normalizeMemberPath(from));
    if (to) migratedPaths.add(normalizeMemberPath(to));
  };
  let existingGeneratedMembers: Set<string> | null = null;
  let livePackage: SequencePackageDocument | null = null;
  if (!files.overwrite && packageExists) {
    throw new FinalizationPreconditionError(
      'output_exists',
      'Accepted assembly output already exists. Choose a different save folder before finalizing.'
    );
  }
  if (packageExists && files.overwrite) {
    if (fs.readTextFile) {
      try {
        const live = await loadSequencePackageDocument(files.packageRoot, {
          exists: fs.exists,
          readTextFile: fs.readTextFile,
          writeTextFile: fs.writeTextFile,
          writeWorkspaceTextFileAtomic: fs.writeWorkspaceTextFileAtomic,
          mkdir: fs.mkdir,
          move: async (sourcePath, destinationDir) => {
            const name = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? sourcePath;
            const destPath = `${destinationDir.replace(/\\/g, '/')}/${name}`;
            await fs.rename(sourcePath, destPath);
            recordMigration(sourcePath, destPath);
            return { destPath };
          },
          rename: async (from, to) => {
            await fs.rename(from, to);
            recordMigration(from, to);
          },
          unlink: fs.unlink
            ? async (path) => {
                await fs.unlink!(path);
                recordMigration(path);
              }
            : undefined,
        });
        livePackage = live;
        if (
          files.expectedExistingPackageChecksum &&
          (await computeChecksum(serializeSequencePackageDocument(live))) !==
            files.expectedExistingPackageChecksum
        ) {
          throw new Error('The package changed after finalization preview. Preview again.');
        }
        files.sidecarJsonContent = mergeLiveMembersIntoPreparedSidecar(
          files.sidecarJsonContent,
          live
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Refusing to overwrite: could not load the live package members (${message}).`
        );
      }
    }
    existingGeneratedMembers = fs.readTextFile
      ? await matchingExistingSequencePackageGeneratedMembers(
          { exists: fs.exists, readTextFile: fs.readTextFile },
          files.packageRoot,
          files.productGenBankPath
        )
      : null;
    if (!existingGeneratedMembers) {
      throw new Error(
        'Existing directory is not a valid plasmid package record for the selected product. ' +
          'Refusing to overwrite or remove any of its contents.'
      );
    }

    for (const target of [
      files.productGenBankPath,
      files.metaPath,
      files.primerCsvPath,
      files.primerFastaPath,
    ]) {
      if ((await fs.exists(target)) && !existingGeneratedMembers.has(normalizeMemberPath(target))) {
        throw new Error(
          `Refusing to replace "${target}": the existing package marker does not record it ` +
            'as a generated member, so it may be user-authored.'
        );
      }
    }
  }

  const preparedPackage = parseSequencePackageDocument(files.sidecarJsonContent);
  const acceptedVersionId = acceptedPayloadVersionId(preparedPackage.assembly?.accepted);
  if (!acceptedVersionId) {
    throw new Error('Accepted assembly publication is missing its version identity.');
  }
  const currentProductContent = livePackage
    ? await fs.readTextFile!(files.productGenBankPath)
    : null;
  const versioned = await prepareSequencePackageRevision({
    current: livePackage,
    currentProductContent,
    next: preparedPackage,
    nextProductContent: files.productGenBankContent,
    kind: 'assembly-finalization',
    operationId: `assembly-finalization:${acceptedVersionId}`,
    revisionId: `assembly-finalization:${acceptedVersionId}`,
    adoptedRevisionId: `adopted-before:${acceptedVersionId}`,
  });
  files.sidecarJsonContent = serializeSequencePackageDocument(versioned.document);
  files.snapshotFiles = versioned.snapshots;

  if (packageExists && fs.publishAcceptedAssemblyRevision) {
    if (!livePackage || currentProductContent === null) {
      throw new Error('Accepted assembly overwrite has no verified live package baseline.');
    }
    const result = await fs.publishAcceptedAssemblyRevision({
      packageRoot: files.packageRoot,
      packageId: livePackage.id,
      nextDocument: preparedPackage,
      nextProductContent: files.productGenBankContent,
      acceptedVersionId,
      expectedMarkerSha256: await computeChecksum(await fs.readTextFile!(files.metaPath)),
      expectedProductSha256: await computeChecksum(currentProductContent),
      primerAssets: [
        {
          path: toPackageRelative(files.primerCsvPath, files.packageRoot),
          sha256: files.primerCsvChecksum,
          content: files.primerCsvContent,
        },
        {
          path: toPackageRelative(files.primerFastaPath, files.packageRoot),
          sha256: files.primerFastaChecksum,
          content: files.primerFastaContent,
        },
      ],
    });
    files.sidecarJsonContent = result.markerContent;
    return {
      migratedPaths: [...migratedPaths],
      publicationPaths: [
        ...result.snapshotPaths,
        ...result.assetPaths,
        sequencePackagePaths(files.packageRoot).revisionJournalPath,
      ],
    };
  }

  const packageParent = files.packageRoot.slice(0, files.packageRoot.lastIndexOf('/'));
  if (packageParent && !(await fs.exists(packageParent))) {
    await fs.mkdir(packageParent, { recursive: true });
  }

  const scratch = await reservePackageScratch(files.packageRoot, fs);
  const staging = scratch.staging.path;

  const stagedPaths = sequencePackagePaths(staging, {
    productFile: `${files.basename}${acceptedGenBankExtension(files.productGenBankPath)}`,
  });
  const stagedContentsDir = stagedPaths.contentsDir;
  try {
    await fs.mkdir(staging, { recursive: true });
    await fs.mkdir(stagedPaths.metaDir, { recursive: true });
    await fs.mkdir(stagedContentsDir, { recursive: true });
    await fs.writeTextFile(stagedPaths.productPath, files.productGenBankContent);
    await fs.writeTextFile(stagedPaths.metaPath, files.sidecarJsonContent);
    await fs.writeTextFile(
      `${stagedContentsDir}/${files.primerCsvPath.split('/').pop()}`,
      files.primerCsvContent
    );
    await fs.writeTextFile(
      `${stagedContentsDir}/${files.primerFastaPath.split('/').pop()}`,
      files.primerFastaContent
    );
    for (const snapshot of files.snapshotFiles ?? []) {
      const name = snapshot.path.split('/').pop();
      if (!name) throw new Error('Sequence snapshot has no filename.');
      await fs.writeTextFile(`${stagedContentsDir}/${name}`, snapshot.content);
    }
  } catch (error) {
    await discard(fs, scratch.staging);
    if (scratch.managed) await discard(fs, scratch.previous);
    throw error;
  }

  if (packageExists) {
    await replaceGeneratedMembers(files, stagedPaths, scratch, fs);
    return { migratedPaths: [...migratedPaths] };
  }

  try {
    await renameScratchMember(fs, scratch, scratch.staging, staging, files.packageRoot);
  } catch (error) {
    await discard(fs, scratch.staging);
    if (scratch.managed) await discard(fs, scratch.previous);
    throw error;
  }
  if (scratch.managed) {
    await discard(fs, scratch.staging);
    await discard(fs, scratch.previous);
  }
  return { migratedPaths: [...migratedPaths] };
}

function normalizeMemberPath(path: string): string {
  return path.replace(/\\/g, '/');
}

type GeneratedMemberMove = {
  staged: string;
  target: string;
  previous: string;
};

type AcceptedAssemblyScratch = PackageScratchLeaseSet & {
  managed: boolean;
};

async function replaceGeneratedMembers(
  files: PreparedAcceptedAssemblyFiles,
  stagedPaths: ReturnType<typeof sequencePackagePaths>,
  scratch: AcceptedAssemblyScratch,
  fs: AcceptedAssemblyFileOps
): Promise<void> {
  const staging = scratch.staging.path;
  const displaced = scratch.previous.path;
  const displacedPaths = sequencePackagePaths(displaced, {
    productFile: `${files.basename}${acceptedGenBankExtension(files.productGenBankPath)}`,
  });
  const moves: GeneratedMemberMove[] = [
    {
      staged: stagedPaths.productPath,
      target: files.productGenBankPath,
      previous: displacedPaths.productPath,
    },
    { staged: stagedPaths.metaPath, target: files.metaPath, previous: displacedPaths.metaPath },
    {
      staged: `${stagedPaths.contentsDir}/${files.primerCsvPath.split('/').pop()}`,
      target: files.primerCsvPath,
      previous: `${displacedPaths.contentsDir}/${files.primerCsvPath.split('/').pop()}`,
    },
    {
      staged: `${stagedPaths.contentsDir}/${files.primerFastaPath.split('/').pop()}`,
      target: files.primerFastaPath,
      previous: `${displacedPaths.contentsDir}/${files.primerFastaPath.split('/').pop()}`,
    },
  ];
  const installedSnapshots: Array<{ staged: string; target: string }> = [];

  try {
    await fs.mkdir(displaced, { recursive: true });
    await fs.mkdir(displacedPaths.metaDir, { recursive: true });
    await fs.mkdir(displacedPaths.contentsDir, { recursive: true });
    await fs.mkdir(files.metaDir, { recursive: true });
    await fs.mkdir(sequencePackagePaths(files.packageRoot).contentsDir, { recursive: true });
    for (const snapshot of files.snapshotFiles ?? []) {
      const staged = fromPackageRelative(snapshot.path, staging);
      const target = fromPackageRelative(snapshot.path, files.packageRoot);
      if (await fs.exists(target)) {
        if (
          !fs.readTextFile ||
          (await computeChecksum(await fs.readTextFile(target))) !== snapshot.sha256
        ) {
          throw new Error(`Immutable sequence snapshot conflicts at ${snapshot.path}.`);
        }
        continue;
      }
      await renameScratchMember(fs, scratch, scratch.staging, staged, target);
      installedSnapshots.push({ staged, target });
    }
  } catch (error) {
    const rollbackErrors = await restoreStagedSnapshots(installedSnapshots, scratch, fs);
    if (rollbackErrors.length > 0) {
      throw recoveryFailure(error, rollbackErrors, staging, displaced, files.packageRoot);
    }
    await discard(fs, scratch.staging);
    await discard(fs, scratch.previous);
    throw error;
  }

  const backedUp: GeneratedMemberMove[] = [];
  try {
    for (const move of moves) {
      if (!(await fs.exists(move.target))) continue;
      await renameScratchMember(fs, scratch, scratch.previous, move.target, move.previous);
      backedUp.push(move);
    }
  } catch (error) {
    const rollbackErrors = [
      ...(await restorePreviousMembers(backedUp, scratch, fs)),
      ...(await restoreStagedSnapshots(installedSnapshots, scratch, fs)),
    ];
    if (rollbackErrors.length > 0) {
      throw recoveryFailure(error, rollbackErrors, staging, displaced, files.packageRoot);
    }
    await discard(fs, scratch.staging);
    await discard(fs, scratch.previous);
    throw error;
  }

  const installed: GeneratedMemberMove[] = [];
  try {
    for (const move of moves) {
      await renameScratchMember(fs, scratch, scratch.staging, move.staged, move.target);
      installed.push(move);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const move of [...installed].reverse()) {
      try {
        await renameScratchMember(fs, scratch, scratch.staging, move.target, move.staged);
      } catch (rollbackError) {
        rollbackErrors.push(
          `could not move new member "${move.target}" back to staging: ${errorMessage(rollbackError)}`
        );
      }
    }
    rollbackErrors.push(...(await restorePreviousMembers(backedUp, scratch, fs)));
    rollbackErrors.push(...(await restoreStagedSnapshots(installedSnapshots, scratch, fs)));
    if (rollbackErrors.length > 0) {
      throw recoveryFailure(error, rollbackErrors, staging, displaced, files.packageRoot);
    }
    await discard(fs, scratch.staging);
    await discard(fs, scratch.previous);
    throw error;
  }

  await discard(fs, scratch.staging);
  await discard(fs, scratch.previous);
}

async function restoreStagedSnapshots(
  installed: readonly { staged: string; target: string }[],
  scratch: AcceptedAssemblyScratch,
  fs: AcceptedAssemblyFileOps
): Promise<string[]> {
  const errors: string[] = [];
  for (const snapshot of [...installed].reverse()) {
    try {
      await renameScratchMember(fs, scratch, scratch.staging, snapshot.target, snapshot.staged);
    } catch (error) {
      errors.push(
        `could not roll back immutable snapshot "${snapshot.target}": ${errorMessage(error)}`
      );
    }
  }
  return errors;
}

async function restorePreviousMembers(
  backedUp: readonly GeneratedMemberMove[],
  scratch: AcceptedAssemblyScratch,
  fs: AcceptedAssemblyFileOps
): Promise<string[]> {
  const errors: string[] = [];
  for (const move of [...backedUp].reverse()) {
    try {
      await renameScratchMember(fs, scratch, scratch.previous, move.previous, move.target);
    } catch (error) {
      errors.push(
        `could not restore previous member "${move.previous}" to "${move.target}": ${errorMessage(error)}`
      );
    }
  }
  return errors;
}

function recoveryFailure(
  originalError: unknown,
  rollbackErrors: readonly string[],
  staging: string,
  displaced: string,
  packageRoot: string
): Error {
  return new Error(
    `Finalization failed AND generated members could not be fully restored at "${packageRoot}". ` +
      `Recovery data remains in "${staging}" and "${displaced}". Original error: ` +
      `${errorMessage(originalError)}. Rollback errors: ${rollbackErrors.join('; ')}`
  );
}

function mergeLiveMembersIntoPreparedSidecar(
  preparedSidecar: string,
  live: SequencePackageDocument
): string {
  const prepared = parseSequencePackageDocument(preparedSidecar);
  const primerExports = prepared.members.filter(
    (member) =>
      member.role === 'primer-export' &&
      !live.members.some((existing) => existing.path === member.path)
  );
  const keptLive = live.members;
  const next = buildSequencePackageDocument({
    id: prepared.id,
    name: prepared.name,
    product: prepared.product,
    members: [...keptLive, ...primerExports],
    assembly: prepared.assembly,
    updatedAt: prepared.updatedAt,
    existing: prepared,
  });
  return serializeSequencePackageDocument(next);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reservePackageScratch(
  packageRoot: string,
  fs: AcceptedAssemblyFileOps
): Promise<AcceptedAssemblyScratch> {
  if (fs.createScratch && fs.removeScratch && fs.renameScratch) {
    return { ...(await fs.createScratch(packageRoot)), managed: true };
  }
  if (fs.createScratch || fs.removeScratch || fs.renameScratch) {
    throw new Error(
      'Package scratch creation, cleanup, and member-rename capabilities must be supplied together.'
    );
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const lastSlash = packageRoot.lastIndexOf('/');
  const parentDirectory = lastSlash > 0 ? packageRoot.slice(0, lastSlash) : '';
  const rootName = packageRoot.slice(lastSlash + 1);
  const hidden = (suffix: string) => `${parentDirectory}/.${rootName}.${suffix}-${token}`;
  return {
    staging: { path: hidden('staging'), cleanupToken: '' },
    previous: { path: hidden('previous'), cleanupToken: '' },
    managed: false,
  };
}

async function renameScratchMember(
  fs: AcceptedAssemblyFileOps,
  scratch: AcceptedAssemblyScratch,
  lease: PackageScratchLease,
  from: string,
  to: string
): Promise<void> {
  if (scratch.managed) {
    if (!fs.renameScratch) {
      throw new Error('Managed package scratch member rename is unavailable.');
    }
    await fs.renameScratch(lease, from, to);
    return;
  }
  await fs.rename(from, to);
}

async function discard(fs: AcceptedAssemblyFileOps, lease: PackageScratchLease): Promise<void> {
  if (!fs.removeScratch) {
    console.warn(
      `[accepted-writer] no delete available; leaving scratch directory "${lease.path}" in place`
    );
    return;
  }
  await fs.removeScratch(lease).catch((error: unknown) => {
    console.warn(`[accepted-writer] could not remove scratch directory "${lease.path}":`, error);
  });
}

export function projectionInputToAnnotatedSequence(
  projectionInput: AcceptedAssemblyProjectionInput,
  options: { outputPath: string }
): AnnotatedSequence {
  return {
    id: options.outputPath,
    name: projectionInput.designName,
    sequence: projectionInput.productSequence,
    length: projectionInput.productSequence.length,
    circular: projectionInput.topology === 'circular',
    description: acceptedAssemblyDescription(projectionInput.assemblyMethod),
    annotations: projectAcceptedAssemblyProductAnnotations(projectionInput),
  };
}

function acceptedAssemblyDescription(method: AssemblyMethod): string {
  return `Accepted ${method} assembly generated by DNAForge. Construction metadata is stored in the paired .waypoint-assembly.json sidecar.`;
}

function normalizeSafeRelativeDirectory(input: string): string {
  const normalized = input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
  if (normalized === '' || normalized === '.') return '';
  if (isAbsolutePath(normalized)) {
    throw new Error('relativeDirectory must be relative to the selected project folder.');
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('relativeDirectory cannot contain . or .. path segments.');
  }
  return segments.join('/');
}

function normalizeSafeBasename(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('basename must be a non-empty file name.');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error('basename must be a file name, not a path.');
  }
  const withoutExtension = stripSequenceProductExtension(trimmed);
  if (!withoutExtension || withoutExtension === '.' || withoutExtension === '..') {
    throw new Error('basename must be a non-empty file name.');
  }
  return withoutExtension.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function acceptedGenBankExtension(input: string): SequenceProductExtension {
  return sequenceProductExtensionForPath(input) ?? '.gb';
}

function stripTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, '');
}

function isAbsolutePath(input: string): boolean {
  return input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input);
}
