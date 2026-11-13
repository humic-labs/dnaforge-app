import { decodeGenBankLocusName } from '@waypoint/sequence-utils';
import type { ManagedSequenceDocumentRef } from '../../shared/managed-sequence-document';
import {
  GENBANK_LOCUS_ENCODING_COMMENT,
  isCustomGeneticCodeSpec,
  updateGenBankGeneticCodeComment,
  validateCustomGeneticCode,
  type CustomGeneticCodeDefinition,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import { updateGenBankLocusMetadata } from '../../shared/genbank-locus-metadata';
export {
  renameGenBankLocus,
  updateGenBankLocusMetadata,
} from '../../shared/genbank-locus-metadata';
import { geneticCodeChangeSubject } from './genetic-code-change-subject';
import {
  fromPackageRelative,
  isSequencePackageFileKind,
  isSequencePackageMetaPath,
  parseSequencePackageDocument,
  resolveSequenceProductFile,
  sequencePackageRootForMetaPath,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from '../../db/sequence-package';
import {
  findEnclosingSequencePackageRoot,
  loadSequencePackageDocument,
  locateSequencePackageMetaPath,
} from '../../db/sequence-package-io';
import { platform } from '../../platform';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import {
  getCurrentSequenceFileForDocumentId,
  findWorkspaceRootForPath,
} from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { gitCommitPaths, gitRepoRoot } from '../workspace/public/git';
import { SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME } from '../../db/sequence-package-contract';
import { acceptedSequenceMetadataOwner } from './accepted-sequence-metadata';
import type {
  AcceptedSequenceMetadataOwner,
  ManagedSequenceRepository,
  ManagedSequenceResolutionOptions,
  ResolvedManagedSequenceDocument,
} from './managed-sequence-repository-types';
export type {
  AcceptedSequenceMetadataOwner,
  ManagedSequenceRepository,
  ManagedSequenceResolutionOptions,
  ResolvedManagedSequenceDocument,
  UpdateManagedSequenceMetadataOptions,
} from './managed-sequence-repository-types';
import type {
  SequenceMetadataRevisionRequest,
  SequenceMetadataRevisionResult,
} from '../../shared/sequence-package-revision';

type ManagedSequenceFs = Pick<
  ReturnType<typeof platform>['fs'],
  | 'exists'
  | 'readTextFile'
  | 'writeTextFile'
  | 'mkdir'
  | 'move'
  | 'readFile'
  | 'rename'
  | 'readDir'
  | 'writeWorkspaceTextFileAtomic'
> & {
  recoverLegacySequenceMetadataTransaction?(
    packageRoot: string,
    mutationToken?: string
  ): Promise<void>;
};

interface ManagedSequenceMetadataCommit {
  packageRoot: string;
  metaPath: string;
  productPath: string;
  productChanged: boolean;
  transactionPath?: string;
  name: string;

  changes?: readonly string[];
  snapshotPaths?: readonly string[];
}

function metadataFieldsUnchanged(
  current: SequencePackageDocument,
  next: SequencePackageDocument
): boolean {
  return JSON.stringify(current.entity.fields) === JSON.stringify(next.entity.fields);
}

function platformFs(): ManagedSequenceFs {
  return platform().fs;
}

function filesystemForResolution(fs: ManagedSequenceFs, mutationToken?: string): ManagedSequenceFs {
  if (!mutationToken) return fs;
  const recoverLegacy = fs.recoverLegacySequenceMetadataTransaction;

  return {
    ...fs,
    writeTextFile: (path, content, options) =>
      fs.writeTextFile(path, content, options, mutationToken),
    writeWorkspaceTextFileAtomic: (input) =>
      fs.writeWorkspaceTextFileAtomic({ ...input, mutationToken }),
    mkdir: (path, options) => fs.mkdir(path, options, mutationToken),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath, mutationToken),
    recoverLegacySequenceMetadataTransaction: recoverLegacy
      ? (packageRoot) => recoverLegacy(packageRoot, mutationToken)
      : undefined,
  };
}

async function commitMetadataUpdate(input: ManagedSequenceMetadataCommit): Promise<void> {
  const repoRoot = await gitRepoRoot(input.metaPath);
  if (!repoRoot) return;
  const absolutePaths = [
    input.metaPath,
    ...(input.productChanged ? [input.productPath] : []),
    ...(input.transactionPath ? [input.transactionPath] : []),
    ...(input.snapshotPaths ?? []),
  ];
  const relativePaths = absolutePaths.map((path) => {
    const relativePath = pathRelativeToBoundary(path, repoRoot);
    if (!relativePath) {
      throw new Error(`Sequence package member is outside its Git workspace: ${path}`);
    }
    return relativePath;
  });

  const summary = input.changes?.length ? input.changes.join(', ') : 'metadata';
  await gitCommitPaths(repoRoot, `Update ${summary} for ${input.name}`, relativePaths);
}

export function createManagedSequenceRepository(
  getFs: () => ManagedSequenceFs = platformFs,
  discoverArtifacts: (rootPath: string) => Promise<readonly string[]> = async (rootPath) =>
    (
      await platform().workspace.discoverArtifacts({
        rootPath,
        knownFiles: [],
      })
    ).entityArtifactPaths,
  commitUpdate: (input: ManagedSequenceMetadataCommit) => Promise<void> = commitMetadataUpdate,
  preparePackage: (packageRoot: string) => Promise<void> = async () => undefined,
  publishRevision?: (
    request: SequenceMetadataRevisionRequest
  ) => Promise<SequenceMetadataRevisionResult>,
  currentPackageRoot: (packageId: string) => Promise<string | null> = async () => null,
  acceptedOwner?: AcceptedSequenceMetadataOwner,
  owningWorkspaceRoot: (packageRoot: string) => string = (packageRoot) => packageRoot
): ManagedSequenceRepository {
  const captured = new WeakMap<ManagedSequenceDocumentRef, ResolvedManagedSequenceDocument>();
  const openPackage = async (
    packageRoot: string,
    options: ManagedSequenceResolutionOptions = {}
  ): Promise<ResolvedManagedSequenceDocument> => {
    const fs = filesystemForResolution(getFs(), options.mutationToken);
    const accepted = await acceptedOwner?.load(packageRoot);
    if (accepted) return accepted;
    await preparePackage(packageRoot);
    if (await fs.exists(metadataTransactionPath(packageRoot))) {
      if (fs.recoverLegacySequenceMetadataTransaction) {
        await fs.recoverLegacySequenceMetadataTransaction(packageRoot);
      } else {
        await recoverMetadataTransaction(packageRoot, fs);
      }
    }
    const document = await loadSequencePackageDocument(
      packageRoot,
      fs,
      owningWorkspaceRoot(packageRoot)
    );
    const entries = await fs.readDir(packageRoot);
    const productFile = resolveSequenceProductFile(document.product.file, entries);
    const normalizedRoot = sequencePackagePaths(packageRoot).root;
    const ref: ManagedSequenceDocumentRef = {
      kind: 'managed-sequence',
      packageId: document.id,
      packageRoot: normalizedRoot,
    };
    return {
      ref,
      document,
      productPath: fromPackageRelative(productFile, normalizedRoot),
    };
  };

  const resolve = async (
    ref: ManagedSequenceDocumentRef,
    options: ManagedSequenceResolutionOptions = {}
  ): Promise<ResolvedManagedSequenceDocument> => {
    let packageRoot = (await currentPackageRoot(ref.packageId)) ?? ref.packageRoot;
    let resolved: ResolvedManagedSequenceDocument;
    try {
      resolved = await openPackage(packageRoot, options);
    } catch (error) {
      const currentRoot = await currentPackageRoot(ref.packageId);
      if (!currentRoot || currentRoot === packageRoot) throw error;
      packageRoot = currentRoot;
      resolved = await openPackage(packageRoot, options);
    }
    if (resolved.document.id !== ref.packageId) {
      throw new Error(
        `Sequence package identity changed at ${packageRoot}: expected ${ref.packageId}, found ${resolved.document.id}.`
      );
    }
    if (resolved.accepted) captured.set(ref, resolved);
    return resolved;
  };

  return {
    async findByMemberPath(path, options) {
      const packageRoot = await findEnclosingSequencePackageRoot(path, getFs());
      return packageRoot ? openPackage(packageRoot, options) : null;
    },
    async findById(packageId, workspaceRoots, options) {
      const matches: ResolvedManagedSequenceDocument[] = [];
      for (const rootPath of workspaceRoots) {
        for (const metaPath of await discoverArtifacts(rootPath)) {
          if (!isSequencePackageMetaPath(metaPath)) continue;
          const packageRoot = sequencePackageRootForMetaPath(metaPath);
          if (!packageRoot) continue;
          const candidate = await openPackage(packageRoot, options).catch(() => null);
          if (!candidate) continue;
          if (candidate.document.id === packageId) matches.push(candidate);
        }
      }
      if (matches.length > 1) {
        throw new Error(`Duplicate managed sequence package identity: ${packageId}.`);
      }
      return matches[0] ?? null;
    },
    openPackage,
    resolve,
    async updateMetadata(requestedRef, update, options = {}) {
      const fs = getFs();
      const current = captured.get(requestedRef) ?? (await resolve(requestedRef));
      const ref = current.ref;
      if (current.accepted) {
        const next = update(current.document);
        if (next.id !== ref.packageId)
          throw new Error('Managed sequence metadata updates cannot change package identity.');
        const saved = await acceptedOwner!.save(current, next, options);
        await resolve(requestedRef);
        return saved;
      }
      const metaPath =
        (await locateSequencePackageMetaPath(ref.packageRoot, fs.exists)) ??
        sequencePackagePaths(ref.packageRoot).metaPath;
      const currentMarkerContent = await fs.readTextFile(metaPath);
      const authoritativeCurrent = parseSequencePackageDocument(currentMarkerContent);
      if (authoritativeCurrent.id !== ref.packageId) {
        throw new Error('Managed sequence metadata target changed after it was resolved.');
      }
      const next = update(authoritativeCurrent);
      if (next.id !== ref.packageId) {
        throw new Error('Managed sequence metadata updates cannot change package identity.');
      }
      const nameChanged = next.name !== authoritativeCurrent.name;
      const topologyChanged = next.product.topology !== authoritativeCurrent.product.topology;

      const geneticCodeChanged = options.geneticCode !== undefined;
      const previousLocus = recordedLocusField(authoritativeCurrent.entity.fields);
      const nextLocus = recordedLocusField(next.entity.fields);
      const locusChanged = nextLocus !== undefined && nextLocus !== previousLocus;
      const currentProduct = locusChanged ? await fs.readTextFile(current.productPath) : undefined;
      const writeLocusName =
        locusChanged && nextLocus !== fileLocusName(currentProduct ?? '') ? nextLocus : undefined;

      const productChanged = topologyChanged || geneticCodeChanged || writeLocusName !== undefined;
      const changes: string[] = [];
      if (nameChanged) changes.push(`name (${authoritativeCurrent.name} -> ${next.name})`);
      if (topologyChanged) changes.push(`topology (${next.product.topology})`);
      if (locusChanged) changes.push(`locus (${previousLocus ?? 'none'} -> ${nextLocus})`);
      if (geneticCodeChanged) changes.push(geneticCodeChangeSubject(options.geneticCode ?? null));
      if (!metadataFieldsUnchanged(authoritativeCurrent, next)) changes.push('fields');

      if (publishRevision) {
        const result = await publishRevision({
          document: ref,
          expectedMarkerSha256: `sha256:${await sha256Text(currentMarkerContent)}`,
          operationId: globalThis.crypto.randomUUID(),
          proposed: {
            name: next.name,
            topology: next.product.topology,
            entity: next.entity,
            ...(options.geneticCode !== undefined ? { geneticCode: options.geneticCode } : {}),
          },
        });
        const published = parseSequencePackageDocument(result.updatedMarkerContent);
        if (result.revisionId && !result.alreadyPublished) {
          await commitUpdate({
            packageRoot: ref.packageRoot,
            metaPath,
            productPath: current.productPath,
            productChanged: result.productChanged,
            transactionPath: sequencePackagePaths(ref.packageRoot).revisionJournalPath,
            snapshotPaths: result.snapshotPaths,
            name: published.name,
            changes,
          });
        }
        return published;
      }

      const nextMetadata = serializeSequencePackageDocument(next);
      let transactionPath: string | undefined;
      if (productChanged) {
        transactionPath = metadataTransactionPath(ref.packageRoot);
        await writeMetadataTransaction(fs, ref.packageRoot, transactionPath, {
          schema: 'waypoint.sequence-metadata-transaction.v1',
          state: 'pending',
          packageId: ref.packageId,
          targetDocument: next,
          ...(geneticCodeChanged ? { targetGeneticCode: options.geneticCode ?? null } : {}),
          applyLocus: false,
          ...(writeLocusName ? { locusName: writeLocusName } : {}),
          ...(topologyChanged ? { applyTopology: true } : {}),
        });
        if (fs.recoverLegacySequenceMetadataTransaction) {
          await fs.recoverLegacySequenceMetadataTransaction(ref.packageRoot);
        } else {
          await recoverMetadataTransaction(ref.packageRoot, fs);
        }
      } else {
        await atomicSetText(fs, ref.packageRoot, metaPath, nextMetadata);
      }
      await commitUpdate({
        packageRoot: ref.packageRoot,
        metaPath,
        productPath: current.productPath,
        productChanged,
        transactionPath,
        name: next.name,
        changes,
      });
      return next;
    },
  };
}

const METADATA_TRANSACTION_SCHEMA = 'waypoint.sequence-metadata-transaction.v1' as const;

type SequenceMetadataTransaction =
  | {
      schema: typeof METADATA_TRANSACTION_SCHEMA;
      state: 'pending';
      packageId: string;
      targetDocument: SequencePackageDocument;

      targetGeneticCode?: GeneticCodeSpec | null;

      applyLocus?: boolean;

      locusName?: string;

      applyTopology?: boolean;
    }
  | {
      schema: typeof METADATA_TRANSACTION_SCHEMA;
      state: 'complete';
      packageId: string;
      completedAt: string;
    };

function metadataTransactionPath(packageRoot: string): string {
  return `${sequencePackagePaths(packageRoot).metaDir}/${SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME}`;
}

async function recoverMetadataTransaction(
  packageRoot: string,
  fs: ManagedSequenceFs
): Promise<void> {
  const transactionPath = metadataTransactionPath(packageRoot);
  if (!(await fs.exists(transactionPath))) return;
  const transaction = parseMetadataTransaction(await fs.readTextFile(transactionPath));
  if (transaction.state === 'complete') return;

  const target = transaction.targetDocument;
  if (target.id !== transaction.packageId) {
    throw new Error('Sequence metadata transaction package identity does not match its target.');
  }
  const paths = sequencePackagePaths(packageRoot, { productFile: target.product.file });
  const liveMarker = parseSequencePackageDocument(await fs.readTextFile(paths.metaPath));
  if (
    liveMarker.versionHistory.headId !== null &&
    JSON.stringify(liveMarker) !== JSON.stringify(target)
  ) {
    throw new Error(
      'Pending legacy metadata recovery conflicts with a newer sequence revision. No package files were changed.'
    );
  }
  const currentProduct = await fs.readTextFile(paths.productPath);
  const legacyLocusRewrite =
    transaction.applyLocus !== false &&
    transaction.locusName === undefined &&
    transaction.applyTopology !== true;
  const withLocus = legacyLocusRewrite
    ? updateGenBankLocusMetadata(currentProduct, {
        name: target.name,
        topology: target.product.topology,
      })
    : applyRecordedLocusEdit(currentProduct, transaction, target);
  const targetProduct =
    transaction.targetGeneticCode === undefined
      ? withLocus
      : updateGenBankGeneticCodeComment(withLocus, transaction.targetGeneticCode);
  await atomicSetText(fs, packageRoot, paths.productPath, targetProduct);
  await atomicSetText(fs, packageRoot, paths.metaPath, serializeSequencePackageDocument(target));
  await writeMetadataTransaction(fs, packageRoot, transactionPath, {
    schema: METADATA_TRANSACTION_SCHEMA,
    state: 'complete',
    packageId: target.id,
    completedAt: new Date().toISOString(),
  });
}

async function writeMetadataTransaction(
  fs: ManagedSequenceFs,
  packageRoot: string,
  path: string,
  transaction: SequenceMetadataTransaction
): Promise<void> {
  await atomicSetText(fs, packageRoot, path, `${JSON.stringify(transaction, null, 2)}\n`);
}

async function atomicSetText(
  fs: ManagedSequenceFs,
  packageRoot: string,
  path: string,
  content: string
): Promise<void> {
  const exists = await fs.exists(path);
  if (exists) {
    const current = await fs.readTextFile(path);
    if (current === content) return;
    await fs.writeWorkspaceTextFileAtomic({
      workspaceRoot: packageRoot,
      path,
      content,
      mode: 'replace',
      expectedContentHash: await sha256Text(current),
      artifactNoun: 'sequence package',
    });
    return;
  }
  await fs.writeWorkspaceTextFileAtomic({
    workspaceRoot: packageRoot,
    path,
    content,
    mode: 'create',
    artifactNoun: 'sequence package',
  });
}

function parseMetadataTransaction(content: string): SequenceMetadataTransaction {
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sequence metadata transaction must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== METADATA_TRANSACTION_SCHEMA || typeof record.packageId !== 'string') {
    throw new Error('Sequence metadata transaction identity is invalid.');
  }
  if (record.state === 'complete' && typeof record.completedAt === 'string') {
    return record as SequenceMetadataTransaction;
  }
  if (record.state === 'pending') {
    const geneticCode = record.targetGeneticCode;

    const validGeneticCode =
      geneticCode === null ||
      (typeof geneticCode === 'number' && Number.isInteger(geneticCode)) ||
      (isCustomGeneticCodeSpec(geneticCode as GeneticCodeSpec) &&
        validateCustomGeneticCode(geneticCode as CustomGeneticCodeDefinition).length === 0);
    return {
      schema: METADATA_TRANSACTION_SCHEMA,
      state: 'pending',
      packageId: record.packageId,
      targetDocument: parseSequencePackageDocument(JSON.stringify(record.targetDocument)),
      ...(validGeneticCode ? { targetGeneticCode: geneticCode as GeneticCodeSpec | null } : {}),
      ...(record.applyLocus === false ? { applyLocus: false } : {}),
      ...(typeof record.locusName === 'string' && record.locusName.trim()
        ? { locusName: record.locusName.trim() }
        : {}),
      ...(record.applyTopology === true ? { applyTopology: true as const } : {}),
    };
  }
  throw new Error('Sequence metadata transaction state is invalid.');
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function recordedLocusField(fields: Record<string, unknown> | undefined): string | undefined {
  const value = fields?.locus;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fileLocusName(content: string): string | undefined {
  const line = content.split(/\r?\n/).find((entry) => entry.startsWith('LOCUS'));
  if (!line) return undefined;
  const match = line.match(/^LOCUS\s+(.+?)\s+\d+\s+bp\b/i);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  return content.split(/\r?\n/).includes(GENBANK_LOCUS_ENCODING_COMMENT)
    ? decodeGenBankLocusName(raw)
    : raw;
}

function applyRecordedLocusEdit(
  content: string,
  transaction: Extract<SequenceMetadataTransaction, { state: 'pending' }>,
  target: SequencePackageDocument
): string {
  const name = transaction.locusName;
  const topology = transaction.applyTopology ? target.product.topology : undefined;
  if (!name && !topology) return content;
  return updateGenBankLocusMetadata(content, {
    ...(name ? { name } : {}),
    ...(topology ? { topology } : {}),
  });
}

export const managedSequenceRepository = createManagedSequenceRepository(
  platformFs,
  async (rootPath) =>
    (
      await platform().workspace.discoverArtifacts({
        rootPath,
        knownFiles: [],
      })
    ).entityArtifactPaths,
  commitMetadataUpdate,
  async (packageRoot) => {
    await platform().fileAssociations.prepareQuickLookPackage({ packageRoot });
  },
  (request) => platform().fs.publishSequenceMetadataRevision(request),
  async (packageId) => {
    const binding = await getCurrentSequenceFileForDocumentId(packageId);
    if (!binding) return null;
    if (!isSequencePackageFileKind(binding.file_kind)) {
      throw new Error(`Sequence package ${packageId} no longer has a current package binding.`);
    }
    return binding.path;
  },
  acceptedSequenceMetadataOwner,
  (packageRoot) =>
    findWorkspaceRootForPath(useWorkspaceStore.getState().folders, packageRoot) ?? packageRoot
);
