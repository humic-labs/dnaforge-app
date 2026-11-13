import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import type {
  DeepShareFileV1,
  DeepShareManifestArtifact,
  DeepShareOmission,
  ShareBundleLimits,
} from '@waypoint/share-bundle';
import { isSafeRelativePath } from '@waypoint/share-bundle';
import { parseNotebookPackageDocument } from '../../db/notebook-package';
import { parseSequencePackageDocument } from '../../db/sequence-package';

export interface DeepShareCatalogFileRow {
  entityId: string;
  path: string;
  relativePath: string | null;
  fileKind: string;
}

export interface ResolveDeepShareArtifactFilesInput {
  workspaceRoot: string;
  artifacts: readonly DeepShareManifestArtifact[];
  catalogFiles: readonly DeepShareCatalogFileRow[];
  limits: ShareBundleLimits;
}

export interface ResolvedDeepShareArtifactFiles {
  files: DeepShareFileV1[];
  omissions: DeepShareOmission[];
}

export async function resolveDeepShareArtifactFiles(
  input: ResolveDeepShareArtifactFilesInput
): Promise<ResolvedDeepShareArtifactFiles> {
  const files: DeepShareFileV1[] = [];
  const omissions: DeepShareOmission[] = [];
  const workspaceRealPath = await realpath(input.workspaceRoot);
  const artifacts = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));

  for (const row of input.catalogFiles) {
    const artifact = artifacts.get(row.entityId);
    if (!artifact) continue;
    let candidates: Array<{ absolutePath: string; role: string }>;
    try {
      const rowStat = await stat(row.path);
      candidates = rowStat.isDirectory()
        ? await packageCandidates(row.path, artifact.type)
        : (artifact.type === 'sequence' || artifact.type === 'construct') &&
            (await isSequencePackageRoot(dirname(row.path)))
          ? await packageCandidates(dirname(row.path), artifact.type)
          : [{ absolutePath: row.path, role: 'primary' }];
    } catch {
      omissions.push({
        code: 'UNSUPPORTED_FILE',
        subject: row.relativePath ?? row.path,
        detail: 'The catalog file is missing or unreadable.',
      });
      continue;
    }

    for (const candidate of candidates) {
      const resolved = await resolvePortableFile({
        workspaceRealPath,
        artifactId: artifact.id,
        absolutePath: candidate.absolutePath,
        role: candidate.role,
        limits: input.limits,
      });
      if (resolved.kind === 'file') files.push(resolved.file);
      else omissions.push(resolved.omission);
    }
  }

  const uniqueFiles = new Map(files.map((file) => [file.relativePath, file]));
  return {
    files: [...uniqueFiles.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    ),
    omissions: [...omissions].sort((left, right) =>
      `${left.code}\u0000${left.subject}`.localeCompare(`${right.code}\u0000${right.subject}`)
    ),
  };
}

async function isSequencePackageRoot(path: string): Promise<boolean> {
  try {
    return (await stat(resolve(path, '.forge', 'plasmid.json'))).isFile();
  } catch {
    return false;
  }
}

async function packageCandidates(
  packageRoot: string,
  artifactType: DeepShareManifestArtifact['type']
): Promise<Array<{ absolutePath: string; role: string }>> {
  if (artifactType === 'notebook') return notebookPackageCandidates(packageRoot);
  if (artifactType === 'sequence' || artifactType === 'construct') {
    return sequencePackageCandidates(packageRoot);
  }
  return [];
}

async function notebookPackageCandidates(
  packageRoot: string
): Promise<Array<{ absolutePath: string; role: string }>> {
  const metaPath = resolve(packageRoot, '.forge', 'notebook.json');
  const markdownPath = resolve(packageRoot, `${basename(packageRoot)}.md`);
  const document = parseNotebookPackageDocument(await readFile(metaPath, 'utf8'));
  const candidates = [
    { absolutePath: metaPath, role: 'package-metadata' },
    { absolutePath: markdownPath, role: 'human-readable-projection' },
  ];
  for (const attachmentPath of collectNotebookAttachmentPaths(document.content)) {
    candidates.push({ absolutePath: resolve(packageRoot, attachmentPath), role: 'attachment' });
  }
  return candidates;
}

async function sequencePackageCandidates(
  packageRoot: string
): Promise<Array<{ absolutePath: string; role: string }>> {
  const metaPath = resolve(packageRoot, '.forge', 'plasmid.json');
  const document = parseSequencePackageDocument(await readFile(metaPath, 'utf8'));
  const candidates = [
    { absolutePath: metaPath, role: 'package-metadata' },
    { absolutePath: resolve(packageRoot, document.product.file), role: 'primary' },
  ];
  for (const member of document.members) {
    candidates.push({ absolutePath: resolve(packageRoot, member.path), role: member.role });
  }
  return candidates;
}

function collectNotebookAttachmentPaths(value: unknown): string[] {
  const paths = new Set<string>();
  visitNotebookNode(value, paths);
  return [...paths].sort();
}

function visitNotebookNode(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitNotebookNode(entry, paths));
    return;
  }
  const record = objectRecord(value);
  if (!record) return;
  const attrs = objectRecord(record.attrs);
  if (
    record.type === 'image' &&
    attrs &&
    typeof attrs.src === 'string' &&
    isSafeRelativePath(attrs.src) &&
    attrs.src.startsWith('assets/')
  ) {
    paths.add(attrs.src);
  }
  Object.values(record).forEach((entry) => visitNotebookNode(entry, paths));
}

type PortableFileResult =
  | { kind: 'file'; file: DeepShareFileV1 }
  | { kind: 'omission'; omission: DeepShareOmission };

async function resolvePortableFile(input: {
  workspaceRealPath: string;
  artifactId: string;
  absolutePath: string;
  role: string;
  limits: ShareBundleLimits;
}): Promise<PortableFileResult> {
  let fileRealPath: string;
  try {
    fileRealPath = await realpath(input.absolutePath);
  } catch {
    return {
      kind: 'omission',
      omission: {
        code: 'UNSUPPORTED_FILE',
        subject: input.absolutePath,
        detail: 'A package-owned file is missing or unreadable.',
      },
    };
  }
  if (!isWithin(input.workspaceRealPath, fileRealPath)) {
    return {
      kind: 'omission',
      omission: {
        code: 'UNSUPPORTED_FILE',
        subject: input.absolutePath,
        detail: 'The file resolves outside the owning workspace.',
      },
    };
  }
  const relativePath = relative(input.workspaceRealPath, fileRealPath).split(sep).join('/');
  if (!isSafeRelativePath(relativePath)) {
    return {
      kind: 'omission',
      omission: {
        code: 'UNSUPPORTED_FILE',
        subject: relativePath,
        detail: 'The file path is not portable.',
      },
    };
  }
  const bytes = await readFile(fileRealPath);
  if (bytes.byteLength > input.limits.maxFileBytes) {
    return {
      kind: 'omission',
      omission: {
        code: 'FILE_TOO_LARGE',
        subject: relativePath,
        detail: `The file exceeds the ${input.limits.maxFileBytes} byte limit.`,
      },
    };
  }
  const contentType = contentTypeFor(relativePath);
  const utf8 = isTextContentType(contentType);
  return {
    kind: 'file',
    file: {
      id: stableFileId(input.artifactId, relativePath),
      ownerArtifactId: input.artifactId,
      relativePath,
      name: basename(relativePath),
      role: input.role,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content: utf8
        ? { encoding: 'utf8', text: bytes.toString('utf8') }
        : { encoding: 'base64', data: bytes.toString('base64') },
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    record[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
  }
  return record;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function stableFileId(artifactId: string, relativePath: string): string {
  return `file-${createHash('sha256')
    .update(`${artifactId}\u0000${relativePath}`, 'utf8')
    .digest('hex')}`;
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    case '.csv':
      return 'text/csv';
    case '.fa':
    case '.fasta':
    case '.gb':
    case '.gbk':
    case '.gbff':
    case '.genbank':
    case '.txt':
      return 'text/plain';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith('text/') || contentType === 'application/json';
}
