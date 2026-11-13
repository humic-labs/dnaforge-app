import { SEQUENCE_PACKAGE_MIGRATORS } from './sequence-package-contract';
import {
  assertKnownSequenceMemberRole,
  fromPackageRelative,
  parseSequencePackageDocument,
  SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR,
  sequenceAlignmentHistoryRelPath,
  sequenceManagedMemberPath,
  sequencePackageMembersWithRole,
  sequencePackageMetaPaths,
  sequencePackagePaths,
  sequencePrimerArtifactLookupPaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from './sequence-package';

export interface SequencePackageIoFs {
  exists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;

  writeWorkspaceTextFileAtomic?(input: {
    workspaceRoot: string;
    path: string;
    content: string;
    mode: 'replace';
    expectedContentHash: string;
    artifactNoun: string;
  }): Promise<unknown>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  move(sourcePath: string, destinationDir: string): Promise<{ destPath: string }>;

  readFile?(path: string): Promise<Uint8Array>;
  writeFile?(path: string, contents: Uint8Array): Promise<void>;

  unlink?(path: string): Promise<void>;

  rename?(oldPath: string, newPath: string): Promise<void>;
}

const DISK_RELOCATORS: Record<
  string,
  (
    packageRoot: string,
    document: SequencePackageDocument,
    fs: SequencePackageIoFs
  ) => Promise<boolean>
> = {
  relocateSequencePackageV2ToV3,
  relocateSequencePackageV3ToV4,
};

export async function loadSequencePackageDocument(
  packageRoot: string,
  fs: SequencePackageIoFs,
  workspaceRoot: string = packageRoot
): Promise<SequencePackageDocument> {
  const locatedMeta = await locateSequencePackageMetaPath(packageRoot, fs.exists);
  const paths = sequencePackagePaths(packageRoot);
  const metaPath = locatedMeta ?? paths.metaPath;
  const raw = await fs.readTextFile(metaPath);
  const originalVersion = readOnDiskFormatVersion(raw);
  const document = parseSequencePackageDocument(raw);
  let relocated = false;
  for (const step of SEQUENCE_PACKAGE_MIGRATORS) {
    if (step.from < originalVersion || !step.disk) continue;
    const relocator = DISK_RELOCATORS[step.disk];
    if (!relocator) {
      throw new Error(`Missing disk relocator ${step.disk} for ${step.name}`);
    }
    if (await relocator(packageRoot, document, fs)) relocated = true;
  }
  if (await relocateLegacyPayloadMembers(packageRoot, document, fs)) relocated = true;
  if (relocated || originalVersion < document.formatVersion) {
    await replacePackageMarker(fs, workspaceRoot, metaPath, raw, document);
  }
  return document;
}

function readOnDiskFormatVersion(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 1;
    const version = (parsed as { formatVersion?: unknown }).formatVersion;
    if (version === undefined) return 1;
    if (typeof version === 'number' && Number.isInteger(version) && version >= 1) return version;
  } catch {}
  return 1;
}

export async function relocateSequencePackageV2ToV3(
  packageRoot: string,
  document: SequencePackageDocument,
  fs: SequencePackageIoFs
): Promise<boolean> {
  const primerRels = [
    ...sequencePackageMembersWithRole(document.members, 'primer-export').map(
      (member) => member.path
    ),
    document.assembly?.primers?.csv,
    document.assembly?.primers?.fasta,
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (primerRels.length === 0) return false;

  const paths = sequencePackagePaths(packageRoot);
  let moved = false;
  for (const relativePath of primerRels) {
    const destAbs = fromPackageRelative(relativePath, packageRoot);
    const lookup = sequencePrimerArtifactLookupPaths(relativePath);
    let sourceAbs: string | null = null;
    for (const candidate of lookup) {
      if (candidate === relativePath) continue;
      const abs = fromPackageRelative(candidate, packageRoot);
      if (await fs.exists(abs)) {
        sourceAbs = abs;
        break;
      }
    }
    if (!sourceAbs) continue;
    await fs.mkdir(paths.contentsDir, { recursive: true });
    await copyVerifyThenRetire(fs, sourceAbs, destAbs, packageRoot);
    moved = true;
  }
  return moved;
}

export async function relocateSequencePackageV3ToV4(
  packageRoot: string,
  document: SequencePackageDocument,
  fs: SequencePackageIoFs
): Promise<boolean> {
  const destRel = sequenceAlignmentHistoryRelPath(document.product.file);
  const destAbs = fromPackageRelative(destRel, packageRoot);
  const siblingAbs = `${packageRoot.replace(/\\/g, '/')}/${document.product.file}.waypoint.json`;
  let moved = false;
  if (await fs.exists(siblingAbs)) {
    const paths = sequencePackagePaths(packageRoot);
    await fs.mkdir(paths.contentsDir, { recursive: true });
    await copyVerifyThenRetire(fs, siblingAbs, destAbs, packageRoot);
    moved = true;
  }
  if (!(await fs.exists(destAbs))) return moved;
  const alreadyListed = document.members.some(
    (member) => member.role === 'alignment' && member.path === destRel
  );
  if (alreadyListed) return moved;
  document.members.push({
    id: `alignment:${document.product.file}`,
    role: 'alignment',
    path: destRel,
    replaceable: false,
    createdAt: new Date().toISOString(),
  });
  return true;
}

export async function relocateLegacyPayloadMembers(
  packageRoot: string,
  document: SequencePackageDocument,
  fs: SequencePackageIoFs
): Promise<boolean> {
  const paths = sequencePackagePaths(packageRoot);
  let moved = false;
  for (const member of document.members) {
    const destAbs = fromPackageRelative(member.path, packageRoot);
    const name = fileNameOf(member.path);
    const leftover = fromPackageRelative(
      `${SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR}/${name}`,
      packageRoot
    );
    if (leftover === destAbs) continue;
    if (!(await fs.exists(leftover))) continue;
    await fs.mkdir(paths.contentsDir, { recursive: true });
    await copyVerifyThenRetire(fs, leftover, destAbs, packageRoot);
    moved = true;
  }
  return moved;
}

export async function copyVerifyThenRetire(
  fs: SequencePackageIoFs,
  sourceAbs: string,
  destAbs: string,
  packageRoot: string
): Promise<void> {
  if (await fs.exists(destAbs)) {
    if (!(await sameMemberBytes(fs, sourceAbs, destAbs))) {
      throw new Error(
        `MIGRATE_DEST_CONFLICT: "${destAbs}" already exists and does not match "${sourceAbs}". ` +
          'Source was left in place.'
      );
    }
    await retireVerifiedSource(fs, sourceAbs, packageRoot);
    return;
  }

  await ensureParentDir(fs, destAbs);
  if (fs.rename) {
    await fs.rename(sourceAbs, destAbs);
    return;
  }

  if (fs.readFile && fs.writeFile) {
    const source = await fs.readFile(sourceAbs);
    await fs.writeFile(destAbs, source);
    let written: Uint8Array;
    try {
      written = await fs.readFile(destAbs);
    } catch (err) {
      throw new Error(
        `MIGRATE_VERIFY_FAILED: could not re-read "${destAbs}" after copy. Source left at "${sourceAbs}". (${
          err instanceof Error ? err.message : String(err)
        })`
      );
    }
    if (!bytesEqual(source, written)) {
      await retireUnverifiedDest(fs, destAbs);
      throw new Error(
        `MIGRATE_VERIFY_FAILED: "${destAbs}" does not match source. Source left at "${sourceAbs}".`
      );
    }
    await retireVerifiedSource(fs, sourceAbs, packageRoot);
    return;
  }

  const source = await fs.readTextFile(sourceAbs);
  await fs.writeTextFile(destAbs, source);
  let written: string;
  try {
    written = await fs.readTextFile(destAbs);
  } catch (err) {
    throw new Error(
      `MIGRATE_VERIFY_FAILED: could not re-read "${destAbs}" after copy. Source left at "${sourceAbs}". (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  if (written !== source) {
    await retireUnverifiedDest(fs, destAbs);
    throw new Error(
      `MIGRATE_VERIFY_FAILED: "${destAbs}" does not match source. Source left at "${sourceAbs}".`
    );
  }
  await retireVerifiedSource(fs, sourceAbs, packageRoot);
}

async function retireVerifiedSource(
  fs: SequencePackageIoFs,
  sourceAbs: string,
  packageRoot: string
): Promise<void> {
  if (fs.unlink) {
    await fs.unlink(sourceAbs);
    return;
  }
  if (fs.rename) {
    const migratedDir = `${packageRoot.replace(/\\/g, '/')}/.forge/migrated`;
    await fs.mkdir(migratedDir, { recursive: true });
    const name = sourceAbs.split(/[\\/]/).filter(Boolean).pop() ?? 'retired';
    let parked = `${migratedDir}/${name}`;
    if (await fs.exists(parked)) {
      parked = `${migratedDir}/${Date.now()}-${name}`;
    }
    await fs.rename(sourceAbs, parked);
    return;
  }
}

async function retireUnverifiedDest(fs: SequencePackageIoFs, destAbs: string): Promise<void> {
  if (fs.unlink) await fs.unlink(destAbs).catch(() => {});
}

export async function locateSequencePackageMetaPath(
  packageRoot: string,
  exists: (path: string) => Promise<boolean>
): Promise<string | null> {
  for (const metaPath of sequencePackageMetaPaths(packageRoot)) {
    try {
      if (await exists(metaPath)) return metaPath;
    } catch {}
  }
  return null;
}

export async function resolveAlignmentHistoryPaths(
  referencePath: string,
  packageRoot: string | null,
  fs: Pick<SequencePackageIoFs, 'exists' | 'readTextFile' | 'writeTextFile' | 'mkdir' | 'move'>
): Promise<string[]> {
  const sibling = `${referencePath}.waypoint.json`;
  if (!packageRoot) return [sibling];
  const document = await loadSequencePackageDocument(packageRoot, fs);
  const listed = sequencePackageMembersWithRole(document.members, 'alignment').map((member) =>
    fromPackageRelative(member.path, packageRoot)
  );
  const conventional = fromPackageRelative(
    sequenceAlignmentHistoryRelPath(document.product.file),
    packageRoot
  );
  return [...new Set([...listed, conventional, sibling])];
}

export async function writeAlignmentHistoryMember(input: {
  packageRoot: string;
  workspaceRoot?: string;
  productFile: string;
  content: string;
  fs: SequencePackageIoFs;
}): Promise<string> {
  assertKnownSequenceMemberRole('alignment');
  const document = await loadSequencePackageDocument(input.packageRoot, input.fs);
  const relativePath = sequenceAlignmentHistoryRelPath(input.productFile);
  const destPath = fromPackageRelative(relativePath, input.packageRoot);
  const paths = sequencePackagePaths(input.packageRoot);
  await input.fs.mkdir(paths.contentsDir, { recursive: true });
  await input.fs.writeTextFile(destPath, input.content);
  if (document.members.some((member) => member.path === relativePath)) {
    return destPath;
  }
  const metaPath =
    (await locateSequencePackageMetaPath(input.packageRoot, input.fs.exists)) ?? paths.metaPath;
  await appendMemberAfterPlacement({
    fs: input.fs,
    packageRoot: input.packageRoot,
    workspaceRoot: input.workspaceRoot,
    metaPath,
    initial: document,
    member: {
      id: `alignment:${input.productFile}`,
      role: 'alignment',
      path: relativePath,
      replaceable: false,
      createdAt: new Date().toISOString(),
    },
  });
  return destPath;
}

export async function addSequencePackageMember(input: {
  packageRoot: string;
  workspaceRoot?: string;
  role: string;
  sourcePath: string;
  replaceable?: boolean;
  fs: SequencePackageIoFs;
}): Promise<{ destPath: string; document: SequencePackageDocument }> {
  const locatedMeta = await locateSequencePackageMetaPath(input.packageRoot, input.fs.exists);
  const paths = sequencePackagePaths(input.packageRoot);
  const metaPath = locatedMeta ?? paths.metaPath;
  assertKnownSequenceMemberRole(input.role);
  const document = await loadSequencePackageDocument(input.packageRoot, input.fs);
  if (input.role === 'user' && document.versionHistory.headId !== null) {
    throw new Error('A managed user attachment must use the versioned package attachment writer.');
  }
  if (isInsideDirectory(input.sourcePath, input.packageRoot)) {
    return { destPath: input.sourcePath, document };
  }

  await input.fs.mkdir(paths.contentsDir, { recursive: true });

  const destPath = await placeAttachmentInContents(
    input.fs,
    input.sourcePath,
    paths.contentsDir,
    input.packageRoot
  );

  const relativePath = sequenceManagedMemberPath(fileNameOf(destPath));
  let userAttachmentSha256: string | undefined;
  if (input.role === 'user') {
    if (!input.fs.readFile) {
      throw new Error('A user attachment requires byte verification before registration.');
    }
    const bytes = await input.fs.readFile(destPath);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
    userAttachmentSha256 = `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
  }
  const next = await appendMemberAfterPlacement({
    fs: input.fs,
    packageRoot: input.packageRoot,
    workspaceRoot: input.workspaceRoot,
    metaPath,
    initial: document,
    member: {
      id: mintMemberId(),
      role: input.role,
      path: relativePath,
      replaceable: input.replaceable === true,
      createdAt: new Date().toISOString(),
    },
    userAttachmentSha256,
  });
  return { destPath, document: next };
}

async function appendMemberAfterPlacement(input: {
  fs: SequencePackageIoFs;
  packageRoot: string;
  workspaceRoot?: string;
  metaPath: string;
  initial: SequencePackageDocument;
  member: SequencePackageDocument['members'][number];
  userAttachmentSha256?: string;
}): Promise<SequencePackageDocument> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = await input.fs.readTextFile(input.metaPath);
    const live = parseSequencePackageDocument(before);
    if (live.id !== input.initial.id || live.product.file !== input.initial.product.file) {
      throw new Error('The sequence package identity or product changed while attaching a member.');
    }
    if (input.member.role === 'user' && live.versionHistory.headId !== null) {
      throw new Error(
        'A managed user attachment must use the versioned package attachment writer.'
      );
    }
    const existing = live.members.find((member) => member.path === input.member.path);
    if (existing) {
      if (existing.role !== input.member.role) {
        throw new Error('A different package member already owns the attachment path.');
      }
      return live;
    }
    const next: SequencePackageDocument = {
      ...live,
      members: [...live.members, input.member],
      ...(input.member.role === 'user'
        ? {
            userAttachments: {
              ...live.userAttachments,
              [input.member.id]: {
                memberId: input.member.id,
                sha256: input.userAttachmentSha256 ?? null,
              },
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    try {
      await replacePackageMarker(
        input.fs,
        input.workspaceRoot ?? input.packageRoot,
        input.metaPath,
        before,
        next
      );
      return next;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'WorkspaceFilePreconditionError') {
        throw error;
      }
      if ((await input.fs.readTextFile(input.metaPath)) === before) throw error;
    }
  }
  throw new Error(
    'Sequence package kept the attachment bytes, but its member registration conflicted repeatedly.'
  );
}

async function replacePackageMarker(
  fs: SequencePackageIoFs,
  workspaceRoot: string,
  metaPath: string,
  before: string,
  next: SequencePackageDocument
): Promise<void> {
  const content = serializeSequencePackageDocument(next);
  if (content === before) return;
  if (!fs.writeWorkspaceTextFileAtomic) {
    throw new Error('Sequence package marker writes require compare-and-swap authority.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(before));
  const expectedContentHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  await fs.writeWorkspaceTextFileAtomic({
    workspaceRoot,
    path: metaPath,
    content,
    mode: 'replace',
    expectedContentHash,
    artifactNoun: 'sequence package',
  });
}

async function placeAttachmentInContents(
  fs: SequencePackageIoFs,
  sourcePath: string,
  contentsDir: string,
  packageRoot: string
): Promise<string> {
  const originalName = fileNameOf(sourcePath);
  const preferred = `${contentsDir}${separatorOf(contentsDir)}${originalName}`;
  const sourcePackageRoot = await findEnclosingSequencePackageRoot(sourcePath, fs);
  const copyOnly = sourcePackageRoot !== null && !isInsideDirectory(sourcePath, packageRoot);

  if (await fs.exists(preferred)) {
    if (await sameMemberBytes(fs, sourcePath, preferred)) return preferred;
    const uniquePath = await unusedContentsPath(fs, contentsDir, originalName);
    await placeAtExactPath(fs, sourcePath, uniquePath, packageRoot, copyOnly);
    return uniquePath;
  }

  if (copyOnly) {
    await placeAtExactPath(fs, sourcePath, preferred, packageRoot, true);
    return preferred;
  }

  try {
    return (await fs.move(sourcePath, contentsDir)).destPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('MOVE_EXISTS')) throw err;
    const uniquePath = await unusedContentsPath(fs, contentsDir, originalName);
    await placeAtExactPath(fs, sourcePath, uniquePath, packageRoot, false);
    return uniquePath;
  }
}

async function placeAtExactPath(
  fs: SequencePackageIoFs,
  sourcePath: string,
  destPath: string,
  packageRoot: string,
  copyOnly: boolean
): Promise<void> {
  if (copyOnly) {
    await copyBytesLeaveSource(fs, sourcePath, destPath);
    return;
  }
  if (fs.rename && !(await fs.exists(destPath))) {
    await ensureParentDir(fs, destPath);
    await fs.rename(sourcePath, destPath);
    return;
  }
  await copyVerifyThenRetire(fs, sourcePath, destPath, packageRoot);
}

async function copyBytesLeaveSource(
  fs: SequencePackageIoFs,
  sourcePath: string,
  destPath: string
): Promise<void> {
  if (!fs.readFile || !fs.writeFile) {
    throw new Error(
      'ATTACH_COPY_UNAVAILABLE: cannot copy a read that already lives in another sequence package. Source was left in place.'
    );
  }
  const source = await fs.readFile(sourcePath);
  await ensureParentDir(fs, destPath);
  await fs.writeFile(destPath, source);
  const written = await fs.readFile(destPath);
  if (!bytesEqual(source, written)) {
    await retireUnverifiedDest(fs, destPath);
    throw new Error(
      `ATTACH_COPY_VERIFY_FAILED: "${destPath}" does not match source. Source left at "${sourcePath}".`
    );
  }
}

const ENCLOSING_PACKAGE_MEMBER_DIRS = new Set([
  'contents',
  SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR,
  'assets',
  'primers',
]);

export async function findEnclosingSequencePackageRoot(
  filePath: string,
  fs: Pick<SequencePackageIoFs, 'exists'>
): Promise<string | null> {
  const candidateRoot = filePath.replace(/[\\/]+$/, '');
  if (candidateRoot && (await locateSequencePackageMetaPath(candidateRoot, fs.exists))) {
    return candidateRoot;
  }
  const parent = parentDirectory(filePath);
  if (!parent) return null;
  if (await locateSequencePackageMetaPath(parent, fs.exists)) return parent;
  const grandparent = parentDirectory(parent);
  if (!grandparent) return null;
  if (!ENCLOSING_PACKAGE_MEMBER_DIRS.has(fileNameOf(parent))) return null;
  if (await locateSequencePackageMetaPath(grandparent, fs.exists)) return grandparent;
  return null;
}

async function sameMemberBytes(
  fs: SequencePackageIoFs,
  leftPath: string,
  rightPath: string
): Promise<boolean> {
  if (fs.readFile) {
    const [left, right] = await Promise.all([fs.readFile(leftPath), fs.readFile(rightPath)]);
    return bytesEqual(left, right);
  }
  const [left, right] = await Promise.all([fs.readTextFile(leftPath), fs.readTextFile(rightPath)]);
  return left === right;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

async function ensureParentDir(fs: SequencePackageIoFs, destAbs: string): Promise<void> {
  const parent = destAbs.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
  if (parent && parent !== destAbs) await fs.mkdir(parent, { recursive: true });
}

function parentDirectory(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const cut = normalized.lastIndexOf('/');
  if (cut <= 0) return null;
  return normalized.slice(0, cut);
}

async function unusedContentsPath(
  fs: SequencePackageIoFs,
  contentsDir: string,
  fileName: string
): Promise<string> {
  const sep = separatorOf(contentsDir);
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${contentsDir}${sep}${stem}-${n}${ext}`;
    if (!(await fs.exists(candidate))) return candidate;
  }
  throw new Error(`Could not allocate a unique name for "${fileName}" in ${contentsDir}`);
}

function mintMemberId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `member-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

function isInsideDirectory(path: string, directory: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
}
