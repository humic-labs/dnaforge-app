import { useMemo, useCallback } from 'react';
import type { Cell, CellPosition, SelectionRange } from '../types';

type FormatValue = boolean | 'mixed';
type ColorValue = string | null | 'mixed';

interface FormatState {
  bold: FormatValue;
  italic: FormatValue;
  underline: FormatValue;
  strikethrough: FormatValue;
  align: 'left' | 'center' | 'right' | 'mixed';
  textColor: ColorValue;
  bgColor: ColorValue;
}

interface UseFormattingOptions {
  cells: Cell[][];
  selection: SelectionRange | null;
  focusedCell: CellPosition | null;
  onCellFormat?: (
    range: SelectionRange,
    format: {
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
      align?: 'left' | 'center' | 'right';
      textColor?: string;
      bgColor?: string;
    }
  ) => void;
}

interface UseFormattingReturn {
  effectiveSelection: SelectionRange | null;
  selectionFormatState: FormatState;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrikethrough: () => void;
  setAlign: (align: 'left' | 'center' | 'right') => void;
  setTextColor: (color: string | undefined) => void;
  setBgColor: (color: string | undefined) => void;
}

export function useFormatting({
  cells,
  selection,
  focusedCell,
  onCellFormat,
}: UseFormattingOptions): UseFormattingReturn {
  const effectiveSelection = useMemo((): SelectionRange | null => {
    if (selection) return selection;
    if (focusedCell) {
      return {
        startRow: focusedCell.row,
        startCol: focusedCell.col,
        endRow: focusedCell.row,
        endCol: focusedCell.col,
      };
    }
    return null;
  }, [selection, focusedCell]);

  const selectionFormatState = useMemo((): FormatState => {
    if (!effectiveSelection) {
      return {
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        align: 'left' as const,
        textColor: null,
        bgColor: null,
      };
    }

    let allBold = true,
      anyBold = false;
    let allItalic = true,
      anyItalic = false;
    let allUnderline = true,
      anyUnderline = false;
    let allStrikethrough = true,
      anyStrikethrough = false;
    let commonAlign: 'left' | 'center' | 'right' | 'mixed' = 'left';
    let firstAlign = true;
    let commonTextColor: string | null | 'mixed' = null;
    let firstTextColor = true;
    let commonBgColor: string | null | 'mixed' = null;
    let firstBgColor = true;

    for (let r = effectiveSelection.startRow; r <= effectiveSelection.endRow; r++) {
      for (let c = effectiveSelection.startCol; c <= effectiveSelection.endCol; c++) {
        const cell = cells[r]?.[c];
        if (cell) {
          if (cell.format?.bold) anyBold = true;
          else allBold = false;
          if (cell.format?.italic) anyItalic = true;
          else allItalic = false;
          if (cell.format?.underline) anyUnderline = true;
          else allUnderline = false;
          if (cell.format?.strikethrough) anyStrikethrough = true;
          else allStrikethrough = false;

          const cellAlign = cell.format?.align ?? 'left';
          if (firstAlign) {
            commonAlign = cellAlign;
            firstAlign = false;
          } else if (commonAlign !== 'mixed' && commonAlign !== cellAlign) {
            commonAlign = 'mixed';
          }

          const cellTextColor = cell.format?.textColor ?? null;
          if (firstTextColor) {
            commonTextColor = cellTextColor;
            firstTextColor = false;
          } else if (commonTextColor !== 'mixed' && commonTextColor !== cellTextColor) {
            commonTextColor = 'mixed';
          }

          const cellBgColor = cell.format?.bgColor ?? null;
          if (firstBgColor) {
            commonBgColor = cellBgColor;
            firstBgColor = false;
          } else if (commonBgColor !== 'mixed' && commonBgColor !== cellBgColor) {
            commonBgColor = 'mixed';
          }
        } else {
          allBold = false;
          allItalic = false;
          allUnderline = false;
          allStrikethrough = false;
        }
      }
    }

    return {
      bold: allBold ? true : anyBold ? 'mixed' : false,
      italic: allItalic ? true : anyItalic ? 'mixed' : false,
      underline: allUnderline ? true : anyUnderline ? 'mixed' : false,
      strikethrough: allStrikethrough ? true : anyStrikethrough ? 'mixed' : false,
      align: commonAlign,
      textColor: commonTextColor,
      bgColor: commonBgColor,
    };
  }, [effectiveSelection, cells]);

  const toggleFormat = useCallback(
    (formatKey: 'bold' | 'italic' | 'underline' | 'strikethrough') => {
      if (!effectiveSelection || !onCellFormat) return;

      const currentState = selectionFormatState[formatKey];
      const newValue = currentState !== true;

      onCellFormat(effectiveSelection, { [formatKey]: newValue });
    },
    [effectiveSelection, selectionFormatState, onCellFormat]
  );

  const toggleBold = useCallback(() => toggleFormat('bold'), [toggleFormat]);
  const toggleItalic = useCallback(() => toggleFormat('italic'), [toggleFormat]);
  const toggleUnderline = useCallback(() => toggleFormat('underline'), [toggleFormat]);
  const toggleStrikethrough = useCallback(() => toggleFormat('strikethrough'), [toggleFormat]);

  const setAlign = useCallback(
    (align: 'left' | 'center' | 'right') => {
      if (!effectiveSelection || !onCellFormat) return;
      onCellFormat(effectiveSelection, { align });
    },
    [effectiveSelection, onCellFormat]
  );

  const setTextColor = useCallback(
    (color: string | undefined) => {
      if (!effectiveSelection || !onCellFormat) return;
      onCellFormat(effectiveSelection, { textColor: color });
    },
    [effectiveSelection, onCellFormat]
  );

  const setBgColor = useCallback(
    (color: string | undefined) => {
      if (!effectiveSelection || !onCellFormat) return;
      onCellFormat(effectiveSelection, { bgColor: color });
    },
    [effectiveSelection, onCellFormat]
  );

  return {
    effectiveSelection,
    selectionFormatState,
    toggleBold,
    toggleItalic,
    toggleUnderline,
    toggleStrikethrough,
    setAlign,
    setTextColor,
    setBgColor,
  };
}
