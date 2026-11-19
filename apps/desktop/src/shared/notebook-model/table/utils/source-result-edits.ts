import { readSavedFormulaResult } from '../../../source-formula-result';
import type { Cell } from '../../../table-document-types';

export function userOwnedCell(cell: Cell, value: string, type: Cell['type']): Cell {
  const {
    sourceFormula: _sourceFormula,
    sourceRenderedValue: _sourceRenderedValue,
    formulaCompatibility: _formulaCompatibility,
    stale: _stale,
    computed: _computed,
    content: _content,
    ...retained
  } = cell;
  return { ...retained, value, type };
}

function sameContent(left: Cell | undefined, right: Cell): boolean {
  return (
    left !== undefined &&
    left.value === right.value &&
    left.type === right.type &&
    left.sourceFormula === right.sourceFormula &&
    left.sourceRenderedValue === right.sourceRenderedValue &&
    left.formulaCompatibility === right.formulaCompatibility
  );
}

export function invalidateSavedResults(before: Cell[][], after: Cell[][]): Cell[][] {
  const changed =
    before.length !== after.length ||
    after.some(
      (row, index) =>
        before[index]?.length !== row.length ||
        row.some((cell, column) => !sameContent(before[index]?.[column], cell))
    );
  if (!changed) return after;
  return after.map((row) =>
    row.map((cell) =>
      readSavedFormulaResult(cell) && !cell.stale ? { ...cell, stale: true } : cell
    )
  );
}
