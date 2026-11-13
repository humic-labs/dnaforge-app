export interface SourceFormulaMetadata {
  sourceFormula?: string;
  sourceRenderedValue?: string;
  formulaCompatibility?: 'supported' | 'unsupported';
  stale?: boolean;
}

export type SavedFormulaResult = Readonly<{
  formula: string;
  value: string | null;
  stale: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readSavedFormulaResult(cell: unknown): SavedFormulaResult | null {
  if (!isRecord(cell) || cell.formulaCompatibility !== 'unsupported') return null;
  const formula = cell.sourceFormula ?? (cell.type === 'formula' ? cell.value : undefined);
  if (typeof formula !== 'string' || !formula.trimStart().startsWith('=')) return null;
  if (
    typeof cell.sourceFormula === 'string' &&
    ((cell.type === 'formula' && cell.value !== cell.sourceFormula) ||
      (cell.type !== 'formula' &&
        typeof cell.sourceRenderedValue === 'string' &&
        cell.value !== cell.sourceRenderedValue))
  )
    return null;
  const value = cell.sourceRenderedValue ?? (cell.type === 'formula' ? cell.computed : cell.value);
  return {
    formula,
    value:
      typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
        ? String(value)
        : null,
    stale: cell.stale === true,
  };
}

export function isSourceFormulaMetadataValid(cell: Record<string, unknown>): boolean {
  if (
    cell.sourceFormula !== undefined &&
    (typeof cell.sourceFormula !== 'string' || !cell.sourceFormula.trimStart().startsWith('='))
  )
    return false;
  if (cell.sourceRenderedValue !== undefined && typeof cell.sourceRenderedValue !== 'string')
    return false;
  if (cell.stale !== undefined && typeof cell.stale !== 'boolean') return false;
  if (
    cell.formulaCompatibility !== undefined &&
    cell.formulaCompatibility !== 'supported' &&
    cell.formulaCompatibility !== 'unsupported'
  )
    return false;
  const formula = cell.sourceFormula ?? (cell.type === 'formula' ? cell.value : undefined);
  return (
    cell.formulaCompatibility !== 'unsupported' ||
    (typeof formula === 'string' && formula.trimStart().startsWith('='))
  );
}

export function savedFormulaResultExplanation(result: SavedFormulaResult): string {
  const status = result.stale ? 'May be outdated. The table has changed.' : 'Saved result.';
  const value =
    result.value === null ? 'No result was saved in the source.' : `Saved value: ${result.value}.`;
  return `${status} DNAForge does not recalculate this formula. ${value} Source formula: ${result.formula}`;
}
