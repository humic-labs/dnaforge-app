import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { PARSER_DISPATCH_LIMITS } from '@waypoint/sequence-utils';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import { packagedCoordinateFormat } from '../shared/default-molecular-view';
import {
  getCurrentMolecularSnapshot,
  MOLECULAR_DOCUMENT_MAX_BYTES,
  MOLECULAR_DOCUMENT_SUFFIX,
  parseMolecularDocument,
  serializeMolecularDocument,
} from '../shared/molecular-document';
import {
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { readMolecularDocumentFile } from './molecular-document-library';
import { SOFT_WARN_BYTES } from '../shared/oversized-guard';
import {
  SOURCE_DOCUMENT_MARKER_PATH,
  SOURCE_DOCUMENT_SCHEMA,
  type SourceDocumentDescriptor,
  type SourceDocumentFamily,
  type SourceDocumentPresentationData,
} from '../shared/source-document-package';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { writeSourceDocumentProducts } from './source-document-products';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { syncDirectory } from './fs-durability';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const member = z
  .string()
  .min(1)
  .refine((value) =>
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && !/[\\:\0]/u.test(part))
  );
const manifestSchema = z
  .object({
    schema: z.literal(SOURCE_DOCUMENT_SCHEMA),
    packageId: digest,
    sourcePathHash: digest,
    sha256: digest,
    projectIdentity: digest.optional(),
    familyId: z.enum(['fasta', 'structure', 'chromatogram']),
    sourceName: member.refine((name) => !name.includes('/')),
    presentation: z.enum([
      'fasta-collection',
      'sequence-package',
      'molecular-document',
      'coordinate-asset',
      'chromatogram',
    ]),
    recordCount: z.number().int().positive(),
    products: z.array(member).nonempty(),
    productIds: z.array(z.string().uuid()),
    files: z.array(z.object({ path: member, sha256: digest }).strict()),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function idFor(familyId: SourceDocumentFamily, sourcePathHash: string, sha256: string) {
  return hash(JSON.stringify([SOURCE_DOCUMENT_SCHEMA, familyId, sourcePathHash, sha256]));
}
export function sourceDocumentPackageId(
  familyId: SourceDocumentFamily,
  sourcePath: string,
  sha256: string
) {
  return idFor(familyId, hash(resolve(sourcePath)), sha256);
}

export function sourceDocumentFamily(path: string): SourceDocumentFamily | null {
  const format = sequenceFileTypeForPath(path)?.format;
  if (format === 'fasta') return 'fasta';
  if (format === 'ab1') return 'chromatogram';
  return packagedCoordinateFormat(path) ? 'structure' : null;
}

const SOURCE_LIMITS = {
  fasta: PARSER_DISPATCH_LIMITS.fastaIndexedBytes,
  structure: SOFT_WARN_BYTES,
  chromatogram: 8 * 1024 * 1024,
};

function originalMember(name: string) {
  return 'original/' + name;
}
function descriptor(root: string, manifest: Manifest): SourceDocumentDescriptor {
  const productPaths = manifest.products.map((member) => join(root, member));
  return {
    packageId: manifest.packageId,
    sourceName: manifest.sourceName,
    familyId: manifest.familyId,
    sha256: manifest.sha256,
    packageRoot: root,
    originalPath: join(root, originalMember(manifest.sourceName)),
    entryPath: productPaths[0],
    productPaths,
    presentation: manifest.presentation,
  };
}

async function physicalMember(root: string, memberPath: string) {
  const path = join(root, member.parse(memberPath));
  if ((await realpath(path)) !== path)
    throw new Error('A source document package member was replaced by a link.');
  return path;
}

async function nativeProductIds(
  root: string,
  presentation: Manifest['presentation'],
  products: string[]
) {
  if (presentation === 'molecular-document') {
    const { document } = await readMolecularDocumentFile({
      workspaceRoot: root,
      path: await physicalMember(root, products[0]),
    });
    return [document.id];
  }
  if (presentation !== 'sequence-package') return [];
  return Promise.all(
    products.map(async (product) => {
      await physicalMember(root, product);
      const directory = dirname(product);
      const metadata = await physicalMember(
        root,
        directory.split(sep).join('/') + '/.forge/plasmid.json'
      );
      const document = parseSequencePackageDocument(
        new TextDecoder().decode(
          await readFileBoundedFromHandle(metadata, MOLECULAR_DOCUMENT_MAX_BYTES)
        )
      );
      if (document.product.file !== basename(product))
        throw new Error('The sequence product no longer matches its document.');
      return document.id;
    })
  );
}

export async function readSourcePackageAtRoot(root: string, immutable: boolean) {
  const directory = await realpath(root);
  if (!(await lstat(root)).isDirectory())
    throw new Error('The source document package is unavailable.');
  const marker = await physicalMember(directory, SOURCE_DOCUMENT_MARKER_PATH);
  const manifest = manifestSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readFileBoundedFromHandle(marker, 16 * 1024 * 1024)
      )
    )
  );
  const original = originalMember(manifest.sourceName);
  const listed = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  const sourceId = idFor(manifest.familyId, manifest.sourcePathHash, manifest.sha256);
  if (
    (manifest.projectIdentity ? hash(sourceId + manifest.projectIdentity) : sourceId) !==
      manifest.packageId ||
    sourceDocumentFamily(manifest.sourceName) !== manifest.familyId ||
    listed.get(original) !== manifest.sha256 ||
    listed.size !== manifest.files.length ||
    manifest.products.some((path) => path !== SOURCE_DOCUMENT_MARKER_PATH && !listed.has(path)) ||
    (manifest.familyId === 'structure' &&
      (manifest.products.length !== 1 ||
        !(
          (manifest.presentation === 'molecular-document' &&
            manifest.products[0].endsWith(MOLECULAR_DOCUMENT_SUFFIX)) ||
          (manifest.presentation === 'coordinate-asset' &&
            manifest.products[0] === SOURCE_DOCUMENT_MARKER_PATH)
        ))) ||
    (manifest.familyId === 'chromatogram' && manifest.presentation !== 'chromatogram') ||
    (manifest.familyId === 'fasta' &&
      !['sequence-package', 'fasta-collection'].includes(manifest.presentation))
  )
    throw new Error('The source document manifest does not match its package.');
  const bytes = await readFileBoundedFromHandle(
    await physicalMember(directory, original),
    SOURCE_LIMITS[manifest.familyId]
  );
  if (hash(bytes) !== manifest.sha256)
    throw new Error('The original source in this package has changed.');
  const ids = await nativeProductIds(directory, manifest.presentation, manifest.products);
  if (
    ids.length !== manifest.productIds.length ||
    ids.some((id, i) => id !== manifest.productIds[i])
  )
    throw new Error('A native product belongs to a different document.');
  if (immutable) {
    for (const file of manifest.files) {
      if (file.path === original) continue;
      const data = await readFileBoundedFromHandle(
        await physicalMember(directory, file.path),
        MOLECULAR_DOCUMENT_MAX_BYTES
      );
      if (hash(data) !== file.sha256)
        throw new Error('A source document package product has changed.');
    }
  }
  return { descriptor: descriptor(directory, manifest), bytes, manifest };
}

type VerifiedPackage = Awaited<ReturnType<typeof readSourcePackageAtRoot>>;

function scopedUuid(key: string) {
  const value = hash(key);
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    '5' + value.slice(13, 16),
    '8' + value.slice(17, 20),
    value.slice(20, 32),
  ].join('-');
}

export async function writeProjectSourceDocumentCopy(
  source: VerifiedPackage,
  root: string,
  projectIdentity: string
) {
  const projectId = hash(source.descriptor.packageId + projectIdentity);
  for (const file of source.manifest.files) {
    const destination = join(root, file.path);
    const path = await physicalMember(source.descriptor.packageRoot, file.path);
    await mkdir(dirname(destination), { recursive: true });
    if (file.path.endsWith('/.forge/plasmid.json')) {
      const document = parseSequencePackageDocument(await readTextMember(source, file));
      await writeFile(
        destination,
        serializeSequencePackageDocument({
          ...document,
          id: scopedUuid(projectId + ':' + file.path),
        }),
        { flag: 'wx' }
      );
    } else if (
      source.manifest.familyId === 'structure' &&
      source.manifest.products.includes(file.path)
    ) {
      const document = parseMolecularDocument(await readTextMember(source, file));
      const id = scopedUuid(projectId + ':' + file.path);
      const history = document.history.map((entry) => ({
        referenceId: scopedUuid(projectId + entry.referenceId),
        snapshot: { ...entry.snapshot, presentation: { ...entry.snapshot.presentation, id } },
      }));
      await writeFile(
        destination,
        serializeMolecularDocument({
          ...document,
          id,
          history,
          currentReferenceId: scopedUuid(projectId + document.currentReferenceId),
        }),
        { flag: 'wx' }
      );
    } else {
      await copyFile(path, destination);
      if (
        hash(await readFileBoundedFromHandle(destination, MOLECULAR_DOCUMENT_MAX_BYTES)) !==
        file.sha256
      )
        throw new Error('The preview changed while saving its package.');
    }
  }
  const files = await inventory(root);
  const productIds = await nativeProductIds(
    await realpath(root),
    source.manifest.presentation,
    source.manifest.products
  );
  const manifest = { ...source.manifest, packageId: projectId, projectIdentity, files, productIds };
  await mkdir(join(root, '.forge'), { recursive: true });
  await writeFile(join(root, SOURCE_DOCUMENT_MARKER_PATH), JSON.stringify(manifest) + '\n', {
    flag: 'wx',
  });
  return readSourcePackageAtRoot(root, true);
}

async function readTextMember(source: VerifiedPackage, file: Manifest['files'][number]) {
  const bytes = await readFileBoundedFromHandle(
    await physicalMember(source.descriptor.packageRoot, file.path),
    MOLECULAR_DOCUMENT_MAX_BYTES
  );
  if (hash(bytes) !== file.sha256)
    throw new Error('The source document package member has changed.');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function presentation(packageData: VerifiedPackage): Promise<SourceDocumentPresentationData> {
  const { descriptor, manifest, bytes } = packageData;
  const sourceSha256 = descriptor.sha256;
  if (descriptor.familyId === 'chromatogram')
    return { familyId: 'chromatogram', sourceSha256, bytes };
  if (descriptor.familyId === 'structure') {
    if (manifest.presentation === 'coordinate-asset') {
      const format = packagedCoordinateFormat(manifest.sourceName);
      if (!format) throw new Error('The coordinate asset format is unavailable.');
      return { familyId: 'structure', sourceSha256, coordinateAsset: { format, bytes } };
    }
    const { document, revision } = await readMolecularDocumentFile({
      workspaceRoot: descriptor.packageRoot,
      path: descriptor.entryPath,
    });
    if (
      document.id !== manifest.productIds[0] ||
      (!manifest.projectIdentity &&
        revision !== manifest.files.find((f) => f.path === manifest.products[0])?.sha256)
    )
      throw new Error('The molecular document changed during presentation.');
    return {
      familyId: 'structure',
      sourceSha256,
      documentId: document.id,
      coordinates: getCurrentMolecularSnapshot(document).coordinates,
    };
  }
  const recordsFile = manifest.files.find((f) => f.path === 'records.json');
  if (!recordsFile) throw new Error('The FASTA record collection is missing.');
  const records = z
    .array(
      z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
          sequence: z.string().min(1),
          length: z.number().int().positive(),
        })
        .strict()
    )
    .parse(JSON.parse(await readTextMember(packageData, recordsFile)));
  if (
    records.length !== manifest.recordCount ||
    records.some((r) => r.sequence.length !== r.length)
  )
    throw new Error('The FASTA record collection is incomplete.');
  return { familyId: 'fasta', sourceSha256, records };
}

export async function readSourceDocumentPresentation(storeRoot: string, packageId: string) {
  return presentation(await readSourceDocumentPackage(storeRoot, packageId));
}
export async function readProjectSourceDocumentPresentation(
  projectRoot: string,
  path: string,
  expected?: { expectedPackageId?: string; expectedSourceSha256?: string }
) {
  const data = await readProjectSourceDocumentPackage(projectRoot, path);
  if (
    (expected?.expectedPackageId && data.descriptor.packageId !== expected.expectedPackageId) ||
    (expected?.expectedSourceSha256 && data.descriptor.sha256 !== expected.expectedSourceSha256)
  )
    throw new Error('The project document no longer matches the opened package.');
  return presentation(data);
}

async function inventory(root: string, dir = root): Promise<Manifest['files']> {
  const files: Manifest['files'] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(root, path)));
    else if (entry.isFile())
      files.push({
        path: relative(root, path).split(sep).join('/'),
        sha256: hash(await readFileBoundedFromHandle(path, MOLECULAR_DOCUMENT_MAX_BYTES)),
      });
    else throw new Error('A source document package contains a non-file member.');
  }
  return files;
}

const pending = new Map<string, Promise<SourceDocumentDescriptor>>();

export async function prepareSourceDocumentPackage(
  storeRoot: string,
  request: { familyId: SourceDocumentFamily; sourcePath: string },
  readSource: (path: string, maxBytes: number) => Promise<Uint8Array> = readFileBoundedFromHandle
): Promise<SourceDocumentDescriptor> {
  const { familyId, sourcePath } = request;
  const sourceName = basename(sourcePath);
  if (
    !isAbsolute(sourcePath) ||
    sourceDocumentFamily(sourceName) !== familyId ||
    !member.safeParse(sourceName).success
  )
    throw new Error('Select a supported source document.');
  const bytes = await readSource(sourcePath, SOURCE_LIMITS[familyId]);
  if (!bytes.length || bytes.length > SOURCE_LIMITS[familyId])
    throw new Error('The source is empty or exceeds the document package size limit.');
  const sha256 = hash(bytes);
  const sourcePathHash = hash(resolve(sourcePath));
  const packageId = idFor(familyId, sourcePathHash, sha256);
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const store = await realpath(storeRoot);
  const root = join(store, packageId);
  const existing = pending.get(root);
  if (existing) return existing;
  const publish = async () => {
    const exists = await lstat(root).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (exists) return (await readSourceDocumentPackage(store, packageId)).descriptor;
    const stage = await mkdtemp(join(store, '.building-'));
    try {
      await mkdir(join(stage, 'original'));
      await writeFile(join(stage, originalMember(sourceName)), bytes, { flag: 'wx', mode: 0o600 });
      const products = await writeSourceDocumentProducts(
        stage,
        familyId,
        sourceName,
        bytes,
        sha256
      );
      const files = await inventory(stage);
      const productIds = await nativeProductIds(
        await realpath(stage),
        products.presentation,
        products.products
      );
      const manifest = manifestSchema.parse({
        schema: SOURCE_DOCUMENT_SCHEMA,
        packageId,
        sourceName,
        sha256,
        sourcePathHash,
        familyId,
        ...products,
        files,
        productIds,
      });
      await mkdir(join(stage, '.forge'));
      await writeFile(join(stage, SOURCE_DOCUMENT_MARKER_PATH), JSON.stringify(manifest) + '\n', {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      await syncDirectory(stage);
      try {
        await rename(stage, root);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
      await syncDirectory(store);
      return (await readSourceDocumentPackage(store, packageId)).descriptor;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  };
  const operation = publish();
  pending.set(root, operation);
  try {
    return await operation;
  } finally {
    pending.delete(root);
  }
}

export async function readSourceDocumentPackage(storeRoot: string, packageId: string) {
  const id = digest.parse(packageId);
  const result = await readSourcePackageAtRoot(join(storeRoot, id), true);
  if (result.descriptor.packageId !== id)
    throw new Error('The source package identity has changed.');
  return result;
}

export async function readProjectSourceDocumentPackage(projectRoot: string, path: string) {
  const { root, candidate } = await canonicalWorkspacePath({
    workspaceRoot: projectRoot,
    path,
    allowMissing: false,
    artifactNoun: 'source document',
  });
  let dir = (await lstat(candidate)).isDirectory() ? candidate : dirname(candidate);
  for (;;) {
    if (
      await lstat(join(dir, SOURCE_DOCUMENT_MARKER_PATH)).catch((error) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        return null;
      })
    ) {
      const result = await readSourcePackageAtRoot(dir, false);
      if (
        candidate !== dir &&
        candidate !== join(dir, SOURCE_DOCUMENT_MARKER_PATH) &&
        !result.descriptor.productPaths.includes(candidate)
      )
        throw new Error('This file is not a source document package product.');
      return result;
    }
    if (dir === root || dirname(dir) === dir)
      throw new Error('The project has no package for this document.');
    dir = dirname(dir);
  }
}

export { importSourceDocumentPackage } from './workspace-git/source-document-promotion';
