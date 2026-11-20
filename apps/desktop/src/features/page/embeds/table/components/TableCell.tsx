'use client';

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Cell, CellPosition } from '../types';
import { FormulaAutocomplete } from './FormulaAutocomplete';
import { TableCellContent } from './TableCellContent';
import { filterFormulaOptions } from '../utils/formulas';
import { safeFocus } from '../../../../../shared/utils/safeFocus';
import {
  dispatchOpenNativeEntityReference,
  nativeEntityReferenceHref,
  isNewTabClick,
  openImportedProviderReference,
} from '../../../editor/native-entity-links';
import {
  BENCHLING_EXTERNAL_LINK_MARKER,
  useBenchlingLinkDisplayDestination,
} from '../../../editor/benchling-external-link-marker';
import {
  providerObjectClassForStableId,
  providerStableIdFromUrl,
  type ProviderObjectClass,
} from '../../../../../shared/provider-object-reference';
import { sanitizeBenchlingMigrationExternalHttpUrl } from '../../../../../shared/benchling-migration-external-url';
import {
  readSavedFormulaResult,
  savedFormulaResultExplanation,
} from '../../../../../shared/source-formula-result';
import {
  tableCellCutBorderStyle,
  tableCellDisplayClasses,
  tableCellDisplayValue,
  tableCellEdgeMask,
  tableCellHasSelectionEdge,
  tableCellIsError,
  tableCellNativeEntityId,
  tableCellSelectionEdgeOverlayClasses,
  tableCellTitle,
  tableCellWrapperClasses,
} from './table-cell-presentation';

interface TableCellProps {
  cell: Cell;
  position: CellPosition;
  isFocused: boolean;
  isSelected?: boolean;
  isCut?: boolean;
  selectionBounds?: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  cutBounds?: { startRow: number; startCol: number; endRow: number; endCol: number } | null;
  isGhost?: boolean;
  showFillHandle?: boolean;

  isEditing: boolean;
  editingValue: string;
  editInputRef?: React.RefObject<HTMLInputElement>;

  referenceWorkspaceRoot?: string;
  referenceNotebookPageId?: string;

  onCellClick: (pos: CellPosition, shiftKey: boolean) => void;
  onCellDoubleClick: (pos: CellPosition) => void;
  onEditingValueChange: (value: string, cursorPosition: number) => void;
  onEditCommit: (
    navigateDirection?: 'down' | 'right',
    options?: { restoreFocus?: boolean }
  ) => void;
  onEditCancel: () => void;

  onFillStart?: () => void;
  onFillMove?: (pos: CellPosition) => void;
  onFillEnd?: () => void;
  onFillDoubleClick?: () => void;

  onDragSelectStart?: () => void;
  onDragSelectMove?: (pos: CellPosition) => void;
  onDragSelectEnd?: () => void;

  cellRef: React.RefCallback<HTMLDivElement>;
}

const FORMULA_PREFIX = /^=([A-Z]*)$/i;

const TABLE_CELL_REFERENCE_CLASSES =
  'cursor-pointer text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

const CELL_VALUE_PROPS = {
  cell: true,
  isFocused: true,
  isSelected: true,
  isCut: true,
  isGhost: true,
  showFillHandle: true,
  isEditing: true,
  editingValue: true,
  editInputRef: true,
  referenceWorkspaceRoot: true,
  referenceNotebookPageId: true,
  onCellClick: true,
  onCellDoubleClick: true,
  onEditingValueChange: true,
  onEditCommit: true,
  onEditCancel: true,
  onFillStart: true,
  onFillMove: true,
  onFillEnd: true,
  onFillDoubleClick: true,
  onDragSelectStart: true,
  onDragSelectMove: true,
  onDragSelectEnd: true,
  cellRef: true,
} satisfies Record<
  Exclude<keyof TableCellProps, 'position' | 'selectionBounds' | 'cutBounds'>,
  true
>;
const CELL_VALUE_PROP_KEYS = Object.keys(CELL_VALUE_PROPS) as (keyof typeof CELL_VALUE_PROPS)[];

function sameCellEdges(
  active: boolean | undefined,
  position: CellPosition,
  before: TableCellProps['selectionBounds'],
  after: TableCellProps['selectionBounds']
): boolean {
  if (!active || before === after) return true;
  const previousEdges = tableCellEdgeMask(active, position, before);
  const nextEdges = tableCellEdgeMask(active, position, after);
  return (
    previousEdges.top === nextEdges.top &&
    previousEdges.bottom === nextEdges.bottom &&
    previousEdges.left === nextEdges.left &&
    previousEdges.right === nextEdges.right
  );
}

function sameCellProps(before: TableCellProps, after: TableCellProps): boolean {
  return (
    before.position.row === after.position.row &&
    before.position.col === after.position.col &&
    CELL_VALUE_PROP_KEYS.every((key) => Object.is(before[key], after[key])) &&
    sameCellEdges(
      before.isSelected,
      before.position,
      before.selectionBounds,
      after.selectionBounds
    ) &&
    sameCellEdges(before.isCut, before.position, before.cutBounds, after.cutBounds)
  );
}

export const TableCell = React.memo(function TableCell({
  cell,
  position,
  isFocused,
  isSelected = false,
  isCut = false,
  selectionBounds,
  cutBounds,
  isGhost = false,
  showFillHandle = false,
  isEditing,
  editingValue,
  editInputRef,
  referenceWorkspaceRoot,
  referenceNotebookPageId,
  onCellClick,
  onCellDoubleClick,
  onEditingValueChange,
  onEditCommit,
  onEditCancel,
  onFillStart,
  onFillMove,
  onFillEnd,
  onFillDoubleClick,
  onDragSelectStart,
  onDragSelectMove,
  onDragSelectEnd,
  cellRef,
}: TableCellProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const onFillMoveRef = useRef(onFillMove);
  const onFillEndRef = useRef(onFillEnd);
  const onFillDoubleClickRef = useRef(onFillDoubleClick);
  const onDragSelectMoveRef = useRef(onDragSelectMove);
  const onDragSelectEndRef = useRef(onDragSelectEnd);

  onFillMoveRef.current = onFillMove;
  onFillEndRef.current = onFillEnd;
  onFillDoubleClickRef.current = onFillDoubleClick;
  onDragSelectMoveRef.current = onDragSelectMove;
  onDragSelectEndRef.current = onDragSelectEnd;

  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompletePosition, setAutocompletePosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [autocompleteSelectedIndex, setAutocompleteSelectedIndex] = useState(0);

  const searchTerm = editingValue.match(FORMULA_PREFIX)?.[1].toUpperCase() ?? null;
  const filteredOptions = filterFormulaOptions(searchTerm ?? '');

  useEffect(() => {
    const shouldShow = isEditing && searchTerm !== null;
    setShowAutocomplete(shouldShow);
    if (!shouldShow) {
      setAutocompletePosition(null);
      return;
    }

    const element = editInputRef?.current || wrapperRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const dropdownWidth = 300;
    const dropdownHeight = 350;
    const padding = 8;

    let top = rect.bottom + 4;
    let left = rect.left;
    if (left + dropdownWidth > window.innerWidth - padding) {
      left = Math.max(padding, window.innerWidth - dropdownWidth - padding);
    }
    if (top + dropdownHeight > window.innerHeight - padding) {
      top = Math.max(padding, rect.top - dropdownHeight - 4);
    }
    setAutocompletePosition({ top, left });
  }, [isEditing, searchTerm, editInputRef]);

  useEffect(() => {
    setAutocompleteSelectedIndex(0);
  }, [searchTerm]);

  useEffect(() => {
    if (!showAutocomplete) return;

    const handleScroll = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target?.closest?.('.formula-autocomplete-dropdown')) {
        return;
      }
      setShowAutocomplete(false);
      setAutocompletePosition(null);
    };

    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [showAutocomplete]);

  const beginPointerDrag = useCallback((onMove: (pos: CellPosition) => void, onEnd: () => void) => {
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const posAttr = element?.closest('[data-cell-position]')?.getAttribute('data-cell-position');
      if (!posAttr) return;
      const [row, col] = posAttr.split(',').map(Number);
      onMove({ row, col });
    };

    const stop = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    function handleMouseUp() {
      stop();
      dragCleanupRef.current = null;
      onEnd();
    }

    dragCleanupRef.current = stop;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  useEffect(() => {
    return () => {
      if (dragCleanupRef.current) {
        dragCleanupRef.current();
      }
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      e.stopPropagation();
      onCellClick(position, e.shiftKey);

      onDragSelectStart?.();
      beginPointerDrag(
        (pos) => onDragSelectMoveRef.current?.(pos),
        () => onDragSelectEndRef.current?.()
      );
    },
    [position, onCellClick, onDragSelectStart, beginPointerDrag]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onCellDoubleClick(position);
    },
    [position, onCellDoubleClick]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      onEditingValueChange(input.value, input.selectionStart ?? input.value.length);
    },
    [onEditingValueChange]
  );

  const handleFormulaSelect = useCallback(
    (formula: string) => {
      onEditingValueChange(formula, formula.length);
      setShowAutocomplete(false);
      safeFocus(editInputRef?.current);
    },
    [onEditingValueChange, editInputRef]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || (e as { isComposing?: boolean }).isComposing) return;

      if (showAutocomplete && filteredOptions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setAutocompleteSelectedIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setAutocompleteSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          const opt = filteredOptions[autocompleteSelectedIndex];
          if (opt) handleFormulaSelect(`=${opt.name}(`);
          return;
        }
      }

      if (showAutocomplete && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShowAutocomplete(false);
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onEditCancel();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        setShowAutocomplete(false);
        onEditCommit('down');
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        setShowAutocomplete(false);
        onEditCommit('right');
        return;
      }
    },
    [
      showAutocomplete,
      filteredOptions,
      autocompleteSelectedIndex,
      handleFormulaSelect,
      onEditCommit,
      onEditCancel,
    ]
  );

  const handleFillHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onFillStart?.();
      beginPointerDrag(
        (pos) => onFillMoveRef.current?.(pos),
        () => onFillEndRef.current?.()
      );
    },
    [onFillStart, beginPointerDrag]
  );

  const mergedWrapperRef = useCallback(
    (el: HTMLDivElement | null) => {
      (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      cellRef(el);
    },
    [cellRef]
  );

  const displayValue = tableCellDisplayValue(cell);
  const savedResult = readSavedFormulaResult(cell);
  const nativeEntityId = tableCellNativeEntityId(cell);
  const nativeEntityHref = nativeEntityReferenceHref(nativeEntityId);
  const canOpenNativeReference = Boolean(nativeEntityHref && referenceWorkspaceRoot);
  const externalReferenceHref =
    cell.reference?.kind === 'external-url'
      ? sanitizeBenchlingMigrationExternalHttpUrl(cell.reference.href)
      : null;
  const importedStableObjectId = providerStableIdFromUrl(externalReferenceHref);
  const importedObjectClass = importedStableObjectId
    ? providerObjectClassForStableId(importedStableObjectId)
    : null;
  const canResolveImportedReference = Boolean(
    importedStableObjectId && importedObjectClass && referenceWorkspaceRoot
  );
  const importedLinkDestination = useBenchlingLinkDisplayDestination({
    href: externalReferenceHref,
    label: String(displayValue),
    owningRoot: referenceWorkspaceRoot ?? null,
    stableObjectId: importedStableObjectId,
    objectClass: importedObjectClass,
  });
  const opensInBenchling = importedLinkDestination === 'benchling';
  const opensInDNAForge = importedLinkDestination === 'native';

  const handleNativeReferenceClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!referenceWorkspaceRoot || !nativeEntityId) return;
      dispatchOpenNativeEntityReference({
        entityId: nativeEntityId,
        label: String(displayValue),
        owningRoot: referenceWorkspaceRoot,
      });
    },
    [displayValue, nativeEntityId, referenceWorkspaceRoot]
  );

  const isError = tableCellIsError(cell);
  const selectionEdges = tableCellEdgeMask(isSelected, position, selectionBounds);
  const cutEdges = tableCellEdgeMask(isCut, position, cutBounds);
  const hasSelectionEdge = tableCellHasSelectionEdge(isSelected, isFocused, selectionEdges);
  const selectionEdgeOverlayClasses = tableCellSelectionEdgeOverlayClasses(
    hasSelectionEdge,
    selectionEdges
  );
  const wrapperClasses = tableCellWrapperClasses({
    isFocused,
    isSelected,
    isCut,
    isGhost,
    hasSelectionEdge,
    hasBgColor: Boolean(cell.format?.bgColor),
  });
  const cutBorderStyle = tableCellCutBorderStyle(isCut, cutEdges);
  const displayClasses = tableCellDisplayClasses({ cell, isError, isGhost, isFocused });
  const displayStyle: React.CSSProperties = cell.format?.textColor
    ? { color: cell.format.textColor }
    : {};

  let cellContent: React.ReactNode = cell.content ? (
    <TableCellContent content={cell.content} sourceNotebookPageId={referenceNotebookPageId} />
  ) : (
    displayValue
  );
  if (!cell.content && canOpenNativeReference && nativeEntityHref) {
    cellContent = (
      <a
        href={nativeEntityHref}
        data-testid="table-cell-reference"
        className={TABLE_CELL_REFERENCE_CLASSES}
        aria-label={`Open ${displayValue} in DNAForge`}
        title={`Open ${displayValue} in DNAForge`}
        onMouseDown={suppressReferenceMouseDown}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={handleNativeReferenceClick}
      >
        {displayValue}
      </a>
    );
  } else if (!cell.content && externalReferenceHref) {
    const canResolve = canResolveImportedReference && importedStableObjectId && importedObjectClass;
    const openLabel = opensInDNAForge
      ? `Open ${displayValue} in DNAForge`
      : `Open ${displayValue} in browser`;
    cellContent = (
      <a
        href={externalReferenceHref}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="table-cell-reference"
        {...(canResolve
          ? {
              'data-provider-stable-id': importedStableObjectId,
              'data-provider-object-class': importedObjectClass,
            }
          : {})}
        {...(opensInBenchling
          ? {
              'data-benchling-link-destination': 'external',
              'data-benchling-link-marker': BENCHLING_EXTERNAL_LINK_MARKER,
            }
          : opensInDNAForge
            ? { 'data-benchling-link-destination': 'native' }
            : {})}
        onClickCapture={
          canResolve
            ? (event) => {
                if (isNewTabClick(event)) return;
                event.preventDefault();
                event.stopPropagation();
                void openImportedProviderReference({
                  stableObjectId: importedStableObjectId as string,
                  objectClass: importedObjectClass as unknown as ProviderObjectClass,
                  href: externalReferenceHref as string,
                  label: String(displayValue),
                  owningRoot: referenceWorkspaceRoot as string,
                });
              }
            : undefined
        }
        className={TABLE_CELL_REFERENCE_CLASSES}
        aria-label={opensInBenchling ? `${displayValue}, opens in Benchling` : openLabel}
        title={opensInBenchling ? 'Opens in Benchling' : openLabel}
        onMouseDown={suppressReferenceMouseDown}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {displayValue}
      </a>
    );
  }

  return (
    <>
      <div
        ref={mergedWrapperRef}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        className={wrapperClasses}
        style={isCut ? cutBorderStyle : undefined}
        data-cell-position={`${position.row},${position.col}`}
        data-table-selected={isSelected ? 'true' : undefined}
        aria-label={`Cell row ${position.row + 1}, column ${position.col + 1}${isGhost ? ' (expand to add)' : ''}`}
        title={tableCellTitle(cell, isGhost)}
      >
        {isSelected && !isFocused && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-x-px -inset-y-[2px] bg-fg/[0.08]"
          />
        )}
        {hasSelectionEdge && <div aria-hidden="true" className={selectionEdgeOverlayClasses} />}
        {isFocused && (
          <div
            aria-hidden="true"
            data-testid="cell-focus-ring"
            className="pointer-events-none absolute -inset-x-px -inset-y-[2px] border-2 border-accent"
          />
        )}

        {isEditing ? (
          <input
            ref={editInputRef}
            type="text"
            value={editingValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onBlur={(e) => {
              setShowAutocomplete(false);
              if (stayInTableOnBlur(e.relatedTarget)) return;
              onEditCommit(undefined, { restoreFocus: false });
            }}
            className="w-full px-1.5 py-0.5 text-xs bg-transparent border-0 outline-none"
          />
        ) : (
          <div className={displayClasses} style={displayStyle}>
            {cellContent}
          </div>
        )}

        {savedResult && !isEditing && (
          <span
            role="img"
            aria-label={savedFormulaResultExplanation(savedResult)}
            title={savedFormulaResultExplanation(savedResult)}
            tabIndex={0}
            className={`block max-w-full whitespace-normal break-words px-1.5 pb-0.5 text-[10px] leading-3 focus-visible:outline focus-visible:outline-1 ${savedResult.stale ? 'text-warning' : 'text-fg-muted'}`}
          >
            {savedResult.stale ? 'May be outdated' : 'Saved'}
          </span>
        )}
        {cell.type === 'formula' && !savedResult && !isEditing && (
          <div
            className="absolute top-0 right-0 w-0 h-0 border-t-[6px] border-r-[6px] border-t-accent/40 border-r-transparent border-l-transparent border-b-transparent"
            style={{ borderRightColor: 'var(--color-accent)', opacity: 0.4 }}
            title={`Formula: ${cell.value}`}
          />
        )}
        {showFillHandle && !isEditing && (
          <div
            className="absolute bottom-0 right-0 w-2 h-2 bg-accent cursor-crosshair translate-x-1/2 translate-y-1/2 z-10 border border-bg"
            onMouseDown={handleFillHandleMouseDown}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onFillDoubleClickRef.current?.();
            }}
            title="Drag to fill, double-click to auto-fill"
          />
        )}
      </div>
      {showAutocomplete && autocompletePosition && typeof document !== 'undefined'
        ? createPortal(
            <FormulaAutocomplete
              filteredOptions={filteredOptions}
              selectedIndex={autocompleteSelectedIndex}
              onSelectionChange={setAutocompleteSelectedIndex}
              onSelect={handleFormulaSelect}
              onClose={() => {
                setShowAutocomplete(false);
                setAutocompletePosition(null);
              }}
              position={autocompletePosition}
            />,
            document.body
          )
        : null}
    </>
  );
}, sameCellProps);

function stayInTableOnBlur(related: EventTarget | null): boolean {
  if (!(related instanceof HTMLElement)) return false;
  return Boolean(
    related.closest('[data-cell-position]') ||
    related.closest('[data-table-root]') ||
    related.classList.contains('table-focus-sink')
  );
}

function suppressReferenceMouseDown(event: React.MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}
