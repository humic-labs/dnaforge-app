import { basename, isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type {
  ExternalPreviewReceipt,
  PreviewTabSnapshot,
  PromoteQuickLookPackageRequest,
  PromoteQuickLookPackageResult,
  QuickLookPackageReceipt,
} from '../../shared/file-association-ipc';
import { externalFormatForPath } from '../../shared/external-preview';
import {
  QUICK_LOOK_PACKAGE_STORE_DIRECTORY,
  type HandlerFamilyId,
} from '../../shared/file-associations';
import { readFileBoundedFromHandle } from '../ipc/bounded-file-read';
import { getDb } from '../ipc/database';
import { managedRootDir } from '../ipc/workspace-git';
import { assertSharedProjectContentWritable } from '../shared-project-write-access';
import { findKnownWorkspaceRoot } from '../workspace-git/known-workspace-scope';
import {
  QUICK_LOOK_STORE_MAX_BYTES,
  QUICK_LOOK_MAX_SOURCE_BYTES,
  quickLookPackageId,
  type QuickLookPackageStore,
} from './quick-look-package-store';
import { PreviewCache, type PreviewCacheKey } from './preview-cache';

type SavedReceipt = ExternalPreviewReceipt | QuickLookPackageReceipt;
type SaveDestination = PromoteQuickLookPackageRequest['destination'];
const ID = /^[a-f0-9]{64}$/u;

function sequenceReceipt(source: QuickLookPackageReceipt): ExternalPreviewReceipt {
  return {
    version: 1,
    packageId: quickLookPackageId(source),
    familyId: source.familyId,
    sourcePath: source.sourcePath,
    sourceFileName: source.sourceFileName,
    contentHash: source.contentHash,
    sequence: source,
  };
}

function normalize(value: SavedReceipt): ExternalPreviewReceipt {
  if (!value || typeof value !== 'object') throw Error('A saved preview is required.');
  if (!('version' in value)) {
    if (value.familyId !== 'genbank' && value.familyId !== 'snapgene')
      throw Error('Unknown legacy preview type.');
    return normalize(sequenceReceipt(value));
  }
  if (
    value.version !== 1 ||
    !ID.test(value.packageId) ||
    !ID.test(value.contentHash) ||
    typeof value.sourcePath !== 'string' ||
    !isAbsolute(value.sourcePath) ||
    basename(value.sourcePath) !== value.sourceFileName ||
    externalFormatForPath(value.sourcePath) !== value.familyId
  )
    throw Error('The saved preview receipt is invalid.');
  if (value.familyId === 'genbank' || value.familyId === 'snapgene') {
    const seq = value.sequence;
    if (
      !seq ||
      seq.familyId !== value.familyId ||
      seq.sourcePath !== value.sourcePath ||
      seq.contentHash !== value.contentHash ||
      seq.sourceFileName !== value.sourceFileName ||
      quickLookPackageId(seq) !== value.packageId
    )
      throw Error('The saved sequence identity does not match.');
  } else if (value.sequence) throw Error('The saved preview type does not match.');
  return value;
}

function key(receipt: ExternalPreviewReceipt): PreviewCacheKey {
  return `${receipt.sequence ? 'sequence' : 'source'}:${receipt.packageId}`;
}

export function createExternalPreviewLifecycle(
  userData: string,
  sequenceStore: QuickLookPackageStore,
  saveSequence: (request: PromoteQuickLookPackageRequest) => Promise<PromoteQuickLookPackageResult>
) {
  const sequence = join(userData, QUICK_LOOK_PACKAGE_STORE_DIRECTORY);
  const source = join(sequence, '.source-documents');
  const cache = new PreviewCache(
    { sequence, source },
    join(userData, 'preview-ownership.json'),
    QUICK_LOOK_STORE_MAX_BYTES
  );
  const native = () => import('../source-document-package-store');
  const workspaces = () => ({ db: getDb(), managedRootDir: managedRootDir() });
  const claim = async (
    sender: number,
    make: () => Promise<ExternalPreviewReceipt>,
    legacy = false
  ) => {
    const before = new Set((await cache.packages()).keys());
    let receipt: ExternalPreviewReceipt;
    try {
      receipt = await make();
    } catch (error) {
      if (!(error instanceof Error) || !/Quick Look storage is full/.test(error.message))
        throw error;
      await cache.sweep(true);
      receipt = await make();
    }
    await cache.admit(key(receipt), before);
    return { ...receipt, acquisitionId: await cache.acquire(sender, key(receipt), legacy) };
  };

  async function verifySourceIdentity(receipt: ExternalPreviewReceipt) {
    const service = await native();
    if (
      receipt.sequence ||
      receipt.familyId === 'genbank' ||
      receipt.familyId === 'snapgene' ||
      service.sourceDocumentPackageId(receipt.familyId, receipt.sourcePath, receipt.contentHash) !==
        receipt.packageId
    )
      throw Error('The saved document identity does not match.');
    return service;
  }
  async function verifiedSource(receipt: ExternalPreviewReceipt) {
    const service = await verifySourceIdentity(receipt);
    const snapshot = await service.readSourceDocumentPackage(source, receipt.packageId);
    const { descriptor } = snapshot;
    if (
      descriptor.familyId !== receipt.familyId ||
      descriptor.packageId !== receipt.packageId ||
      descriptor.sourceName !== receipt.sourceFileName ||
      descriptor.sha256 !== receipt.contentHash
    )
      throw Error('The saved document revision does not match.');
    return snapshot;
  }

  async function projectLocation(workspaceRoot: string, path: string) {
    const root = await realpath(workspaceRoot);
    const physicalPath = await realpath(path);
    const owner = await findKnownWorkspaceRoot(physicalPath, workspaces());
    if (!owner || (await realpath(owner)) !== root)
      throw Error('This package is outside its registered project.');
    return { root, physicalPath };
  }

  return {
    open: (sender: number, path: string, familyId: HandlerFamilyId, legacy = false) =>
      cache.run(() =>
        claim(
          sender,
          async () => {
            if (externalFormatForPath(path) !== familyId)
              throw Error('The requested file format does not match its name.');
            if (familyId === 'genbank' || familyId === 'snapgene')
              return sequenceReceipt(
                await sequenceStore.materialize({ sourcePath: path, familyId })
              );
            const descriptor = await (
              await native()
            ).prepareSourceDocumentPackage(
              source,
              { familyId, sourcePath: path },
              readFileBoundedFromHandle
            );
            return {
              version: 1 as const,
              packageId: descriptor.packageId,
              familyId,
              sourcePath: path,
              sourceFileName: descriptor.sourceName,
              contentHash: descriptor.sha256,
            };
          },
          legacy
        )
      ),
    adopt: (sender: number, saved: SavedReceipt) =>
      cache.run(() =>
        claim(sender, async () => {
          const receipt = normalize(saved);
          if (receipt.sequence)
            return sequenceReceipt(await sequenceStore.recoverReceipt(receipt.sequence));
          await verifiedSource(receipt);
          return receipt;
        })
      ),
    release: (sender: number, receipt: ExternalPreviewReceipt) =>
      cache.run(() => cache.release(sender, receipt?.acquisitionId)),
    sync: (sender: number, input: PreviewTabSnapshot) =>
      cache.run(async () => {
        if (!Array.isArray(input?.receipts)) throw Error('Preview tabs must be a list.');
        await cache.sync(
          sender,
          input.ownerId,
          input.receipts.map((item) => key(normalize(item)))
        );
      }),
    detach: (sender: number) => cache.run(() => cache.detach(sender)),
    sweep: () => cache.run(() => cache.sweep()),
    read: (input: ExternalPreviewReceipt) =>
      cache.run(async () => {
        const receipt = normalize(input);
        if (receipt.sequence)
          return readFileBoundedFromHandle(
            await sequenceStore.originalPath(receipt.sequence),
            QUICK_LOOK_MAX_SOURCE_BYTES[receipt.sequence.familyId]
          );
        return (await verifiedSource(receipt)).bytes;
      }),
    original: (input: ExternalPreviewReceipt) =>
      cache.run(async () => {
        const receipt = normalize(input);
        if (receipt.sequence) return sequenceStore.originalPath(receipt.sequence);
        return (await verifiedSource(receipt)).descriptor.originalPath;
      }),
    save: (input: SavedReceipt, destination: SaveDestination) =>
      cache.run(async () => {
        const receipt = normalize(input);
        if (
          !destination ||
          (destination.kind !== 'new-workspace' && destination.kind !== 'existing-workspace') ||
          (destination.kind === 'new-workspace'
            ? typeof destination.name !== 'string'
            : typeof destination.rootPath !== 'string' || !isAbsolute(destination.rootPath))
        )
          throw Error('A project destination is required.');
        if (receipt.sequence) {
          if (destination.kind === 'existing-workspace') {
            const deps = workspaces();
            const root = await findKnownWorkspaceRoot(destination.rootPath, deps);
            if (!root) throw Error('Choose a registered project for this sequence.');
            assertSharedProjectContentWritable(deps.db, root);
          }
          return saveSequence({ receipt: receipt.sequence, destination });
        }
        await verifiedSource(receipt);
        return (await native()).importSourceDocumentPackage(
          source,
          receipt.packageId,
          destination.kind === 'existing-workspace' ? destination.rootPath : null,
          workspaces(),
          destination.kind === 'new-workspace' ? destination.name : undefined
        );
      }),
    presentation: (input: ExternalPreviewReceipt) =>
      cache.run(async () => {
        const receipt = normalize(input);
        const service = await verifySourceIdentity(receipt);
        return service.readSourceDocumentPresentation(source, receipt.packageId);
      }),
    projectPresentation: async (
      workspaceRoot: string,
      path: string,
      expected?: { expectedPackageId?: string; expectedSourceSha256?: string }
    ) => {
      const { root, physicalPath } = await projectLocation(workspaceRoot, path);
      return (await native()).readProjectSourceDocumentPresentation(root, physicalPath, expected);
    },
    project: async (workspaceRoot: string, path: string) => {
      const { root, physicalPath } = await projectLocation(workspaceRoot, path);
      const { descriptor, bytes } = await (
        await native()
      ).readProjectSourceDocumentPackage(root, physicalPath);
      return {
        packageId: descriptor.packageId,
        packageInstanceId: descriptor.packageId,
        familyId: descriptor.familyId,
        sourceFileName: descriptor.sourceName,
        contentHash: descriptor.sha256,
        entryPath: descriptor.entryPath,
        productPaths: descriptor.productPaths,
        presentation: descriptor.presentation,
        bytes,
      };
    },
  };
}
export type ExternalPreviewLifecycle = ReturnType<typeof createExternalPreviewLifecycle>;
