'use client';

import { useEffect, useRef } from 'react';
import type { FormulaOption } from '../utils/formulas';

interface FormulaAutocompleteProps {
  filteredOptions: FormulaOption[];
  selectedIndex: number;
  onSelectionChange: (index: number) => void;
  onSelect: (formula: string) => void;
  onClose: () => void;
  position: { top: number; left: number };
}

export function FormulaAutocomplete({
  filteredOptions,
  selectedIndex,
  onSelectionChange,
  onSelect,
  onClose,
  position,
}: FormulaAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (filteredOptions.length === 0) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="formula-autocomplete-dropdown fixed z-[10050] flex w-[300px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] flex-col bg-bg text-fg border border-border rounded-lg shadow-lg overflow-hidden"
      style={{
        top: position.top,
        left: position.left,
      }}
    >
      <div className="shrink-0 px-2 py-1.5 text-xs text-fg-muted bg-bg-subtle border-b border-border">
        Functions (↑↓ to navigate, Enter to select)
      </div>
      <div className="min-h-0 max-h-[300px] overflow-y-auto">
        {filteredOptions.map((option, index) => (
          <button
            key={option.name}
            type="button"
            className={`w-full px-3 py-2 text-left text-sm transition-colors ${
              index === selectedIndex ? 'bg-accent/10 text-fg' : 'hover:bg-bg-muted text-fg'
            }`}
            onClick={() => onSelect(`=${option.name}(`)}
            onMouseEnter={() => onSelectionChange(index)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-medium text-accent">{option.name}</span>
              <span className="text-xs text-fg-muted font-mono">{option.syntax}</span>
            </div>
            <div className="text-xs text-fg-muted mt-0.5">{option.description}</div>
            <div className="text-xs text-fg-muted/60 font-mono mt-0.5">e.g. {option.example}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
