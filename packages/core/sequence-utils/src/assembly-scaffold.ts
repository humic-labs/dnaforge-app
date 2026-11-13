import { complementBase } from './iupac';
import type { SequenceStrandOverride } from './sequence-strand-display';

export interface ExposedDigestEnd {
  overhang: string;
  enzyme?: string;
  junctionIndex?: number;
}

export interface AssemblyScaffold {
  slotId: string;
  slotIndex: number;
  label: string;
  incomingOverhang: string | null;
  outgoingOverhang: string | null;
  enzyme?: string;
  exposedDigestEnds?: { preceding?: ExposedDigestEnd; following?: ExposedDigestEnd };
}

export function assemblyScaffoldTooltip(scaffold: AssemblyScaffold): string {
  const left = scaffold.incomingOverhang ?? '—';
  const right = scaffold.outgoingOverhang ?? '—';
  return `${scaffold.label} · ${left} → ${right}`;
}

export interface AssemblyScaffoldGap {
  start: number;
  end: number;
  sourcePosition: number;
  scaffold: AssemblyScaffold;
  leadingJunction?: ExposedDigestEnd & { kind: 'schema' | 'digest' };
}

function scaffoldDisplayText(scaffold: AssemblyScaffold): string {
  return `.......... ${scaffold.label.replace(/\s+/g, ' ').trim()} ..........`;
}

export function createAssemblyScaffoldLayout(
  sourceLength: number,
  segments: readonly { start: number; end: number; scaffold?: AssemblyScaffold }[] = [],
  circular = false
) {
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const missing = ordered.filter((segment) => segment.scaffold);
  let insertedColumns = 0;
  const gaps: AssemblyScaffoldGap[] = missing.map((segment) => {
    const scaffold = segment.scaffold!;
    const index = ordered.indexOf(segment);
    const preceding = ordered[index - 1] ?? (circular ? ordered[ordered.length - 1] : undefined);
    const adjacent =
      preceding &&
      (preceding.end === segment.start ||
        (circular && index === 0 && segment.start === 0 && preceding.end === sourceLength));
    const digestEnd = scaffold.exposedDigestEnds?.preceding;
    const leadingJunction: AssemblyScaffoldGap['leadingJunction'] = digestEnd
      ? { ...digestEnd, kind: 'digest' }
      : preceding?.scaffold && adjacent && scaffold.incomingOverhang
        ? {
            kind: 'schema',
            overhang: scaffold.incomingOverhang,
            enzyme: scaffold.enzyme,
            junctionIndex: preceding.scaffold.slotIndex,
          }
        : undefined;
    const start = segment.start + insertedColumns;
    const width = scaffoldDisplayText(scaffold).length + (leadingJunction?.overhang.length ?? 0);
    insertedColumns += width;
    return { start, end: start + width, sourcePosition: segment.start, scaffold, leadingJunction };
  });
  const displayLength = sourceLength + insertedColumns;
  const strandOverrides: SequenceStrandOverride[] = gaps.flatMap((gap) => {
    const ends = gap.scaffold.exposedDigestEnds;
    const text = scaffoldDisplayText(gap.scaffold);
    const result: SequenceStrandOverride[] = [
      {
        start: gap.start + (gap.leadingJunction?.overhang.length ?? 0),
        kind: 'label',
        forward: text,
        reverse: text,
      },
    ];
    if (gap.leadingJunction)
      result.push({
        start: gap.start,
        forward:
          gap.leadingJunction.kind === 'schema'
            ? gap.leadingJunction.overhang
            : ' '.repeat(gap.leadingJunction.overhang.length),
        reverse: Array.from(gap.leadingJunction.overhang, (base) => complementBase(base)).join(''),
      });
    if (ends?.following)
      result.push({
        start: gap.end,
        reverse: ' '.repeat(ends.following.overhang.length),
      });
    return result;
  });
  return {
    sourceLength,
    displayLength,
    gaps,
    strandOverrides,
    junctions: gaps.flatMap((gap) =>
      gap.leadingJunction
        ? [{ ...gap.leadingJunction, start: gap.start, slotId: gap.scaffold.slotId }]
        : []
    ),
    sourceToDisplay(position: number): number {
      return (
        position +
        gaps.reduce(
          (offset, gap) => offset + (gap.sourcePosition <= position ? gap.end - gap.start : 0),
          0
        )
      );
    },
    displayToSource(position: number): number {
      let offset = 0;
      for (const gap of gaps) {
        if (position < gap.start) break;
        if (position < gap.end) return gap.sourcePosition;
        offset += gap.end - gap.start;
      }
      return position - offset;
    },
    gapAt(position: number): AssemblyScaffoldGap | undefined {
      return gaps.find((gap) => position >= gap.start && position < gap.end);
    },
    displaySequence(sequence: string): string {
      if (!gaps.length) return sequence;
      const chunks: string[] = [];
      let cursor = 0;
      for (const gap of gaps) {
        chunks.push(sequence.slice(cursor, gap.sourcePosition), '.'.repeat(gap.end - gap.start));
        cursor = gap.sourcePosition;
      }
      chunks.push(sequence.slice(cursor));
      return chunks.join('');
    },
  };
}

export type AssemblyScaffoldLayout = ReturnType<typeof createAssemblyScaffoldLayout>;

export function assemblyScaffoldSelectionLength(
  displayLength: number,
  gaps: readonly { start: number; end: number }[],
  selection: { start: number; end: number; wraps?: boolean } | null
): number {
  if (!selection || displayLength <= 0) return 0;
  const split = (start: number, end: number) =>
    end > start
      ? [{ start, end }]
      : [
          { start, end: displayLength },
          { start: 0, end },
        ];
  const selected = split(selection.start, selection.end + 1);
  let length = selected.reduce((sum, span) => sum + span.end - span.start, 0);
  for (const gap of gaps) {
    for (const span of split(gap.start, gap.end)) {
      for (const range of selected) {
        length -= Math.max(0, Math.min(span.end, range.end) - Math.max(span.start, range.start));
      }
    }
  }
  return Math.max(0, length);
}

export function assemblyScaffoldRulerTicks(
  displayLength: number,
  segments: readonly { start: number; end: number; scaffold?: AssemblyScaffold }[],
  step: number,
  from = 0,
  to = displayLength,
  labelOffset = 0
): { position: number; label: number }[] {
  const gaps = segments
    .filter((segment) => segment.scaffold)
    .flatMap((segment) =>
      segment.end > segment.start
        ? [segment]
        : [
            { start: segment.start, end: displayLength },
            { start: 0, end: segment.end },
          ]
    )
    .sort((a, b) => a.start - b.start);
  const ticks: { position: number; label: number }[] = [];
  let cursor = 0;
  let omitted = 0;
  for (const gap of [...gaps, { start: displayLength, end: displayLength }]) {
    const start = Math.max(cursor, from);
    const end = Math.min(gap.start, to);
    const firstLabel = Math.ceil((start - omitted + labelOffset) / step) * step;
    for (let label = firstLabel; label - labelOffset + omitted < end; label += step) {
      ticks.push({ position: label - labelOffset + omitted, label });
    }
    omitted += gap.end - gap.start;
    cursor = gap.end;
  }
  return ticks;
}
