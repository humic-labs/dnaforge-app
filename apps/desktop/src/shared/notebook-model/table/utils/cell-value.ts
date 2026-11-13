import type { Cell } from '../../../table-document-types';
import { readSavedFormulaResult } from '../../../source-formula-result';

export function tableCellValue(cell: Cell | undefined): string | number {
  if (!cell) return '';
  const saved = readSavedFormulaResult(cell);
  if (saved) return saved.value ?? '';
  return cell.type === 'formula' && cell.computed !== undefined ? cell.computed : cell.value;
}
