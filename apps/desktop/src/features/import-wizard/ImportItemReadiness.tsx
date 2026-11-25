import {
  toUserMessage,
  userMessageValue,
  userMessageWithValues,
  type UserMessageKey,
} from '@waypoint/user-messages';
import type { ImportItem } from '../workspace-loader/public/import-wizard-state';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import { importReadiness, IMPORT_READINESS_LABELS } from './import-readiness';
import type { SequenceImportBlockCode } from '../../shared/workspace-git-types';

const BLOCK_COPY: Record<SequenceImportBlockCode, UserMessageKey> = {
  unsupported_format: 'import.unsupportedFormat',
  unsupported_source_kind: 'import.unsupportedSource',
  read_failure: 'import.readFailed',
  parse_failure: 'import.parseFailed',
  unconfirmed_molecule_identity: 'import.identityUnconfirmed',
  non_dna_content: 'import.notDna',
  lossless_conversion_blocked: 'import.losslessBlocked',
  source_too_large: 'import.tooLarge',
  automatic_split_required: 'import.automaticSplitRequired',
  record_name_conflict: 'import.recordNames',
};

const RECOVERY_GUIDANCE: Record<SequenceImportBlockCode, string> = {
  unsupported_format:
    'Export this DNA sequence as GenBank, DNA FASTA or SnapGene in the original application, then select the exported file.',
  unsupported_source_kind:
    'Select the sequence files inside this folder. Use File → Import to copy a whole folder.',
  read_failure: 'Check that this file is still available and readable, then select it again.',
  parse_failure:
    'Open this file in its original application and export a valid GenBank, DNA FASTA or SnapGene copy, then select that copy.',
  unconfirmed_molecule_identity:
    'Use the original application to export DNA as GenBank or FASTA that explicitly identifies DNA. A/C/G/T letters alone do not confirm that a sequence is DNA.',
  non_dna_content:
    'Protein and RNA cannot become DNA sequence packages. Use File → Import for the original file, or select a DNA sequence.',
  lossless_conversion_blocked:
    'Use the original application to export a GenBank copy that preserves the sequence and its additional data, then select that copy.',
  source_too_large:
    'Export the DNA records as separate, smaller GenBank files in the original application, then import those files.',
  automatic_split_required:
    'Use Add → DNA sequences → Import to review the records before importing them as separate sequences.',
  record_name_conflict:
    'Give the records distinct names in the original application, then export and select the file again.',
};

export function importResultDescription(item: ImportItem): string {
  if (item.plannedSequencePackage) return 'Creates an editable DNA sequence package.';
  if (item.kind === 'folder') return 'Copies this folder into the project.';
  const type = sequenceFileTypeForPath(item.sourcePath ?? item.name);
  if (type?.format === 'ab1') return 'Keeps the original chromatogram and quality scores.';
  if (type?.format === 'fastq') return 'Keeps the original sequencing reads and quality scores.';
  if (type?.format === 'fasta' && type.managedImport === 'source') {
    return 'Keeps the original protein FASTA file.';
  }
  return 'Adds this file to the project.';
}

export function ImportItemReadiness({ item }: { item: ImportItem }) {
  const readiness = importReadiness(item);
  return (
    <span
      data-testid="import-readiness-badge"
      data-readiness={readiness}
      className={
        'rounded px-1.5 py-0.5 text-[11px] not-italic ' +
        (readiness === 'blocked' || readiness === 'conflict'
          ? 'bg-warning/10 text-warning'
          : readiness === 'ready'
            ? 'bg-accent/10 text-accent'
            : 'bg-bg-muted text-fg-muted')
      }
    >
      {IMPORT_READINESS_LABELS[readiness]}
    </span>
  );
}

export function ImportItemExplanation({ item }: { item: ImportItem }) {
  if (item.block) {
    return (
      <div className="w-full pl-6 text-xs">
        <p role="alert" data-testid="import-block-warning" className="text-warning">
          Cannot import:{' '}
          {item.block.kind === 'multi-record-fasta'
            ? userMessageWithValues('import.multipleRecordsCount', {
                count: userMessageValue(item.block.recordCount),
              })
            : toUserMessage(
                item.block.message,
                item.block.kind === 'sequence-preview-failed' && item.block.reasonCode
                  ? BLOCK_COPY[item.block.reasonCode]
                  : 'import.readFailed'
              )}
        </p>
        <p data-testid="import-recovery-guidance" className="mt-1 text-fg-muted">
          {item.block.kind === 'multi-record-fasta'
            ? 'For multiple DNA records, use Add → DNA sequences → Import. For other sequences, select a single-record file.'
            : item.block.kind === 'unreadable-source'
              ? 'Check that the source is accessible, then select it again.'
              : item.block.reasonCode
                ? RECOVERY_GUIDANCE[item.block.reasonCode]
                : 'Check this file in the original application, then select a supported DNA source. The reason above must be resolved before it can be imported.'}
        </p>
      </div>
    );
  }
  if (importReadiness(item) === 'duplicate') return null;
  return (
    <p
      data-testid="import-result-description"
      className="w-full pl-6 text-xs text-fg-muted not-italic"
    >
      {importResultDescription(item)}
    </p>
  );
}
