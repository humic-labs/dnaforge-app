'use client';

import { useState, useRef, useCallback } from 'react';
import { TABLE_INITIAL_DIMENSIONS } from '../configuration';
import { useInlineConfigFocus } from '../../hooks/useInlineConfigFocus';

interface InlineConfigProps {
  onConfigure: (rows: number, cols: number) => void;
  autoFocus?: boolean;
  onClearFresh?: () => void;
  onBlurToEditor?: () => void;
}

const DEFAULT_ROWS = TABLE_INITIAL_DIMENSIONS.rows.default;
const DEFAULT_COLS = TABLE_INITIAL_DIMENSIONS.columns.default;
const MIN_ROWS = TABLE_INITIAL_DIMENSIONS.rows.min;
const MAX_ROWS = TABLE_INITIAL_DIMENSIONS.rows.max;
const MIN_COLS = TABLE_INITIAL_DIMENSIONS.columns.min;
const MAX_COLS = TABLE_INITIAL_DIMENSIONS.columns.max;

export function InlineConfig({
  onConfigure,
  autoFocus = false,
  onClearFresh,
  onBlurToEditor,
}: InlineConfigProps) {
  const [rows, setRows] = useState('');
  const [cols, setCols] = useState('');
  const [activeField, setActiveField] = useState<'rows' | 'cols'>('rows');

  const rowsInputRef = useRef<HTMLInputElement>(null);
  const colsInputRef = useRef<HTMLInputElement>(null);

  useInlineConfigFocus({
    shouldAutoFocus: autoFocus,
    inputRef: activeField === 'rows' ? rowsInputRef : colsInputRef,
    onClearFresh,
  });

  const handleCreate = useCallback(() => {
    const rowsNum = Math.max(MIN_ROWS, Math.min(MAX_ROWS, parseInt(rows) || DEFAULT_ROWS));
    const colsNum = Math.max(MIN_COLS, Math.min(MAX_COLS, parseInt(cols) || DEFAULT_COLS));
    onConfigure(rowsNum, colsNum);
  }, [rows, cols, onConfigure]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, field: 'rows' | 'cols') => {
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        if (field === 'rows') {
          setActiveField('cols');
        } else {
          setActiveField('rows');
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleCreate();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onBlurToEditor?.();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.stopPropagation();
      } else if (e.key.length === 1) {
        e.stopPropagation();
      }
    },
    [handleCreate]
  );

  const handleRowsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRows(e.target.value.replace(/\D/g, ''));
  };

  const handleColsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCols(e.target.value.replace(/\D/g, ''));
  };

  return (
    <div className="flex items-center gap-1.5 py-3">
      <div className="relative inline-flex items-center">
        <input
          ref={rowsInputRef}
          type="text"
          inputMode="numeric"
          value={rows}
          onChange={handleRowsChange}
          onKeyDown={(e) => handleKeyDown(e, 'rows')}
          onFocus={() => setActiveField('rows')}
          placeholder="5"
          className="w-8 bg-transparent text-sm font-mono text-fg outline-none placeholder:text-fg-muted/30"
          autoComplete="off"
          spellCheck={false}
          aria-label="rows"
        />
      </div>
      <span className="text-fg-muted/40 text-sm">×</span>
      <div className="relative inline-flex items-center">
        <input
          ref={colsInputRef}
          type="text"
          inputMode="numeric"
          value={cols}
          onChange={handleColsChange}
          onKeyDown={(e) => handleKeyDown(e, 'cols')}
          onFocus={() => setActiveField('cols')}
          placeholder="5"
          className="w-8 bg-transparent text-sm font-mono text-fg outline-none placeholder:text-fg-muted/30"
          autoComplete="off"
          spellCheck={false}
          aria-label="cols"
        />
      </div>
      <span className="text-fg-muted/40 text-xs ml-2">enter to create</span>
    </div>
  );
}
