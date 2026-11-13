import { decodeSequenceDocument, parseGenBankRecords } from '@waypoint/sequence-utils';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import type { WorkspaceSessionFileWrite } from '@waypoint/domain-services';
import {
  buildSequencePackageDocument,
  createDefaultSequenceEntityMetadata,
  fromPackageRelative,
  sequenceManagedMemberPath,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  stripSequenceProductExtension,
} from '../db/sequence-package';
import {
  allocatePackageSources,
  prepareConvertedSequenceSources,
  type RecordPackageSource,
} from '../db/sequence-package-conversion';
import { hostedWorkspaceSessionController, initializeHostedWorkspaceSession } from './controller';
import { hostedAbsolutePath } from './paths';

const GENBANK_CONTENT_TYPE = 'application/genbank';
const STORED_CONTENT_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'application/x-ndjson',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/genbank',
  'chemical/x-genbank',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
]);

export async function importHostedSequenceFiles(
  files: readonly File[],
  onProgress?: (sent: number, total: number) => void,
  stageWrites?: (writes: readonly WorkspaceSessionFileWrite[]) => Promise<void>,
  options: { convertSequences?: boolean } = {}
): Promise<{ workspaceId: string; paths: string[] }> {
  let session = hostedWorkspaceSessionController.getState();
  let workspaceId = session.activeWorkspaceId;
  if (!workspaceId) {
    await initializeHostedWorkspaceSession();
    session = hostedWorkspaceSessionController.getState();
    workspaceId = session.activeWorkspaceId;
  }
  if (!workspaceId) throw new Error('Create or open a hosted project before importing files.');
  if (!session.snapshot || session.snapshot.workspaceId !== workspaceId) {
    await hostedWorkspaceSessionController.selectWorkspace(workspaceId);
    session = hostedWorkspaceSessionController.getState();
  }
  if (!session.snapshot) throw new Error('No workspace snapshot is loaded.');
  const initiatingAccountId = session.principal?.id;
  const imports = await Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return placementForImportedFile(file, bytes, options.convertSequences !== false);
    })
  );
  const writes = imports.flatMap((entry) => entry.writes);
  assertDistinctImportPaths(writes.map((write) => write.path));
  const current = hostedWorkspaceSessionController.getState();
  if (
    current.activeWorkspaceId !== workspaceId ||
    current.snapshot?.workspaceId !== workspaceId ||
    current.principal?.id !== initiatingAccountId
  ) {
    throw new Error(
      'The project or signed-in account changed while importing. No files were imported.'
    );
  }
  for (const packageRoot of imports.flatMap((entry) => entry.packageRoots)) {
    const root = packageRoot.toLocaleLowerCase('en-US');
    if (
      current.snapshot.files.some((existing) => {
        const path = existing.path.toLocaleLowerCase('en-US');
        return path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
      })
    ) {
      throw new Error(
        `Import would replace an existing project object: ${packageRoot}. Rename the source file or choose another project.`
      );
    }
  }
  if (stageWrites) await stageWrites(writes);
  else await hostedWorkspaceSessionController.commit(writes, onProgress);
  return {
    workspaceId,
    paths: imports.flatMap((entry) =>
      entry.openPaths.map((path) => hostedAbsolutePath(workspaceId, path))
    ),
  };
}

interface ImportPlacement {
  writes: WorkspaceSessionFileWrite[];
  openPaths: string[];
  packageRoots: string[];
}

function placementForImportedFile(
  file: File,
  bytes: Uint8Array,
  convertSequences: boolean
): ImportPlacement {
  if (isGenBankPath(file.name)) {
    const sequence = parseImportedSequence(bytes, file.name);
    const fileName = safeFileName(file.name, sequence.name);
    const candidateStem = stripSequenceProductExtension(fileName);
    const name =
      candidateStem && candidateStem !== '.' && candidateStem !== '..' ? candidateStem : 'sequence';
    const packageRoot = `sequences/${name}`;
    const paths = sequencePackagePaths(packageRoot);
    const entity = createDefaultSequenceEntityMetadata();
    const marker = buildSequencePackageDocument({
      id: crypto.randomUUID(),
      name,
      product: { file: `${name}.gb`, topology: sequence.circular ? 'circular' : 'linear' },
      entity: { ...entity, fields: { ...entity.fields, locus: sequence.name } },
    });
    return {
      packageRoots: [packageRoot],
      openPaths: [paths.productPath],
      writes: [
        {
          path: paths.metaPath,
          bytes: new TextEncoder().encode(serializeSequencePackageDocument(marker)),
          contentType: 'application/json',
        },
        { path: paths.productPath, bytes, contentType: GENBANK_CONTENT_TYPE },
      ],
    };
  }
  const name = portableName(file.name) || 'file.bin';
  const converted = convertSequences ? convertedPackagePlacement(name, bytes) : null;
  if (converted) return converted;
  return {
    packageRoots: [],
    openPaths: [`files/${name}`],
    writes: [
      {
        path: `files/${name}`,
        bytes,
        contentType: STORED_CONTENT_TYPES.has(file.type) ? file.type : 'application/octet-stream',
      },
    ],
  };
}

function convertedPackagePlacement(fileName: string, bytes: Uint8Array): ImportPlacement | null {
  const managedImport = sequenceFileTypeForPath(fileName)?.managedImport;
  if (managedImport !== 'snapgene' && managedImport !== 'nucleotide-fasta') return null;
  const stem = fileName.slice(0, fileName.lastIndexOf('.')) || 'sequence';
  const prepared = prepareConvertedSequenceSources(bytes, fileName, stem);
  if (prepared.kind !== 'ready') return null;
  const allocated = allocatePackageSources(
    prepared.sources.map((source) => ({ ...source, stem: portableName(source.stem) || stem }))
  );
  if (allocated.kind !== 'ready') return null;
  const placement: ImportPlacement = { writes: [], openPaths: [], packageRoots: [] };
  for (const source of allocated.sources) {
    const { writes, productPath, packageRoot } = convertedPackageWrites(source);
    placement.writes.push(...writes);
    placement.openPaths.push(productPath);
    placement.packageRoots.push(packageRoot);
  }
  return placement;
}

function convertedPackageWrites(source: RecordPackageSource): {
  writes: WorkspaceSessionFileWrite[];
  productPath: string;
  packageRoot: string;
} {
  const packageRoot = `sequences/${source.stem}`;
  const productFile = `${source.stem}.gb`;
  const paths = sequencePackagePaths(packageRoot, { productFile });
  const decoded = decodeSequenceDocument(source.content, { filename: productFile });
  const evidencePath = source.original
    ? sequenceManagedMemberPath(portableName(source.original.name) || 'source.bin')
    : null;
  const marker = buildSequencePackageDocument({
    id: crypto.randomUUID(),
    name: source.stem,
    product: { file: productFile, topology: decoded.sequence.circular ? 'circular' : 'linear' },
    ...(evidencePath
      ? {
          members: [
            {
              id: crypto.randomUUID(),
              role: 'evidence-input',
              path: evidencePath,
              replaceable: false,
              createdAt: new Date().toISOString(),
              mediaType: 'application/octet-stream',
            },
          ],
        }
      : {}),
  });
  return {
    packageRoot,
    productPath: paths.productPath,
    writes: [
      {
        path: paths.metaPath,
        bytes: new TextEncoder().encode(serializeSequencePackageDocument(marker)),
        contentType: 'application/json',
      },
      {
        path: paths.productPath,
        bytes: new TextEncoder().encode(source.content),
        contentType: GENBANK_CONTENT_TYPE,
      },
      ...(evidencePath && source.original
        ? [
            {
              path: fromPackageRelative(evidencePath, packageRoot),
              bytes: source.original.bytes,
              contentType: 'application/octet-stream',
            },
          ]
        : []),
    ],
  };
}

function portableName(name: string): string {
  return (
    name
      .replace(/\\/gu, '/')
      .split('/')
      .pop()
      ?.replace(/[^A-Za-z0-9._ -]+/gu, '-')
      .trim() ?? ''
  );
}

function parseImportedSequence(bytes: Uint8Array, filename: string) {
  if (!isGenBankPath(filename)) {
    throw new Error('Hosted sequence editing accepts GenBank files (.gb, .gbk, .gbff).');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The GenBank file is not valid UTF-8.');
  }
  if (parseGenBankRecords(text).length !== 1) {
    throw new Error(
      'This GenBank file contains multiple records. Split it into single-record files before importing into the browser. No records were imported.'
    );
  }
  const decoded = decodeSequenceDocument(text, { filename });
  if (decoded.format !== 'genbank') throw new Error('The selected file is not GenBank.');
  return decoded.sequence;
}

function isGenBankPath(path: string): boolean {
  return /\.(?:gb|gbk|gbff|genbank)$/iu.test(path);
}

function safeFileName(fileName: string, sequenceName: string): string {
  const base = fileName
    .replace(/\\/gu, '/')
    .split('/')
    .pop()
    ?.replace(/[^A-Za-z0-9._ -]+/gu, '-')
    .trim();
  const fallback = sequenceName.replace(/[^A-Za-z0-9._ -]+/gu, '-').trim() || 'sequence';
  const selected = base || `${fallback}.gb`;
  return isGenBankPath(selected) ? selected : `${selected}.gb`;
}

function assertDistinctImportPaths(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const folded = path.toLocaleLowerCase('en-US');
    const previous = seen.get(folded);
    if (previous) {
      throw new Error(`Selected files resolve to the same project path: ${previous} and ${path}.`);
    }
    seen.set(folded, path);
  }
}
