import { countFastaSequences } from '@waypoint/plasmid-viewer';
import type { SequenceImportBlockCode } from '../../shared/workspace-git-types';

function isFastaFormat(content: string): boolean {
  return content.trim().startsWith('>');
}

export type ImportBlock =
  | {
      kind: 'multi-record-fasta';
      recordCount: number;
      message: string;
    }
  | {
      kind: 'sequence-preview-failed';
      message: string;
      reasonCode?: SequenceImportBlockCode;
      canConfirmDnaIdentity?: boolean;
      canConvertToRna?: boolean;
    };

export interface ImportFileAssessment {
  ok: boolean;
  block?: ImportBlock;
}

export function assessImportFile(input: {
  content: string;
  filename: string;
}): ImportFileAssessment {
  const { content, filename } = input;

  if (isFastaFormat(content)) {
    const recordCount = countFastaSequences(content);
    if (recordCount > 1) {
      return {
        ok: false,
        block: {
          kind: 'multi-record-fasta',
          recordCount,
          message:
            `"${filename}" contains ${recordCount} sequences. Multi-record FASTA import isn't ` +
            `supported yet — import a single-sequence file, or split it first. ` +
            `(Nothing was imported.)`,
        },
      };
    }
  }

  return { ok: true };
}
