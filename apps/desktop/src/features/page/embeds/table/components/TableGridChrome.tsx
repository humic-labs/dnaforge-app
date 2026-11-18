import { ColorPalette } from '../../../components/ColorPalette';
import type { ChangeEvent, KeyboardEvent, Ref, RefObject } from 'react';
import {
  tableGridAlignButtonClass,
  tableGridFindWidth,
  tableGridFormatToggleClass,
  tableGridSwatchColor,
} from './table-grid-format-classes';

export const TABLE_FIND_WIDTH = 286;
export const TABLE_FIND_COLLAPSED_WIDTH = 232;

const TEXT_COLORS = [
  '#000000',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];
const BG_COLORS = [
  '#fee2e2',
  '#ffedd5',
  '#fef9c3',
  '#dcfce7',
  '#dbeafe',
  '#ede9fe',
  '#fce7f3',
  '#e5e7eb',
];

type FormatValue = boolean | 'mixed';
type ColorValue = string | null | 'mixed';

export type TableGridSelectionFormatState = {
  bold: FormatValue;
  italic: FormatValue;
  underline: FormatValue;
  strikethrough: FormatValue;
  align: 'left' | 'center' | 'right' | 'mixed';
  textColor: ColorValue;
  bgColor: ColorValue;
};

export function TableGridFilterStatus(props: {
  visible: boolean;
  shown: number;
  total: number;
}): JSX.Element | null {
  if (!props.visible) return null;
  return (
    <div className="px-2 py-1 text-xs text-fg-muted bg-bg-subtle border-t border-border">
      Showing {props.shown} of {props.total} rows
    </div>
  );
}

export function TableGridFindOverlay(props: {
  isFindOpen: boolean;
  searchActive: boolean;
  globalSearch: string;
  setGlobalSearch: (value: string) => void;
  closeFind: () => void;
  findInputRef: RefObject<HTMLInputElement | null>;
  searchedCount: number;
  visibleCount: number;
}): JSX.Element | null {
  const {
    isFindOpen,
    searchActive,
    globalSearch,
    setGlobalSearch,
    closeFind,
    findInputRef,
    searchedCount,
    visibleCount,
  } = props;
  if (!isFindOpen) return null;
  return (
    <div
      role="search"
      aria-label="Find in table"
      data-testid="table-search-popover"
      className="absolute right-2 top-1 z-30 flex h-7 max-w-[calc(100%-16px)] items-center gap-1 rounded-md border border-border bg-bg px-1.5 shadow-md"
      style={{
        width: tableGridFindWidth(searchActive, TABLE_FIND_WIDTH, TABLE_FIND_COLLAPSED_WIDTH),
      }}
    >
      <input
        ref={findInputRef as Ref<HTMLInputElement>}
        type="search"
        value={globalSearch}
        onChange={(event) => setGlobalSearch(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            closeFind();
            return;
          }
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            event.key.toLowerCase() === 'f'
          ) {
            event.preventDefault();
            findInputRef.current?.select();
          }
        }}
        placeholder="Find"
        aria-label="Find in table"
        data-testid="table-search-input"
        className="h-5 min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1.5 text-xs outline-none focus:border-border focus:bg-bg-subtle"
      />
      {searchActive ? (
        <span
          className="shrink-0 tabular-nums text-[11px] text-fg-muted"
          data-testid="table-search-count"
          aria-label={`${searchedCount.toLocaleString()} of ${visibleCount.toLocaleString()} rows`}
        >
          {searchedCount.toLocaleString()}/{visibleCount.toLocaleString()}
        </span>
      ) : null}
      <button
        type="button"
        onClick={closeFind}
        aria-label="Close find"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs leading-none text-fg-muted wp-interactive "
      >
        x
      </button>
    </div>
  );
}

export function TableGridFormulaBar(props: {
  visible: boolean;
  formatDisabled: boolean;
  selectionFormatState: TableGridSelectionFormatState;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleUnderline: () => void;
  toggleStrikethrough: () => void;
  setAlign: (align: 'left' | 'center' | 'right') => void;
  setTextColor: (color: string | undefined) => void;
  setBgColor: (color: string | undefined) => void;
  focusedCellAddress: string;
  formulaBarValue: string;
  formulaBarInputRef: RefObject<HTMLInputElement | null>;
  onFormulaBarChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFormulaBarBlur: () => void;
  onFormulaBarKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onFormulaBarFocus: () => void;
  focusedCell: unknown;
}): JSX.Element | null {
  const {
    visible,
    formatDisabled,
    selectionFormatState,
    toggleBold,
    toggleItalic,
    toggleUnderline,
    toggleStrikethrough,
    setAlign,
    setTextColor,
    setBgColor,
    focusedCellAddress,
    formulaBarValue,
    formulaBarInputRef,
    onFormulaBarChange,
    onFormulaBarBlur,
    onFormulaBarKeyDown,
    onFormulaBarFocus,
    focusedCell,
  } = props;
  if (!visible) return null;
  return (
    <div className="flex items-center gap-2 px-2 py-1 bg-bg-subtle border-b border-border">
      <div className="flex items-center gap-0.5">
        <button
          onClick={toggleBold}
          disabled={formatDisabled}
          className={tableGridFormatToggleClass(
            formatDisabled,
            selectionFormatState.bold,
            ' font-bold'
          )}
          title="Bold (Cmd+B)"
          aria-label="Toggle bold"
        >
          B
        </button>
        <button
          onClick={toggleItalic}
          disabled={formatDisabled}
          className={tableGridFormatToggleClass(formatDisabled, selectionFormatState.italic)}
          style={{ fontStyle: 'italic' }}
          title="Italic (Cmd+I)"
          aria-label="Toggle italic"
        >
          I
        </button>
        <button
          onClick={toggleUnderline}
          disabled={formatDisabled}
          className={tableGridFormatToggleClass(formatDisabled, selectionFormatState.underline)}
          style={{ textDecoration: 'underline' }}
          title="Underline (Cmd+U)"
          aria-label="Toggle underline"
        >
          U
        </button>
        <button
          onClick={toggleStrikethrough}
          disabled={formatDisabled}
          className={tableGridFormatToggleClass(formatDisabled, selectionFormatState.strikethrough)}
          style={{ textDecoration: 'line-through' }}
          title="Strikethrough (Cmd+Shift+X)"
          aria-label="Toggle strikethrough"
        >
          S
        </button>
      </div>

      <div className="w-px h-4 bg-border" />

      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setAlign('left')}
          disabled={formatDisabled}
          className={tableGridAlignButtonClass(
            formatDisabled,
            selectionFormatState.align === 'left'
          )}
          title="Align left"
          aria-label="Align left"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="3" width="12" height="2" />
            <rect x="2" y="7" width="8" height="2" />
            <rect x="2" y="11" width="10" height="2" />
          </svg>
        </button>
        <button
          onClick={() => setAlign('center')}
          disabled={formatDisabled}
          className={tableGridAlignButtonClass(
            formatDisabled,
            selectionFormatState.align === 'center'
          )}
          title="Align center"
          aria-label="Align center"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="3" width="12" height="2" />
            <rect x="4" y="7" width="8" height="2" />
            <rect x="3" y="11" width="10" height="2" />
          </svg>
        </button>
        <button
          onClick={() => setAlign('right')}
          disabled={formatDisabled}
          className={tableGridAlignButtonClass(
            formatDisabled,
            selectionFormatState.align === 'right'
          )}
          title="Align right"
          aria-label="Align right"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="3" width="12" height="2" />
            <rect x="6" y="7" width="8" height="2" />
            <rect x="4" y="11" width="10" height="2" />
          </svg>
        </button>
      </div>

      <div className="w-px h-4 bg-border" />

      <div className="flex items-center gap-0.5">
        <ColorPalette
          label="Text color"
          disabled={formatDisabled}
          colors={TEXT_COLORS.map((value, index) => ({
            value,
            name: ['Black', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink'][index],
          }))}
          value={selectionFormatState.textColor}
          onPick={setTextColor}
          onClear={() => setTextColor(undefined)}
        >
          <span className="text-[10px] font-medium">A</span>
          <span
            className="w-4 h-1 rounded-sm mt-[-2px]"
            style={{
              backgroundColor: tableGridSwatchColor(selectionFormatState.textColor, 'currentColor'),
            }}
          />
        </ColorPalette>
        <ColorPalette
          label="Background color"
          disabled={formatDisabled}
          colors={BG_COLORS.map((value, index) => ({
            value,
            name: [
              'Light red',
              'Light orange',
              'Light yellow',
              'Light green',
              'Light blue',
              'Light purple',
              'Light pink',
              'Gray',
            ][index],
          }))}
          value={selectionFormatState.bgColor}
          onPick={setBgColor}
          onClear={() => setBgColor(undefined)}
        >
          <span
            className="w-4 h-4 rounded border border-border"
            style={{
              backgroundColor: tableGridSwatchColor(selectionFormatState.bgColor, 'transparent'),
            }}
          />
        </ColorPalette>
      </div>

      <div className="w-px h-4 bg-border" />

      <div className="w-12 px-2 py-0.5 text-xs font-medium text-fg-muted bg-bg border border-border rounded text-center">
        {focusedCellAddress || '-'}
      </div>
      <div className="flex-1">
        <input
          ref={formulaBarInputRef as Ref<HTMLInputElement>}
          type="text"
          value={formulaBarValue}
          onChange={onFormulaBarChange}
          onBlur={onFormulaBarBlur}
          onKeyDown={onFormulaBarKeyDown}
          onFocus={onFormulaBarFocus}
          placeholder={focusedCell ? 'Enter value or formula (e.g., =SUM(A1:A5))' : 'Select a cell'}
          disabled={!focusedCell}
          className="w-full px-2 py-0.5 text-sm bg-bg border border-border rounded outline-none focus:ring-1 focus:ring-accent disabled:bg-bg-muted disabled:text-fg-muted"
        />
      </div>
    </div>
  );
}
