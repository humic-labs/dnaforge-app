import { MenuRow, MenuStatus, useMenu } from '@waypoint/ui-components';
import { ActionMenu } from '../../../components/ActionMenu';
import { oligoDiagnosticUserMessage } from '../oligo-user-messages';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type ReactElement,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { CompactFilterMultiSelect } from '../../../components/CompactFilterMultiSelect';
import { PortalMenu } from '../../../components/PortalMenu';
import { OpenExternalIcon } from '../../../components/icons';
import { Tooltip } from '../../../shared/components/Tooltip';
import { safeFocus, scrollIntoNearestScrollContainer } from '../../../shared/utils/safeFocus';
import {
  IDT_VENDOR_DEFINITION,
  IDT_MODIFICATION_CATALOG,
  displayIdtToken,
  insertIdtModification,
  idtModificationCategoryFilters,
  idtModificationPlacements,
  parseIdtOligoNotation,
  searchIdtModificationOptions,
  tokenizeIdtOligoNotation,
  type OligoModificationCatalogEntry,
  type OligoModificationPlacement,
  type OligoNotationDiagnostic,
  type OligoNotationDisplayRunKind,
  type OligoOrderType,
} from '../oligo-modifications';
import {
  projectOligoEntry,
  applyOligoEntryEdit,
  entryOffsetToRaw,
  rawOffsetToEntry,
  type OligoEntrySelection,
} from '../oligo-entry-projection';
import {
  writePrimerIdtOrderClipboard,
  writePrimerNaturalBasesClipboard,
} from '../../sequence-clipboard/public/primer-clipboard';

const TEXT_METRICS = 'font-mono text-sm tracking-wide leading-5 break-all whitespace-pre-wrap';
const PADDING = 'px-2 py-1.5';

interface PrimerSequenceInputProps {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;

  mismatchPositions?: readonly number[];
  placeholder?: string;
  rows?: number;
  variant?: 'field' | 'canvas';
  autoFocus?: boolean;

  showPrimeLabels?: boolean;

  enableModifications?: boolean;

  orderType?: OligoOrderType;
}

interface SlashPickerState {
  start: number;
  end: number;
  query: string;
  replacingExisting: boolean;
}

interface PrimerContextMenuState {
  x: number;
  y: number;
}

interface HoveredModificationState {
  entry: OligoModificationCatalogEntry;
  left: number;
  top: number;
}

type OligoRunStatus =
  | 'unknown-modification'
  | 'incompatible-position'
  | 'invalid'
  | 'warning'
  | 'valid-modification';

type OligoRunVisualState =
  | 'canonical'
  | 'special-base'
  | 'modification'
  | 'warning'
  | 'incompatible'
  | 'invalid'
  | 'unknown'
  | 'mismatch';

const SPECIAL_BASE_RUN_KINDS = new Set<OligoNotationDisplayRunKind>([
  'degenerate-base',
  'rna-degenerate-base',
  'alternate-polymer-base',
]);

const OLIGO_RUN_VISUAL_CLASS: Readonly<Record<OligoRunVisualState, string>> = {
  canonical: '',
  'special-base': 'text-oligo-special',
  modification: 'bg-accent/10 text-accent',
  warning: 'text-warning underline decoration-dotted underline-offset-4',
  incompatible:
    'bg-warning/15 text-warning underline decoration-warning decoration-wavy underline-offset-4',
  invalid: 'text-error underline decoration-error decoration-wavy underline-offset-4',
  unknown: 'bg-error/10 text-error underline decoration-error decoration-wavy underline-offset-4',
  mismatch: 'font-black text-error',
};

function resolveOligoRunVisualState(
  runKind: OligoNotationDisplayRunKind,
  status: OligoRunStatus | undefined,
  mismatch: boolean
): OligoRunVisualState {
  if (mismatch) return 'mismatch';
  if (status === 'unknown-modification') return 'unknown';
  if (status === 'incompatible-position') return 'incompatible';
  if (status === 'invalid') return 'invalid';
  if (status === 'warning') return 'warning';
  if (status === 'valid-modification' || runKind === 'two-prime-o-methyl-base') {
    return 'modification';
  }
  if (SPECIAL_BASE_RUN_KINDS.has(runKind)) return 'special-base';
  if (runKind === 'invalid') return 'invalid';
  return 'canonical';
}

export function PrimerSequenceInput({
  value,
  disabled = false,
  onChange,
  mismatchPositions,
  placeholder,
  rows = 2,
  variant = 'field',
  autoFocus = false,
  showPrimeLabels = false,
  enableModifications = true,
  orderType = 'dna',
}: PrimerSequenceInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const automaticHeightRef = useRef<number | null>(null);
  const manualHeightRef = useRef<number | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const slashAnchorRef = useRef<HTMLSpanElement>(null);
  const modificationOptionRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const modificationMenuId = useId();
  const preferredModification = useRef<string | null>(null);
  const hoveredModificationCloseTimerRef = useRef<number | null>(null);
  const pendingCaretRef = useRef<{ notation: string; caret: number } | null>(null);
  const editSelectionRef = useRef<OligoEntrySelection | null>(null);
  const lastInputEventRef = useRef<Event | null>(null);
  const historyRef = useRef<{
    undo: Array<{ notation: string; caret: number }>;
    redo: Array<{ notation: string; caret: number }>;
    expectedValue: string | null;
  }>({ undo: [], redo: [], expectedValue: null });
  const mismatches = useMemo(() => new Set(mismatchPositions ?? []), [mismatchPositions]);
  const [slashPicker, setSlashPicker] = useState<SlashPickerState | null>(null);
  const [categoryFilters, setCategoryFilters] = useState<string[]>([]);
  const [placementFilters, setPlacementFilters] = useState<OligoModificationPlacement[]>([]);
  const [contextMenu, setContextMenu] = useState<PrimerContextMenuState | null>(null);
  const [hoveredModification, setHoveredModification] = useState<HoveredModificationState | null>(
    null
  );
  const cancelHoveredModificationClose = useCallback(() => {
    if (hoveredModificationCloseTimerRef.current === null) return;
    window.clearTimeout(hoveredModificationCloseTimerRef.current);
    hoveredModificationCloseTimerRef.current = null;
  }, []);
  const scheduleHoveredModificationClose = useCallback(() => {
    cancelHoveredModificationClose();
    hoveredModificationCloseTimerRef.current = window.setTimeout(() => {
      hoveredModificationCloseTimerRef.current = null;
      setHoveredModification(null);
    }, 240);
  }, [cancelHoveredModificationClose]);
  const parsedValue = useMemo(
    () => parseIdtOligoNotation(value, { orderType }),
    [orderType, value]
  );
  const displayRuns = useMemo(
    () => tokenizeIdtOligoNotation(value, { orderType }),
    [orderType, value]
  );
  const projection = useMemo(
    () => projectOligoEntry(displayRuns, parsedValue.bases),
    [displayRuns, parsedValue.bases]
  );
  const commitNotation = useCallback(
    (edit: { notation: string; caret: number }) => {
      if (disabled) return;
      if (edit.notation !== value) {
        historyRef.current.undo.push({
          notation: value,
          caret: entryOffsetToRaw(projection.runs, textareaRef.current?.selectionStart ?? 0),
        });
        historyRef.current.redo = [];
        historyRef.current.expectedValue = edit.notation;
      }
      pendingCaretRef.current = edit;
      onChange(edit.notation);
    },
    [disabled, onChange, projection.runs, value]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const beforeInput = (event: InputEvent) => {
      editSelectionRef.current = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        inputType: event.inputType,
      };
    };
    textarea.addEventListener('beforeinput', beforeInput);
    return () => textarea.removeEventListener('beforeinput', beforeInput);
  }, []);

  useLayoutEffect(() => {
    const history = historyRef.current;
    if (history.expectedValue !== value) {
      history.undo = [];
      history.redo = [];
    }
    history.expectedValue = null;
  }, [value]);
  const categoryFilterOptions = useMemo(
    () => idtModificationCategoryFilters(orderType),
    [orderType]
  );
  const placementFilterOptions = useMemo(() => {
    const available = searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, '', { orderType });
    const count = (placement: OligoModificationPlacement): number =>
      available.filter((entry) => idtModificationPlacements(entry).includes(placement)).length;
    return [
      { value: 'five-prime' as const, label: `5′ end (${count('five-prime')})` },
      { value: 'internal' as const, label: `Internal (${count('internal')})` },
      { value: 'three-prime' as const, label: `3′ end (${count('three-prime')})` },
    ];
  }, [orderType]);

  useLayoutEffect(() => {
    const pendingCaret = pendingCaretRef.current;
    if (!pendingCaret) return;
    pendingCaretRef.current = null;
    if (pendingCaret.notation !== value) return;

    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!safeFocus(textarea)) return;
    const caret = rawOffsetToEntry(projection.runs, pendingCaret.caret);
    textarea.setSelectionRange(caret, caret);
  }, [value, projection.runs]);

  const slashOptions = useMemo(() => {
    if (!slashPicker) return [];
    return searchIdtModificationOptions(IDT_MODIFICATION_CATALOG, slashPicker.query, {
      orderType,
      ...(categoryFilters.length > 0 ? { categoryLabels: categoryFilters } : {}),
      ...(placementFilters.length > 0 ? { placements: placementFilters } : {}),
    });
  }, [categoryFilters, orderType, placementFilters, slashPicker]);
  const modificationMenu = useMenu({
    items: slashOptions.map((option) => ({
      id: option.vendorCode,
      textValue: option.label,
      disabled,
      closeOnActivate: false,
    })),
    onClose: () => setSlashPicker(null),
    onActivate: (id) => {
      const option = slashOptions.find((candidate) => candidate.vendorCode === id);
      if (option) chooseModification(option);
    },
  });
  const slashOpen = slashPicker !== null;
  const sendModification = modificationMenu.send;
  useLayoutEffect(() => {
    if (disabled) {
      modificationMenu.close('owner-revoked');
      preferredModification.current = null;
      return;
    }
    if (
      slashOpen &&
      (modificationMenu.stateRef.current.phase === 'closed' ||
        preferredModification.current !== null)
    )
      sendModification({
        type: 'open',
        menuId: 'root',
        preferredId: preferredModification.current,
      });
    else if (!slashOpen) modificationMenu.close('handoff');
    preferredModification.current = null;
  });
  const activeSlashOption =
    slashOptions.find((option) => option.vendorCode === modificationMenu.activeId) ??
    slashOptions[0];

  useEffect(() => {
    if (!activeSlashOption) return;
    scrollIntoNearestScrollContainer(
      modificationOptionRefs.current.get(activeSlashOption.vendorCode),
      { block: 'nearest' }
    );
  }, [activeSlashOption]);

  useEffect(() => {
    if (slashPicker) return;
    setCategoryFilters([]);
    setPlacementFilters([]);
  }, [slashPicker]);

  useEffect(() => {
    if (!slashPicker) return;
    cancelHoveredModificationClose();
    setHoveredModification(null);
  }, [cancelHoveredModificationClose, slashPicker]);

  useEffect(() => {
    setCategoryFilters([]);
    setPlacementFilters([]);
  }, [orderType]);

  useEffect(
    () => () => {
      cancelHoveredModificationClose();
    },
    [cancelHoveredModificationClose]
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (variant === 'canvas') {
      textarea.style.removeProperty('height');
      automaticHeightRef.current = null;
      manualHeightRef.current = null;
      return;
    }

    const currentHeight = Number.parseFloat(textarea.style.height);
    if (
      automaticHeightRef.current !== null &&
      Number.isFinite(currentHeight) &&
      currentHeight !== automaticHeightRef.current
    ) {
      manualHeightRef.current = currentHeight;
    }
    const minimum = rows * 20 + 12;
    if (manualHeightRef.current !== null) {
      const height = Math.max(minimum, manualHeightRef.current);
      textarea.style.height = `${height}px`;
      automaticHeightRef.current = height;
      return;
    }
    textarea.style.height = 'auto';
    const maximum = Math.max(minimum, 240);
    const contentHeight = Math.max(textarea.scrollHeight, backdropRef.current?.scrollHeight ?? 0);
    const height = Math.min(maximum, Math.max(minimum, contentHeight));
    textarea.style.height = `${height}px`;
    automaticHeightRef.current = height;
  }, [value, variant, showPrimeLabels, rows]);

  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const bd = backdropRef.current;
    if (ta && bd) {
      bd.scrollTop = ta.scrollTop;
      bd.scrollLeft = ta.scrollLeft;
    }
  }, []);

  const updateSlashPicker = useCallback((next: string, caret: number) => {
    const prefix = next.slice(0, caret);
    const slashCount = Array.from(prefix).filter((character) => character === '/').length;
    if (slashCount % 2 === 0) {
      setSlashPicker(null);
      return;
    }
    const start = prefix.lastIndexOf('/');
    const query = prefix.slice(start + 1);
    if (!/^[A-Za-z0-9+_.-]*$/.test(query)) {
      setSlashPicker(null);
      return;
    }
    setSlashPicker({
      start,
      end: caret,
      query,
      replacingExisting: false,
    });
  }, []);

  const reopenModificationPicker = useCallback(
    (caret: number) => {
      if (!enableModifications) return;
      const run = displayRuns.find(
        (candidate) =>
          candidate.kind === 'modification' &&
          caret >= candidate.rawStart &&
          caret <= candidate.rawEnd
      );
      if (!run?.catalogEntry) return;
      preferredModification.current = run.catalogEntry.vendorCode;
      setSlashPicker({
        start: run.rawStart,
        end: run.rawEnd,
        query: '',
        replacingExisting: true,
      });
    },
    [displayRuns, enableModifications]
  );

  const selectionStillAnchorsPicker = useCallback(
    (textarea: HTMLTextAreaElement): boolean => {
      if (!slashPicker) return false;
      const selectionStart = entryOffsetToRaw(projection.runs, textarea.selectionStart);
      const selectionEnd = entryOffsetToRaw(projection.runs, textarea.selectionEnd);
      if (slashPicker.replacingExisting) {
        const caretIsInsideToken =
          selectionStart === selectionEnd &&
          selectionStart >= slashPicker.start &&
          selectionStart <= slashPicker.end;
        const wholeTokenIsSelected =
          selectionStart === slashPicker.start && selectionEnd === slashPicker.end;
        return caretIsInsideToken || wholeTokenIsSelected;
      }
      if (selectionStart !== selectionEnd) return false;
      return selectionStart === slashPicker.end;
    },
    [slashPicker, projection.runs]
  );

  const closeModificationMenu = modificationMenu.close;
  const chooseModification = useCallback(
    (option: OligoModificationCatalogEntry) => {
      if (!slashPicker) return;
      const inserted = insertIdtModification(
        value,
        slashPicker.start,
        slashPicker.end,
        option.vendorCode,
        { consumeFollowingBase: !slashPicker.replacingExisting, orderType }
      );
      commitNotation(inserted);
      closeModificationMenu('handoff');
    },
    [commitNotation, orderType, slashPicker, value, closeModificationMenu]
  );

  const handleEntryChange = (event: FormEvent<HTMLTextAreaElement>) => {
    if (lastInputEventRef.current === event.nativeEvent) return;
    lastInputEventRef.current = event.nativeEvent;
    const textarea = event.currentTarget;
    const edit = applyOligoEntryEdit(
      value,
      projection,
      textarea.value,
      textarea.selectionStart,
      editSelectionRef.current
    );
    editSelectionRef.current = null;
    commitNotation(edit);
    if (enableModifications) updateSlashPicker(edit.notation, edit.caret);
    else setSlashPicker(null);
  };

  const textMetrics =
    variant === 'canvas'
      ? 'font-mono text-lg tracking-[0.08em] leading-8 break-all whitespace-pre-wrap'
      : TEXT_METRICS;
  const padding =
    variant === 'canvas' ? (showPrimeLabels ? 'py-3 pl-11 pr-10' : 'px-3 py-3') : PADDING;
  const shellClass =
    variant === 'canvas'
      ? 'relative h-full min-h-0 bg-bg'
      : 'relative rounded-md border border-border bg-bg focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40';
  const textareaSize = variant === 'canvas' ? 'h-full min-h-0' : '';

  return (
    <div className={shellClass} data-testid="primer-sequence-shell">
      {showPrimeLabels ? (
        <span
          aria-hidden="true"
          data-testid="primer-sequence-five-prime"
          className="pointer-events-none absolute left-3 top-3 z-10 select-none font-mono text-lg font-medium leading-8 text-fg-muted"
        >
          5′
        </span>
      ) : null}
      {}
      <div
        ref={backdropRef}
        aria-hidden="true"
        data-testid="primer-sequence-highlight"
        className={`pointer-events-none absolute inset-0 overflow-hidden text-fg ${textMetrics} ${padding}`}
      >
        {projection.runs.map((run) => {
          const mismatch =
            run.naturalBaseIndex !== undefined && mismatches.has(run.naturalBaseIndex);
          const errorDiagnostic = parsedValue.diagnostics.find(
            (candidate) =>
              candidate.severity === 'error' &&
              candidate.rawStart < run.rawEnd &&
              candidate.rawEnd > run.rawStart
          );
          const warningDiagnostic = parsedValue.diagnostics.find(
            (candidate) =>
              candidate.severity === 'warning' &&
              candidate.rawStart < run.rawEnd &&
              candidate.rawEnd > run.rawStart
          );
          const diagnostic = errorDiagnostic ?? warningDiagnostic;
          const status: OligoRunStatus | undefined =
            errorDiagnostic?.code === 'unknown-modification'
              ? 'unknown-modification'
              : errorDiagnostic?.code === 'invalid-placement' ||
                  errorDiagnostic?.code === 'incompatible-order-type'
                ? 'incompatible-position'
                : errorDiagnostic
                  ? 'invalid'
                  : warningDiagnostic
                    ? 'warning'
                    : run.kind === 'modification'
                      ? 'valid-modification'
                      : undefined;
          const visualState = resolveOligoRunVisualState(run.kind, status, mismatch);
          const className = OLIGO_RUN_VISUAL_CLASS[visualState];
          const interactive = Boolean(run.catalogEntry || diagnostic);
          const runElement = (
            <span
              key={run.rawStart}
              ref={slashPicker?.start === run.rawStart ? slashAnchorRef : undefined}
              data-slash-picker-anchor={slashPicker?.start === run.rawStart ? 'true' : undefined}
              className={`${className} ${interactive ? 'pointer-events-auto relative z-20' : ''} ${
                run.catalogEntry ? 'cursor-pointer' : diagnostic ? 'cursor-help' : ''
              }`}
              data-mismatch={mismatch ? 'true' : undefined}
              data-oligo-run={run.kind}
              data-oligo-visual-state={visualState}
              data-oligo-status={status}
              data-oligo-error={errorDiagnostic ? 'true' : undefined}
              data-oligo-warning={warningDiagnostic ? 'true' : undefined}
              data-vendor-code={run.catalogEntry?.vendorCode}
              data-raw-start={run.rawStart}
              data-raw-end={run.rawEnd}
              title={
                run.catalogEntry
                  ? `${run.catalogEntry.label} ${run.text}`
                  : run.kind === 'two-prime-o-methyl-base'
                    ? `2′-O-methyl ${run.displayText} (${run.text})`
                    : undefined
              }
              onMouseDown={
                interactive
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const textarea = textareaRef.current;
                      if (!textarea) return;
                      if (!safeFocus(textarea)) return;
                      textarea.setSelectionRange(run.displayStart, run.displayEnd);
                      cancelHoveredModificationClose();
                      setHoveredModification(null);
                      if (run.catalogEntry) reopenModificationPicker(run.rawStart);
                    }
                  : undefined
              }
              onMouseEnter={
                run.catalogEntry && !diagnostic
                  ? (event) => {
                      if (slashPicker) return;
                      cancelHoveredModificationClose();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setHoveredModification({
                        entry: run.catalogEntry as OligoModificationCatalogEntry,
                        left: bounds.left,
                        top: bounds.bottom + 6,
                      });
                    }
                  : undefined
              }
              onMouseLeave={
                run.catalogEntry && !diagnostic ? scheduleHoveredModificationClose : undefined
              }
            >
              {run.displayText}
            </span>
          );
          if (!diagnostic) {
            return runElement;
          }
          return (
            <Tooltip
              key={run.rawStart}
              content={<OligoDiagnosticTooltipContent diagnostic={diagnostic} />}
              side="top"
              className="pointer-events-auto align-baseline"
            >
              {runElement}
            </Tooltip>
          );
        })}
        {showPrimeLabels && value.length > 0 ? (
          <span
            aria-hidden="true"
            data-testid="primer-sequence-three-prime"
            className="pointer-events-none ml-3 inline-block select-none font-medium text-fg-muted"
          >
            3′
          </span>
        ) : null}
        {}
        {'\n'}
      </div>
      <textarea
        disabled={disabled}
        ref={textareaRef}
        style={variant === 'field' ? { minHeight: rows * 20 + 12 } : undefined}
        id="primer-sequence-input"
        data-testid="primer-sequence-input"
        data-oligo-notation={value}
        value={projection.text}
        onChange={handleEntryChange}
        onInput={handleEntryChange}
        onCopy={(event) => {
          const textarea = event.currentTarget;
          if (textarea.selectionStart === textarea.selectionEnd) return;
          event.preventDefault();
          event.clipboardData.setData(
            'text/plain',
            value.slice(
              entryOffsetToRaw(projection.runs, textarea.selectionStart),
              entryOffsetToRaw(projection.runs, textarea.selectionEnd)
            )
          );
        }}
        onCut={(event) => {
          const textarea = event.currentTarget;
          if (textarea.selectionStart === textarea.selectionEnd) return;
          event.preventDefault();
          const start = entryOffsetToRaw(projection.runs, textarea.selectionStart);
          const end = entryOffsetToRaw(projection.runs, textarea.selectionEnd);
          event.clipboardData.setData('text/plain', value.slice(start, end));
          commitNotation({ notation: value.slice(0, start) + value.slice(end), caret: start });
          setSlashPicker(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (
            (event.metaKey || event.ctrlKey) &&
            (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')
          ) {
            event.preventDefault();
            const redo = event.shiftKey || event.key.toLowerCase() === 'y';
            const history = historyRef.current;
            const source = redo ? history.redo : history.undo;
            const destination = redo ? history.undo : history.redo;
            const next = source.pop();
            if (next) {
              destination.push({
                notation: value,
                caret: entryOffsetToRaw(projection.runs, event.currentTarget.selectionStart),
              });
              history.expectedValue = next.notation;
              pendingCaretRef.current = next;
              onChange(next.notation);
              setSlashPicker(null);
            }
            return;
          }
          if (!slashPicker) return;
          if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) {
            modificationMenu.handleKeyDown(event, { wrap: true });
            return;
          }
          if (
            event.key === 'ArrowLeft' ||
            event.key === 'ArrowRight' ||
            event.key === 'Home' ||
            event.key === 'End'
          ) {
            setSlashPicker(null);
          }
        }}
        onSelect={(event) => {
          if (slashPicker && !selectionStillAnchorsPicker(event.currentTarget)) {
            setSlashPicker(null);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setSlashPicker(null);
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
        onClick={(event) => {
          if (slashPicker && !selectionStillAnchorsPicker(event.currentTarget)) {
            setSlashPicker(null);
          }
          reopenModificationPicker(
            entryOffsetToRaw(projection.runs, event.currentTarget.selectionStart)
          );
        }}
        onScroll={syncScroll}
        rows={rows}
        wrap="soft"
        spellCheck={false}
        autoCapitalize="off"
        autoFocus={autoFocus}
        aria-label="Primer sequence"
        aria-controls={slashOpen ? modificationMenuId : undefined}
        aria-activedescendant={
          slashOpen && modificationMenu.activeId !== null
            ? `${modificationMenuId}-${encodeURIComponent(modificationMenu.activeId)}`
            : undefined
        }
        aria-invalid={parsedValue.errors.length > 0 ? true : undefined}
        placeholder={placeholder}
        className={`relative z-10 block w-full ${variant === 'field' ? 'resize-y' : 'resize-none'} overflow-x-hidden overflow-y-auto bg-transparent text-transparent caret-fg placeholder:text-fg-muted/50 focus:outline-none ${textareaSize} ${textMetrics} ${padding}`}
      />
      <PortalMenu
        id={modificationMenuId}
        open={slashOpen}
        menu={modificationMenu}
        anchorRef={variant === 'field' ? textareaRef : slashAnchorRef}
        onRequestClose={modificationMenu.close}
        role="listbox"
        selection={false}
        shortcuts
        horizontalAlign="start"
        preferredSide={variant === 'field' ? 'bottom' : 'top'}
        allowFlip={variant !== 'field'}
        data-testid="primer-modification-picker"
        className="flex w-[610px] max-w-[calc(100vw-16px)] flex-col !overflow-hidden"
      >
        <div className="shrink-0 border-b border-border px-2.5 py-1.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-fg-muted">
            IDT modifications
          </div>
        </div>
        <div className="grid min-h-0 max-h-[360px] flex-1 grid-cols-[minmax(0,340px)_270px] overflow-hidden">
          <div className="flex min-h-0 flex-col border-r border-border">
            <div
              data-testid="primer-modification-filter-bar"
              data-ignore-picker-shortcuts="true"
              className="flex shrink-0 items-center gap-1.5 border-b border-border bg-bg px-2 py-1.5"
            >
              <CompactFilterMultiSelect
                values={categoryFilters}
                options={categoryFilterOptions.map(({ label, count }) => ({
                  value: label,
                  label: `${label} (${count})`,
                }))}
                onChange={(nextCategories) => {
                  setCategoryFilters(nextCategories);
                }}
                ariaLabel="IDT modification category"
                allLabel="All categories"
                menuAlign="end"
                testId="primer-modification-category-filter"
                className="min-w-0 flex-1"
              />
              <CompactFilterMultiSelect
                values={placementFilters}
                options={placementFilterOptions}
                onChange={(nextPlacements) => {
                  setPlacementFilters(nextPlacements);
                }}
                ariaLabel="IDT modification position"
                allLabel="Any position"
                testId="primer-modification-position-filter"
                className="w-[124px] shrink-0"
              />
            </div>
            <div
              data-testid="primer-modification-results"
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {slashOptions.length === 0 ? (
                <MenuStatus>No IDT modifications match these filters.</MenuStatus>
              ) : null}
              {slashOptions.map((option) => (
                <MenuRow
                  key={option.vendorCode}
                  id={`${modificationMenuId}-${encodeURIComponent(option.vendorCode)}`}
                  ref={(element) => {
                    if (element) modificationOptionRefs.current.set(option.vendorCode, element);
                    else modificationOptionRefs.current.delete(option.vendorCode);
                  }}
                  role="option"
                  aria-selected={option.vendorCode === modificationMenu.activeId}
                  active={option.vendorCode === modificationMenu.activeId}
                  aria-label={`${option.label} ${option.vendorCode}`}
                  tabIndex={-1}
                  shortcut={
                    <span className="flex items-center gap-2">
                      <span>{placementLabel(option)}</span>
                      <code>{displayIdtToken(option.vendorCode)}</code>
                    </span>
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => modificationMenu.activate(option.vendorCode)}
                  onMouseEnter={() => modificationMenu.point(option.vendorCode)}
                >
                  {option.label}
                </MenuRow>
              ))}
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto bg-bg px-3 py-3">
            <ModificationPreview entry={activeSlashOption} />
          </div>
        </div>
        <div className="flex shrink-0 justify-end border-t border-border px-2.5 py-1.5">
          <a
            href={IDT_VENDOR_DEFINITION.catalogBrowseUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="primer-modification-catalog-link"
            data-ignore-picker-shortcuts="true"
            className="inline-flex items-center gap-1 text-[10px] text-fg-link hover:underline focus:outline-none focus:underline"
          >
            Browse the IDT modification catalog
            <OpenExternalIcon size={11} />
          </a>
        </div>
      </PortalMenu>
      {hoveredModification && !slashPicker
        ? createPortal(
            <div
              data-testid="primer-modification-token-preview"
              className="pointer-events-none fixed z-[10070] w-[270px] border border-border bg-bg-subtle p-3 shadow-lg"
              style={{ left: hoveredModification.left, top: hoveredModification.top }}
            >
              <ModificationPreview
                entry={hoveredModification.entry}
                embedded
                onProductLinkMouseEnter={cancelHoveredModificationClose}
                onProductLinkMouseLeave={scheduleHoveredModificationClose}
              />
            </div>,
            document.body
          )
        : null}
      {contextMenu ? (
        <ActionMenu
          open
          label="Primer copy options"
          testId="primer-copy-menu"
          anchorPoint={contextMenu}
          onClose={() => setContextMenu(null)}
          entries={[
            {
              id: 'copy-bases',
              label: 'Copy bases',
              disabled: parsedValue.errors.length > 0,
              title: parsedValue.errors[0],
              onSelect: () => {
                void writePrimerNaturalBasesClipboard(value, orderType);
              },
            },
            {
              id: 'copy-idt',
              label: 'Copy for IDT',
              disabled: parsedValue.errors.length > 0,
              title: parsedValue.errors[0],
              onSelect: () => {
                void writePrimerIdtOrderClipboard(parsedValue.bases, value, orderType);
              },
            },
          ]}
        />
      ) : null}
    </div>
  );
}

function ModificationPreview({
  entry,
  embedded = false,
  onProductLinkMouseEnter,
  onProductLinkMouseLeave,
}: {
  entry: OligoModificationCatalogEntry | undefined;
  embedded?: boolean;
  onProductLinkMouseEnter?: () => void;
  onProductLinkMouseLeave?: () => void;
}) {
  if (!entry) {
    return (
      <div
        data-testid={embedded ? undefined : 'primer-modification-preview-empty'}
        className="flex min-h-[150px] items-center justify-center text-center text-[11px] leading-4 text-fg-subtle"
      >
        Choose a modification to preview it
      </div>
    );
  }
  return (
    <div data-testid={embedded ? undefined : 'primer-modification-preview'}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-fg">{entry.label}</span>
        <code className="shrink-0 text-[10px] text-fg-subtle">
          {displayIdtToken(entry.vendorCode)}
        </code>
      </div>
      <ModificationProductLink
        entry={entry}
        embedded={embedded}
        onMouseEnter={onProductLinkMouseEnter}
        onMouseLeave={onProductLinkMouseLeave}
      />
      <dl
        data-testid={embedded ? undefined : 'primer-modification-facts'}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] leading-4"
      >
        {modificationFacts(entry).map(({ term, value }) => (
          <Fragment key={term}>
            <dt className="text-fg-subtle">{term}</dt>
            <dd className="text-fg">{value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function modificationFacts(
  entry: OligoModificationCatalogEntry
): readonly { term: string; value: string }[] {
  const facts = [{ term: 'Position', value: placementLabel(entry) }];
  if (entry.supportedOrderTypes.length > 0) {
    facts.push({
      term: 'Oligo types',
      value: entry.supportedOrderTypes.map((orderType) => orderType.toUpperCase()).join(', '),
    });
  }
  const metadata = entry.vendorMetadata;
  if (!metadata) return facts;
  facts.push({ term: 'Molecular weight', value: `${metadata.molecularWeight} g/mol` });
  if (metadata.extinctionCoefficient > 0) {
    facts.push({
      term: 'Extinction coefficient',
      value: `${metadata.extinctionCoefficient.toLocaleString('en-US')} L/(mol·cm) at 260 nm`,
    });
  }
  if (metadata.requiresIeHplc) facts.push({ term: 'Purification', value: 'IE-HPLC required' });
  else if (metadata.requiresHplc) facts.push({ term: 'Purification', value: 'HPLC required' });
  return facts;
}

function ModificationProductLink({
  entry,
  embedded,
  onMouseEnter,
  onMouseLeave,
}: {
  entry: OligoModificationCatalogEntry | undefined;
  embedded: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  if (!entry?.productUrl) return null;
  return (
    <a
      href={entry.productUrl}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={
        embedded ? 'primer-modification-token-product-link' : 'primer-modification-product-link'
      }
      data-ignore-picker-shortcuts="true"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="pointer-events-auto mb-2 inline-flex items-center gap-1 text-[10px] text-fg-link hover:underline focus:outline-none focus:underline"
    >
      View this modification on IDT
      <OpenExternalIcon size={11} />
    </a>
  );
}

function placementLabel(entry: OligoModificationCatalogEntry | undefined): string {
  const placements = entry ? idtModificationPlacements(entry) : [];
  if (placements.length === 3) return 'any position';
  const placement = placements[0];
  if (placement === 'five-prime') return '5′ end';
  if (placement === 'three-prime') return '3′ end';
  return 'internal';
}

function OligoDiagnosticTooltipContent({
  diagnostic,
}: {
  diagnostic: OligoNotationDiagnostic;
}): ReactElement {
  const heading =
    diagnostic.code === 'unknown-modification'
      ? 'Not recognized by IDT'
      : diagnostic.code === 'incompatible-order-type'
        ? 'Recognized by IDT, wrong oligo type'
        : diagnostic.code === 'invalid-placement'
          ? 'Recognized by IDT, wrong position'
          : diagnostic.severity === 'warning'
            ? 'IDT synthesis guidance'
            : 'Invalid oligo entry';
  const markerClass =
    diagnostic.code === 'invalid-placement' ||
    diagnostic.code === 'incompatible-order-type' ||
    diagnostic.severity === 'warning'
      ? 'bg-warning'
      : 'bg-error';

  return (
    <span className="flex max-w-72 items-start gap-2" data-oligo-tooltip={diagnostic.code}>
      <span
        aria-hidden="true"
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${markerClass}`}
      />
      <span className="min-w-0">
        <span className="block font-semibold">{heading}</span>
        <span className="mt-0.5 block font-normal text-fg-muted">
          {oligoDiagnosticUserMessage(diagnostic)}
        </span>
      </span>
    </span>
  );
}
