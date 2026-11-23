import { usePresentationListener } from '../../../presentation/PresentationSurface';
import {
  TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX,
  TRACK_STACK_ABOVE_ZONE_PAD_PX,
  TRACK_STACK_END_CONTROL_HEIGHT_PX,
} from '@waypoint/genome-renderer/pure';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';

import type { TrackPresentationDrag } from '@waypoint/genome-renderer/pure';
import { cn } from '../../../shared/lib/cn';
import { Tooltip } from '../../../shared/components/Tooltip';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { SettingsIcon, TrashIcon } from '../../../components/icons';
import type { AnnotationTrackDefinition } from '../annotation-track-registry';
import type { GutterRow } from './track-gutter-rows';
import { AnnotationTypePicker } from './AnnotationTypePicker';
import type { PresentedTrackScrollReceipt } from './lane-screen-bands';

export const GUTTER_MIN_WIDTH = 160;
export const GUTTER_MAX_WIDTH = 480;
export const GUTTER_DEFAULT_WIDTH = 220;
export const GUTTER_COLLAPSED_WIDTH = 28;
export const GUTTER_STYLE = {
  bg: 'bg-[var(--indexed-viewer-track-background,hsl(var(--color-bg)))]',
  edgeLine: 'w-[3px] bg-border/40',
  rowDivider: '',
  resizeLine: 'h-px bg-transparent',
  headerLabel: 'text-sm font-semibold text-fg-muted',
  toolbarRule: 'h-[3px] bg-border/40',
  addRowRule: '',
} as const;
const GUTTER_BG_CLASS = GUTTER_STYLE.bg;
export const GUTTER_ADD_ROW_HEIGHT_PX = TRACK_STACK_END_CONTROL_HEIGHT_PX;

export interface TrackGutterProps {
  rows: ReadonlyArray<GutterRow>;
  onToggleVisible: (row: GutterRow) => void;
  onRemove: (row: GutterRow) => void;
  onMoveDataRow?: (trackId: string, targetTrackId: string, placement: TrackMovePlacement) => void;
  onPreviewMoveDataRow?: (
    trackId: string,
    targetTrackId: string,
    placement: TrackMovePlacement
  ) => void;
  dataRowOrder?: ReadonlyArray<string>;
  onPreviewDataRowOrder?: (orderedTrackIds: ReadonlyArray<string>) => void;
  onPreviewDataRowDrag?: (preview: TrackPresentationDrag | null) => void;
  onCommitDataRowOrder?: (orderedTrackIds: ReadonlyArray<string>) => void;
  onCancelDataRowOrder?: () => void;
  onPreviewDataRowHeight?: (row: GutterRow, heightPx: number) => void;
  onCommitDataRowHeight?: (row: GutterRow, startingHeightPx: number, heightPx: number) => void;
  onCancelDataRowHeight?: (row: GutterRow, startingHeightPx: number) => void;
  onAddTrack?: () => void;
  onOpenMutationNavigator?: () => void;
  width?: number;
  onResize?: (width: number) => void;
  collapsed?: boolean;
  annotationTrackRegistry?: ReadonlyArray<AnnotationTrackDefinition>;
  visibleTypes?: ReadonlySet<string>;
  onToggleVisibleType?: (type: string) => void;
  onSetVisibleTypes?: (types: ReadonlySet<string>) => void;
  temporaryAnnotationReveal?: {
    trackId: string;
    onShowTrack: () => void;
  } | null;
  visibleAnnotationSearchFocus?: {
    trackId: string;
    canonicalIdentity: string;
    onKeepAdditionalLane?: () => void;
  } | null;
  referenceControls?: ReactNode;
  renderDataControls?: (row: GutterRow, settingsExpanded: boolean) => ReactNode;
  dataRowTone?: (row: GutterRow) => TrackGutterDataTone;
  onVerticalScroll?: (deltaYPx: number) => void;
  scrollLayerRef?: Ref<HTMLDivElement>;
}

export type TrackMovePlacement = 'before' | 'after';

export function trackReorderPlacementFromPointerY(
  clientY: number,
  rowTop: number,
  rowHeight: number
): TrackMovePlacement {
  return clientY < rowTop + rowHeight / 2 ? 'before' : 'after';
}

export function moveTrackOrder(
  orderedTrackIds: ReadonlyArray<string>,
  sourceTrackId: string,
  targetTrackId: string,
  placement: TrackMovePlacement
): ReadonlyArray<string> {
  if (sourceTrackId === targetTrackId) return orderedTrackIds;
  const sourceIndex = orderedTrackIds.indexOf(sourceTrackId);
  const targetIndex = orderedTrackIds.indexOf(targetTrackId);
  if (sourceIndex < 0 || targetIndex < 0) return orderedTrackIds;
  const next = orderedTrackIds.filter((trackId) => trackId !== sourceTrackId);
  const nextTargetIndex = next.indexOf(targetTrackId);
  next.splice(placement === 'before' ? nextTargetIndex : nextTargetIndex + 1, 0, sourceTrackId);
  return next.every((trackId, index) => trackId === orderedTrackIds[index])
    ? orderedTrackIds
    : next;
}

export function applyPresentedTrackScrollReceipt(
  target: HTMLElement,
  receipt: PresentedTrackScrollReceipt
): void {
  target.style.transform = `translate3d(0, -${receipt.trackScrollTop}px, 0)`;
  target.style.setProperty('--track-scroll-top', `${receipt.trackScrollTop}px`);
  target.dataset.presentedFrameEpoch = String(receipt.completedFrameEpoch);
  target.dataset.trackScrollTop = String(receipt.trackScrollTop);
}

function wheelDeltaPixels(event: WheelEvent, viewportHeight: number): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, viewportHeight);
  return event.deltaY;
}

export interface TrackSettingsPopoverPlacementInput {
  readonly anchorTop: number;
  readonly anchorBottom: number;
  readonly boundaryTop: number;
  readonly boundaryBottom: number;
  readonly desiredHeight: number;
  readonly gap?: number;
}

export interface TrackSettingsPopoverPlacement {
  readonly direction: 'up' | 'down';
  readonly top: number;
  readonly maxHeight: number;
}

export function resolveTrackSettingsPopoverPlacement({
  anchorTop,
  anchorBottom,
  boundaryTop,
  boundaryBottom,
  desiredHeight,
  gap = 4,
}: TrackSettingsPopoverPlacementInput): TrackSettingsPopoverPlacement {
  const spaceAbove = Math.max(0, anchorTop - boundaryTop - gap);
  const spaceBelow = Math.max(0, boundaryBottom - anchorBottom - gap);
  const direction =
    desiredHeight <= spaceBelow || (desiredHeight > spaceAbove && spaceBelow >= spaceAbove)
      ? 'down'
      : 'up';
  const maxHeight = direction === 'down' ? spaceBelow : spaceAbove;
  const renderedHeight = Math.min(Math.max(0, desiredHeight), maxHeight);
  return {
    direction,
    top: direction === 'down' ? anchorBottom + gap : anchorTop - gap - renderedHeight,
    maxHeight,
  };
}

export type TrackGutterDataTone =
  | 'default'
  | 'loading'
  | 'recovering'
  | 'stalled'
  | 'blocked'
  | 'empty';

function dotColorClass(row: GutterRow, tone: TrackGutterDataTone = 'default'): string {
  if (row.kind === 'reference') return 'bg-emerald-500';
  if (row.kind === 'cytoband') return 'bg-indigo-500';
  if (tone === 'loading') return 'bg-slate-400';
  if (tone === 'recovering') return 'bg-amber-500';
  if (tone === 'stalled') return 'bg-amber-500';
  if (tone === 'blocked') return 'bg-danger';
  if (tone === 'empty') return 'bg-slate-400';
  return 'bg-blue-500';
}

function exceptionalTrackStatusLabel(tone: TrackGutterDataTone): string | null {
  if (tone === 'loading') return 'Loading';
  if (tone === 'recovering') return 'Recovering';
  if (tone === 'stalled') return 'Waiting for SSH';
  if (tone === 'blocked') return 'Failed to load';
  if (tone === 'empty') return 'No data';
  return null;
}

export const GUTTER_UNBANDED_ROW_HEIGHT_PX = 30;
const TRACK_SETTINGS_MIN_WIDTH_PX = 244;
export const TRACK_HEIGHT_MIN_PX = 32;
export const TRACK_HEIGHT_MAX_PX = 2_048;
export const TRACK_HEIGHT_KEYBOARD_STEP_PX = 8;

function clampWidth(w: number): number {
  return Math.max(GUTTER_MIN_WIDTH, Math.min(GUTTER_MAX_WIDTH, w));
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function ResizeHandle({ width, onResize }: { width: number; onResize: (w: number) => void }) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => onResize(clampWidth(startWidth + (ev.clientX - startX)));
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
  return (
    <div
      data-testid="track-gutter-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize track gutter"
      onPointerDown={onPointerDown}
      className="absolute right-0 top-0 z-30 h-full w-1.5 cursor-col-resize hover:bg-accent/60"
    />
  );
}

function clampTrackHeight(heightPx: number): number {
  return Math.max(TRACK_HEIGHT_MIN_PX, Math.min(TRACK_HEIGHT_MAX_PX, Math.round(heightPx)));
}

function TrackHeightResizeHandle({
  row,
  heightPx,
  onPreview,
  onCommit,
  onCancel,
}: {
  row: GutterRow;
  heightPx: number;
  onPreview: (row: GutterRow, heightPx: number) => void;
  onCommit: (row: GutterRow, startingHeightPx: number, heightPx: number) => void;
  onCancel?: (row: GutterRow, startingHeightPx: number) => void;
}) {
  const presentationEvents = usePresentationListener();

  const [active, setActive] = useState(false);
  const cancelActiveGestureRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cancelActiveGestureRef.current?.();
    },
    []
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cancelActiveGestureRef.current?.();

    const startY = event.clientY;
    const startingHeightPx = clampTrackHeight(heightPx);
    let previewHeightPx = startingHeightPx;
    let finished = false;
    setActive(true);

    const removeListeners = () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
      presentationEvents.remove(document, 'keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleWindowBlur);
      cancelActiveGestureRef.current = null;
    };
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      removeListeners();
      setActive(false);
      if (previewHeightPx === startingHeightPx) return;
      if (commit) onCommit(row, startingHeightPx, previewHeightPx);
      else onCancel?.(row, startingHeightPx);
    };
    const previewAt = (clientY: number) => {
      const nextHeightPx = clampTrackHeight(startingHeightPx + clientY - startY);
      if (nextHeightPx === previewHeightPx) return;
      previewHeightPx = nextHeightPx;
      onPreview(row, nextHeightPx);
    };
    function handlePointerMove(moveEvent: PointerEvent) {
      moveEvent.preventDefault();
      previewAt(moveEvent.clientY);
    }
    function handlePointerUp(upEvent: PointerEvent) {
      previewAt(upEvent.clientY);
      finish(true);
    }
    function handlePointerCancel() {
      finish(false);
    }
    function handleKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    }
    function handleWindowBlur() {
      finish(false);
    }

    cancelActiveGestureRef.current = () => finish(false);
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);
    presentationEvents.add(document, 'keydown', handleKeyDown, true);
    window.addEventListener('blur', handleWindowBlur);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={`Resize ${row.label} track height`}
      aria-valuemin={TRACK_HEIGHT_MIN_PX}
      aria-valuemax={TRACK_HEIGHT_MAX_PX}
      aria-valuenow={clampTrackHeight(heightPx)}
      aria-valuetext={`${clampTrackHeight(heightPx)} pixels`}
      data-testid={`track-gutter-height-resize-${row.id}`}
      data-resize-active={active ? 'true' : 'false'}
      title="Drag to resize track height. Use ↑ or ↓ for precise adjustment."
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        const step = event.shiftKey
          ? TRACK_HEIGHT_KEYBOARD_STEP_PX * 4
          : TRACK_HEIGHT_KEYBOARD_STEP_PX;
        const nextHeightPx = clampTrackHeight(heightPx + direction * step);
        if (nextHeightPx !== heightPx) onCommit(row, heightPx, nextHeightPx);
      }}
      className={`group/height absolute bottom-0 left-0 right-0 z-20 h-2 cursor-row-resize outline-none ${
        active ? 'bg-accent/5' : ''
      }`}
    >
      <span
        aria-hidden
        data-testid={`track-gutter-height-resize-line-${row.id}`}
        data-line-thickness-px="1"
        className={`absolute bottom-0 left-0 right-0 transition-colors ${GUTTER_STYLE.resizeLine} ${
          active
            ? '!bg-accent'
            : 'group-hover/height:!bg-accent/80 group-focus-visible/height:!bg-accent/80'
        }`}
      />
    </div>
  );
}

function TrackDragHandle({
  row,
  onMoveUp,
  onMoveDown,
  onPointerDown,
}: {
  row: GutterRow;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`track-gutter-drag-${row.id}`}
      aria-label={`Move ${row.label}`}
      title="Drag to reorder. Use ↑ or ↓ from the keyboard."
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' && onMoveUp) {
          event.preventDefault();
          onMoveUp();
        } else if (event.key === 'ArrowDown' && onMoveDown) {
          event.preventDefault();
          onMoveDown();
        }
      }}
      className="flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-fg-subtle outline-none wp-interactive active:cursor-grabbing"
    >
      <svg
        aria-hidden
        data-testid={`track-gutter-drag-grip-${row.id}`}
        className="h-[18px] w-3"
        viewBox="0 0 12 18"
        fill="currentColor"
      >
        <circle cx="3" cy="3" r="1.25" />
        <circle cx="9" cy="3" r="1.25" />
        <circle cx="3" cy="9" r="1.25" />
        <circle cx="9" cy="9" r="1.25" />
        <circle cx="3" cy="15" r="1.25" />
        <circle cx="9" cy="15" r="1.25" />
      </svg>
    </button>
  );
}

function RowBody({
  row,
  onToggleVisible,
  onRemove,
  annotationTrackRegistry,
  visibleTypes,
  onToggleVisibleType,
  onSetVisibleTypes,
  temporaryAnnotationReveal,
  visibleAnnotationSearchFocus,
  referenceControls,
  renderDataControls,
  dataRowTone,
  dragHandle,
  dataSettingsExpanded,
  onToggleDataSettings,
  settingsButtonRef,
}: {
  row: GutterRow;
  onToggleVisible: (row: GutterRow) => void;
  onRemove: (row: GutterRow) => void;
  annotationTrackRegistry?: ReadonlyArray<AnnotationTrackDefinition>;
  visibleTypes?: ReadonlySet<string>;
  onToggleVisibleType?: (type: string) => void;
  onSetVisibleTypes?: (types: ReadonlySet<string>) => void;
  temporaryAnnotationReveal?: {
    trackId: string;
    onShowTrack: () => void;
  } | null;
  visibleAnnotationSearchFocus?: {
    trackId: string;
    canonicalIdentity: string;
    onKeepAdditionalLane?: () => void;
  } | null;
  referenceControls?: ReactNode;
  renderDataControls?: (row: GutterRow, settingsExpanded: boolean) => ReactNode;
  dataRowTone?: (row: GutterRow) => TrackGutterDataTone;
  dragHandle?: ReactNode;
  dataSettingsExpanded?: boolean;
  onToggleDataSettings?: () => void;
  settingsButtonRef?: Ref<HTMLButtonElement>;
}) {
  const nameRef = useRef<HTMLSpanElement | null>(null);
  const showTypePicker =
    row.kind === 'reference' &&
    annotationTrackRegistry &&
    annotationTrackRegistry.length > 0 &&
    visibleTypes &&
    onToggleVisibleType &&
    onSetVisibleTypes;
  const wrappedDataName =
    row.kind === 'data' &&
    row.band !== undefined &&
    row.band.heightPx >= TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX;
  const visibilityControl = row.togglable ? (
    <input
      type="checkbox"
      data-testid={`track-gutter-visible-${row.id}`}
      checked={row.visible}
      onChange={() => onToggleVisible(row)}
      aria-label={`Show ${row.label}`}
      className="shrink-0 accent-blue-500 outline-none focus-visible:ring-1 focus-visible:ring-fg-subtle/30"
    />
  ) : null;
  const rowTone = dataRowTone?.(row) ?? 'default';
  const exceptionalStatusLabel = row.kind === 'data' ? exceptionalTrackStatusLabel(rowTone) : null;
  const statusDot = exceptionalStatusLabel ? (
    <span
      role="img"
      aria-label={`${row.label} status: ${exceptionalStatusLabel}`}
      title={exceptionalStatusLabel}
      data-testid={`track-gutter-status-${row.id}`}
      className={`h-2 w-2 shrink-0 rounded-full ${dotColorClass(row, rowTone)} ${row.visible ? '' : 'opacity-30'}`}
    />
  ) : null;
  const nameControl = (
    <Tooltip
      content={row.label}
      side="top"
      align="start"
      delay={0}
      shouldShow={() => {
        const name = nameRef.current;
        return Boolean(
          name &&
          (name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1)
        );
      }}
      className={`min-w-0 flex-1 ${wrappedDataName ? 'h-full w-full overflow-hidden' : ''}`}
    >
      <span
        ref={nameRef}
        tabIndex={0}
        data-testid={`track-gutter-name-${row.id}`}
        data-name-layout={wrappedDataName ? 'wrapped' : 'single-line'}
        className={`block min-w-0 flex-1 text-[12px] font-medium leading-[1.25] ${
          wrappedDataName ? 'h-full overflow-hidden whitespace-normal break-words' : 'truncate'
        } ${row.visible ? 'text-fg' : 'text-fg-muted opacity-60'}`}
      >
        {row.label}
      </span>
    </Tooltip>
  );
  const settingsControl =
    (row.kind === 'data' || row.kind === 'group') && renderDataControls && onToggleDataSettings ? (
      <button
        type="button"
        ref={settingsButtonRef}
        data-testid={`track-gutter-settings-${row.id}`}
        onClick={onToggleDataSettings}
        aria-label={`${dataSettingsExpanded ? 'Close' : 'Open'} settings for ${row.label}`}
        aria-expanded={dataSettingsExpanded === true}
        aria-controls={dataSettingsExpanded ? `track-gutter-settings-panel-${row.id}` : undefined}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle outline-none transition-colors wp-interactive ${
          dataSettingsExpanded ? 'bg-bg-muted text-fg' : ''
        }`}
      >
        <SettingsIcon size={14} />
      </button>
    ) : null;
  const removeControl = row.removable ? (
    <button
      type="button"
      data-testid={`track-gutter-remove-${row.id}`}
      onClick={() => onRemove(row)}
      aria-label={`Remove ${row.label}`}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle opacity-60 outline-none transition-colors hover:bg-danger/10 hover:text-danger hover:opacity-100 focus:opacity-100 focus-visible:bg-danger/10 focus-visible:text-danger group-hover:opacity-100"
    >
      <TrashIcon size={13} />
    </button>
  ) : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-1">
      {wrappedDataName ? (
        <>
          <div
            data-testid={`track-gutter-actions-${row.id}`}
            data-control-placement="top-toolbar"
            className="flex h-6 min-w-0 flex-none items-center gap-1.5"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {dragHandle}
              {visibilityControl}
              {statusDot}
            </span>
            <span className="min-w-0 flex-1" />
            <span
              data-testid={`track-gutter-action-cluster-${row.id}`}
              className="flex h-6 shrink-0 items-center overflow-hidden rounded-md bg-bg/70 shadow-sm ring-1 ring-inset ring-border/60"
            >
              {settingsControl}
              {removeControl}
            </span>
          </div>
          <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">{nameControl}</div>
        </>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5">
          {dragHandle}
          <span className="flex shrink-0">{visibilityControl}</span>
          <span className="flex shrink-0">{statusDot}</span>
          {nameControl}
          {settingsControl}
          {removeControl}
        </div>
      )}
      {showTypePicker ? (
        <AnnotationTypePicker
          registry={annotationTrackRegistry}
          visibleTypes={visibleTypes}
          onToggleVisibleType={onToggleVisibleType}
          onSetVisibleTypes={onSetVisibleTypes}
        />
      ) : null}
      {row.kind === 'reference' && temporaryAnnotationReveal ? (
        <div
          data-testid="track-gutter-temporary-annotation-reveal"
          className="flex min-w-0 items-center gap-1 rounded bg-accent/10 px-1.5 py-1 text-[10px] leading-tight text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            Selected annotation from hidden {temporaryAnnotationReveal.trackId} track
          </span>
          <button
            type="button"
            data-testid="track-gutter-show-temporary-annotation-track"
            onClick={temporaryAnnotationReveal.onShowTrack}
            aria-label={`Show ${temporaryAnnotationReveal.trackId} track`}
            className="shrink-0 rounded px-1 py-0.5 font-semibold text-accent hover:bg-accent/15"
          >
            Show track
          </button>
        </div>
      ) : null}
      {row.kind === 'reference' && visibleAnnotationSearchFocus ? (
        <div
          data-testid="track-gutter-visible-annotation-search-focus"
          className="flex min-w-0 items-center gap-1 rounded bg-accent/10 px-1.5 py-1 text-[10px] leading-tight text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {visibleAnnotationSearchFocus.trackId} selected in temporary search lane
          </span>
          {visibleAnnotationSearchFocus.onKeepAdditionalLane ? (
            <button
              type="button"
              data-testid="track-gutter-keep-additional-search-lane"
              onClick={visibleAnnotationSearchFocus.onKeepAdditionalLane}
              aria-label={`Raise ${visibleAnnotationSearchFocus.trackId} lane limit by one`}
              className="shrink-0 rounded px-1 py-0.5 font-semibold text-accent hover:bg-accent/15"
            >
              Raise +1 lane
            </button>
          ) : null}
        </div>
      ) : null}
      {row.kind === 'reference' ? referenceControls : null}
      {row.kind === 'data' && renderDataControls ? renderDataControls(row, false) : null}
    </div>
  );
}

function TrackSettingsPopover({
  row,
  anchor,
  gutter,
  onDismiss,
  children,
}: {
  row: GutterRow;
  anchor: HTMLButtonElement;
  gutter: HTMLDivElement;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const presentationEvents = usePresentationListener();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<TrackSettingsPopoverPlacement | null>(null);
  const updatePosition = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || !anchor.isConnected || !gutter.isConnected) return;
    const anchorRect = anchor.getBoundingClientRect();
    const gutterRect = gutter.getBoundingClientRect();
    let boundaryTop = gutterRect.top;
    for (const pinned of gutter.querySelectorAll<HTMLElement>(
      '[data-track-row-kind="cytoband"][data-renderer-band="true"]'
    )) {
      boundaryTop = Math.max(boundaryTop, pinned.getBoundingClientRect().bottom);
    }
    const next = resolveTrackSettingsPopoverPlacement({
      anchorTop: anchorRect.top,
      anchorBottom: anchorRect.bottom,
      boundaryTop: Math.min(boundaryTop, gutterRect.bottom),
      boundaryBottom: gutterRect.bottom,
      desiredHeight: panel.scrollHeight,
    });
    const relative = { ...next, top: next.top - gutterRect.top };
    setPlacement((current) =>
      current &&
      current.direction === relative.direction &&
      current.top === relative.top &&
      current.maxHeight === relative.maxHeight
        ? current
        : relative
    );
  }, [anchor, gutter]);

  useLayoutEffect(() => {
    updatePosition();
  });

  useEffect(() => {
    const panel = panelRef.current;
    const openChildMenus = () =>
      Array.from(panel?.querySelectorAll('[aria-expanded="true"][aria-controls]') ?? [])
        .map((trigger) => document.getElementById(trigger.getAttribute('aria-controls')!))
        .filter((menu) => menu !== null);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panel?.contains(target) || anchor.contains(target)) return;
      if (openChildMenus().some((menu) => menu.contains(target))) return;
      onDismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || openChildMenus().length > 0) return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      safeFocus(anchor);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    presentationEvents.add(document, 'keydown', handleKeyDown, true);
    window.addEventListener('resize', updatePosition);

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => updatePosition());
    if (panel) resizeObserver?.observe(panel);
    resizeObserver?.observe(anchor);
    resizeObserver?.observe(gutter);

    const scrollLayer = gutter.querySelector<HTMLElement>(
      '[data-testid="track-gutter-scroll-layer"]'
    );
    const scrollObserver =
      scrollLayer && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => updatePosition())
        : null;
    if (scrollLayer) {
      scrollObserver?.observe(scrollLayer, { attributes: true, attributeFilter: ['style'] });
    }

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      presentationEvents.remove(document, 'keydown', handleKeyDown, true);
      window.removeEventListener('resize', updatePosition);
      resizeObserver?.disconnect();
      scrollObserver?.disconnect();
    };
  }, [anchor, gutter, onDismiss, updatePosition, presentationEvents]);

  return (
    <div
      ref={panelRef}
      id={`track-gutter-settings-panel-${row.id}`}
      data-testid={`track-gutter-settings-panel-${row.id}`}
      data-track-gutter-settings-popover
      data-placement={placement?.direction}
      role="region"
      aria-label={`Settings for ${row.label}`}
      style={{
        left: 8,
        width: 'calc(100% - 16px)',
        minWidth: TRACK_SETTINGS_MIN_WIDTH_PX,
        top: placement?.top ?? 4,
        maxHeight: placement?.maxHeight,
        visibility: placement ? 'visible' : 'hidden',
      }}
      className="absolute z-50 overflow-y-auto overscroll-contain rounded-lg border border-border/80 bg-bg/95 p-2 shadow-xl backdrop-blur-sm"
    >
      {children}
    </div>
  );
}

export function TrackGutterHeader({
  onToggleCollapsed,
  collapsed,
}: {
  onToggleCollapsed?: () => void;
  collapsed?: boolean;
}) {
  if (collapsed) {
    return onToggleCollapsed ? (
      <div className="flex h-full w-full items-center justify-center">
        <button
          type="button"
          data-testid="track-gutter-expand"
          onClick={onToggleCollapsed}
          aria-label="Expand track gutter"
          title="Expand tracks"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted wp-interactive "
        >
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    ) : null;
  }

  return (
    <div data-testid="track-gutter-chrome" className="flex h-full items-center gap-0.5 px-1">
      {onToggleCollapsed ? (
        <button
          type="button"
          data-testid="track-gutter-collapse"
          onClick={onToggleCollapsed}
          aria-label="Collapse track gutter"
          title="Collapse tracks"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted wp-interactive "
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <span className={`min-w-0 flex-1 truncate ${GUTTER_STYLE.headerLabel}`}>Tracks</span>
    </div>
  );
}

const GUTTER_EDGE_PX = 3;

function RowHoverBar({ row }: { row: GutterRow }) {
  return (
    <span
      aria-hidden
      data-testid={`track-gutter-hover-bar-${row.id}`}
      style={row.color ? { backgroundColor: row.color } : undefined}
      className={`pointer-events-none absolute bottom-0 left-0 top-0 z-10 w-[3px] opacity-0 transition-opacity duration-100 group-hover:opacity-100 ${
        row.color ? '' : row.kind === 'data' ? 'bg-accent' : dotColorClass(row)
      }`}
    />
  );
}

function GutterEdgeLine() {
  return (
    <span
      aria-hidden
      data-testid="track-gutter-edge-line"
      className={`pointer-events-none absolute bottom-0 right-0 top-0 ${GUTTER_STYLE.edgeLine}`}
    />
  );
}

function AddTrackRow({
  onAddTrack,
  onOpenMutationNavigator,
  style,
}: {
  onAddTrack: () => void;
  onOpenMutationNavigator?: () => void;
  style?: CSSProperties;
}) {
  return (
    <div
      data-testid="track-gutter-add-row"
      style={{ height: GUTTER_ADD_ROW_HEIGHT_PX, ...style }}
      className={`mr-[3px] flex items-center justify-center px-2 ${GUTTER_STYLE.addRowRule} ${GUTTER_BG_CLASS}`}
    >
      <button
        type="button"
        data-testid="track-gutter-add"
        onClick={onAddTrack}
        aria-label="Add track"
        title="Add track"
        className="flex h-7 min-w-0 items-center gap-1.5 rounded px-2.5 text-sm font-medium text-fg-muted wp-interactive "
      >
        <span aria-hidden className="text-lg leading-none">
          +
        </span>
        <span>Add track</span>
      </button>
      {onOpenMutationNavigator ? (
        <button
          type="button"
          data-testid="open-mutation-navigator"
          onClick={onOpenMutationNavigator}
          aria-label="Open mutations"
          title="Open mutations"
          className="ml-auto flex h-6 min-w-0 items-center rounded px-1.5 text-[11px] font-medium text-fg-muted wp-interactive "
        >
          Mutations
        </button>
      ) : null}
    </div>
  );
}

export function TrackGutter({
  rows,
  onToggleVisible,
  onRemove,
  onMoveDataRow,
  onPreviewMoveDataRow,
  dataRowOrder,
  onPreviewDataRowOrder,
  onPreviewDataRowDrag,
  onCommitDataRowOrder,
  onCancelDataRowOrder,
  onPreviewDataRowHeight,
  onCommitDataRowHeight,
  onCancelDataRowHeight,
  onAddTrack,
  onOpenMutationNavigator,
  width = GUTTER_DEFAULT_WIDTH,
  onResize,
  collapsed = false,
  annotationTrackRegistry,
  visibleTypes,
  onToggleVisibleType,
  onSetVisibleTypes,
  temporaryAnnotationReveal,
  visibleAnnotationSearchFocus,
  referenceControls,
  renderDataControls,
  dataRowTone,
  onVerticalScroll,
  scrollLayerRef,
}: TrackGutterProps) {
  const presentationEvents = usePresentationListener();

  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [previewTrackOrder, setPreviewTrackOrder] = useState<ReadonlyArray<string> | null>(null);
  const [expandedDataRowId, setExpandedDataRowId] = useState<string | null>(null);
  const previewTrackOrderRef = useRef<ReadonlyArray<string> | null>(null);
  const cancelReorderRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelReorderRef.current?.(), []);
  const aligned = rows.some((r) => r.band);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const settingsButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const gutter = gutterRef.current;
    if (!gutter || !onVerticalScroll) return;
    const handleWheel = (event: WheelEvent) => {
      const deltaY = wheelDeltaPixels(event, gutter.clientHeight);
      const target = event.target instanceof Element ? event.target : null;
      const settingsPanel = target?.closest<HTMLElement>('[data-track-gutter-settings-popover]');
      if (settingsPanel && settingsPanel.scrollHeight > settingsPanel.clientHeight) {
        const canScrollPanel =
          deltaY < 0
            ? settingsPanel.scrollTop > 0
            : settingsPanel.scrollTop + settingsPanel.clientHeight < settingsPanel.scrollHeight;
        if (canScrollPanel) {
          event.stopPropagation();
          return;
        }
      }
      onVerticalScroll(deltaY);
      event.preventDefault();
      event.stopPropagation();
    };
    gutter.addEventListener('wheel', handleWheel, { passive: false });
    return () => gutter.removeEventListener('wheel', handleWheel);
  }, [onVerticalScroll]);
  useEffect(() => {
    if (expandedDataRowId && !rows.some((row) => row.id === expandedDataRowId)) {
      setExpandedDataRowId(null);
    }
  }, [expandedDataRowId, rows]);
  const dismissDataSettings = useCallback(() => setExpandedDataRowId(null), []);

  const maxBottom = rows.reduce(
    (m, r) => (r.band ? Math.max(m, r.band.topPx + r.band.heightPx) : m),
    0
  );
  let unbanded = 0;
  const basePositioned = rows.map((row) => ({
    row,
    top: row.band ? row.band.topPx : maxBottom + unbanded++ * GUTTER_UNBANDED_ROW_HEIGHT_PX,
    height: row.band ? row.band.heightPx : GUTTER_UNBANDED_ROW_HEIGHT_PX,
  }));
  const movableRowsById = new Map(
    rows
      .filter(
        (row): row is GutterRow & { trackId: string } =>
          (row.kind === 'data' || row.kind === 'group') &&
          row.reorderable === true &&
          typeof row.trackId === 'string'
      )
      .map((row) => [row.trackId, row] as const)
  );
  const requestedDataRowOrder =
    dataRowOrder ?? rows.flatMap((row) => (row.trackId ? [row.trackId] : []));
  const stableDataRowOrder = [
    ...requestedDataRowOrder.filter((trackId) => movableRowsById.has(trackId)),
    ...Array.from(movableRowsById.keys()).filter(
      (trackId) => !requestedDataRowOrder.includes(trackId)
    ),
  ];
  const movableRows = stableDataRowOrder.flatMap((trackId) => {
    const row = movableRowsById.get(trackId);
    return row ? [row] : [];
  });
  const previewBandedOrder = (previewTrackOrder ?? stableDataRowOrder).filter(
    (trackId) => movableRowsById.get(trackId)?.band
  );
  const bandedEntriesByTrackId = new Map(
    basePositioned.flatMap((entry) =>
      entry.row.trackId && entry.row.reorderable && entry.row.band
        ? [[entry.row.trackId, entry] as const]
        : []
    )
  );
  const previewPositions = new Map<string, number>();
  if (previewTrackOrder && previewBandedOrder.length > 0) {
    const previewEntries = previewBandedOrder.flatMap((trackId) => {
      const entry = bandedEntriesByTrackId.get(trackId);
      return entry ? [entry] : [];
    });
    let nextTop = Math.min(...previewEntries.map((entry) => entry.top));
    for (const trackId of previewBandedOrder) {
      const entry = bandedEntriesByTrackId.get(trackId);
      if (!entry) continue;
      previewPositions.set(trackId, nextTop);
      nextTop += entry.height;
    }
  }
  const positioned = basePositioned.map((entry) => ({
    ...entry,
    top:
      !onPreviewMoveDataRow && !onPreviewDataRowDrag && entry.row.trackId
        ? (previewPositions.get(entry.row.trackId) ?? entry.top)
        : entry.top,
  }));
  const dragHandleFor = (row: GutterRow): ReactNode => {
    if (
      (!onMoveDataRow && !onCommitDataRowOrder) ||
      (row.kind !== 'data' && row.kind !== 'group') ||
      !row.reorderable ||
      !row.trackId
    ) {
      return null;
    }
    const trackId = row.trackId;
    const candidates =
      row.kind === 'group' ? movableRows.filter((peer) => !peer.groupId) : movableRows;
    const index = candidates.findIndex((candidate) => candidate.trackId === trackId);
    const previous = index > 0 ? candidates[index - 1] : null;
    const next = index >= 0 && index < candidates.length - 1 ? candidates[index + 1] : null;
    return (
      <TrackDragHandle
        row={row}
        onMoveUp={
          previous && onMoveDataRow
            ? () => onMoveDataRow(trackId, previous.trackId, 'before')
            : undefined
        }
        onMoveDown={
          next && onMoveDataRow ? () => onMoveDataRow(trackId, next.trackId, 'after') : undefined
        }
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const gutter = gutterRef.current;
          const rowElement = event.currentTarget.closest<HTMLElement>('[data-track-gutter-row]');
          if (!gutter || !rowElement) return;
          event.preventDefault();
          event.stopPropagation();
          cancelReorderRef.current?.();
          const pointerId = event.pointerId;
          const ownsCursor = !document.body.classList.contains('dragging-track-row');
          document.body.classList.add('dragging-track-row');
          const gutterBounds = gutter.getBoundingClientRect();
          const bounds = rowElement.getBoundingClientRect();
          const grabOffset = event.clientY - bounds.top;
          const initialOrder = [...stableDataRowOrder];
          const elements = Array.from(
            gutter.querySelectorAll<HTMLElement>('[data-track-gutter-row]')
          );
          const peers = candidates.flatMap((candidate) => {
            if (candidate.trackId === trackId) return [];
            const element = elements.find(
              (entry) => entry.dataset.testid === `track-gutter-row-${candidate.id}`
            );
            if (!element || !candidate.visible) return [];
            const peerBounds = element.getBoundingClientRect();
            return [
              {
                trackId: candidate.trackId,
                top: peerBounds.top,
                bottom: peerBounds.bottom,
                center: peerBounds.top + peerBounds.height / 2,
              },
            ];
          });
          let placement: { id: string; side: TrackMovePlacement } | null = null;
          let finished = false;
          setDraggingTrackId(trackId);
          previewTrackOrderRef.current = initialOrder;
          setPreviewTrackOrder(initialOrder);
          onPreviewDataRowDrag?.({ trackId, topPx: bounds.top - gutterBounds.top });
          const removeListeners = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('pointercancel', cancel);
            presentationEvents.remove(document, 'keydown', keyDown, true);
            window.removeEventListener('blur', cancel);
            gutter.removeEventListener('lostpointercapture', lostCapture);
            if (gutter.hasPointerCapture?.(pointerId)) {
              gutter.releasePointerCapture(pointerId);
            }
            if (ownsCursor) document.body.classList.remove('dragging-track-row');
            cancelReorderRef.current = null;
          };
          const finish = (commit: boolean) => {
            if (finished) return;
            finished = true;
            removeListeners();
            if (commit) {
              const order = previewTrackOrderRef.current ?? initialOrder;
              if (onPreviewMoveDataRow) {
                if (placement) onMoveDataRow?.(trackId, placement.id, placement.side);
                else onCancelDataRowOrder?.();
              } else if (onCommitDataRowOrder) onCommitDataRowOrder(order);
              else if (!order.every((id, position) => id === initialOrder[position])) {
                const position = order.indexOf(trackId);
                const target = position > 0 ? order[position - 1] : order[position + 1];
                if (target) onMoveDataRow?.(trackId, target, position > 0 ? 'after' : 'before');
              }
            } else onCancelDataRowOrder?.();
            onPreviewDataRowDrag?.(null);
            previewTrackOrderRef.current = null;
            setDraggingTrackId(null);
            setPreviewTrackOrder(null);
          };
          const preview = (clientY: number) => {
            const hit = onPreviewMoveDataRow
              ? peers.find((peer) => clientY >= peer.top && clientY < peer.bottom)
              : undefined;
            const target = hit ?? peers.find((peer) => clientY < peer.center) ?? peers.at(-1);
            if (onPreviewMoveDataRow) {
              if (!target || (clientY >= bounds.top && clientY < bounds.bottom)) {
                if (placement) onCancelDataRowOrder?.();
                placement = null;
                return;
              }
              const side = clientY < target.center ? 'before' : 'after';
              if (placement?.id !== target.trackId || placement.side !== side) {
                placement = { id: target.trackId, side };
                onPreviewMoveDataRow(trackId, target.trackId, side);
              }
              return;
            }
            const order = target
              ? moveTrackOrder(
                  initialOrder,
                  trackId,
                  target.trackId,
                  clientY < target.center ? 'before' : 'after'
                )
              : initialOrder;
            if (!order.every((id, position) => id === previewTrackOrderRef.current?.[position])) {
              previewTrackOrderRef.current = order;
              setPreviewTrackOrder(order);
              onPreviewDataRowOrder?.(order);
            }
            onPreviewDataRowDrag?.({
              trackId,
              topPx: clientY - grabOffset - gutterBounds.top,
            });
          };
          function move(moveEvent: PointerEvent) {
            if (moveEvent.pointerId !== pointerId) return;
            moveEvent.preventDefault();
            preview(moveEvent.clientY);
          }
          function up(upEvent: PointerEvent) {
            if (upEvent.pointerId !== pointerId) return;
            const parentBounds = gutter!.parentElement?.getBoundingClientRect();
            const dropBounds =
              parentBounds && parentBounds.width > 0 && parentBounds.height > 0
                ? parentBounds
                : gutterBounds;
            const inside =
              upEvent.clientX >= dropBounds.left &&
              upEvent.clientX <= dropBounds.right &&
              upEvent.clientY >= dropBounds.top &&
              upEvent.clientY <= dropBounds.bottom;
            if (inside) preview(upEvent.clientY);
            finish(inside);
          }
          function cancel(cancelEvent?: Event) {
            if (
              cancelEvent &&
              'pointerId' in cancelEvent &&
              (cancelEvent as PointerEvent).pointerId !== pointerId
            )
              return;
            finish(false);
          }
          function lostCapture(captureEvent: PointerEvent) {
            if (captureEvent.pointerId === pointerId) finish(false);
          }
          function keyDown(keyEvent: KeyboardEvent) {
            if (keyEvent.key !== 'Escape') return;
            keyEvent.preventDefault();
            keyEvent.stopPropagation();
            finish(false);
          }
          cancelReorderRef.current = cancel;
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
          document.addEventListener('pointercancel', cancel);
          presentationEvents.add(document, 'keydown', keyDown, true);
          window.addEventListener('blur', cancel);
          gutter.addEventListener('lostpointercapture', lostCapture);
          gutter.setPointerCapture?.(pointerId);
        }}
      />
    );
  };
  const heightResizeHandleFor = (row: GutterRow): ReactNode => {
    if (
      row.kind !== 'data' ||
      !onPreviewDataRowHeight ||
      !onCommitDataRowHeight ||
      row.requestedHeightPx === undefined
    ) {
      return null;
    }
    return (
      <TrackHeightResizeHandle
        row={row}
        heightPx={row.requestedHeightPx}
        onPreview={onPreviewDataRowHeight}
        onCommit={onCommitDataRowHeight}
        onCancel={onCancelDataRowHeight}
      />
    );
  };
  const positionedBottom = positioned.reduce(
    (bottom, entry) => Math.max(bottom, entry.top + entry.height),
    0
  );

  const rowBodyProps = {
    onToggleVisible,
    onRemove,
    annotationTrackRegistry,
    visibleTypes,
    onToggleVisibleType,
    onSetVisibleTypes,
    temporaryAnnotationReveal,
    visibleAnnotationSearchFocus,
    referenceControls,
    renderDataControls,
    dataRowTone,
  };
  const expandedDataRow =
    expandedDataRowId === null
      ? null
      : (rows.find(
          (row) => (row.kind === 'data' || row.kind === 'group') && row.id === expandedDataRowId
        ) ?? null);
  const expandedSettingsAnchor = expandedDataRow
    ? (settingsButtonRefs.current.get(expandedDataRow.id) ?? null)
    : null;

  const pinnedRows = positioned.filter(({ row }) => row.kind === 'cytoband' && row.band);
  const scrollingRows = positioned.filter((entry) => !pinnedRows.includes(entry));
  const pinned = pinnedRows.map(({ row, top, height }) => (
    <div
      key={row.id}
      data-track-gutter-row
      data-track-row-kind={row.kind}
      data-track-reorderable="false"
      data-testid={`track-gutter-row-${row.id}`}
      data-renderer-band="true"
      style={{
        position: 'absolute',
        top: Math.max(0, top - TRACK_STACK_ABOVE_ZONE_PAD_PX),
        height: height + 2 * TRACK_STACK_ABOVE_ZONE_PAD_PX,
        left: 0,
        right: GUTTER_EDGE_PX,
      }}
      className={`group z-20 ${GUTTER_BG_CLASS} ${
        collapsed
          ? 'flex items-center justify-center'
          : `flex items-center gap-1.5 px-2 ${GUTTER_STYLE.rowDivider}`
      }`}
      title={collapsed ? row.label : undefined}
    >
      {collapsed ? (
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${dotColorClass(row)} ${row.visible ? '' : 'opacity-30'}`}
        />
      ) : (
        <div className="min-w-0 flex-1">
          <RowBody row={row} {...rowBodyProps} />
        </div>
      )}
      {collapsed ? null : <RowHoverBar row={row} />}
    </div>
  ));

  if (collapsed) {
    return (
      <div
        ref={gutterRef}
        data-testid="track-gutter"
        style={{ width: GUTTER_COLLAPSED_WIDTH }}
        className={`relative h-full shrink-0 overflow-hidden ${GUTTER_BG_CLASS}`}
      >
        <GutterEdgeLine />
        {pinned}
        <div
          ref={scrollLayerRef}
          data-testid="track-gutter-scroll-layer"
          className="absolute inset-0 will-change-transform"
        >
          {scrollingRows.map(({ row, top, height }) => (
            <div
              key={row.id}
              data-track-gutter-row
              data-testid={`track-gutter-row-${row.id}`}
              data-renderer-band={row.band ? 'true' : 'false'}
              title={row.label}
              style={{ position: 'absolute', top, height, left: 0, right: 0 }}
              className="flex items-start justify-center pt-1"
            >
              <span
                aria-hidden
                className={`h-2 w-2 shrink-0 rounded-full ${dotColorClass(row, dataRowTone?.(row))} ${row.visible ? '' : 'opacity-30'}`}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  let content: React.ReactNode;
  if (rows.length === 0) {
    content = (
      <div className="flex h-full flex-col">
        <div
          data-testid="track-gutter-empty"
          className="m-2 rounded border border-dashed border-border px-2 py-3 text-center text-[11px] text-fg-muted"
        >
          No tracks yet.
        </div>
        {onAddTrack ? (
          <AddTrackRow onAddTrack={onAddTrack} onOpenMutationNavigator={onOpenMutationNavigator} />
        ) : null}
      </div>
    );
  } else {
    content = (
      <div
        data-testid="track-gutter-row-container"
        className={aligned ? 'relative h-full' : 'flex h-full min-h-0 flex-col overflow-y-auto'}
      >
        {scrollingRows.map(({ row, top, height }) => {
          const settingsExpanded = expandedDataRowId === row.id;
          const heightResizeHandle = heightResizeHandleFor(row);
          return (
            <div
              key={row.id}
              data-track-gutter-row
              data-track-row-kind={row.kind}
              data-track-group={row.groupId}
              data-track-reorderable={row.reorderable === true ? 'true' : 'false'}
              data-testid={`track-gutter-row-${row.id}`}
              data-renderer-band={row.band ? 'true' : 'false'}
              style={
                aligned
                  ? {
                      position: 'absolute',
                      top,
                      height,
                      left: 0,
                      right: 0,
                      paddingTop: 6,
                      paddingBottom: heightResizeHandle ? 7 : undefined,
                    }
                  : undefined
              }
              data-drag-state={draggingTrackId === row.trackId ? 'dragging' : undefined}
              className={cn(
                aligned
                  ? 'group flex items-start gap-1.5 overflow-hidden px-2'
                  : 'group relative flex items-center gap-1.5 overflow-visible px-2 py-1.5 wp-interactive',
                row.groupId && 'pl-5',
                row.kind === 'group' && 'bg-bg-muted font-semibold',
                draggingTrackId === row.trackId && 'z-30 bg-bg shadow-lg ring-1 ring-fg-subtle/30'
              )}
            >
              <RowBody
                row={row}
                dragHandle={dragHandleFor(row)}
                dataSettingsExpanded={settingsExpanded}
                settingsButtonRef={(target) => {
                  if (target) settingsButtonRefs.current.set(row.id, target);
                  else settingsButtonRefs.current.delete(row.id);
                }}
                onToggleDataSettings={
                  row.kind === 'data' || row.kind === 'group'
                    ? () => setExpandedDataRowId((current) => (current === row.id ? null : row.id))
                    : undefined
                }
                {...rowBodyProps}
              />
              {heightResizeHandle}
              <RowHoverBar row={row} />
            </div>
          );
        })}
        {onAddTrack ? (
          <AddTrackRow
            onAddTrack={onAddTrack}
            onOpenMutationNavigator={onOpenMutationNavigator}
            style={
              aligned
                ? {
                    position: 'absolute',
                    top: `min(${positionedBottom}px, calc(var(--track-scroll-top, 0px) + 100% - ${GUTTER_ADD_ROW_HEIGHT_PX}px))`,
                    left: 0,
                    right: 0,
                    zIndex: 10,
                  }
                : { position: 'sticky', bottom: 0, zIndex: 10, flexShrink: 0 }
            }
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={gutterRef}
      data-testid="track-gutter"
      style={{ width }}
      className={`relative h-full shrink-0 overflow-visible ${GUTTER_BG_CLASS}`}
    >
      <GutterEdgeLine />
      <div data-testid="track-gutter-scroll-viewport" className="absolute inset-0 overflow-hidden">
        <div
          ref={scrollLayerRef}
          data-testid="track-gutter-scroll-layer"
          className="absolute inset-0 will-change-transform"
        >
          {content}
        </div>
      </div>
      {pinned}
      {expandedDataRow && expandedSettingsAnchor && gutterRef.current && renderDataControls ? (
        <TrackSettingsPopover
          row={expandedDataRow}
          anchor={expandedSettingsAnchor}
          gutter={gutterRef.current}
          onDismiss={dismissDataSettings}
        >
          {renderDataControls(expandedDataRow, true)}
        </TrackSettingsPopover>
      ) : null}
      {onResize ? <ResizeHandle width={width} onResize={onResize} /> : null}
    </div>
  );
}
