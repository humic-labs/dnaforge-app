import { isRecoveredComputeResultDirectory } from '../../shared/compute-result-path';
import { promises as fs } from 'node:fs';
import type { NucleicAcid } from '@waypoint/sequence-utils';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import {
  isConstructSequenceFile,
  isConversionSourceDirectoryName,
  materializeImportedSequencePackages,
  previewImportedSequencePackages,
  recoverHeldConversionSource,
  inspectSequenceRecovery,
  recoverImportedSequencePackages,
} from './sequence-package-import';
import { publishRerunSequenceRevision } from './sequence-package-rerun';
import { FORGE_PACKAGE_MARKER_DIR } from '../../db/forge-package';
import {
  SEQUENCE_PACKAGE_META_ALIASES,
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
} from '../../db/sequence-package';
import { NOTEBOOK_PACKAGE_META_NAME } from '../../db/notebook-package';
import {
  collectSequenceMigrationGitContent,
  prepareSequenceMigration,
} from './sequence-migration-journal';
import { PAIRED_SIDECAR_SUFFIXES } from '../../db/workspace-content-manifest';
import {
  assertMigrationPathsAvailable,
  captureMigrationGitContent,
  migrationPathsIntersect,
  type MigrationPathOptions,
} from './migration-paths';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', '__pycache__']);

const MAX_DEPTH = 40;
const MAX_REMEMBERED_REFUSALS = 10_000;

const rememberedRefusals = new Map<string, { identity: string; reason: string }>();

async function refusalIdentity(path: string): Promise<string | null> {
  try {
    const [file, parent] = await Promise.all([
      fs.stat(path, { bigint: true }),
      fs.stat(dirname(path), { bigint: true }),
    ]);
    return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs, parent.mtimeNs].join(':');
  } catch {
    return null;
  }
}

function rememberRefusal(path: string, identity: string | null, reason: string): void {
  if (!identity) return;
  if (rememberedRefusals.size >= MAX_REMEMBERED_REFUSALS) rememberedRefusals.clear();
  rememberedRefusals.set(path, { identity, reason });
}

export interface ConvertTreeResult {
  converted: number;
  packages: number;
  skipped: number;
  skippedDetails: Array<{ path: string; reason: string; repeated?: true }>;
  failures: Array<{ path: string; message: string }>;
  requiredGitFiles: string[];
  mutatedGitFiles: string[];
  expectedContentSha256: Record<string, string | null>;
}

export interface ConvertTreeOptions extends MigrationPathOptions {
  onProgress?: (done: number, total: number) => void;
  packageIdForPath?: (path: string) => string | undefined;
}

export async function convertTreeToPlasmidPackages(
  rootDir: string,
  options: ConvertTreeOptions = {}
): Promise<ConvertTreeResult> {
  const result: ConvertTreeResult = {
    converted: 0,
    packages: 0,
    skipped: 0,
    skippedDetails: [],
    failures: [],
    requiredGitFiles: [],
    mutatedGitFiles: [],
    expectedContentSha256: {},
  };

  options = {
    ...options,
    protectedPaths: [
      ...(options.protectedPaths ?? []),
      ...(await declaredNativeMigrationPaths(rootDir)),
    ],
  };
  const settled = await collectSequenceMigrationGitContent(rootDir, options);
  Object.assign(result.expectedContentSha256, settled.expectedContentSha256);
  result.converted += settled.recovered;
  result.failures.push(...settled.failures);
  const discovery = await collectConstructFiles(rootDir, result.failures, options);
  const candidates = discovery.files.filter((path) => !settled.pendingSources.includes(path));
  const migration = { ...options, protectedPaths: discovery.protectedPaths };
  const total = candidates.length;
  let done = 0;

  for (const path of candidates) {
    const identity = await refusalIdentity(path);
    const remembered = rememberedRefusals.get(path);
    if (identity && remembered?.identity === identity) {
      result.skipped += 1;
      result.skippedDetails.push({ path, reason: remembered.reason, repeated: true });
      done += 1;
      options.onProgress?.(done, total);
      continue;
    }
    rememberedRefusals.delete(path);
    let receipt: Awaited<ReturnType<typeof prepareSequenceMigration>> | undefined;
    try {
      const sidecars = (
        await Promise.all(
          PAIRED_SIDECAR_SUFFIXES.map(async (suffix) => {
            const sidecar = path + suffix;
            return await fs.lstat(sidecar).then(
              () => sidecar,
              (error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return null;
                throw error;
              }
            );
          })
        )
      ).filter((path): path is string => path !== null);
      const rerunRoot = join(dirname(path), basename(path, extname(path)));
      const rerun = settled.rerunPackages.find(
        (candidate) => candidate.source === path && candidate.packageRoot === rerunRoot
      );
      const materialized = await materializeImportedSequencePackages(path, undefined, {
        ...migration,
        prepareAutomaticMigration: async (sourceSha256) => {
          receipt = await prepareSequenceMigration(rootDir, path, migration);
          if (receipt.expectedSourceSha256 !== sourceSha256) {
            await receipt.cancel();
            throw new Error('The sequence changed after its automatic conversion was inspected.');
          }
          return receipt;
        },
        automatic: true,
        packageId: options.packageIdForPath?.(path),
        ...(rerun
          ? {
              rerunPackageId: rerun.packageId,
              updateExistingPackage: (input: { packageRoot: string; productContent: string }) =>
                publishRerunSequenceRevision(rootDir, { ...input, expected: rerun }),
            }
          : {}),
      });
      if (materialized.converted) {
        if (!receipt)
          throw new Error('The converted sequence is missing its required migration receipt.');
        result.converted += 1;
        result.packages += materialized.packages.length;
        const ownedFiles: string[] = [];
        for (const pkg of materialized.packages) {
          const packageFiles = await collectPlasmidPackageGitFiles(pkg.packageRoot);
          ownedFiles.push(...packageFiles);
        }
        const content = await captureMigrationGitContent(rootDir, ownedFiles);
        content.expectedContentSha256[relative(rootDir, path).split(sep).join('/')] = null;
        for (const sidecar of sidecars) {
          const remaining = await fs.lstat(sidecar).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            }
          );
          if (remaining)
            result.failures.push({
              path: sidecar,
              message:
                'The sequence was converted, but its attachment could not be moved. The original attachment was preserved.',
            });
          else
            content.expectedContentSha256[relative(rootDir, sidecar).split(sep).join('/')] = null;
        }
        Object.assign(result.expectedContentSha256, content.expectedContentSha256);
        Object.assign(
          result.expectedContentSha256,
          await receipt.finish(materialized.packages.map((pkg) => pkg.packageRoot))
        );
        result.mutatedGitFiles.push(...Object.keys(content.expectedContentSha256));
      } else {
        await receipt?.cancel();
        result.skipped += 1;
        if (materialized.skippedReason) {
          result.skippedDetails.push({ path, reason: materialized.skippedReason });
          rememberRefusal(path, identity, materialized.skippedReason);
        }
      }
    } catch (err) {
      await receipt?.cancelIfUnchanged().catch(() => undefined);
      result.failures.push({
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    done += 1;
    options.onProgress?.(done, total);
  }

  result.requiredGitFiles = await collectPlasmidPackageGitFiles(rootDir);
  result.mutatedGitFiles = Object.keys(result.expectedContentSha256).sort();
  return result;
}

export interface ConvertLooseSequenceFileResult {
  converted: boolean;
  packageRoots: string[];
  reason: string | null;
  disposition?: 'source-only' | 'owned' | 'blocked';
  mutatedGitFiles?: string[];
  expectedContentSha256?: Record<string, string | null>;
}

async function containedWorkspaceFile(rootDir: string, sourcePath: string): Promise<string> {
  const realRoot = await fs.realpath(rootDir);
  const realParent = await fs.realpath(dirname(sourcePath));
  const fromRoot = relative(realRoot, realParent);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('LOOSE_SEQUENCE_OUTSIDE_WORKSPACE: the file is not inside this workspace.');
  }
  return join(rootDir, fromRoot, basename(sourcePath));
}

export type LooseSequenceFileInspection =
  | { state: 'not-sequence'; reason: string | null }
  | { state: 'convertible'; reason: null }
  | {
      state: 'recoverable';
      reason: string;
      sourceSha256: string;
      replacementCount: number;
      recordCount: number;
    }
  | {
      state: 'needs-dna-confirmation';
      reason: string;
      sourceSha256: string;
      canConvertToRna: boolean;
    }
  | { state: 'refused'; reason: string };

export async function inspectLooseSequenceFile(
  rootDir: string,
  requestedPath: string
): Promise<LooseSequenceFileInspection> {
  const sourcePath = await containedWorkspaceFile(rootDir, requestedPath);
  if (!isConstructSequenceFile(sourcePath)) return { state: 'not-sequence', reason: null };
  const preview = await previewImportedSequencePackages(sourcePath);
  if (preview.kind === 'ready') return { state: 'convertible', reason: null };
  if (preview.canConfirmDnaIdentity && preview.sourceSha256) {
    return {
      state: 'needs-dna-confirmation',
      reason: preview.reason,
      sourceSha256: preview.sourceSha256,
      canConvertToRna: preview.canConvertToRna === true,
    };
  }
  if (preview.reasonCode === 'parse_failure') {
    const recovery = await inspectSequenceRecovery(sourcePath);
    if (recovery) return { state: 'recoverable', reason: preview.reason, ...recovery };
  }
  return { state: 'refused', reason: preview.reason };
}

export async function convertLooseSequenceFile(
  rootDir: string,
  requestedPath: string,
  options: {
    automatic?: boolean;
    confirmedDnaSourceSha256?: string;
    confirmedNucleicAcid?: NucleicAcid;
    confirmedRecoverySourceSha256?: string;
    packageIdForPath?: (path: string) => string | undefined;
  } & MigrationPathOptions = {}
): Promise<ConvertLooseSequenceFileResult> {
  const sourcePath = await containedWorkspaceFile(rootDir, requestedPath);
  if (!isConstructSequenceFile(sourcePath)) {
    return {
      converted: false,
      packageRoots: [],
      reason: 'This is not a DNA sequence file type.',
      disposition: 'source-only',
    };
  }
  const protectedPaths = options.automatic
    ? [...(options.protectedPaths ?? []), ...(await declaredNativeMigrationPaths(rootDir))]
    : options.protectedPaths;
  if (options.automatic) {
    for (let directory = dirname(sourcePath); ; directory = dirname(directory)) {
      if (await isPackageRoot(directory, await fs.readdir(directory, { withFileTypes: true })))
        return {
          converted: false,
          packageRoots: [],
          reason: 'This file belongs to an existing package and was left unchanged.',
          disposition: 'owned',
        };
      if (directory === rootDir || dirname(directory) === directory) break;
    }
  }
  if (
    options.automatic &&
    protectedPaths?.some((path) => migrationPathsIntersect(sourcePath, path))
  )
    return {
      converted: false,
      packageRoots: [],
      reason: 'This file already belongs to an entity and was left unchanged.',
      disposition: 'owned',
    };
  assertMigrationPathsAvailable([sourcePath], { ...options, protectedPaths });
  if (
    options.automatic &&
    (options.confirmedDnaSourceSha256 ||
      options.confirmedRecoverySourceSha256 ||
      options.confirmedNucleicAcid)
  )
    throw new Error('Automatic conversion cannot declare or repair sequence content.');
  if (options.confirmedRecoverySourceSha256 !== undefined) {
    const recovered = await recoverImportedSequencePackages(
      sourcePath,
      options.confirmedRecoverySourceSha256
    );
    return {
      converted: recovered.converted,
      packageRoots: recovered.packages.map((pkg) => pkg.packageRoot),
      reason: null,
    };
  }
  const automaticPreview = options.automatic
    ? await previewImportedSequencePackages(sourcePath, { automatic: true })
    : undefined;
  if (automaticPreview?.kind === 'blocked')
    return {
      converted: false,
      packageRoots: [],
      reason: automaticPreview.reason,
      disposition: automaticPreview.reasonCode === 'read_failure' ? 'blocked' : 'source-only',
    };
  const receipt = options.automatic
    ? await prepareSequenceMigration(rootDir, sourcePath, { ...options, protectedPaths })
    : undefined;
  if (
    receipt &&
    automaticPreview?.kind === 'ready' &&
    receipt.expectedSourceSha256 !== automaticPreview.sourceSha256
  ) {
    await receipt.cancel();
    throw new Error('The sequence changed after its automatic conversion was inspected.');
  }
  const materialized = await materializeImportedSequencePackages(sourcePath, undefined, {
    ...options,
    protectedPaths,
    ...(receipt
      ? {
          expectedSourceSha256: receipt.expectedSourceSha256,
          onPackagePlanned: receipt.onPackagePlanned,
        }
      : {}),
    ...(options.confirmedDnaSourceSha256
      ? {
          confirmedDnaSourceSha256: options.confirmedDnaSourceSha256,
          confirmedNucleicAcid: options.confirmedNucleicAcid,
        }
      : {}),
    packageId: options.packageIdForPath?.(sourcePath),
    ...(options.automatic
      ? {}
      : {
          updateExistingPackage: (input: { packageRoot: string; productContent: string }) =>
            publishRerunSequenceRevision(rootDir, input),
        }),
  }).catch(async (error) => {
    await receipt?.cancelIfUnchanged().catch(() => undefined);
    throw error;
  });
  const content =
    materialized.converted && options.automatic
      ? await captureMigrationGitContent(
          rootDir,
          (
            await Promise.all(
              materialized.packages.map((pkg) => collectPlasmidPackageGitFiles(pkg.packageRoot))
            )
          ).flat()
        )
      : undefined;
  if (content) {
    content.expectedContentSha256[relative(rootDir, sourcePath).split(sep).join('/')] = null;
    for (const suffix of PAIRED_SIDECAR_SUFFIXES) {
      const sidecar = sourcePath + suffix;
      if (
        !(await fs.lstat(sidecar).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          }
        ))
      )
        content.expectedContentSha256[relative(rootDir, sidecar).split(sep).join('/')] = null;
    }
    if (receipt)
      Object.assign(
        content.expectedContentSha256,
        await receipt.finish(materialized.packages.map((pkg) => pkg.packageRoot))
      );
    content.mutatedGitFiles = Object.keys(content.expectedContentSha256).sort();
  }
  if (receipt && !materialized.converted) await receipt.cancel();
  return {
    ...content,
    converted: materialized.converted,
    disposition: materialized.converted
      ? undefined
      : materialized.sourceOnly
        ? 'source-only'
        : materialized.packages.length > 0
          ? 'owned'
          : 'blocked',
    packageRoots: materialized.packages.map((pkg) => pkg.packageRoot),
    reason: materialized.converted
      ? null
      : (materialized.skippedReason ??
        (materialized.packages.length > 0 ? null : 'The file was left as it is.')),
  };
}

export async function collectPlasmidPackageGitFiles(rootDir: string): Promise<string[]> {
  const found = new Set<string>();

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    const markerDir = entries.some(
      (entry) => entry.isDirectory() && entry.name === FORGE_PACKAGE_MARKER_DIR
    );
    if (markerDir) {
      const metaPath = sequencePackagePaths(dirPath).metaPath;
      try {
        const doc = parseSequencePackageDocument(await fs.readFile(metaPath, 'utf8'));
        const memberPaths = [
          metaPath,
          fromPackageRelative(doc.product.file, dirPath),
          ...doc.members.map((member) => fromPackageRelative(member.path, dirPath)),
        ];
        for (const memberPath of memberPaths) {
          try {
            const member = await fs.lstat(memberPath);
            if (member.isFile() || member.isSymbolicLink()) found.add(memberPath);
          } catch {}
        }
      } catch {
        try {
          const markers = await fs.readdir(join(dirPath, FORGE_PACKAGE_MARKER_DIR));
          if (markers.some((name) => name.toLowerCase() === NOTEBOOK_PACKAGE_META_NAME)) {
            return;
          }
        } catch {}
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
      if (depth === 0 && entry.name === 'test-fixtures') continue;
      await walk(join(dirPath, entry.name), depth + 1);
    }
  }

  await walk(rootDir, 0);
  return [...found];
}

async function collectConstructFiles(
  rootDir: string,
  failures: Array<{ path: string; message: string }>,
  options: MigrationPathOptions
): Promise<{ files: string[]; protectedPaths: string[] }> {
  const found: string[] = [];
  const protectedPaths = [
    ...(options.protectedPaths ?? []),
    ...(await declaredNativeMigrationPaths(rootDir)),
  ];
  const protectedFile = (path: string) =>
    protectedPaths.some((protectedPath) => migrationPathsIntersect(path, protectedPath));

  async function recoverInterruptedConversion(recoveryRoot: string): Promise<void> {
    try {
      const sourcePaths = (await fs.readdir(recoveryRoot)).map((name) =>
        join(dirname(recoveryRoot), name)
      );
      const recover = () => {
        assertMigrationPathsAvailable(sourcePaths, { ...options, protectedPaths });
        return recoverHeldConversionSource(recoveryRoot);
      };
      const recovery = options.withCleanPaths
        ? await options.withCleanPaths([recoveryRoot, ...sourcePaths], recover)
        : await recover();
      if (recovery.kind === 'restored') {
        if (isConstructSequenceFile(basename(recovery.path)) && !protectedFile(recovery.path))
          found.push(recovery.path);
      } else if (recovery.kind === 'stranded') {
        failures.push({ path: recovery.path, message: recovery.reason });
      }
    } catch (error) {
      failures.push({
        path: recoveryRoot,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      failures.push({ path: dirPath, message: `Directory nesting exceeds ${MAX_DEPTH} levels.` });
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      failures.push({
        path: dirPath,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (
      protectedPaths.some((path) => dirPath === path || dirPath.startsWith(path + sep)) ||
      (await isPackageRoot(dirPath, entries))
    )
      return;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isConversionSourceDirectoryName(entry.name)) {
          await recoverInterruptedConversion(join(dirPath, entry.name));
          continue;
        }
        if (
          depth === 0 &&
          (entry.name === 'compute' ||
            entry.name === 'test-fixtures' ||
            isRecoveredComputeResultDirectory(entry.name))
        )
          continue;
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(join(dirPath, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const path = join(dirPath, entry.name);
      if (isConstructSequenceFile(entry.name) && !protectedFile(path)) found.push(path);
    }
  }

  await walk(rootDir, 0);
  return { files: found, protectedPaths };
}

export async function declaredNativeMigrationPaths(rootDir: string): Promise<string[]> {
  const manifestText = await fs
    .readFile(join(rootDir, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  const manifest = manifestText === null ? null : parseNativeWorkspaceManifest(manifestText);
  const nativeFiles = new Set<string>();
  const nativePackages = new Set<string>();
  if (manifest?.schema === NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA) {
    for (const entity of manifest.entities) {
      if (entity.placement.kind === 'file')
        nativeFiles.add(join(rootDir, entity.placement.relativePath));
      if (entity.placement.kind === 'package')
        nativePackages.add(join(rootDir, entity.placement.rootRelativePath));
    }
  }
  return [...nativeFiles, ...nativePackages];
}

async function isPackageRoot(
  dirPath: string,
  entries: readonly { name: string; isDirectory(): boolean }[]
): Promise<boolean> {
  if (!entries.some((entry) => entry.isDirectory() && entry.name === FORGE_PACKAGE_MARKER_DIR))
    return false;
  try {
    const markers = await fs.readdir(join(dirPath, FORGE_PACKAGE_MARKER_DIR));
    const names = new Set(markers.map((name) => name.toLowerCase()));
    return (
      SEQUENCE_PACKAGE_META_ALIASES.some((name) => names.has(name.toLowerCase())) ||
      names.has(NOTEBOOK_PACKAGE_META_NAME) ||
      names.has('protocol.json') ||
      names.has('protocol-run.json')
    );
  } catch {
    return true;
  }
}
