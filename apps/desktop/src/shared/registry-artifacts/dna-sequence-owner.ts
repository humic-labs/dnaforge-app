import type { ArtifactIO } from '../artifact-io';
import type { createSequenceIdentityRepository } from '../../db/sequence-identity-repository';
import type { createCatalogRepository } from '../../db/catalog-repository';
import type { inferCatalogFileKind } from '../catalog-file-kind';

import { computeChecksum, resolveSequenceGeneticCode } from '@waypoint/sequence-utils';

import {
  type DnaSequenceRef,
  type DnaSequenceSourceFormat,
  type DnaSequenceTopology,
  type FileDnaSequenceRef,
} from '../lims';
import {
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from '../parse-sequence-file';

export type ResolvedDnaSequence =
  | {
      status: 'loaded' | 'drifted';
      ref: DnaSequenceRef;
      bases: string;
      length: number;
      topology: DnaSequenceTopology;
      contentHash: string;
      sequenceId?: number | null;
    }
  | {
      status: 'missing';
      ref: FileDnaSequenceRef;
      length: number;
      topology: DnaSequenceTopology;
    }
  | {
      status: 'unresolved';
      ref: DnaSequenceRef;
    }
  | {
      status: 'error';
      ref: DnaSequenceRef;
      error: string;
    };

export { buildInlineDnaSequenceRef } from './dna-sequence-value';

export interface FileDnaSequenceSnapshot {
  ref: FileDnaSequenceRef;

  bases: string;
}
export interface DnaSequenceDependencies {
  assertCanonicalSequenceSource(documentId: string, filePath: string): Promise<void>;
  io(): { fs: Pick<ArtifactIO['fs'], 'exists' | 'stat' | 'readFile' | 'readTextFile'> };
  ensureSequenceIdentity: ReturnType<
    typeof createSequenceIdentityRepository
  >['ensureSequenceIdentity'];
  getCatalogEntityForFilePath: ReturnType<
    typeof createCatalogRepository
  >['getCatalogEntityForFilePath'];
  inferCatalogFileKind: typeof inferCatalogFileKind;
  registerWorkspaceFile: ReturnType<typeof createCatalogRepository>['registerWorkspaceFile'];
}
export function createDnaSequenceOwner(dependencies: DnaSequenceDependencies) {
  const {
    assertCanonicalSequenceSource,
    ensureSequenceIdentity,
    getCatalogEntityForFilePath,
    inferCatalogFileKind,
    registerWorkspaceFile,
  } = dependencies;
  async function resolveDnaSequence(ref: DnaSequenceRef): Promise<ResolvedDnaSequence> {
    if (ref.mode === 'unresolved') {
      return { status: 'unresolved', ref };
    }
    if (ref.mode === 'inline') {
      const bases = ref.bases.replace(/\s/g, '');
      const contentHash = ref.contentHash ?? (await computeChecksum(bases));
      return {
        status: contentHash === ref.contentHash || !ref.contentHash ? 'loaded' : 'drifted',
        ref: { ...ref, bases, length: bases.length, contentHash },
        bases,
        length: bases.length,
        topology: 'linear',
        contentHash,
      };
    }

    try {
      const exists = await dependencies.io().fs.exists(ref.relPath);
      if (!exists) {
        return {
          status: 'missing',
          ref,
          length: ref.length,
          topology: ref.topology,
        };
      }
      const loaded = await readAndParseDnaSequenceFile(ref.relPath);
      const parsed = loaded.parsed;
      const contentHash = await computeChecksum(loaded.contentForHash);
      const normalizedSequenceHash = await computeChecksum(parsed.sequence.sequence.toUpperCase());
      const expectedFileHash = ref.fileContentHash ?? ref.contentHash;
      const documentId = await resolveSequenceDocumentId(ref.relPath, undefined, ref.documentId);
      let sequenceId = ref.sequenceId ?? null;
      if (sequenceId == null) {
        sequenceId = await ensureSequenceIdentity(
          documentId,
          ref.relPath,
          parsed.sequence.name || ref.relPath.split('/').pop() || ref.relPath,
          parsed.sequence.length,
          parsed.sequence.circular ?? ref.topology === 'circular'
        );
      }
      return {
        status: contentHash === expectedFileHash ? 'loaded' : 'drifted',
        ref: {
          ...ref,
          documentId,
          length: parsed.sequence.length,
          topology: parsed.sequence.circular ? 'circular' : 'linear',
          geneticCode: resolveSequenceGeneticCode(parsed.sequence).code,
          contentHash,
          fileContentHash: contentHash,
          normalizedSequenceHash,
          sourceFormat: sourceFormatForParsed(parsed.format),
          sequenceId,
        },
        bases: parsed.sequence.sequence,
        length: parsed.sequence.length,
        topology: parsed.sequence.circular ? 'circular' : 'linear',
        contentHash,
        sequenceId,
      };
    } catch (err) {
      return {
        status: 'error',
        ref,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function buildFileDnaSequenceSnapshot(
    filePath: string,
    options: { workspaceRoot?: string; documentId?: string } = {}
  ): Promise<FileDnaSequenceSnapshot> {
    const [stat, loaded] = await Promise.all([
      dependencies.io().fs.stat(filePath),
      readAndParseDnaSequenceFile(filePath),
    ]);
    const parsed = loaded.parsed;
    const bases = parsed.sequence.sequence;
    const topology: DnaSequenceTopology = parsed.sequence.circular ? 'circular' : 'linear';
    const contentHash = await computeChecksum(loaded.contentForHash);
    const normalizedSequenceHash = await computeChecksum(bases.toUpperCase());
    const sequenceName = parsed.sequence.name || filePath.split('/').pop() || filePath;
    const documentId = await resolveSequenceDocumentId(
      filePath,
      options.workspaceRoot,
      options.documentId
    );
    await assertCanonicalSequenceSource(documentId, filePath);
    const sequenceId = options.workspaceRoot
      ? await ensureSequenceIdentity(
          documentId,
          filePath,
          sequenceName,
          parsed.sequence.length,
          topology === 'circular',
          options.workspaceRoot
        )
      : await ensureSequenceIdentity(
          documentId,
          filePath,
          sequenceName,
          parsed.sequence.length,
          topology === 'circular'
        );
    return {
      ref: {
        mode: 'file',
        documentId,
        relPath: filePath,
        topology,
        length: parsed.sequence.length,
        geneticCode: resolveSequenceGeneticCode(parsed.sequence).code,
        contentHash,
        fileContentHash: contentHash,
        normalizedSequenceHash,
        sourceFormat: sourceFormatForParsed(parsed.format),
        sequenceId,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime,
      },
      bases,
    };
  }

  async function resolveSequenceDocumentId(
    filePath: string,
    workspaceRoot?: string,
    suppliedDocumentId?: string
  ): Promise<string> {
    if (suppliedDocumentId?.trim()) return suppliedDocumentId;
    const existing = await getCatalogEntityForFilePath(filePath);
    if (existing) return existing.id;
    const entity = await registerWorkspaceFile({
      path: filePath,
      name: filePath.split(/[\\/]/).pop() || 'Sequence',
      entityType: 'sequence',
      fileKind: inferCatalogFileKind(filePath),
      workspaceRoot: workspaceRoot ?? null,
      metadata: { discoveredFrom: 'dna-sequence-reference' },
    });
    return entity.id;
  }

  async function buildFileDnaSequenceRef(
    filePath: string,
    options: { workspaceRoot?: string; documentId?: string } = {}
  ): Promise<FileDnaSequenceRef> {
    return (await buildFileDnaSequenceSnapshot(filePath, options)).ref;
  }

  function sourceFormatForParsed(format: string): DnaSequenceSourceFormat {
    if (format === 'genbank') return 'gb';
    if (format === 'fasta') return 'fasta';
    if (format === 'snapgene') return 'snapgene';
    return 'unknown';
  }

  async function readAndParseDnaSequenceFile(filePath: string): Promise<{
    parsed: ReturnType<typeof parseTextSequenceFileAsAnnotated>;
    contentForHash: string | ArrayBuffer;
  }> {
    if (filePath.toLowerCase().endsWith('.dna')) {
      const bytes = await dependencies.io().fs.readFile(filePath);
      const contentForHash = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      );
      return {
        parsed: parseBinarySequenceFileAsAnnotated(bytes, filePath),
        contentForHash,
      };
    }
    const content = await dependencies.io().fs.readTextFile(filePath);
    return {
      parsed: parseTextSequenceFileAsAnnotated(content, filePath),
      contentForHash: content,
    };
  }
  return { resolveDnaSequence, buildFileDnaSequenceSnapshot, buildFileDnaSequenceRef };
}
