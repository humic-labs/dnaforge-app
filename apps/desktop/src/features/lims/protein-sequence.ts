import { computeChecksum } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import type {
  AminoAcidSequenceRef,
  FileAminoAcidSequenceRef,
  ProteinSequenceRef,
} from '../../shared/lims';
import { parseFastaAminoAcidSequence } from '../../shared/amino-acid-sequence';

export {
  normalizeProteinSequence,
  proteinSequenceValidationError,
  buildInlineProteinSequenceRef,
  buildInlineAminoAcidSequenceRef,
} from './protein-sequence-value';

export async function buildFileAminoAcidSequenceRef(
  filePath: string
): Promise<FileAminoAcidSequenceRef> {
  const [stat, raw] = await Promise.all([
    platform().fs.stat(filePath),
    platform().fs.readTextFile(filePath),
  ]);
  const sequence = parseFastaAminoAcidSequence(raw);
  const contentHash = await computeChecksum(raw);
  const normalizedSequenceHash = await computeChecksum(sequence);
  return {
    mode: 'file',
    relPath: filePath,
    length: sequence.length,
    contentHash,
    fileContentHash: contentHash,
    normalizedSequenceHash,
    sourceFormat: 'fasta',
    sizeBytes: stat.size,
    modifiedAt: stat.mtime,
  };
}

export type ResolvedAminoAcidSequence =
  | { status: 'loaded'; bases: string; length: number }
  | { status: 'missing'; length: number }
  | { status: 'unresolved' }
  | { status: 'error'; error: string };

export async function resolveAminoAcidSequence(
  ref: AminoAcidSequenceRef | ProteinSequenceRef
): Promise<ResolvedAminoAcidSequence> {
  if (ref.mode === 'unresolved') return { status: 'unresolved' };
  if (ref.mode === 'inline') {
    const bases = 'aminoAcids' in ref ? ref.aminoAcids : ref.bases;
    return { status: 'loaded', bases, length: ref.length };
  }
  try {
    const exists = await platform().fs.exists(ref.relPath);
    if (!exists) return { status: 'missing', length: ref.length };
    const raw = await platform().fs.readTextFile(ref.relPath);
    const bases = parseFastaAminoAcidSequence(raw);
    return { status: 'loaded', bases, length: bases.length };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
