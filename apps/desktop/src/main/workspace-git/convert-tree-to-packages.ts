import { isRecoveredComputeResultDirectory } from '../../shared/compute-result-path';
import { promises as fs } from 'node:fs';
import type { NucleicAcid } from '@waypoint/sequence-utils';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
  NATIVE_WORKSPACE_MANIFEST_PATH,
  NATIVE_WORKSPACE_MANIFEST_V2_SCHEMA,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.svn',
  '.hg',
  '__pycache__',
  'test-fixtures',
]);

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
}

export interface ConvertTreeOptions {
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
  };

  const candidates = await collectConstructFiles(rootDir, result.failures);
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
    try {
      const materialized = await materializeImportedSequencePackages(path, undefined, {
        automatic: true,
        packageId: options.packageIdForPath?.(path),
        updateExistingPackage: (input) => publishRerunSequenceRevision(rootDir, input),
      });
      if (materialized.converted) {
        result.converted += 1;
        result.packages += materialized.packages.length;
        for (const pkg of materialized.packages) {
          const packageFiles = await collectPlasmidPackageGitFiles(pkg.packageRoot);
          for (const packageFile of packageFiles) {
            result.mutatedGitFiles.push(relative(rootDir, packageFile).split(sep).join('/'));
          }
        }
      } else {
        result.skipped += 1;
        if (materialized.skippedReason) {
          result.skippedDetails.push({ path, reason: materialized.skippedReason });
          rememberRefusal(path, identity, materialized.skippedReason);
        }
      }
    } catch (err) {
      result.failures.push({
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    done += 1;
    options.onProgress?.(done, total);
  }

  result.requiredGitFiles = await collectPlasmidPackageGitFiles(rootDir);
  result.mutatedGitFiles = [...new Set(result.mutatedGitFiles)].sort();
  return result;
}

export interface ConvertLooseSequenceFileResult {
  converted: boolean;
  packageRoots: string[];
  reason: string | null;
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
    confirmedDnaSourceSha256?: string;
    confirmedNucleicAcid?: NucleicAcid;
    confirmedRecoverySourceSha256?: string;
    packageIdForPath?: (path: string) => string | undefined;
  } = {}
): Promise<ConvertLooseSequenceFileResult> {
  const sourcePath = await containedWorkspaceFile(rootDir, requestedPath);
  if (!isConstructSequenceFile(sourcePath)) {
    return { converted: false, packageRoots: [], reason: 'This is not a DNA sequence file type.' };
  }
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
  const materialized = await materializeImportedSequencePackages(sourcePath, undefined, {
    ...(options.confirmedDnaSourceSha256
      ? {
          confirmedDnaSourceSha256: options.confirmedDnaSourceSha256,
          confirmedNucleicAcid: options.confirmedNucleicAcid,
        }
      : {}),
    packageId: options.packageIdForPath?.(sourcePath),
    updateExistingPackage: (input) => publishRerunSequenceRevision(rootDir, input),
  });
  return {
    converted: materialized.converted,
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
      await walk(join(dirPath, entry.name), depth + 1);
    }
  }

  await walk(rootDir, 0);
  return [...found];
}

async function collectConstructFiles(
  rootDir: string,
  failures: Array<{ path: string; message: string }>
): Promise<string[]> {
  const found: string[] = [];
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

  async function recoverInterruptedConversion(recoveryRoot: string): Promise<void> {
    try {
      const recovery = await recoverHeldConversionSource(recoveryRoot);
      if (recovery.kind === 'restored') {
        if (isConstructSequenceFile(basename(recovery.path)) && !nativeFiles.has(recovery.path))
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

    if (nativePackages.has(dirPath) || (await isPackageRoot(dirPath, entries))) return;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isConversionSourceDirectoryName(entry.name)) {
          await recoverInterruptedConversion(join(dirPath, entry.name));
          continue;
        }
        if (
          depth === 0 &&
          (entry.name === 'compute' || isRecoveredComputeResultDirectory(entry.name))
        )
          continue;
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(join(dirPath, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const path = join(dirPath, entry.name);
      if (isConstructSequenceFile(entry.name) && !nativeFiles.has(path)) found.push(path);
    }
  }

  await walk(rootDir, 0);
  return found;
}

async function isPackageRoot(
  dirPath: string,
  entries: readonly { name: string; isDirectory(): boolean }[]
): Promise<boolean> {
  if (!entries.some((entry) => entry.isDirectory() && entry.name === FORGE_PACKAGE_MARKER_DIR)) {
    return false;
  }
  try {
    const markers = await fs.readdir(join(dirPath, FORGE_PACKAGE_MARKER_DIR));
    const names = new Set(markers.map((name) => name.toLowerCase()));
    return (
      SEQUENCE_PACKAGE_META_ALIASES.some((name) => names.has(name.toLowerCase())) ||
      names.has(NOTEBOOK_PACKAGE_META_NAME)
    );
  } catch {
    return false;
  }
}
