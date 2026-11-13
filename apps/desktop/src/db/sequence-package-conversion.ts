import {
  classifyMoleculeType,
  nucleicAcidOfBases,
  parseSequenceFile,
  parseSnapGene,
  serializeGenBank,
  toNucleicAcid,
  type NucleicAcid,
} from '@waypoint/sequence-utils';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import type { SequenceImportBlockCode } from '../shared/workspace-git-types';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionOf(fileName: string): string {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

const NUCLEOTIDE_SPECIFIC_FASTA_EXTENSIONS = new Set(['.fna', '.ffn', '.dnas']);
const PROTEIN_IDENTITY_TERMS =
  /\b(?:protein|peptide|polypeptide|proteome|amino[\s-]?acid|translat(?:ion|ed)|enzyme)\b/i;
const RNA_IDENTITY_TERMS =
  /\b(?:(?:m|r|t|nc|mi|si|sn|sno|sc|srp|tm|ss|ds)?rna|ribonucleic[\s-]?acid)\b/i;
const REFSEQ_TRANSCRIPT_ACCESSION = /^(?:NM|XM|NR|XR)_\d+(?:\.\d+)?$/;
const NUCLEOTIDE_IDENTITY_TERMS =
  /\b(?:dna|nucleotide|deoxyribonucleic[\s-]?acid|plasmid|vector|coding[\s-]?sequence|amplicon|oligonucleotide|oligo)\b/i;
const NUCLEOTIDE_ALPHABET = /^[ACGTURYSWKMBDHVN]+$/i;

export type ConversionIssue = {
  reason: string;
  reasonCode: SequenceImportBlockCode;
  canConfirmDnaIdentity?: boolean;
  canConvertToRna?: boolean;
};

function conversionIssue(reasonCode: SequenceImportBlockCode, reason: string): ConversionIssue {
  return { reasonCode, reason };
}

export function describeLossyConversion(
  records: readonly { name: string; sequence: string }[],
  rawContent: string,
  fileName: string,
  dnaIdentityConfirmed = false
): ConversionIssue | null {
  const content = normalizeFastaContent(rawContent);

  const firstHeader = content.indexOf('>');
  if (firstHeader < 0) {
    return conversionIssue(
      'parse_failure',
      'No FASTA header found; refusing to convert a file this parser did not understand.'
    );
  }
  if (content.slice(0, firstHeader).trim().length > 0) {
    return conversionIssue(
      'lossless_conversion_blocked',
      'This file has text before its first ">" header, which conversion would discard.'
    );
  }
  if (/^[ \t]+>/m.test(content)) {
    return conversionIssue(
      'lossless_conversion_blocked',
      'This file has indented ">" lines; they are not read as headers, so their sequences would be merged into the record above.'
    );
  }
  if (/^[ \t]*;/m.test(content)) {
    return conversionIssue(
      'lossless_conversion_blocked',
      'This file has ";" comment lines, which conversion would discard.'
    );
  }

  const headers = extractFastaHeaders(content);
  if (headers.length !== records.length) {
    return conversionIssue(
      'lossless_conversion_blocked',
      headers.length > records.length
        ? `${headers.length - records.length} empty record(s) in this file have no sequence; converting would drop them.`
        : 'This file did not parse into one record per header; refusing to convert.'
    );
  }

  const classifications = records.map((record) => classifyMoleculeType(record.sequence));
  const mixed = describeMixedMoleculeTypes(classifications);
  if (mixed) return mixed;

  for (const [index, record] of records.entries()) {
    if (/[-.*]/.test(record.sequence)) {
      return conversionIssue(
        'lossless_conversion_blocked',
        `"${record.name}" contains gap or stop characters, which GenBank cannot round-trip.`
      );
    }
    const classification = classifications[index];
    if (classification.kind === 'protein') {
      return conversionIssue(
        'non_dna_content',
        `"${record.name}" is a protein sequence, so it cannot be written as a GenBank nucleotide record.`
      );
    }
    if (!NUCLEOTIDE_ALPHABET.test(record.sequence)) {
      return conversionIssue(
        'non_dna_content',
        `"${record.name}" is not a DNA/RNA sequence, so it cannot be written as a GenBank nucleotide record.`
      );
    }
    if (classification.kind === 'ambiguous' && classification.reason === 'mixed_t_u') {
      return conversionIssue(
        'non_dna_content',
        `"${record.name}" contains both T and U, so it is neither clearly DNA nor RNA.`
      );
    }
    if (
      !dnaIdentityConfirmed &&
      classification.kind === 'ambiguous' &&
      classification.reason === 'ambiguity_codes'
    ) {
      return conversionIssue(
        'unconfirmed_molecule_identity',
        `"${record.name}" is N-rich: more than 10% of its letters are N or other ambiguity codes, so its letters alone do not show that it is DNA.`
      );
    }
    if (nucleicAcidOfBases(record.sequence) === 'rna') continue;

    const identityReason = describeUnconfirmedNucleotideIdentity(
      fileName,
      [headers[index] ?? ''],
      classification.kind === 'dna'
    );
    if (
      identityReason &&
      (!dnaIdentityConfirmed || identityReason.reasonCode !== 'unconfirmed_molecule_identity')
    )
      return { ...identityReason, reason: `"${record.name}": ${identityReason.reason}` };
  }

  return null;
}

export function normalizeFastaContent(rawContent: string): string {
  return rawContent.replace(/^\uFEFF/, '');
}

export function extractFastaHeaders(normalizedContent: string): string[] {
  return (normalizedContent.match(/^>.*$/gm) ?? []).map((line) => line.slice(1).trim());
}

function describeMixedMoleculeTypes(
  classifications: readonly ReturnType<typeof classifyMoleculeType>[]
): ConversionIssue | null {
  const counts = { dna: 0, rna: 0, protein: 0 };
  for (const classification of classifications) {
    if (classification.kind !== 'ambiguous') counts[classification.kind]++;
  }
  const present = (['dna', 'rna', 'protein'] as const).filter((kind) => counts[kind] > 0);
  if (present.length < 2) return null;
  const label = { dna: 'DNA', rna: 'RNA', protein: 'protein' };
  return conversionIssue(
    'non_dna_content',
    `This file mixes molecule types (${present
      .map((kind) => `${counts[kind]} ${label[kind]}`)
      .join(', ')} records), so it cannot be converted as one set of DNA sequences.`
  );
}

function describeUnconfirmedNucleotideIdentity(
  fileName: string,
  headers: readonly string[],
  compositionIsDna: boolean
): ConversionIssue | null {
  const accession = headers[0]?.trim().split(/\s+/)[0] ?? '';
  if (compositionIsDna && REFSEQ_TRANSCRIPT_ACCESSION.test(accession)) {
    return null;
  }
  const identityText = `${fileName}\n${headers.join('\n')}`.replace(/_/g, ' ');
  if (PROTEIN_IDENTITY_TERMS.test(identityText)) {
    return conversionIssue(
      'non_dna_content',
      `"${fileName}" identifies protein or peptide content, so it cannot be written as a GenBank nucleotide record.`
    );
  }
  if (RNA_IDENTITY_TERMS.test(identityText)) {
    return {
      ...conversionIssue(
        'unconfirmed_molecule_identity',
        `"${fileName}" declares RNA, but its bases use T. Import it as cDNA (DNA), ` +
          'or convert it to RNA, which replaces T with U and keeps the original file.'
      ),
      canConfirmDnaIdentity: true,
      canConvertToRna: true,
    };
  }
  if (NUCLEOTIDE_SPECIFIC_FASTA_EXTENSIONS.has(extensionOf(fileName).toLowerCase())) {
    return null;
  }
  if (NUCLEOTIDE_IDENTITY_TERMS.test(identityText) || compositionIsDna) {
    return null;
  }
  return {
    ...conversionIssue(
      'unconfirmed_molecule_identity',
      `"${fileName}" uses a generic FASTA extension without explicit nucleotide identity, ` +
        'and its sequence is too short or too repetitive to tell DNA from protein. ' +
        'Confirm that this file contains DNA to import it as a DNA sequence.'
    ),
    canConfirmDnaIdentity: true,
  };
}

export interface RecordPackageSource {
  stem: string;
  fileName: string;
  content: string;
  original?: { name: string; bytes: Uint8Array };
}

type SplitGenBankResult =
  | { kind: 'single' }
  | { kind: 'records'; records: RecordPackageSource[] }
  | { kind: 'invalid'; reason: string };

export function splitGenBankPackageSources(
  content: string,
  sourceStem: string
): SplitGenBankResult {
  const starts = [...content.matchAll(/^(?:\uFEFF)?LOCUS\b/gm)].map((match) => match.index);
  if (starts.length <= 1) return { kind: 'single' };

  const records: RecordPackageSource[] = [];
  let cursor = 0;
  for (const [index, start] of starts.entries()) {
    const gap = content.slice(cursor, start).replace(/^\uFEFF/, '');
    if (gap.trim().length > 0) {
      return {
        kind: 'invalid',
        reason: `Text outside GenBank record ${index + 1} would be lost during splitting.`,
      };
    }

    const nextStart = starts[index + 1] ?? content.length;
    const terminator = /^\/\/[ \t]*(?:\r?\n|$)/gm;
    terminator.lastIndex = start;
    const endMatch = terminator.exec(content);
    if (!endMatch || endMatch.index >= nextStart) {
      return {
        kind: 'invalid',
        reason: `GenBank record ${index + 1} has no complete "//" terminator.`,
      };
    }
    const end = endMatch.index + endMatch[0].length;
    const recordContent = content.slice(start, end);
    try {
      const parsed = parseSequenceFile(recordContent, {
        filename: `${sourceStem}-${index + 1}.gb`,
      });
      if (parsed.length !== 1 || !parsed[0]?.sequence) {
        throw new Error('record did not resolve to exactly one sequence');
      }
      const recordStem = safeStem(parsed[0].name) ?? `${sourceStem} ${index + 1}`;
      records.push({
        stem: recordStem,
        fileName: `${recordStem}.gb`,
        content: recordContent,
      });
    } catch (error) {
      return {
        kind: 'invalid',
        reason: `GenBank record ${index + 1} could not be read: ${errorMessage(error)}.`,
      };
    }
    cursor = end;
  }

  const trailing = content.slice(cursor);
  if (trailing.trim().length > 0) {
    return { kind: 'invalid', reason: 'Text after the final GenBank record would be lost.' };
  }
  if (trailing.length > 0) {
    records[records.length - 1].content += trailing;
  }
  return { kind: 'records', records };
}

export const MAX_AUTOMATIC_SPLIT_RECORDS = 100;
export const MAX_OLIGO_SET_RECORD_LENGTH = 100;

export function describeAutomaticSplitRefusal(
  fileName: string,
  records: readonly RecordPackageSource[]
): string | null {
  if (records.length > MAX_AUTOMATIC_SPLIT_RECORDS) {
    return (
      `"${fileName}" contains ${records.length} records, more than ${MAX_AUTOMATIC_SPLIT_RECORDS} ` +
      'to split into separate sequences automatically. Convert it from its tab to split it.'
    );
  }
  if (
    records.length > 1 &&
    records.every((record) => locusLength(record.content) < MAX_OLIGO_SET_RECORD_LENGTH)
  ) {
    return (
      `"${fileName}" is a set of ${records.length} short oligos, such as primers, so it was not ` +
      'split into separate sequences automatically. Convert it from its tab to split it.'
    );
  }
  return null;
}

function locusLength(genBank: string): number {
  const match = /^LOCUS\s+\S+\s+(\d+)\s+bp/m.exec(genBank);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export type PreparedFastaPackageSources =
  | { kind: 'ready'; sources: RecordPackageSource[] }
  | ({ kind: 'blocked' } & ConversionIssue);

function prepareFastaPackageSources(
  rawContent: string,
  fileName: string,
  stem: string,
  confirmedNucleicAcid?: NucleicAcid,
  originalBytes?: Uint8Array
): PreparedFastaPackageSources {
  let records: ReturnType<typeof parseSequenceFile>;
  try {
    records = declaredRecords(
      parseSequenceFile(rawContent, { filename: fileName }),
      confirmedNucleicAcid
    );
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `"${fileName}" could not be read as sequences: ${errorMessage(error)}.`,
      reasonCode: 'parse_failure',
    };
  }
  if (records.length === 0) {
    return {
      kind: 'blocked',
      reason: `"${fileName}" contains no readable sequences.`,
      reasonCode: 'parse_failure',
    };
  }

  const lossy = describeLossyConversion(
    records,
    rawContent,
    fileName,
    confirmedNucleicAcid !== undefined
  );
  if (lossy) return { kind: 'blocked', ...lossy };

  const headers = extractFastaHeaders(normalizeFastaContent(rawContent));
  const keepOriginal = confirmedNucleicAcid === 'rna' && originalBytes !== undefined;
  const sources = records.map((record, index): RecordPackageSource => {
    const recordStem =
      records.length === 1 ? stem : (safeStem(record.name) ?? `${stem} ${index + 1}`);
    return {
      stem: recordStem,
      fileName: `${recordStem}.gb`,
      content: fastaRecordGenBank(record, headers[index], confirmedNucleicAcid),
      ...(keepOriginal ? { original: { name: fileName, bytes: originalBytes } } : {}),
    };
  });
  return { kind: 'ready', sources };
}

export function declaredRecords<T extends { sequence: string }>(
  records: readonly T[],
  confirmedNucleicAcid: NucleicAcid | undefined
): T[] {
  return confirmedNucleicAcid === 'rna'
    ? records.map((record) => ({ ...record, sequence: toNucleicAcid(record.sequence, 'rna') }))
    : [...records];
}

export function fastaRecordGenBank(
  record: { id: string; name: string; sequence: string; length: number },
  header: string | undefined,
  confirmedNucleicAcid: NucleicAcid | undefined
): string {
  const rna = confirmedNucleicAcid === 'rna' || nucleicAcidOfBases(record.sequence) === 'rna';
  return serializeGenBank({
    id: record.id,
    name: record.name,
    description: header || undefined,
    sequence: record.sequence,
    length: record.length,
    circular: false,
    annotations: [],
    ...(rna ? { molecule: 'RNA' } : {}),
  });
}

export function prepareConvertedSequenceSources(
  bytes: Uint8Array,
  fileName: string,
  stem: string,
  confirmedNucleicAcid?: NucleicAcid
): PreparedFastaPackageSources {
  if (sequenceFileTypeForPath(fileName)?.managedImport !== 'snapgene') {
    return prepareFastaPackageSources(
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
      fileName,
      stem,
      confirmedNucleicAcid,
      bytes
    );
  }
  try {
    const sequence = parseSnapGene(bytes, fileName);
    if (
      sequence.length === 0 ||
      !NUCLEOTIDE_ALPHABET.test(sequence.sequence) ||
      /U/i.test(sequence.sequence)
    ) {
      return {
        kind: 'blocked',
        reason: `"${fileName}" does not contain a nonempty DNA sequence.`,
        reasonCode: 'non_dna_content',
      };
    }
    const converted = {
      ...sequence,
      annotations: sequence.annotations.map((annotation) => ({
        ...annotation,
        qualifiers: {
          ...annotation.qualifiers,
          direction: [
            annotation.direction === -1 ? 'LEFT' : annotation.direction === 1 ? 'RIGHT' : 'NONE',
          ],
        },
      })),
    };
    return {
      kind: 'ready',
      sources: [
        {
          stem,
          fileName: `${stem}.gb`,
          content: serializeGenBank(converted),
          original: { name: fileName, bytes },
        },
      ],
    };
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `"${fileName}" could not be read as SnapGene DNA: ${errorMessage(error)}.`,
      reasonCode: 'parse_failure',
    };
  }
}

export const MAX_PACKAGE_NAME_COLLISIONS = 1000;

type AllocatedPackageSources =
  | { kind: 'ready'; sources: RecordPackageSource[] }
  | { kind: 'blocked'; reason: string };

export function allocatePackageSources(
  sources: readonly RecordPackageSource[]
): AllocatedPackageSources {
  const used = new Set<string>();
  const allocated: RecordPackageSource[] = [];
  for (const source of sources) {
    let name = source.stem;
    for (let suffix = 1; used.has(name); suffix += 1) {
      if (suffix > MAX_PACKAGE_NAME_COLLISIONS) {
        return {
          kind: 'blocked',
          reason:
            `More than ${MAX_PACKAGE_NAME_COLLISIONS + 1} records resolve to the same package name. ` +
            'Rename the duplicate records before importing.',
        };
      }
      name = `${source.stem} (${suffix})`;
    }
    used.add(name);
    allocated.push({ ...source, stem: name });
  }
  return { kind: 'ready', sources: allocated };
}

function safeStem(name: string): string | null {
  const cleaned = name
    .trim()
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : null;
}
