import {
  classifyMoleculeType,
  decodeSequenceDocument,
  parseGenBankRecords,
  parseSequenceFile,
} from '@waypoint/sequence-utils';
import {
  computeSequenceFingerprint,
  type SequenceFingerprintKind,
} from '@waypoint/sequence-utils/sequence-fingerprint';
import { isBinarySequenceFilePath } from '@waypoint/sequence-utils/sequence-file-types';

export const MAX_FINGERPRINT_SOURCE_BYTES = 32 * 1024 * 1024;

interface FingerprintRecord {
  sequence: string;
  circular?: boolean;
  molecule?: string;
}

export function fingerprintKindOf(record: FingerprintRecord): SequenceFingerprintKind | null {
  const label = record.molecule?.trim();
  if (label) {
    if (/RNA$/i.test(label)) return 'rna';
    if (/DNA$/i.test(label)) return 'dna';
    if (/^(aa|protein)$/i.test(label)) return 'protein';
  }
  const classification = classifyMoleculeType(record.sequence);
  return classification.kind === 'ambiguous' ? null : classification.kind;
}

export function singleRecordOf(bytes: Uint8Array, path: string): FingerprintRecord | null {
  if (isBinarySequenceFilePath(path)) return decodeSequenceDocument(bytes, { path }).sequence;
  const text = new TextDecoder().decode(bytes);
  const document = decodeSequenceDocument(text, { path });
  if (document.format === 'genbank') {
    const records = parseGenBankRecords(text);
    return records.length === 1 ? records[0] : null;
  }
  const records = parseSequenceFile(text, { filename: document.source.filename });
  return records.length === 1 ? document.sequence : null;
}

export async function fingerprintSequenceBytes(
  bytes: Uint8Array,
  path: string
): Promise<string | null> {
  if (bytes.byteLength > MAX_FINGERPRINT_SOURCE_BYTES) return null;
  try {
    const record = singleRecordOf(bytes, path);
    if (!record) return null;
    const kind = fingerprintKindOf(record);
    if (!kind) return null;
    return await computeSequenceFingerprint({
      kind,
      topology: record.circular ? 'circular' : 'linear',
      residues: record.sequence,
    });
  } catch {
    return null;
  }
}
