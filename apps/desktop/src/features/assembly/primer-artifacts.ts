import type { DesignPrimer, DesignPrimerPair } from '../design/public/types';
import { calculateGcContent } from '../design/public/algorithms/draft-assembly';
import { primerTmSequence } from '../design/public/algorithms/refine-design-tm';
import { createAppTmCalculator } from '../junction-workbench/public/settings';
import { sha256Hex } from '../primers/public/primer-artifact';

export function assemblyPrimerAnnealing(primer: Pick<DesignPrimer, 'sequence' | 'pbs'>) {
  return {
    pbsSequence: primer.pbs.sequence,
    overhangSequence: primer.sequence.slice(0, primer.sequence.length - primer.pbs.sequence.length),
  };
}

export async function assemblyPrimerArtifactStem(primer: DesignPrimer): Promise<string> {
  const sequence = primer.sequence.trim().toUpperCase();
  const includeAnnealing = primer.manuallyEdited || sequence.length !== primer.pbs.sequence.length;
  const identity =
    primer.oligo || includeAnnealing
      ? JSON.stringify({
          sequence,
          oligo: primer.oligo ?? null,
          ...(includeAnnealing ? { pbsSequence: primer.pbs.sequence } : {}),
        })
      : sequence;
  return `${primer.name}-${(await sha256Hex(identity)).slice(0, 8)}`;
}

export type PrimerArtifactRow = {
  name: string;
  sequence: string;
  length: number;
  tm: number;
  gc: number;
  direction: 'Forward' | 'Reverse';
  fragment: string;
};

const PRIMER_HEADERS = [
  'Name',
  'Sequence',
  'Length (bp)',
  'Tm (°C)',
  'GC (%)',
  'Direction',
  'Fragment',
] as const;

export function buildPrimerArtifactRows(
  primers: readonly DesignPrimerPair[] | null | undefined,
  polymerase?: string | null
): PrimerArtifactRow[] {
  if (!primers || primers.length === 0) return [];

  const calculator = createAppTmCalculator(polymerase);
  const rows: PrimerArtifactRow[] = [];
  for (const pair of primers) {
    rows.push({
      name: pair.forward.name,
      sequence: pair.forward.sequence,
      length: pair.forward.sequence.length,
      tm: pair.forward.tm ?? calculator.estimate(primerTmSequence(pair.forward)),
      gc: calculateGcContent(pair.forward.sequence),
      direction: 'Forward',
      fragment: `F${pair.fragmentIndex + 1}`,
    });
    rows.push({
      name: pair.reverse.name,
      sequence: pair.reverse.sequence,
      length: pair.reverse.sequence.length,
      tm: pair.reverse.tm ?? calculator.estimate(primerTmSequence(pair.reverse)),
      gc: calculateGcContent(pair.reverse.sequence),
      direction: 'Reverse',
      fragment: `F${pair.fragmentIndex + 1}`,
    });
  }
  return rows;
}

export function serializePrimerRowsCsv(rows: readonly PrimerArtifactRow[]): string {
  return [
    PRIMER_HEADERS.join(','),
    ...rows.map((row) =>
      [
        row.name,
        row.sequence,
        row.length.toString(),
        row.tm.toFixed(1),
        row.gc.toFixed(1),
        row.direction,
        row.fragment,
      ]
        .map(csvCell)
        .join(',')
    ),
  ].join('\n');
}

export function serializePrimerRowsTsv(rows: readonly PrimerArtifactRow[]): string {
  return [
    PRIMER_HEADERS.join('\t'),
    ...rows.map((row) =>
      [
        row.name,
        row.sequence,
        row.length.toString(),
        row.tm.toFixed(1),
        row.gc.toFixed(1),
        row.direction,
        row.fragment,
      ].join('\t')
    ),
  ].join('\n');
}

export function serializePrimerRowsFasta(rows: readonly PrimerArtifactRow[]): string {
  if (rows.length === 0) return '';
  return (
    rows
      .map(
        (row) =>
          `>${row.name} fragment=${row.fragment} direction=${row.direction} length=${row.length} tm=${row.tm.toFixed(
            1
          )} gc=${row.gc.toFixed(1)}\n${wrapSequence(row.sequence)}`
      )
      .join('\n') + '\n'
  );
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function wrapSequence(sequence: string): string {
  const lines: string[] = [];
  for (let index = 0; index < sequence.length; index += 80) {
    lines.push(sequence.slice(index, index + 80));
  }
  return lines.join('\n');
}
