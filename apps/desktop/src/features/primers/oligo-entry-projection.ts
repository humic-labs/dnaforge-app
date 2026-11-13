import type { OligoNotationDisplayRun } from './oligo-modifications';

export interface OligoEntryRun extends OligoNotationDisplayRun {
  displayStart: number;
  displayEnd: number;
  displayText: string;
}

export function projectOligoEntry(runs: OligoNotationDisplayRun[], naturalBases: string) {
  let offset = 0;
  const projectedRuns: OligoEntryRun[] = runs.map((run) => {
    const displayText = run.catalogEntry
      ? run.naturalBaseIndex === undefined
        ? '*'
        : (naturalBases[run.naturalBaseIndex] ?? '*')
      : run.kind === 'rna-base' ||
          run.kind === 'rna-degenerate-base' ||
          run.kind === 'two-prime-o-methyl-base'
        ? run.text.slice(-1)
        : run.text;
    const projected = {
      ...run,
      displayText,
      displayStart: offset,
      displayEnd: offset + displayText.length,
    };
    offset = projected.displayEnd;
    return projected;
  });
  return { text: projectedRuns.map((run) => run.displayText).join(''), runs: projectedRuns };
}

export function entryOffsetToRaw(runs: OligoEntryRun[], offset: number): number {
  for (const run of runs) {
    if (offset <= run.displayStart) return run.rawStart;
    if (offset < run.displayEnd) return run.rawStart + offset - run.displayStart;
    if (offset === run.displayEnd) return run.rawEnd;
  }
  return runs[runs.length - 1]?.rawEnd ?? 0;
}

export function rawOffsetToEntry(runs: OligoEntryRun[], offset: number): number {
  for (const run of runs) {
    if (offset <= run.rawStart) return run.displayStart;
    if (offset < run.rawEnd)
      return run.displayText.length === run.text.length
        ? run.displayStart + offset - run.rawStart
        : run.displayStart;
    if (offset === run.rawEnd) return run.displayEnd;
  }
  return runs[runs.length - 1]?.displayEnd ?? 0;
}

export interface OligoEntrySelection {
  start: number;
  end: number;
  inputType: string;
}

export function applyOligoEntryEdit(
  notation: string,
  projection: ReturnType<typeof projectOligoEntry>,
  nextDisplay: string,
  caret: number,
  selection: OligoEntrySelection | null
) {
  const previous = projection.text;
  let start = 0;
  while (
    start < previous.length &&
    start < nextDisplay.length &&
    previous[start] === nextDisplay[start]
  )
    start++;
  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < nextDisplay.length - start &&
    previous[previous.length - suffix - 1] === nextDisplay[nextDisplay.length - suffix - 1]
  )
    suffix++;
  let end = previous.length - suffix;
  let inserted = nextDisplay.slice(start, nextDisplay.length - suffix);
  const delta = nextDisplay.length - previous.length;
  const editStart = selection?.inputType.startsWith('insert')
    ? selection.start
    : delta < 0
      ? caret
      : delta > 0
        ? caret - delta
        : start;
  const editEnd = selection?.inputType.startsWith('insert')
    ? selection.end
    : delta < 0
      ? caret - delta
      : editStart;
  const insertedLength = nextDisplay.length - previous.length + editEnd - editStart;
  if (
    editStart >= 0 &&
    insertedLength >= 0 &&
    nextDisplay.slice(0, editStart) === previous.slice(0, editStart) &&
    nextDisplay.slice(editStart + insertedLength) === previous.slice(editEnd)
  ) {
    start = editStart;
    end = editEnd;
    inserted = nextDisplay.slice(start, start + insertedLength);
  }
  const rawStart = entryOffsetToRaw(projection.runs, start);
  const rawEnd = entryOffsetToRaw(projection.runs, end);
  return {
    notation: notation.slice(0, rawStart) + inserted + notation.slice(rawEnd),
    caret: rawStart + inserted.length,
  };
}
