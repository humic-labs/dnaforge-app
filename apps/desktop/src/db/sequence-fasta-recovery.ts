import { parseGenBankFull, serializeGenBank } from '@waypoint/sequence-utils';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import {
  prepareConvertedSequenceSources,
  type RecordPackageSource,
} from './sequence-package-conversion';

interface RecoveredPosition {
  record: number;
  position: number;
  line: number;
  column: number;
  character: string;
}

export interface PreparedSequenceRecovery {
  sources: RecordPackageSource[];
  replacementCount: number;
  recordCount: number;
}

export function prepareSequenceRecovery(
  bytes: Uint8Array,
  fileName: string,
  stem: string,
  sourceSha256: string
): PreparedSequenceRecovery | null {
  if (sequenceFileTypeForPath(fileName)?.managedImport !== 'nucleotide-fasta') return null;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) return null;
  const positions: RecoveredPosition[] = [];
  const lengths: number[] = [];
  const damageCounts: number[] = [];
  let record = -1;
  const lines = content.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.startsWith('>')) {
      if (!line.slice(1).trim() || (record >= 0 && lengths[record] === 0)) return null;
      record++;
      lengths.push(0);
      damageCounts.push(0);
      continue;
    }
    if (record < 0) return null;
    let recoveredLine = '';
    for (let column = 0; column < line.length; column++) {
      const character = line[column];
      if (character === ' ' || character === '\t') {
        recoveredLine += character;
        continue;
      }
      if (/^[ACGTURYSWKMBDHVN]$/i.test(character)) {
        recoveredLine += character;
      } else if (/^[`'"?\u2018\u2019\u201c\u201d\ufffd]$/.test(character)) {
        positions.push({
          record,
          position: lengths[record],
          line: index + 1,
          column: column + 1,
          character,
        });
        if (positions.length > 1000) return null;
        damageCounts[record]++;
        recoveredLine += 'N';
      } else {
        return null;
      }
      lengths[record]++;
    }
    lines[index] = recoveredLine;
  }
  if (
    positions.length === 0 ||
    record < 0 ||
    lengths.some((length, i) => length === 0 || damageCounts[i] / length > 0.1)
  )
    return null;
  const prepared = prepareConvertedSequenceSources(
    new TextEncoder().encode(lines.join('\n')),
    fileName,
    `${stem} recovered`,
    'dna'
  );
  if (prepared.kind !== 'ready') return null;
  return {
    replacementCount: positions.length,
    recordCount: prepared.sources.length,
    sources: prepared.sources.map((source, recordIndex) => {
      const parsed = parseGenBankFull(source.content);
      const changes = positions.filter((position) => position.record === recordIndex);
      const recoveryNote = `Recovered copy: ${changes.length} unreadable symbol(s) replaced with N (unknown base). Original sequence length is uncertain; no symbol was deleted. Original file: ${fileName}; SHA256: ${sourceSha256}.`;
      return {
        ...source,
        stem: prepared.sources.length > 1 ? `${source.stem} recovered` : source.stem,
        content: serializeGenBank({
          ...parsed,
          description: `${parsed.description ?? parsed.name}. ${recoveryNote}`,
          annotations: [
            ...parsed.annotations,
            ...changes.map((change) => ({
              name: 'Recovered unknown base',
              type: 'misc_feature',
              direction: 0 as const,
              start: change.position,
              end: change.position + 1,
              qualifiers: {
                note: [
                  `Replaced ${JSON.stringify(change.character)} with N; source line ${change.line}, column ${change.column}. ${recoveryNote}`,
                ],
              },
            })),
          ],
        }),
        original: { name: fileName, bytes },
      };
    }),
  };
}
