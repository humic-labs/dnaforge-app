import { useMemo, useState } from 'react';
import type { Cell } from '../types';

export function useTableGridSearch(
  displayCells: Cell[][],
  visibleRowIndices: number[]
): {
  globalSearch: string;
  setGlobalSearch: (value: string) => void;
  isFindOpen: boolean;
  setIsFindOpen: (open: boolean) => void;
  searchActive: boolean;
  searchedVisibleRowIndices: number[];
} {
  const [globalSearch, setGlobalSearch] = useState('');
  const [isFindOpen, setIsFindOpen] = useState(false);
  const normalizedGlobalSearch = globalSearch.trim().toLowerCase();
  const searchActive = normalizedGlobalSearch.length > 0;
  const searchedVisibleRowIndices = useMemo(() => {
    if (!searchActive) return visibleRowIndices;
    return visibleRowIndices.filter((rowIndex) =>
      (displayCells[rowIndex] ?? []).some((cell) => {
        const value =
          cell.type === 'formula' && cell.computed !== undefined ? cell.computed : cell.value;
        return String(value).toLowerCase().includes(normalizedGlobalSearch);
      })
    );
  }, [displayCells, normalizedGlobalSearch, searchActive, visibleRowIndices]);

  return {
    globalSearch,
    setGlobalSearch,
    isFindOpen,
    setIsFindOpen,
    searchActive,
    searchedVisibleRowIndices,
  };
}
