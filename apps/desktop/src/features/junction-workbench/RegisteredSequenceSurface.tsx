import {
  useCallback,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { SequenceViewer1D, type RenderedPrimerSegment } from '@waypoint/workspace-editor';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  projectFieldHandlesForRow,
  sourceContributionBoundaryFieldForRow,
} from './JunctionFieldHandleProjection';
import { JunctionAssemblyHighlightOverlay } from './JunctionAssemblyHighlightOverlay';
import type {
  JunctionAssemblyHighlightCursor,
  JunctionAssemblyHighlightSegment,
} from './JunctionAssemblyHighlightOverlay';
import { JunctionHandleOverlay, type JunctionFieldHandle } from './JunctionHandleOverlay';
import {
  applyProductOverlapLivePreview,
  clearProductOverlapLivePreview,
} from './ProductOverlapPreviewContract';
import type { JunctionWorkbenchRow } from './model';
import {
  NON_CONTRIBUTING_COLOR,
  type WorkbenchPaintOwner,
  colorWash,
  primersForRow,
  productOwnerColor,
  productOwnerForPoint,
  provenanceForRow,
  rowToSequence,
} from './WorkbenchPaintingContract';

export interface JunctionRowMetric {
  primerBindingLength: number | null;
  homologyLength: number | null;
}

export interface RegisteredSequenceSurfaceProps {
  row: JunctionWorkbenchRow;
  metric?: JunctionRowMetric;
  scrollLeft: number;
  zoomPercent: number;
  pxPerBase: number;
  editableFields: AssemblyWorkbenchEditableField[];
  primerSegments: RenderedPrimerSegment[];
  sourceRegisterPreviewRowKind?: 'left-source' | 'right-source' | null;
  height: number;
  screenXForBioCol: (bioCol: number) => number;
  onPrimerLayoutChange: (rowId: string, segments: RenderedPrimerSegment[]) => void;
  onFieldPreview?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldPreviewImmediate?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCommit?: (field: AssemblyWorkbenchEditableField, nextValue: number) => void;
  onFieldCancel?: () => void;
  onHandlePanRequest?: (deltaPx: number) => void;
  productControls?: ReactNode;
  onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMoveCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancelCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onMouseDownCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseMoveCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseUpCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export function RegisteredSequenceSurface({
  row,
  metric,
  scrollLeft,
  zoomPercent,
  pxPerBase,
  editableFields,
  primerSegments,
  sourceRegisterPreviewRowKind,
  height,
  screenXForBioCol,
  onPrimerLayoutChange,
  onFieldPreview,
  onFieldCommit,
  onFieldCancel,
  onHandlePanRequest,
  productControls,
  onPointerDownCapture,
  onPointerMoveCapture,
  onPointerUpCapture,
  onPointerCancelCapture,
  onMouseDownCapture,
  onMouseMoveCapture,
  onMouseUpCapture,
}: RegisteredSequenceSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const sequence = rowToSequence(row);
  const provenance = provenanceForRow(row);
  const primers = primersForRow(row);
  const sourceRegisterField = sourceContributionBoundaryFieldForRow(row, editableFields);
  const sourceRow = row.kind === 'left-source' || row.kind === 'right-source';
  const assemblyHighlight = assemblyHighlightForRow({
    row,
    scrollLeft,
    screenXForBioCol,
  });
  const productOwnerBoundaryX =
    row.kind === 'product' ? Math.max(0, screenXForBioCol(0) - scrollLeft) : null;
  const activeProductOwner =
    sourceRegisterPreviewRowKind === 'left-source'
      ? 'left'
      : sourceRegisterPreviewRowKind === 'right-source'
        ? 'right'
        : null;
  const rowHandles = projectFieldHandlesForRow({
    row,
    fields: editableFields,
    primerSegments,
    height,
    screenXForBioCol,
  });
  const handleLivePreview = useCallback(
    (handle: JunctionFieldHandle, nextValue: number) => {
      if (
        applyProductOverlapLivePreview(surfaceRef.current, {
          row,
          handle,
          nextValue,
          scrollLeft,
          screenXForBioCol,
        })
      ) {
        return;
      }
      throw new Error(
        `RegisteredSequenceSurface has no live-sync preview implementation for ${handle.kind}:${handle.role}.`
      );
    },
    [row, screenXForBioCol, scrollLeft]
  );
  const handleLivePreviewEnd = useCallback(() => {
    clearProductOverlapLivePreview(surfaceRef.current);
  }, []);

  return (
    <div
      data-testid={`junction-row-${row.kind}`}
      data-row-id={row.id}
      data-linked-scroll-left={scrollLeft}
      data-row-bp={row.sequence.length}
      data-anchor-row-position={row.anchorRowPosition}
      data-strand-count={2}
      data-visible-column-count={row.visibleColumns?.length ?? row.sequence.length}
      data-contributing-column-count={
        row.contributingColumns?.length ?? row.visibleColumns?.length ?? row.sequence.length
      }
      data-muted-column-count={row.mutedColumns?.length ?? 0}
      data-spacer-column-count={row.spacerColumns?.length ?? 0}
      data-primer-count={row.primers?.length ?? 0}
      data-fragment-color={row.fragmentColor ?? ''}
      data-left-fragment-color={row.leftFragmentColor ?? ''}
      data-right-fragment-color={row.rightFragmentColor ?? ''}
      data-source-context-status={row.sourceContextStatus ?? ''}
      data-restriction-cut-site-count={row.cutSites?.length ?? 0}
      data-restriction-cut-sites={restrictionCutSiteSignature(row.cutSites)}
      className="grid min-w-0 max-w-full grid-cols-[15rem_minmax(0,1fr)] items-stretch gap-2"
    >
      <div
        data-testid={`junction-row-label-${row.kind}`}
        className="flex flex-col justify-center rounded border px-2"
        style={{
          borderColor: provenance.borderColor,
          background: provenance.labelBackground,
        }}
      >
        <div className="truncate text-xs font-medium text-fg">{row.label}</div>
        <div className="text-[10px] uppercase tracking-wide text-fg-muted">
          {row.kind === 'product'
            ? 'assembled'
            : row.kind === 'left-source'
              ? 'upstream'
              : 'downstream'}
        </div>
        {metric && (
          <div
            data-testid={`junction-row-metrics-${row.kind}`}
            className="mt-2 grid grid-cols-2 gap-1 border-t border-border/70 pt-1"
          >
            <MetricCell
              testId={`junction-row-metric-${row.kind}-pbs`}
              label="PBS"
              value={metric.primerBindingLength}
            />
            <MetricCell
              testId={`junction-row-metric-${row.kind}-homology`}
              label="Hom"
              value={metric.homologyLength}
            />
          </div>
        )}
        {row.kind === 'product' && productControls && (
          <div
            data-testid="junction-row-product-controls"
            className="mt-2 border-t border-border/70 pt-2"
          >
            {productControls}
          </div>
        )}
      </div>
      <div
        ref={surfaceRef}
        data-linked-viewer-frame="true"
        data-testid={`linked-camera-pan-surface-${row.kind}`}
        data-linked-pan-dragging="false"
        data-linked-source-register-dragging="false"
        data-linked-source-register-field-id={sourceRegisterField?.id ?? ''}
        data-linked-source-register-value={sourceRegisterField?.value ?? ''}
        data-linked-source-register-rendered-value={sourceRegisterField?.value ?? ''}
        data-linked-source-register-presentation-offset-px="0"
        data-linked-drag-action={sourceRegisterField ? 'source-boundary' : 'pan'}
        data-linked-selection-start={assemblyHighlight?.startRowPosition ?? ''}
        data-linked-selection-end={assemblyHighlight?.endRowPosition ?? ''}
        className={`group/junction-card relative min-w-0 select-none overflow-hidden rounded border border-border bg-bg ${
          sourceRegisterField
            ? 'cursor-grab active:cursor-grabbing'
            : sourceRow
              ? 'cursor-default'
              : 'cursor-grab active:cursor-grabbing'
        }`}
        style={{ touchAction: 'none' }}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMoveCapture={onPointerMoveCapture}
        onPointerUpCapture={onPointerUpCapture}
        onPointerCancelCapture={onPointerCancelCapture}
        onMouseDownCapture={onMouseDownCapture}
        onMouseMoveCapture={onMouseMoveCapture}
        onMouseUpCapture={onMouseUpCapture}
      >
        <div
          data-testid={`linked-camera-source-register-visual-layer-${row.kind}`}
          data-linked-source-register-visual-layer={sourceRow ? 'true' : 'false'}
          data-linked-source-register-visual-row-kind={row.kind}
          className="relative"
          style={{ height }}
        >
          <div
            data-testid={`linked-camera-source-register-content-layer-${row.kind}`}
            data-linked-source-register-content-layer="true"
            data-linked-source-register-content-row-kind={row.kind}
            data-linked-source-register-content-offset-px="0"
            className="relative"
            style={{ height, willChange: 'transform' }}
          >
            <SequenceViewer1D
              sequence={sequence}
              extraLanes={provenance.extraLanes}
              primers={primers}
              showPrimers={primers.length > 0}
              cutSites={row.cutSites ?? []}
              showCutSites={(row.cutSites?.length ?? 0) > 0}
              showReverseComplement={true}
              zoomPercent={zoomPercent}
              wheelScrollEnabled={false}
              showScrollbar={false}
              showRuler={false}
              pointerInteractionsEnabled={false}
              passiveCursor="inherit"
              mutedColumns={row.mutedColumns}
              mutedColumnColor={NON_CONTRIBUTING_COLOR}
              scrollLeft={scrollLeft}
              onPrimerLayoutChange={(segments) => onPrimerLayoutChange(row.id, segments)}
              style={{ height }}
            />
          </div>
          {row.kind === 'product' && productOwnerBoundaryX !== null && (
            <>
              <ProductOwnerPreviewLayer
                owner="left"
                renderContent={activeProductOwner === 'left'}
                boundaryX={productOwnerBoundaryX}
                height={height}
                sequence={sequence}
                extraLanes={provenance.extraLanes}
                primers={primers}
                zoomPercent={zoomPercent}
                mutedColumns={row.mutedColumns}
                scrollLeft={scrollLeft}
              />
              <ProductOwnerPreviewLayer
                owner="right"
                renderContent={activeProductOwner === 'right'}
                boundaryX={productOwnerBoundaryX}
                height={height}
                sequence={sequence}
                extraLanes={provenance.extraLanes}
                primers={primers}
                zoomPercent={zoomPercent}
                mutedColumns={row.mutedColumns}
                scrollLeft={scrollLeft}
              />
            </>
          )}
          {assemblyHighlight && (
            <JunctionAssemblyHighlightOverlay
              rowKind={row.kind}
              height={height}
              segments={assemblyHighlight.segments}
              cursors={assemblyHighlight.cursors}
            />
          )}
          {rowHandles.length > 0 && (
            <JunctionHandleOverlay
              handles={rowHandles}
              pxPerBase={pxPerBase}
              scrollLeft={scrollLeft}
              height={height}
              onPreview={(handle, nextValue) => onFieldPreview?.(handle.field, nextValue)}
              onCommit={(handle, nextValue) => onFieldCommit?.(handle.field, nextValue)}
              onCancel={onFieldCancel}
              onLivePreview={handleLivePreview}
              onLivePreviewEnd={handleLivePreviewEnd}
              onPanRequest={onHandlePanRequest}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function restrictionCutSiteSignature(cutSites: JunctionWorkbenchRow['cutSites']): string {
  return (cutSites ?? [])
    .map(
      (site) =>
        `${site.enzyme.name}:${site.cutPositionTop}:${site.cutPositionBottom}:${site.recognitionStart}-${site.recognitionEnd}`
    )
    .join('|');
}

function ProductOwnerPreviewLayer({
  owner,
  renderContent,
  boundaryX,
  height,
  sequence,
  extraLanes,
  primers,
  zoomPercent,
  mutedColumns,
  scrollLeft,
}: {
  owner: Extract<WorkbenchPaintOwner, 'left' | 'right'>;
  renderContent: boolean;
  boundaryX: number;
  height: number;
  sequence: ReturnType<typeof rowToSequence>;
  extraLanes: ReturnType<typeof provenanceForRow>['extraLanes'];
  primers: ReturnType<typeof primersForRow>;
  zoomPercent: number;
  mutedColumns?: number[];
  scrollLeft: number;
}) {
  const clipPath =
    owner === 'left'
      ? `inset(0px calc(100% - ${roundPx(boundaryX)}px) 0px 0px)`
      : `inset(0px 0px 0px ${roundPx(boundaryX)}px)`;
  return (
    <div
      data-testid={`linked-camera-source-register-product-owner-layer-${owner}`}
      data-linked-source-register-product-owner-layer={owner}
      data-linked-source-register-product-owner-active="false"
      data-linked-source-register-product-owner-offset-px="0"
      data-linked-source-register-product-owner-rendered={renderContent ? 'true' : 'false'}
      className="pointer-events-none absolute inset-0 overflow-hidden bg-bg opacity-0"
      style={{ clipPath, height }}
    >
      <div
        data-linked-source-register-product-owner-content="true"
        className="relative"
        style={{ height, willChange: 'transform' }}
      >
        {renderContent && (
          <SequenceViewer1D
            sequence={sequence}
            extraLanes={extraLanes}
            primers={primers}
            showPrimers={primers.length > 0}
            showReverseComplement={true}
            zoomPercent={zoomPercent}
            wheelScrollEnabled={false}
            showScrollbar={false}
            showRuler={false}
            pointerInteractionsEnabled={false}
            passiveCursor="inherit"
            mutedColumns={mutedColumns}
            mutedColumnColor={NON_CONTRIBUTING_COLOR}
            scrollLeft={scrollLeft}
            style={{ height }}
          />
        )}
      </div>
    </div>
  );
}

function roundPx(value: number): number {
  return Math.round(value * 100) / 100;
}

function MetricCell({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: number | null;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-fg-muted">{label}</div>
      <div data-testid={testId} className="font-mono text-[10px] leading-4 text-fg">
        {formatBp(value)}
      </div>
    </div>
  );
}

function formatBp(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} bp` : '--';
}

interface JunctionAssemblyHighlight {
  startRowPosition: number;
  endRowPosition: number;
  segments: JunctionAssemblyHighlightSegment[];
  cursors: JunctionAssemblyHighlightCursor[];
}

function assemblyHighlightForRow(input: {
  row: JunctionWorkbenchRow;
  scrollLeft: number;
  screenXForBioCol: (bioCol: number) => number;
}): JunctionAssemblyHighlight | null {
  const { row, scrollLeft, screenXForBioCol } = input;
  if (row.kind !== 'product') return null;
  const constraint = row.constraints?.find(
    (item) => item.kind === 'homology-width' || item.kind === 'fixed-overhang'
  );
  if (!constraint || constraint.endBioCol <= constraint.startBioCol) return null;

  const start = rowPositionForBioCol(row, constraint.startBioCol);
  const end = rowPositionForBioCol(row, constraint.endBioCol - 1);
  if (start === null || end === null) return null;

  const points = row.points
    .filter(
      (point) => point.bioCol >= constraint.startBioCol && point.bioCol < constraint.endBioCol
    )
    .sort((a, b) => a.bioCol - b.bioCol);
  if (points.length === 0) return null;

  const segments: JunctionAssemblyHighlightSegment[] = [];
  let currentOwner: JunctionAssemblyHighlightSegment['owner'] | null = null;
  let currentStartBioCol: number | null = null;
  let previousBioCol: number | null = null;

  const flush = () => {
    if (currentOwner === null || currentStartBioCol === null || previousBioCol === null) return;
    const color = productOwnerColor(row, currentOwner);
    const left = screenXForBioCol(currentStartBioCol) - scrollLeft;
    const right = screenXForBioCol(previousBioCol + 1) - scrollLeft;
    segments.push({
      id: `${currentOwner}:${currentStartBioCol}:${previousBioCol + 1}`,
      owner: currentOwner,
      left,
      width: Math.max(1, right - left),
      color,
      backgroundColor: colorWash(color, currentOwner === 'spacer' ? 0.2 : 0.28),
    });
  };

  for (const point of points) {
    const owner = productOwnerForPoint(row, point);
    const startsNewRun =
      currentOwner === null ||
      owner !== currentOwner ||
      previousBioCol === null ||
      point.bioCol !== previousBioCol + 1;
    if (startsNewRun) {
      flush();
      currentOwner = owner;
      currentStartBioCol = point.bioCol;
    }
    previousBioCol = point.bioCol;
  }
  flush();

  const leftOwner = productOwnerForPoint(row, points[0]);
  const rightOwner = productOwnerForPoint(row, points[points.length - 1]);
  const cursors: JunctionAssemblyHighlightCursor[] = [
    {
      id: 'start',
      left: screenXForBioCol(constraint.startBioCol) - scrollLeft,
      color: productOwnerColor(row, leftOwner),
      label: `${constraint.label} start`,
    },
    {
      id: 'end',
      left: screenXForBioCol(constraint.endBioCol) - scrollLeft,
      color: productOwnerColor(row, rightOwner),
      label: `${constraint.label} end`,
    },
  ];

  return {
    startRowPosition: Math.min(start, end),
    endRowPosition: Math.max(start, end),
    segments,
    cursors,
  };
}

function rowPositionForBioCol(row: JunctionWorkbenchRow, bioCol: number): number | null {
  const point = row.points.find((item) => item.bioCol === bioCol);
  return point?.rowPosition ?? null;
}
