import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ComputeRecoveryResult } from '../../shared/compute-jobs-ipc';
import { z } from 'zod';
import { canonicalJson } from '../../shared/canonical-json';
import { publishNativeCatalogBytes } from '../native-catalog-publication';
import { assertWorkspaceProjectionPathSafe } from '../workspace-projection-boundary';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import { assertWorkspaceWriteAllowed } from '../workspace-write-admission';
import { hashWorkspaceSyncFileOnDisk } from '../workspace-sync-blob-cache';
import { flushFile, syncDirectory } from '../fs-durability';
import { captureComputeResultJob, publishComputeResultJob } from './compute-result-publication';
import {
  assertComputeSourceUnchanged,
  inventoryComputeSource,
  retainComputeSource,
} from './compute-result-retention';
import { materializeCoordinatePackage } from './coordinate-package-import';
import { settleCompletedMolecularMigrationLinks } from './molecular-migration-journal';
import {
  captureComputeNativeMembers,
  computeNativePlanSchema,
} from './compute-native-result-members';
import { parseSequencePackageDocument, sequencePackagePaths } from '../../db/sequence-package';
import {
  isConstructSequenceFile,
  materializeImportedSequencePackages,
  previewImportedSequencePackages,
} from './sequence-package-import';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const path = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/[\\\0:*?"<>|]/u.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git')
  );
const physical = z
  .object({ device: z.string(), inode: z.string(), modifiedNs: z.string(), changedNs: z.string() })
  .strict();
const entry = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('directory'),
      relativePath: path,
      mode: z.number().int().min(0).max(511),
      identity: physical,
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      relativePath: path,
      mode: z.number().int().min(0).max(511),
      identity: physical,
      sha256: hash,
      byteLength: z.number().int().nonnegative(),
    })
    .strict(),
]);
const inventory = z
  .object({
    rootIdentity: physical,
    rootMode: z.number().int().min(0).max(511),
    entries: z.array(entry),
    treeSha256: hash,
  })
  .strict();
export const computeRecoveryManifestSchema = z
  .object({
    schema: z.literal('dnaforge.compute-result-recovery.v1'),
    operationId: hash,
    attempt: z.string().regex(/^attempt-[a-zA-Z0-9]+$/u),
    witness: z
      .object({
        workspaceId: z.number().int(),
        workspaceRoot: z.string(),
        workspaceRepoUuid: z.string().min(1),
        jobId: z.string().min(1),
        provider: z.string(),
        remoteId: z.string(),
        sourceRelativePath: path,
        previousPathsJson: z.string(),
        previousDetailsJson: z.string().nullable(),
      })
      .strict(),
    source: inventory,
    output: inventory,
    native: computeNativePlanSchema.optional(),
  })
  .strict();
type Manifest = z.infer<typeof computeRecoveryManifestSchema>;
export type ComputeRecoveryPhase =
  | 'prepared'
  | 'file-published'
  | 'database-published'
  | 'completion-recorded';
export interface ComputeRecoveryInput {
  workspaceRoot: string;
  provider: string;
  remoteId: string;
}

export async function recoverComputeResult(
  db: Database.Database,
  input: ComputeRecoveryInput,
  options: {
    checkpoint?: (phase: ComputeRecoveryPhase, path?: string) => Promise<void>;
    assertCurrent?: () => void;
  } = {}
): Promise<ComputeRecoveryResult> {
  if (
    ![input.provider, input.remoteId].every(
      (value) => /^[a-zA-Z0-9_.-]+$/u.test(value) && value !== '.' && value !== '..'
    )
  )
    throw new Error('COMPUTE_RECOVERY_SOURCE_INVALID');
  const release = await acquireWorkspaceSyncMutationLease(input.workspaceRoot);
  const assertCurrent = () => {
    options.assertCurrent?.();
    assertWorkspaceWriteAllowed(db, [input.workspaceRoot]);
  };
  try {
    assertCurrent();
    const operationId = digest(canonicalJson(input));
    const base = `.dnaforge/compute-results/${operationId}`;
    const targetRelativePath = `Recovered compute ${operationId.slice(0, 12)}`;
    const sourceRelativePath = `compute/${input.provider}/${input.remoteId}`;
    const sourceRoot = join(input.workspaceRoot, sourceRelativePath);
    const baseRoot = join(input.workspaceRoot, base);
    const manifestPath = join(baseRoot, 'manifest.json');
    const durable = async (name: string, value: unknown) => {
      assertCurrent();
      return publishNativeCatalogBytes({
        workspacePath: input.workspaceRoot,
        operationId: `compute-${operationId}-${name}`,
        relativePath: `${base}/${name}.json`,
        beforeBytes: null,
        afterBytes: Buffer.from(canonicalJson(value)),
      });
    };
    let bytes = await readOptional(input.workspaceRoot, manifestPath);
    let manifest: Manifest;
    if (bytes === null) {
      const witness = captureComputeResultJob(db, { ...input, sourceRelativePath });
      assertWorkspaceProjectionPathSafe(input.workspaceRoot, sourceRoot);
      const source = await inventoryComputeSource(sourceRoot);
      const native = await captureComputeNativeMembers(db, {
        workspaceRoot: input.workspaceRoot,
        sourceRoot,
        workspaceId: witness.workspaceId,
        source,
        importedPaths: JSON.parse(witness.previousPathsJson) as string[],
        targetRoot: join(input.workspaceRoot, targetRelativePath),
      });
      assertWorkspaceProjectionPathSafe(input.workspaceRoot, baseRoot);
      await mkdir(baseRoot, { recursive: true });
      const attemptRoot = await mkdtemp(join(baseRoot, 'attempt-'));
      await syncDirectory(baseRoot);
      const retainedRoot = join(attemptRoot, 'original');
      const outputRoot = join(attemptRoot, 'output');
      await retainComputeSource({ sourceRoot, retainedRoot, expected: source });
      await retainComputeSource({ sourceRoot, retainedRoot: outputRoot, expected: source });
      for (const directory of [
        outputRoot,
        ...source.entries
          .filter((item) => item.kind === 'directory')
          .map((item) => join(outputRoot, item.relativePath)),
      ])
        await chmod(directory, 0o700);
      for (const member of native.members.filter((member) =>
        member.disposition.startsWith('retain-')
      )) {
        assertCurrent();
        const path = join(outputRoot, member.path);
        assertWorkspaceProjectionPathSafe(input.workspaceRoot, path);
        await rm(path, { recursive: true });
      }
      for (const item of source.entries) {
        if (
          item.kind !== 'file' ||
          item.relativePath.split('/').some((part) => part.startsWith('.')) ||
          native.members.some(
            (member) =>
              !(
                member.kind === 'file' &&
                member.disposition === 'transfer' &&
                !member.preserveDirect
              ) &&
              (item.relativePath === member.path || item.relativePath.startsWith(member.path + '/'))
          )
        )
          continue;
        assertCurrent();
        const filePath = join(outputRoot, item.relativePath);
        const bound = native.members.find(
          (member) =>
            member.kind === 'file' &&
            member.disposition === 'transfer' &&
            member.path === item.relativePath
        );
        if (isConstructSequenceFile(filePath)) {
          if (bound) {
            const preview = await previewImportedSequencePackages(filePath, { automatic: true });
            if (preview.kind === 'blocked') {
              if (
                ![
                  'source_too_large',
                  'automatic_split_required',
                  'non_dna_content',
                  'lossless_conversion_blocked',
                  'unsupported_source_kind',
                ].includes(preview.reasonCode ?? '')
              )
                throw new Error(`COMPUTE_RECOVERY_CONVERSION_REFUSED: ${preview.reason}`);
              bound.preserveDirect = true;
              bound.directReason = preview.reason;
              continue;
            }
          }
          const result = await materializeImportedSequencePackages(filePath, undefined, {
            automatic: true,
            expectedSourceSha256: item.sha256,
            ...(bound ? { packageId: bound.entityId } : {}),
          });
          if (result.skippedReason)
            throw new Error(`COMPUTE_RECOVERY_CONVERSION_REFUSED: ${result.skippedReason}`);
          if (bound) {
            const owned = [];
            for (const pkg of result.packages)
              if (
                parseSequencePackageDocument(
                  await readFile(sequencePackagePaths(pkg.packageRoot).metaPath, 'utf8')
                ).id === bound.entityId
              )
                owned.push(pkg);
            if (!result.converted || owned.length !== 1)
              throw new Error('COMPUTE_RECOVERY_NATIVE_SEQUENCE_NOT_PACKAGED');
            bound.targetPath = owned[0].packageRoot
              .slice(outputRoot.length + 1)
              .replaceAll('\\', '/');
          }
        } else {
          const result = await materializeCoordinatePackage(filePath, { removeSource: unlink });
          if (!result.converted && result.skippedReason)
            throw new Error(`COMPUTE_RECOVERY_CONVERSION_REFUSED: ${result.skippedReason}`);
        }
      }
      await settleCompletedMolecularMigrationLinks(outputRoot, {
        scope: 'unpublished-compute-staging',
        assertCurrent,
      });
      const output = await inventoryComputeSource(outputRoot);
      for (const item of output.entries)
        if (item.kind === 'file') await flushFile(join(outputRoot, item.relativePath));
      for (const item of [...output.entries].reverse())
        if (item.kind === 'directory') await syncDirectory(join(outputRoot, item.relativePath));
      await syncDirectory(outputRoot);
      await assertComputeSourceUnchanged(sourceRoot, source);
      manifest = {
        schema: 'dnaforge.compute-result-recovery.v1',
        operationId,
        attempt: basename(attemptRoot),
        witness,
        source,
        output,
        ...(native.members.length || native.catalogHeadWitness !== null ? { native } : {}),
      };
      await durable('manifest', manifest);
      bytes = await readOptional(input.workspaceRoot, manifestPath);
      await options.checkpoint?.('prepared');
    }
    manifest = computeRecoveryManifestSchema.parse(JSON.parse(bytes!.toString('utf8')));
    if (
      manifest.operationId !== operationId ||
      manifest.witness.workspaceRoot !== input.workspaceRoot ||
      manifest.witness.provider !== input.provider ||
      manifest.witness.remoteId !== input.remoteId ||
      manifest.witness.sourceRelativePath !== sourceRelativePath
    )
      throw new Error('COMPUTE_RECOVERY_MANIFEST_IDENTITY_CHANGED');
    const planSha256 = digest(canonicalJson(manifest));
    const retainedRelativePath = `${base}/${manifest.attempt}/original`;
    const retained = await inventoryComputeSource(join(input.workspaceRoot, retainedRelativePath));
    if (retained.treeSha256 !== manifest.source.treeSha256)
      throw new Error('COMPUTE_RECOVERY_RETAINED_SOURCE_CHANGED');
    const outputRoot = join(baseRoot, manifest.attempt, 'output');
    const targetRoot = join(input.workspaceRoot, targetRelativePath);
    const publication = {
      operationId,
      planSha256,
      sourceTreeSha256: manifest.source.treeSha256,
      targetRelativePaths: manifest.output.entries
        .filter(
          (item) =>
            item.kind === 'file' &&
            !item.relativePath.split('/').some((part) => part.startsWith('.'))
        )
        .map((item) => `${targetRelativePath}/${item.relativePath}`),
      previews: [],
      ...(manifest.native
        ? { native: manifest.native, nativeTargetRelativeRoot: targetRelativePath }
        : {}),
    };
    if (publication.targetRelativePaths.length === 0)
      publication.targetRelativePaths.push(targetRelativePath);
    const finish = async () => {
      const { commitOwnedPathsIfDirty, resolveHeadCommit, readBlobBytesAtCommit } =
        await import('./index');
      const head = await resolveHeadCommit(input.workspaceRoot);
      if (!head) throw new Error('COMPUTE_RECOVERY_GIT_HEAD_UNAVAILABLE');
      let committed: Uint8Array | null = null;
      try {
        committed = await readBlobBytesAtCommit(input.workspaceRoot, head, `${base}/complete.json`);
      } catch (error) {
        if ((error as { code?: string }).code !== 'NotFoundError') throw error;
      }
      if (committed) {
        if (Buffer.from(committed).toString('utf8') !== canonicalJson({ planSha256 }))
          throw new Error('COMPUTE_RECOVERY_COMMITTED_PLAN_CHANGED');
        return;
      }
      for (const item of manifest.output.entries) {
        if (item.kind !== 'file') continue;
        const destination = join(targetRoot, item.relativePath);
        assertWorkspaceProjectionPathSafe(input.workspaceRoot, destination);
        const info = await lstat(destination, { bigint: true });
        const bytes = await hashWorkspaceSyncFileOnDisk(destination);
        if (
          !info.isFile() ||
          String(info.dev) !== item.identity.device ||
          String(info.ino) !== item.identity.inode ||
          bytes.sha256 !== item.sha256 ||
          bytes.sizeBytes !== item.byteLength
        )
          throw new Error('COMPUTE_RECOVERY_DESTINATION_CHANGED');
      }
      for (const item of manifest.output.entries) {
        if (item.kind !== 'file') continue;
        const anchor = join(outputRoot, item.relativePath);
        assertWorkspaceProjectionPathSafe(input.workspaceRoot, anchor);
        const current = await lstat(anchor, { bigint: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          }
        );
        if (
          current &&
          String(current.dev) === item.identity.device &&
          String(current.ino) === item.identity.inode
        )
          await unlink(anchor);
      }
      const paths = [
        manifestPath,
        join(baseRoot, 'complete.json'),
        join(baseRoot, `directory-${digest('')}.json`),
        ...manifest.source.entries
          .filter((item) => item.kind === 'file')
          .map((item) => join(input.workspaceRoot, retainedRelativePath, item.relativePath)),
        ...manifest.output.entries.map((item) =>
          item.kind === 'file'
            ? join(targetRoot, item.relativePath)
            : join(baseRoot, `directory-${digest(item.relativePath)}.json`)
        ),
      ];
      for (const path of paths) assertWorkspaceProjectionPathSafe(input.workspaceRoot, path);
      assertCurrent();
      await commitOwnedPathsIfDirty(input.workspaceRoot, 'Recover legacy compute results', {
        expectedHead: head,
        paths,
        forceInclude: paths,
      });
    };
    const complete = await readOptional(input.workspaceRoot, join(baseRoot, 'complete.json'));
    if (complete) {
      if (complete.toString('utf8') !== canonicalJson({ planSha256 }))
        throw new Error('COMPUTE_RECOVERY_COMPLETION_CHANGED');
      assertCurrent();
      publishComputeResultJob(db, manifest.witness, publication, Date.now());
      await finish();
      return { kind: 'already-committed', operationId, targetRelativePath, retainedRelativePath };
    }
    await assertComputeSourceUnchanged(sourceRoot, manifest.source);
    const ensureDirectory = async (relativePath: string) => {
      const destination = join(targetRoot, relativePath);
      const key = `directory-${digest(relativePath)}`;
      const receipt = await readOptional(input.workspaceRoot, join(baseRoot, `${key}.json`));
      assertWorkspaceProjectionPathSafe(input.workspaceRoot, destination);
      if (receipt === null) {
        assertCurrent();
        await mkdir(destination, { mode: 0o700 });
        await syncDirectory(dirname(destination));
        const info = await lstat(destination, { bigint: true });
        await durable(key, { device: String(info.dev), inode: String(info.ino) });
      } else {
        const expected: unknown = JSON.parse(receipt.toString('utf8'));
        const info = await lstat(destination, { bigint: true });
        if (
          !info.isDirectory() ||
          canonicalJson(expected) !==
            canonicalJson({ device: String(info.dev), inode: String(info.ino) })
        )
          throw new Error('COMPUTE_RECOVERY_DESTINATION_CHANGED');
      }
    };
    await ensureDirectory('');
    for (const item of manifest.output.entries) {
      assertCurrent();
      if (item.kind === 'directory') {
        await ensureDirectory(item.relativePath);
        continue;
      }
      const staged = join(outputRoot, item.relativePath);
      const destination = join(targetRoot, item.relativePath);
      assertWorkspaceProjectionPathSafe(input.workspaceRoot, staged);
      assertWorkspaceProjectionPathSafe(input.workspaceRoot, destination);
      const stagedInfo = await lstat(staged, { bigint: true });
      const stagedHash = await hashWorkspaceSyncFileOnDisk(staged);
      if (
        !stagedInfo.isFile() ||
        String(stagedInfo.dev) !== item.identity.device ||
        String(stagedInfo.ino) !== item.identity.inode ||
        stagedHash.sha256 !== item.sha256 ||
        stagedHash.sizeBytes !== item.byteLength
      )
        throw new Error('COMPUTE_RECOVERY_PREPARED_FILE_CHANGED');
      try {
        await link(staged, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const installed = await lstat(destination, { bigint: true });
      if (
        !installed.isFile() ||
        installed.dev !== stagedInfo.dev ||
        installed.ino !== stagedInfo.ino
      )
        throw new Error('COMPUTE_RECOVERY_DESTINATION_CHANGED');
      await syncDirectory(dirname(destination));
      await options.checkpoint?.('file-published', destination);
    }
    for (const item of manifest.output.entries) {
      if (item.kind === 'directory') {
        await ensureDirectory(item.relativePath);
        continue;
      }
      const installed = await lstat(join(targetRoot, item.relativePath), { bigint: true });
      const bytes = await hashWorkspaceSyncFileOnDisk(join(targetRoot, item.relativePath));
      if (
        !installed.isFile() ||
        String(installed.dev) !== item.identity.device ||
        String(installed.ino) !== item.identity.inode ||
        bytes.sha256 !== item.sha256 ||
        bytes.sizeBytes !== item.byteLength
      )
        throw new Error('COMPUTE_RECOVERY_DESTINATION_CHANGED');
    }
    await ensureDirectory('');
    await assertComputeSourceUnchanged(sourceRoot, manifest.source);
    assertCurrent();
    const published = publishComputeResultJob(db, manifest.witness, publication, Date.now());
    await options.checkpoint?.('database-published');
    await durable('complete', { planSha256 });
    await options.checkpoint?.('completion-recorded');
    await finish();
    return { kind: published.kind, operationId, targetRelativePath, retainedRelativePath };
  } finally {
    release();
  }
}

async function readOptional(root: string, path: string): Promise<Buffer | null> {
  assertWorkspaceProjectionPathSafe(root, path);
  try {
    if (!(await lstat(path)).isFile()) throw new Error('COMPUTE_RECOVERY_RECORD_NOT_FILE');
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
