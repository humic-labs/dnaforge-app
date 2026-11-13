import type { CodonInfo, CodonMutationInfo, CodonMutationKind } from './translation';
import { projectCodonColumns } from '../renderers/pixi/shared/project-codon-columns';

export interface CodonComparisonAxis {
  readonly biologicalLength: number;
  bioToColumn(base: number): number | null;
  columnToBio(column: number): number | null;
}

export interface CodonComparisonInput {
  readonly reference: readonly CodonInfo[];
  readonly referenceAxis: CodonComparisonAxis;
  readonly query: readonly CodonInfo[];
  readonly queryAxis: CodonComparisonAxis;
  readonly columnLength: number;
  readonly direction: 'forward' | 'reverse';
}

export function compareProjectedCodons(input: CodonComparisonInput): CodonInfo[] {
  const reference = projectCodonColumns(
    input.reference,
    input.referenceAxis.biologicalLength,
    input.referenceAxis.bioToColumn
  );
  const query = projectCodonColumns(
    input.query,
    input.queryAxis.biologicalLength,
    input.queryAxis.bioToColumn
  );
  const distance = (column: number, anchor: number) =>
    ((input.direction === 'forward' ? column - anchor : anchor - column) + input.columnLength) %
    input.columnLength;
  const group = (codons: readonly CodonInfo[]) => {
    const groups = new Map<
      string,
      { info: CodonInfo; fragments: CodonInfo[]; columns: number[] }
    >();
    for (const codon of codons) {
      const key = `${codon.residueIndex ?? ''}:${codon.codonStartBp}:${codon.codonEndBp}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { info: codon, fragments: [], columns: [] };
        groups.set(key, entry);
      }
      entry.fragments.push(codon);
      for (let column = codon.startBp; column < codon.endBp; column++) entry.columns.push(column);
    }
    for (const entry of groups.values()) {
      const anchor =
        input.direction === 'forward' ? entry.info.codonStartBp! : entry.info.codonEndBp!;
      entry.columns = [...new Set(entry.columns)].sort(
        (a, b) => distance(a, anchor) - distance(b, anchor)
      );
    }
    return [...groups.values()];
  };
  const original = group(reference);
  const mutated = group(query);
  const referenceColumns = new Map<number, { group: (typeof original)[number]; slot: number }>();
  for (const entry of original)
    entry.columns.forEach((column, slot) => referenceColumns.set(column, { group: entry, slot }));
  const originalFirst = original[0]?.info;
  const readingAnchor = originalFirst
    ? input.direction === 'forward'
      ? originalFirst.codonStartBp!
      : originalFirst.codonEndBp!
    : 0;
  const firstOriginalStop = original.find((entry) => entry.info.isStop)?.info;
  const result: CodonInfo[] = [];
  let stopLossSeen = false;
  for (const entry of mutated) {
    const mapped = entry.columns.map((column, slot) => ({
      column,
      slot,
      reference: referenceColumns.get(column),
    }));
    const references = [
      ...new Set(mapped.flatMap((base) => (base.reference ? [base.reference.group] : []))),
    ];
    const inserted = mapped.some((base) => input.referenceAxis.columnToBio(base.column) === null);
    const extension =
      stopLossSeen &&
      references.length === 0 &&
      mapped.every((base) => input.referenceAxis.columnToBio(base.column) !== null);
    const frameShifted = mapped.some((base) => base.reference && base.reference.slot !== base.slot);
    const previous = references.length === 1 ? references[0].info : undefined;
    const unassigned = (codon: CodonInfo) =>
      codon.display?.kind === 'unassigned' ||
      (codon.aa === 'X' && codon.display?.kind !== 'residue');
    const unknown =
      unassigned(entry.info) ||
      references.some((reference) => unassigned(reference.info)) ||
      (!inserted && !extension && references.length === 0);
    let kind: CodonMutationKind;
    if (unknown) kind = 'unknown';
    else if (inserted || extension) kind = 'inserted';
    else if (frameShifted) kind = 'frameshifted';
    else if (!previous) kind = 'substitution';
    else {
      const identity = (codon: CodonInfo) =>
        codon.display?.kind === 'residue' ? codon.display.full : codon.aa;
      const sameAa = identity(entry.info) === identity(previous);
      kind =
        sameAa && entry.info.codon === previous.codon
          ? 'match'
          : sameAa
            ? 'synonymous'
            : 'substitution';
    }
    const mutation: CodonMutationInfo = {
      kind,
      referenceCodons: references.map((reference) => ({
        codon: reference.info.codon,
        aa: reference.info.aa,
        residueIndex: reference.info.residueIndex,
      })),
      referenceAa: previous?.aa,
      queryAa: entry.info.aa,
      queryResidueIndex: entry.info.residueIndex,
      frameShifted,
      prematureStop:
        !unknown &&
        entry.info.isStop &&
        (!firstOriginalStop ||
          distance(
            input.direction === 'forward' ? entry.info.codonStartBp! : entry.info.codonEndBp!,
            readingAnchor
          ) <
            distance(
              input.direction === 'forward'
                ? firstOriginalStop.codonStartBp!
                : firstOriginalStop.codonEndBp!,
              readingAnchor
            )),
      stopLost:
        !unknown && !entry.info.isStop && references.some((reference) => reference.info.isStop),
    };
    stopLossSeen ||= mutation.stopLost;
    result.push(...entry.fragments.map((fragment) => ({ ...fragment, mutation })));
  }
  const coveredStart = input.queryAxis.bioToColumn(0);
  const coveredEnd = input.queryAxis.bioToColumn(input.queryAxis.biologicalLength - 1);
  if (coveredStart !== null && coveredEnd !== null) {
    for (const entry of original) {
      const mutation: CodonMutationInfo = {
        kind: 'deleted',
        referenceCodons: [
          { codon: entry.info.codon, aa: entry.info.aa, residueIndex: entry.info.residueIndex },
        ],
        referenceAa: entry.info.aa,
        frameShifted: false,
        prematureStop: false,
        stopLost: false,
      };
      for (const fragment of entry.fragments) {
        const spans: Array<{ start: number; end: number }> = [];
        for (let column = fragment.startBp; column < fragment.endBp; column++) {
          if (
            column < coveredStart ||
            column > coveredEnd ||
            input.queryAxis.columnToBio(column) !== null
          )
            continue;
          const last = spans[spans.length - 1];
          if (last?.end === column) last.end++;
          else spans.push({ start: column, end: column + 1 });
        }
        result.push(
          ...spans.map((span) => ({
            ...fragment,
            startBp: span.start,
            endBp: span.end,
            aa: '-',
            display: undefined,
            isStop: false,
            isStart: false,
            renderLetter: span.end - span.start >= 2,
            residueIndex: undefined,
            mutation,
          }))
        );
      }
    }
  }
  const first = mutated[0]?.info ?? original[0]?.info;
  if (!first) return [];
  const anchor = input.direction === 'forward' ? first.codonStartBp! : first.codonEndBp!;
  return result.sort((a, b) => distance(a.startBp, anchor) - distance(b.startBp, anchor));
}
