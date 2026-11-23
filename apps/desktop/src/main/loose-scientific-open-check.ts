import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import {
  GenBankParseError,
  SequenceParseError,
  isGenBankFormat,
  isSeqFormat,
  isSnapGeneFormat,
} from '@waypoint/sequence-utils';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import { parseFastaAminoAcidSequence, ProteinFastaReadError } from '../shared/amino-acid-sequence';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import { readCompressedGenBank } from '../shared/compressed-genbank-reader';
import { DocumentReadError } from '../shared/document-read-failure';
import type { FastaKindReadAuthority } from '../shared/fasta-kind';
import { readLooseCoordinateModel } from '../shared/loose-coordinate-reader';
import { NATIVE_WORKSPACE_MANIFEST_PATH } from '../shared/native-workspace-manifest';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  getStructureFileFormat,
  isCompressedGenBankPath,
  sequenceParserRouteForPath,
} from '../shared/scientific-file-types';
import type { DocumentOpenSource } from './document-open-source';
import { getFastaKindReadAuthorityInDb } from './fasta-kind-authority';
import { inspectIndexedGenomeDocument } from './indexed-genome-open-check';
import {
  readScientificDocumentInMain,
  resolveMainWorkspaceIdentity,
} from './scientific-document-reader';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';

export type LooseScientificKind = 'structure' | 'sequence' | 'protein';

export async function inspectLooseScientificDocument(
  kind: LooseScientificKind,
  source: DocumentOpenSource
): Promise<void> {
  await source.observe(source.path);
  if (kind === 'structure') return inspectStructure(source);
  const fasta = await readLooseFastaKind(source);
  const readerKind = fasta
    ? fasta.status === 'declared'
      ? fasta.kind
      : fasta.legacyReadView
    : kind;
  if (readerKind === 'protein') return inspectProtein(source);

  const canonicalPath = await source.localPath(source.path);
  const metadata = await stat(canonicalPath);
  if (sequenceParserRouteForPath(source.path, metadata.size) === 'indexed') {
    await inspectIndexedGenomeDocument(source, canonicalPath, metadata);
    return;
  }
  const fileType = sequenceFileTypeForPath(
    isCompressedGenBankPath(source.path) ? source.path.slice(0, -3) : source.path
  );
  if (!fileType) throw new DocumentReadError('unsupported-format');
  if (metadata.size > HARD_CAP_BYTES) throw new DocumentReadError('too-large');
  const content =
    fileType.encoding === 'binary'
      ? await source.readBytes(source.path, HARD_CAP_BYTES)
      : await readWorkspaceSequenceText(source);
  try {
    parseSequenceFileAsDocument(content, source.path);
  } catch (error) {
    if (!(error instanceof SequenceParseError) && !(error instanceof GenBankParseError))
      throw error;
    const recognized = hasSequenceFormatEvidence(content, fileType.format);
    const futureAbif =
      Buffer.isBuffer(content) &&
      fileType.format === 'ab1' &&
      recognized &&
      content.byteLength >= 128 &&
      content.readInt16BE(4) > 200;
    throw new DocumentReadError(futureAbif ? 'newer-format' : 'malformed', recognized, {
      cause: error,
    });
  }
}

async function readLooseFastaKind(
  source: DocumentOpenSource
): Promise<FastaKindReadAuthority | null> {
  if (inferCatalogFileKind(source.path) !== 'fasta') return null;
  async function read(): Promise<FastaKindReadAuthority | null> {
    const binding = source.db
      .prepare(
        `SELECT e.id, e.workspace_id AS entity_workspace, f.workspace_id AS file_workspace
         FROM catalog_entity_files f LEFT JOIN catalog_entities e ON e.id = f.entity_id
         WHERE f.path = ? LIMIT 1`
      )
      .get(source.path) as
      | { id: string | null; entity_workspace: number | null; file_workspace: number | null }
      | undefined;
    if (
      !binding ||
      (binding.id && binding.entity_workspace === null && binding.file_workspace === null)
    )
      return null;
    if (!source.workspaceRoot) throw new DocumentReadError('project');
    await source.observe(join(source.workspaceRoot, NATIVE_WORKSPACE_MANIFEST_PATH));
    try {
      return getFastaKindReadAuthorityInDb(source.db, {
        path: source.path,
        workspaceRoot: source.workspaceRoot,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('FASTA_KIND_'))
        throw new DocumentReadError('project', false, { cause: error });
      throw error;
    }
  }
  let authority: FastaKindReadAuthority | null = null;
  await source.observeRevision(`fasta-kind:${source.path}`, async () => {
    authority = await read();
    return JSON.stringify(authority);
  });
  return authority;
}

async function readWorkspaceSequenceText(source: DocumentOpenSource): Promise<string> {
  const root = source.workspaceRoot;
  if (!root) {
    return isCompressedGenBankPath(source.path)
      ? readCompressedGenBank(await source.readBytes(source.path, HARD_CAP_BYTES))
      : source.readText(source.path, HARD_CAP_BYTES);
  }
  const workspace = resolveMainWorkspaceIdentity(root, source.db);
  const workspaceId = scientificWorkspaceIdForRoot(source.db, root);
  if (!workspace || workspaceId === null) throw new DocumentReadError('project');
  const store = new ScientificObjectStore(source.db, workspaceId);
  await source.observeRevision(`scientific-head:${root}`, () => store.read().head ?? '');

  let filesystemError: unknown;
  const result = await readScientificDocumentInMain(
    {
      operationId: randomUUID(),
      document: parseScientificDocumentIdentity(relative(root, source.path)),
      workspace: parseWorkspaceIdentity(workspace),
      workspaceRoot: root,
    },
    {
      database: source.db,
      read: async (path) => {
        try {
          return await source.readBytes(path, HARD_CAP_BYTES);
        } catch (error) {
          filesystemError = error;
          throw error;
        }
      },
    }
  );
  if (result.ok) return result.document.content;
  if (filesystemError !== undefined) throw filesystemError;
  if (result.error.code === 'DOCUMENT_NOT_FOUND') throw new DocumentReadError('missing');
  if (result.error.code === 'ACCESS_DENIED') throw new DocumentReadError('permission');
  if (result.error.code === 'UNSUPPORTED_FORMAT') throw new DocumentReadError('too-large');
  if (result.error.code === 'INVALID_ENCODING') throw new DocumentReadError('malformed');
  throw new DocumentReadError('runtime');
}

function hasSequenceFormatEvidence(
  content: string | Buffer,
  format: NonNullable<ReturnType<typeof sequenceFileTypeForPath>>['format']
): boolean {
  if (typeof content !== 'string') {
    if (format === 'ab1') return content.subarray(0, 4).equals(Buffer.from('ABIF'));
    return format === 'snapgene' && isSnapGeneFormat(content);
  }
  switch (format) {
    case 'fasta':
      return content.trimStart().startsWith('>');
    case 'fastq':
      return /^@[^\r\n]+\r?\n[^\r\n]+\r?\n\+/u.test(content.trimStart());
    case 'genbank':
      return isGenBankFormat(content);
    case 'seq':
      return isSeqFormat(content);
    default:
      return false;
  }
}

async function inspectProtein(source: DocumentOpenSource): Promise<void> {
  const content = await source.readText(source.path, HARD_CAP_BYTES);
  try {
    parseFastaAminoAcidSequence(content);
  } catch (error) {
    if (!(error instanceof ProteinFastaReadError)) throw error;
    throw new DocumentReadError(
      error.code === 'multiple-records' ? 'unsupported-format' : 'malformed',
      /^\s*>/mu.test(content),
      { cause: error }
    );
  }
}

async function inspectStructure(source: DocumentOpenSource): Promise<void> {
  const format = getStructureFileFormat(source.path);
  if (!format) throw new DocumentReadError('unsupported-format');
  const content =
    format.encoding === 'binary'
      ? await source.readBytes(source.path, HARD_CAP_BYTES)
      : await source.readText(source.path, HARD_CAP_BYTES);
  await readLooseCoordinateModel(content, format);
}
