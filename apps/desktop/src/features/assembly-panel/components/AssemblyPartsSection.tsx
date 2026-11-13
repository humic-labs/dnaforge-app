import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../../presentation/PresentationSurface';
('use client');

import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { complementBase, canonicalGoldenGateEnzymeName } from '@waypoint/sequence-utils';
import type { SequenceDesign, DesignRegion } from '../../design/public/types';
import { emptyDesignRegion, schemaSlotForRegion } from '../../design/public/assembly-slots';
import type { GoldenGateSchemaSlot } from '../../design/public/golden-gate-schema';
import {
  mocloCatalogCandidateToRegion,
  type MocloCatalogCandidate,
} from '../../design/public/moclo-part-catalog';
import { useDesignStore } from '../../design/public/store';
import { useRichSequenceClipboardStore } from '../../sequence-clipboard/public/store';
import type { RichSequenceFragment as CopiedRegion } from '../../sequence-clipboard/public/rich-sequence-clipboard';
import {
  isGoldenGateFixedRegionOrderCompatible,
  reorderGroupByInsertionSlot,
} from '../../design/public/assembly-rail-reorder';
import {
  designWithSelectedPendingSpacer,
  productLayoutSegmentId,
  selectProductLayoutItems,
  type ProductLayoutBoundaryItem,
  type ProductLayoutSegment,
  type ProductLayoutSpacerSegment,
} from '../../design/public/assembly-boundaries';
import { productHighlightsByRegionIndex } from '../../design/public/product-highlight';
import { getFragmentHexForRegion } from '../../design/public/colors';
import { OpenExternalIcon, TargetIcon } from '../../../components/icons/glyphs';
import { PortalMenu } from '../../../components/PortalMenu';
import { RD_FRAGMENT_MIME_TYPE, type RDFragmentDragData } from './VirtualDigestPanel';
import {
  bindDigestDrag,
  DIGEST_RESULT_MIME_TYPE,
  inheritDigestTransfer,
  placeDigestTransfer,
  refuseDigestTransfer,
  safelyObserveDigest,
} from '../digest-workflow';
import {
  PRODUCT_INTERSTITIAL_WIDTH_CLASS,
  ProductSegmentCard,
  ProductSegmentDragHandle,
} from './ProductSegmentCard';
import { useAssemblyColorScheme } from '../../design/public/color-scheme-store';
import { rdFragmentAssemblyBlockReason } from '../../design/public/rd-fragment-policy';
import {
  copiedRegionContext,
  copiedRegionKind,
  copiedRegionName,
} from '../../design/public/copied-region-presentation';
import {
  deriveAssemblyIssues,
  highestIssueSeverity,
  internalCutSiteBadgeLabel,
  type AssemblyIssue,
  type AssemblyIssueSeverity,
} from '../../assembly/public/issues/assembly-issues';
import { MocloSchemaSelector } from './MocloSchemaSelector';
import { MocloSlotPartPicker, useMocloPartCatalog } from './MocloSlotPartPicker';
import {
  openAssemblySourceRegion,
  isOpenableAssemblySourceId as isOpenableSourceId,
} from '../../assembly/public/open-assembly-source';
import { useToastStore } from '../../../stores/toast-store';
import type { AssemblySchemaPickerRequest } from '../schema-picker-request';

interface PendingRDFragment {
  data: RDFragmentDragData;
  insertIndex: number;
}

interface RDConfirmDialogProps {
  pending: PendingRDFragment;
  onConfirm: () => void;
  onCancel: () => void;
}

function RDConfirmDialog({ pending, onConfirm, onCancel }: RDConfirmDialogProps) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const { data } = pending;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [onConfirm, onCancel, presentationEvents]);

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      {}
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} aria-hidden="true" />

      {}
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          className="relative bg-bg border border-border rounded-lg shadow-xl w-[380px] overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rd-confirm-title"
        >
          {}
          <div className="px-4 py-3 border-b border-border bg-bg-muted/30">
            <h3 id="rd-confirm-title" className="font-semibold text-sm">
              Add RD Fragment to Assembly?
            </h3>
          </div>

          {}
          <div className="p-4 space-y-4">
            {}
            <div className="space-y-2">
              <div className="text-sm">
                <span className="text-fg-muted">Fragment:</span>{' '}
                <span className="font-medium">{data.sourceSequenceName}</span>
              </div>
              <div className="text-sm">
                <span className="text-fg-muted">From:</span>{' '}
                <span className="font-medium">{data.enzymeName} digest</span>
              </div>
              <div className="text-sm">
                <span className="text-fg-muted">Size:</span>{' '}
                <span className="font-mono">{data.sequence.length.toLocaleString()} bp</span>
              </div>
            </div>

            {}
            <div className="bg-bg-muted/50 rounded-md p-3 space-y-2">
              <div className="text-xs font-medium text-fg-muted uppercase tracking-wide">
                Fixed Overhangs
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-xs text-fg-muted mb-1">5{"'"} (upstream)</div>
                  <div className="font-mono text-sm font-semibold text-amber-800 dark:text-amber-500 bg-amber-500/10 px-2 py-1 rounded text-center">
                    {data.upstreamOverhang}
                  </div>
                </div>
                <div className="text-fg-subtle">→</div>
                <div className="flex-1">
                  <div className="text-xs text-fg-muted mb-1">3{"'"} (downstream)</div>
                  <div className="font-mono text-sm font-semibold text-amber-800 dark:text-amber-500 bg-amber-500/10 px-2 py-1 rounded text-center">
                    {data.downstreamOverhang}
                  </div>
                </div>
              </div>
            </div>

            {}
            <div className="text-xs text-fg-muted bg-blue-500/5 border border-blue-500/20 rounded-md p-2">
              <span className="text-blue-700 dark:text-blue-400 font-medium">Note:</span> This
              fragment has fixed overhangs from restriction digest. Adjacent parts must have
              matching overhangs for ligation.
            </div>
          </div>

          {}
          <div className="px-4 py-3 border-t border-border bg-bg-muted/20 flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-sm rounded-md hover:bg-bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
            >
              Add Fragment
            </button>
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}

interface AssemblyPartsSectionProps {
  design: SequenceDesign;
  projectRoot?: string | null;
  schemaPickerRequest?: AssemblySchemaPickerRequest | null;
}

interface ProductSegmentDragState {
  segmentId: string;
  sourceIndex: number;
  draggedSegmentIds: string[];
  insertSlot: number;
  offsetPx: number;
  stableCardTops: number[];
}

interface ProductSegmentDragMeta {
  segmentId: string;
  sourceIndex: number;
  startClientY: number;
  segmentIds: string[];
  draggedSegmentIds: string[];
  cardRects: Map<string, DragRect>;
}

interface DragRect {
  top: number;
  height: number;
}

interface ProductSegmentSelectionModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

type ProductSegmentDragVisual = {
  kind: 'none' | 'dragging' | 'up' | 'down';
  translateY: number;
};

const SPACER_SEGMENT_COLOR = '#94a3b8';
const EMPTY_SEGMENT_INSETS = { top: false, bottom: false };

function partIssueBadgeLabel(issues: readonly AssemblyIssue[]): string {
  const first = issues[0];
  if (!first) return 'Assembly issue';
  if (issues.length === 1) return first.title;
  return `${first.title} +${issues.length - 1} more`;
}

function PartCard({
  region,
  index,
  isPcr,
  hasConflict,
  conflictSeverity,
  regionIssues,
  color,
  isDragging,
  isSelected,
  copiedRegion,
  onDelete,
  onClear,
  onOpenSource,
  onLocateInProduct,
  onPasteCopiedRegion,
  onRegisterCard,
  onHoverChange,
  onSelect,
  onKeyDown,
  onBeginPointerDrag,
  schemaSlot,
  onOpenSchemaPicker,
  topInset,
  bottomInset,
}: {
  region: DesignRegion;
  index: number;
  isPcr: boolean;
  hasConflict: boolean;
  conflictSeverity: AssemblyIssueSeverity | null;
  regionIssues: AssemblyIssue[];
  color: string;
  isDragging: boolean;
  isSelected: boolean;
  copiedRegion: CopiedRegion | null;
  onDelete: () => void;
  onClear: () => void;
  onOpenSource: () => void;
  onLocateInProduct: (() => void) | null;
  onPasteCopiedRegion: () => void;
  onRegisterCard: (index: number, node: HTMLDivElement | null) => void;
  onHoverChange: (index: number, active: boolean) => void;
  onSelect: (event: React.MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onBeginPointerDrag: (index: number, event: React.PointerEvent<HTMLElement>) => void;
  schemaSlot: GoldenGateSchemaSlot | null;
  onOpenSchemaPicker: (() => void) | null;
  topInset: boolean;
  bottomInset: boolean;
}) {
  const length = region.sequence.length;
  const sourceLabel = region.isPlaceholder ? 'Empty part' : region.sourceSequenceName || 'Unnamed';
  const digestEnzyme = region.rdSourceEnzymeName || region.rdSourceEnzyme;
  const mapsToASequence = Boolean(region.sourceSequenceId && !region.isPlaceholder);

  const canOpenSource = mapsToASequence && isOpenableSourceId(region.sourceSequenceId);
  const conflictLabel =
    internalCutSiteBadgeLabel(regionIssues) ?? partIssueBadgeLabel(regionIssues);

  return (
    <ProductSegmentCard
      shellTestId="assembly-part-card-shell"
      cardTestId="assembly-part-card"
      color={color}
      isDragging={isDragging}
      isSelected={isSelected}
      tone={hasConflict ? (conflictSeverity === 'error' ? 'error' : 'warning') : 'default'}
      onRegister={(node) => onRegisterCard(index, node)}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      onPointerEnter={() => onHoverChange(index, true)}
      onPointerLeave={() => onHoverChange(index, false)}
      onFocus={() => onHoverChange(index, true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onHoverChange(index, false);
        }
      }}
      topInset={topInset}
      bottomInset={bottomInset}
      cardData={{
        'data-region-index': index,
        'data-region-id': region.id,
        'data-source-name': sourceLabel,
        'data-source-color': color,
        'data-validation-severity': conflictSeverity ?? undefined,
      }}
    >
      {!schemaSlot ? (
        <ProductSegmentDragHandle
          testId={`assembly-part-drag-handle-${region.id}`}
          label={`Reorder ${sourceLabel}`}
          isDragging={isDragging}
          onPointerDown={(event) => onBeginPointerDrag(index, event)}
        />
      ) : null}

      {}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {schemaSlot ? (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
                {schemaSlot.label}
              </span>
              <button
                type="button"
                data-testid={`moclo-drawer-part-picker-${index}`}
                aria-label={`Choose part for ${schemaSlot.label}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenSchemaPicker?.();
                }}
                className="flex min-w-0 max-w-[55%] items-center gap-1 truncate rounded px-1 py-0.5 text-sm font-medium text-fg hover:bg-bg-muted hover:text-accent"
              >
                <span className="truncate">{sourceLabel}</span>
                <span aria-hidden="true" className="shrink-0 text-[10px] text-fg-subtle">
                  ▾
                </span>
              </button>
            </>
          ) : canOpenSource ? (
            <button
              type="button"
              data-testid={`assembly-part-source-link-${region.id}`}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenSource();
              }}
              className="min-w-0 truncate rounded text-left text-sm font-medium text-fg underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title="Open source sequence and highlight this part"
            >
              Part {index + 1}: {sourceLabel}
            </button>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium text-fg">
              Part {index + 1}: {sourceLabel}
            </span>
          )}
          {}
          {onLocateInProduct && (
            <button
              type="button"
              data-testid={`assembly-part-locate-${region.id}`}
              aria-label={`Highlight part ${index + 1} in the assembly`}
              title={`Highlight part ${index + 1} in the assembly`}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onLocateInProduct();
              }}
              className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              <TargetIcon size={10} />
            </button>
          )}
          {canOpenSource && (
            <button
              type="button"
              data-testid={`assembly-part-open-source-${region.id}`}
              aria-label={`Open ${sourceLabel} and highlight part ${index + 1}`}
              title={`Open ${sourceLabel} and highlight part ${index + 1}`}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenSource();
              }}
              className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px] text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              <OpenExternalIcon size={10} />
            </button>
          )}
          {hasConflict && !region.isPlaceholder && (
            <span
              data-testid={`assembly-part-validation-${region.id}`}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                conflictSeverity === 'error'
                  ? 'bg-error/15 text-error'
                  : 'bg-amber-500/15 text-amber-500'
              }`}
              title={regionIssues.map((issue) => issue.title).join('\n')}
            >
              {conflictLabel}
            </span>
          )}
        </div>
        {!region.isPlaceholder && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
            {isPcr ? (
              <span>PCR amplified</span>
            ) : (
              <span>
                {digestEnzyme ? (
                  <>
                    <span className="font-medium text-orange-400">{digestEnzyme}</span> digest
                  </>
                ) : (
                  'Restriction digest'
                )}
              </span>
            )}
            <span className="text-fg-subtle">{length} bp</span>
          </div>
        )}
      </div>

      {region.isPlaceholder && copiedRegion && (
        <button
          type="button"
          data-testid={`assembly-placeholder-paste-${region.id}`}
          data-paste-source-name={copiedRegionName(copiedRegion)}
          data-paste-source-kind={copiedRegion.sourceType === 'rd' ? 'rd' : 'pcr'}
          data-paste-sequence-length={copiedRegion.sequence.length}
          aria-label={`Paste ${copiedRegionName(copiedRegion)} into this empty part`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onPasteCopiedRegion();
          }}
          className="group flex min-h-8 min-w-0 max-w-[60%] shrink-0 self-center overflow-hidden rounded-md border border-accent/40 bg-accent/10 text-xs transition-colors hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          title={`Paste ${copiedRegionName(copiedRegion)} into this empty part`}
        >
          <span
            data-testid={`assembly-placeholder-paste-context-${region.id}`}
            className="min-w-0 truncate px-2 py-1.5 font-medium text-fg"
            title={copiedRegionKind(copiedRegion)}
          >
            {copiedRegionContext(copiedRegion)}
          </span>
          <span
            data-testid={`assembly-placeholder-paste-label-${region.id}`}
            className="flex min-h-8 shrink-0 items-center bg-accent px-2.5 font-semibold text-accent-fg transition-colors group-hover:bg-accent/90"
          >
            Paste
          </span>
        </button>
      )}

      {}
      {mapsToASequence && (
        <button
          type="button"
          data-testid={`assembly-clear-part-${region.id}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="text-fg-subtle hover:text-amber-400 text-xs font-medium px-1.5 py-0.5 rounded hover:bg-amber-500/10 transition-colors"
          title="Clear part (keep the slot, drop its sequence so you can map another)"
        >
          Clear
        </button>
      )}

      {}
      {!schemaSlot ? (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-fg-subtle hover:text-red-400 p-1 -mr-1 rounded hover:bg-red-500/10"
          title="Remove part from assembly"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      ) : null}
    </ProductSegmentCard>
  );
}

function ProductBoundaryControl({
  boundary,
  isActive,
  isSpacerDropTarget,
  isUpperActive,
  isLowerActive,
  onRegisterBoundary,
  onHoverChange,
  onAddPart,
  onAddSpacer,
  onExternalDragOver,
  onExternalDrop,
  schemaOverhang,
}: {
  boundary: ProductLayoutBoundaryItem;
  isActive: boolean;
  isSpacerDropTarget: boolean;
  isUpperActive: boolean;
  isLowerActive: boolean;
  onRegisterBoundary: (boundaryId: string, node: HTMLDivElement | null) => void;
  onHoverChange: (active: boolean) => void;
  onAddPart: (boundaryId: string) => void;
  onAddSpacer: (junctionIndex: number) => void;
  onExternalDragOver: (event: React.DragEvent, insertIndex: number) => void;
  onExternalDrop: (event: React.DragEvent, insertIndex: number) => void;
  schemaOverhang?: string | null;
}) {
  const adjacentToSpacer = boundary.leftKind === 'spacer' || boundary.rightKind === 'spacer';

  const hasSchemaOverhang = schemaOverhang !== undefined;
  const paired = schemaOverhang
    ? [...schemaOverhang].map((base) => complementBase(base)).join('')
    : '—';

  return (
    <div
      data-testid="assembly-product-boundary"
      data-boundary-id={boundary.id}
      data-left-kind={boundary.leftKind}
      data-right-kind={boundary.rightKind}
      data-can-add-spacer={boundary.canAddSpacer ? 'true' : 'false'}
      data-terminal={boundary.isTerminal ? 'true' : 'false'}
      data-adjacent-to-spacer={adjacentToSpacer ? 'true' : 'false'}
      data-active={isActive ? 'true' : 'false'}
      data-spacer-drop-target={isSpacerDropTarget ? 'true' : 'false'}
      data-upper-active={isActive || isUpperActive ? 'true' : 'false'}
      data-lower-active={isActive || isLowerActive ? 'true' : 'false'}
      ref={(node) => onRegisterBoundary(boundary.id, node)}
      className={`group/boundary relative flex h-2 select-none items-center rounded-md ${
        hasSchemaOverhang ? 'cursor-default' : 'cursor-pointer'
      }`}
      onPointerEnter={hasSchemaOverhang ? undefined : () => onHoverChange(true)}
      onPointerLeave={hasSchemaOverhang ? undefined : () => onHoverChange(false)}
      onFocus={hasSchemaOverhang ? undefined : () => onHoverChange(true)}
      onBlur={(event) => {
        if (hasSchemaOverhang) return;
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onHoverChange(false);
        }
      }}
      onDragOver={
        hasSchemaOverhang
          ? undefined
          : (event) => onExternalDragOver(event, boundary.partInsertIndex)
      }
      onDrop={
        hasSchemaOverhang ? undefined : (event) => onExternalDrop(event, boundary.partInsertIndex)
      }
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute left-1 right-1 top-1/2 -translate-y-1/2 ${
          isActive || isSpacerDropTarget ? 'bg-accent/70' : 'bg-border'
        } ${isActive || isSpacerDropTarget ? 'h-0.5' : 'h-px'}`}
      />
      {hasSchemaOverhang ? (
        <div
          data-testid="moclo-drawer-schema-junction"
          className={`pointer-events-none absolute left-1/2 top-1/2 z-30 flex h-6 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-md border border-border bg-bg font-mono text-[11px] font-semibold uppercase leading-[10px] tracking-[0.08em] text-amber-700 shadow-sm dark:text-amber-300 ${PRODUCT_INTERSTITIAL_WIDTH_CLASS}`}
          aria-label={`Schema junction ${schemaOverhang ?? 'unconstrained'}`}
        >
          <span>{schemaOverhang ?? '—'}</span>
          <span className="opacity-80">{paired}</span>
        </div>
      ) : (
        <div
          className={`absolute left-1/2 top-1/2 z-30 grid min-w-0 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md bg-bg shadow-sm ${PRODUCT_INTERSTITIAL_WIDTH_CLASS} ${
            boundary.canAddSpacer ? 'grid-cols-2' : 'grid-cols-1'
          } ${
            isActive || isSpacerDropTarget
              ? 'border-[1.5px] border-accent shadow-accent/10'
              : 'border border-border group-hover/boundary:border-fg-subtle'
          }`}
        >
          <button
            type="button"
            onClick={() => onAddPart(boundary.id)}
            aria-label="Create new part"
            className="h-6 min-w-0 cursor-pointer truncate px-2 text-[10px] font-semibold text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            + Part
          </button>
          {boundary.canAddSpacer && boundary.spacerJunctionIndex !== null && (
            <button
              type="button"
              onClick={() => {
                if (boundary.spacerJunctionIndex !== null) {
                  onAddSpacer(boundary.spacerJunctionIndex);
                }
              }}
              aria-label="Add spacer sequence"
              className="h-6 min-w-0 cursor-pointer truncate border-l border-border px-2 text-[10px] font-semibold text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              + Spacer
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SpacerSegment({
  segment,
  dragVisual,
  topInset,
  bottomInset,
  onRegisterCard,
  onBeginPointerDrag,
  isSelected,
  onSelect,
  onKeyDown,
  onCommit,
  onClear,
}: {
  segment: ProductLayoutSpacerSegment;
  dragVisual: ProductSegmentDragVisual;
  topInset: boolean;
  bottomInset: boolean;
  onRegisterCard: (spacerId: string, node: HTMLDivElement | null) => void;
  onBeginPointerDrag: (spacerId: string, event: React.PointerEvent<HTMLElement>) => void;
  isSelected: boolean;
  onSelect: (event: React.MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onCommit: (junctionIndex: number, sequence: string) => void;
  onClear: (junctionIndex: number) => void;
}) {
  const [draftSequence, setDraftSequence] = useState(segment.spacer.sequence);
  const sequenceAtFocusRef = useRef(segment.spacer.sequence);

  useEffect(() => {
    setDraftSequence(segment.spacer.sequence);
  }, [segment.spacer.sequence, segment.spacer.id]);

  const commit = useCallback(() => {
    onCommit(segment.junctionIndex, draftSequence);
  }, [draftSequence, onCommit, segment.junctionIndex]);

  const isDragging = dragVisual.kind === 'dragging';

  return (
    <ProductSegmentCard
      shellTestId="assembly-spacer-card-shell"
      cardTestId={`assembly-spacer-segment-${segment.junctionIndex}`}
      color={SPACER_SEGMENT_COLOR}
      isDragging={isDragging}
      isSelected={isSelected}
      density="form"
      surface="neutral"
      onRegister={(node) => onRegisterCard(segment.spacer.id, node)}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      shellStyle={productDragItemStyle(dragVisual)}
      topInset={topInset}
      bottomInset={bottomInset}
      cardData={{
        'data-spacer-id': segment.spacer.id,
        'data-spacer-junction-index': segment.junctionIndex,
        'data-spacer-sequence-length': draftSequence.length,
      }}
    >
      <ProductSegmentDragHandle
        testId={`assembly-spacer-drag-handle-${segment.spacer.id}`}
        label="Move spacer sequence"
        isDragging={isDragging}
        onPointerDown={(event) => onBeginPointerDrag(segment.spacer.id, event)}
      />
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-medium text-fg">Spacer sequence</div>
        <div className="group relative w-56 shrink-0">
          <input
            data-testid={`assembly-spacer-sequence-${segment.junctionIndex}`}
            value={draftSequence}
            onFocus={() => {
              sequenceAtFocusRef.current = segment.spacer.sequence;
            }}
            onChange={(event) => {
              const nextSequence = normalizeDnaInput(event.target.value);
              setDraftSequence(nextSequence);
              if (nextSequence.length > 0) {
                onCommit(segment.junctionIndex, nextSequence);
              }
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                const reverted = sequenceAtFocusRef.current;
                setDraftSequence(reverted);
                onCommit(segment.junctionIndex, reverted);
              }
            }}
            className="h-7 w-full min-w-0 truncate rounded border border-border bg-bg px-2 pr-6 font-mono text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            spellCheck={false}
            placeholder="ATCG"
          />
          <button
            type="button"
            data-testid={`assembly-spacer-clear-${segment.junctionIndex}`}
            aria-label="Clear spacer"
            title="Clear spacer"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setDraftSequence('');
              onClear(segment.junctionIndex);
            }}
            className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-fg-muted opacity-0 hover:bg-bg-muted hover:text-fg focus:opacity-100 group-hover:opacity-100"
          >
            x
          </button>
        </div>
      </div>
    </ProductSegmentCard>
  );
}

export function AssemblyPartsSection({
  design,
  projectRoot = null,
  schemaPickerRequest,
}: AssemblyPartsSectionProps) {
  const assemblyColorScheme = useAssemblyColorScheme();
  const addRegion = useDesignStore((state) => state.addRegion);
  const insertRegionAt = useDesignStore((state) => state.insertRegionAt);
  const insertRegionAtProductBoundary = useDesignStore(
    (state) => state.insertRegionAtProductBoundary
  );
  const removeRegion = useDesignStore((state) => state.removeRegion);
  const clearRegion = useDesignStore((state) => state.clearRegion);
  const updateRegion = useDesignStore((state) => state.updateRegion);
  const reorderProductLayoutSegments = useDesignStore(
    (state) => state.reorderProductLayoutSegments
  );
  const setJunctionSpacer = useDesignStore((state) => state.setJunctionSpacer);
  const setSelectedJunction = useDesignStore((state) => state.setSelectedJunction);
  const navigateAndHighlight = useDesignStore((state) => state.navigateAndHighlight);
  const setAssemblyMethod = useDesignStore((state) => state.setAssemblyMethod);
  const lastCopied = useRichSequenceClipboardStore((state) => state.copiedRegion);
  const productSegmentRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const schemaPickerAnchorRefs = useRef<Map<number, { current: HTMLDivElement | null }>>(new Map());
  const schemaPickerAnchorCallbacks = useRef<Map<string, (node: HTMLDivElement | null) => void>>(
    new Map()
  );
  const boundaryRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const productSectionRef = useRef<HTMLDivElement | null>(null);
  const productDragMetaRef = useRef<ProductSegmentDragMeta | null>(null);
  const productDragRef = useRef<ProductSegmentDragState | null>(null);
  const bodyCursorBeforePartDragRef = useRef<string | null>(null);

  const [externalDragOverIndex, setExternalDragOverIndex] = useState<number | null>(null);
  const [productDrag, setProductDrag] = useState<ProductSegmentDragState | null>(null);
  const [selectedProductSegmentIds, setSelectedProductSegmentIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectionAnchorSegmentId, setSelectionAnchorSegmentId] = useState<string | null>(null);
  const [activeBoundaryId, setActiveBoundaryId] = useState<string | null>(null);
  const [hoveredPartIndex, setHoveredPartIndex] = useState<number | null>(null);
  const [openSchemaSlotIndex, setOpenSchemaSlotIndex] = useState<number | null>(null);
  const mocloCatalog = useMocloPartCatalog(projectRoot, design.goldenGateSchema?.enzyme);
  const handledSchemaPickerRequestRef = useRef<AssemblySchemaPickerRequest | null>(null);

  useEffect(() => {
    setOpenSchemaSlotIndex(null);
  }, [design.goldenGateSchema?.id, design.goldenGateSchema?.revision]);

  useEffect(() => {
    if (
      !schemaPickerRequest ||
      !design.goldenGateSchema ||
      handledSchemaPickerRequestRef.current === schemaPickerRequest
    )
      return;
    handledSchemaPickerRequestRef.current = schemaPickerRequest;
    const regionIndex = design.regions.findIndex(
      (region) => region.id === schemaPickerRequest.regionId && region.isPlaceholder
    );
    if (regionIndex >= 0) setOpenSchemaSlotIndex(regionIndex);
  }, [design.goldenGateSchema, design.regions, schemaPickerRequest]);

  const [pendingRDFragment, setPendingRDFragment] = useState<PendingRDFragment | null>(null);

  const regions = design.regions || [];
  const assemblyIssues = useMemo(() => deriveAssemblyIssues({ design }), [design]);
  const issuesByRegionId = useMemo(() => {
    const next = new Map<string, AssemblyIssue[]>();
    for (const issue of assemblyIssues) {
      if (issue.scope.type !== 'part' || issue.kind === 'assembly-empty-part') continue;
      const issues = next.get(issue.scope.regionId) ?? [];
      issues.push(issue);
      next.set(issue.scope.regionId, issues);
    }
    return next;
  }, [assemblyIssues]);
  const productLayoutDesign = useMemo(() => designWithSelectedPendingSpacer(design), [design]);
  const productLayoutItems = useMemo(
    () => selectProductLayoutItems(productLayoutDesign),
    [productLayoutDesign]
  );
  const productSegments = useMemo(
    () =>
      productLayoutItems.filter((item): item is ProductLayoutSegment => item.kind !== 'boundary'),
    [productLayoutItems]
  );
  const productSegmentIds = useMemo(
    () => productSegments.map((segment) => productLayoutSegmentId(segment)),
    [productSegments]
  );
  const previewProductSegmentIds = useMemo(() => {
    if (!productDrag) return productSegmentIds;
    const candidateIds = reorderGroupByInsertionSlot(
      productSegmentIds,
      productSegmentIndicesForIds(productSegmentIds, productDrag.draggedSegmentIds),
      productDrag.insertSlot
    );
    const segmentById = new Map(
      productSegments.map((segment) => [productLayoutSegmentId(segment), segment])
    );
    const candidateRegions = candidateIds.flatMap((segmentId) => {
      const segment = segmentById.get(segmentId);
      return segment?.kind === 'part' ? [segment.region] : [];
    });
    return candidateRegions.length === design.regions.length &&
      isGoldenGateFixedRegionOrderCompatible(design, candidateRegions)
      ? candidateIds
      : productSegmentIds;
  }, [design, productDrag, productSegmentIds, productSegments]);
  const segmentInsetsById = useMemo(
    () => productSegmentInsetsForPreviewOrder(previewProductSegmentIds),
    [previewProductSegmentIds]
  );
  const parseRDFragmentData = useCallback((e: React.DragEvent): RDFragmentDragData | null => {
    try {
      let data = e.dataTransfer.getData(RD_FRAGMENT_MIME_TYPE);
      if (!data) {
        data = e.dataTransfer.getData('text/plain');
      }
      if (!data) return null;

      const parsed = JSON.parse(data);
      if (parsed.type === 'rd-fragment') {
        safelyObserveDigest(() =>
          bindDigestDrag(parsed, e.dataTransfer.getData(DIGEST_RESULT_MIME_TYPE))
        );
        return parsed as RDFragmentDragData;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const isExternalDrag = useCallback((e: React.DragEvent): boolean => {
    return (
      e.dataTransfer.types.includes(RD_FRAGMENT_MIME_TYPE) ||
      (e.dataTransfer.types.includes('text/plain') &&
        !e.dataTransfer.types.includes('application/x-waypoint-part-reorder'))
    );
  }, []);

  const handleExternalDrop = useCallback(
    (e: React.DragEvent, insertIndex?: number) => {
      e.preventDefault();
      setExternalDragOverIndex(null);

      const rdData = parseRDFragmentData(e);
      if (!rdData) return;

      const blockReason = rdFragmentAssemblyBlockReason(design.assemblyMethod, rdData.ggType);
      if (blockReason) {
        refuseDigestTransfer(rdData);
        console.warn(blockReason);
        return;
      }

      setPendingRDFragment({
        data: rdData,
        insertIndex: insertIndex ?? -1,
      });
    },
    [design.assemblyMethod, parseRDFragmentData]
  );

  const handleConfirmRDFragment = useCallback(() => {
    if (!pendingRDFragment) return;

    const { data: rdData, insertIndex } = pendingRDFragment;

    const fragmentEnzyme = canonicalGoldenGateEnzymeName(rdData.enzymeName);
    const existingRdFragments = design.regions.filter(
      (region) => (region.sourceType === 'rd' || region.rdOverhangs) && region.rdSourceEnzyme
    );

    if (
      design.assemblyMethod === 'goldengate' &&
      fragmentEnzyme &&
      existingRdFragments.length === 0 &&
      design.goldenGateConfig?.enzyme !== fragmentEnzyme
    ) {
      setAssemblyMethod(design.id, 'goldengate', fragmentEnzyme);
    }

    const regionData = {
      sourceSequenceId: rdData.sourceSequenceId,
      sourceSequenceName: `${rdData.sourceSequenceName} (${rdData.enzymeName} fragment ${rdData.fragmentIndex + 1})`,
      sourceStart: rdData.sourceStart ?? 0,
      sourceEnd: rdData.sourceEnd ?? rdData.sequence.length,
      sequence: rdData.sequence,
      annotations: rdData.annotations ?? [],
      sourceSequence: rdData.sourceSequence,
      sourceAnnotations: rdData.sourceAnnotations,
      sourceIsCircular: rdData.sourceIsCircular,
      sourceType: 'rd' as const,
      ggType: rdData.ggType,
      rdOverhangs: {
        upstream: rdData.upstreamOverhang,
        downstream: rdData.downstreamOverhang,
      },
      rdSourceEnzyme: rdData.rdSourceEnzyme ?? fragmentEnzyme,
      rdSourceEnzymeName: rdData.rdSourceEnzymeName ?? rdData.enzymeName,
      rdEnds: rdData.rdEnds,
      rdSiblingOverhangs: rdData.siblingOverhangs,
    };

    placeDigestTransfer(
      rdData,
      () => useDesignStore.getState().designs[design.id]?.regions,
      () => {
        if (insertIndex >= 0) {
          insertRegionAt(design.id, insertIndex, regionData);
        } else {
          addRegion(design.id, regionData);
        }
      }
    );

    setPendingRDFragment(null);
  }, [
    pendingRDFragment,
    design.id,
    design.assemblyMethod,
    design.goldenGateConfig?.enzyme,
    design.regions,
    insertRegionAt,
    addRegion,
    setAssemblyMethod,
  ]);

  const handleCancelRDFragment = useCallback(() => {
    refuseDigestTransfer(pendingRDFragment?.data);
    setPendingRDFragment(null);
  }, [pendingRDFragment]);

  const handleExternalDragOver = useCallback(
    (e: React.DragEvent, index?: number) => {
      if (!isExternalDrag(e)) return;

      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setExternalDragOverIndex(index ?? -1);
    },
    [isExternalDrag]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setExternalDragOverIndex(null);
    }
  }, []);

  const registerProductSegment = useCallback((segmentId: string, node: HTMLDivElement | null) => {
    if (node) productSegmentRefs.current.set(segmentId, node);
    else productSegmentRefs.current.delete(segmentId);
  }, []);

  const schemaPickerAnchorRefFor = useCallback((index: number) => {
    let anchorRef = schemaPickerAnchorRefs.current.get(index);
    if (!anchorRef) {
      anchorRef = { current: null };
      schemaPickerAnchorRefs.current.set(index, anchorRef);
    }
    return anchorRef;
  }, []);

  const schemaPickerAnchorCallbackFor = useCallback(
    (segmentId: string, index: number) => {
      const callbackKey = `${segmentId}:${index}`;
      let callback = schemaPickerAnchorCallbacks.current.get(callbackKey);
      if (!callback) {
        const anchorRef = schemaPickerAnchorRefFor(index);
        callback = (node) => {
          registerProductSegment(segmentId, node);
          anchorRef.current = node;
        };
        schemaPickerAnchorCallbacks.current.set(callbackKey, callback);
      }
      return callback;
    },
    [registerProductSegment, schemaPickerAnchorRefFor]
  );

  const registerBoundary = useCallback((boundaryId: string, node: HTMLDivElement | null) => {
    if (node) boundaryRefs.current.set(boundaryId, node);
    else boundaryRefs.current.delete(boundaryId);
  }, []);

  const handlePartHoverChange = useCallback((index: number, active: boolean) => {
    setHoveredPartIndex((current) => {
      if (active) return index;
      return current === index ? null : current;
    });
  }, []);

  useEffect(() => {
    const currentIds = new Set(productSegmentIds);
    setSelectedProductSegmentIds((current) => {
      const next = new Set([...current].filter((id) => currentIds.has(id)));
      return setsEqual(next, current) ? current : next;
    });
    setSelectionAnchorSegmentId((current) => (current && currentIds.has(current) ? current : null));
  }, [productSegmentIds]);

  const updateProductSegmentSelection = useCallback(
    (segmentId: string, modifiers: ProductSegmentSelectionModifiers) => {
      setSelectedProductSegmentIds((current) => {
        if (modifiers.shiftKey && selectionAnchorSegmentId) {
          const anchorIndex = productSegmentIds.indexOf(selectionAnchorSegmentId);
          const targetIndex = productSegmentIds.indexOf(segmentId);
          if (anchorIndex >= 0 && targetIndex >= 0) {
            const start = Math.min(anchorIndex, targetIndex);
            const end = Math.max(anchorIndex, targetIndex);
            return new Set(productSegmentIds.slice(start, end + 1));
          }
        }

        if (modifiers.metaKey || modifiers.ctrlKey) {
          const next = new Set(current);
          if (next.has(segmentId)) next.delete(segmentId);
          else next.add(segmentId);
          return next;
        }

        return new Set([segmentId]);
      });
      setSelectionAnchorSegmentId(segmentId);
    },
    [productSegmentIds, selectionAnchorSegmentId]
  );

  const clearProductSegmentSelection = useCallback(() => {
    setSelectedProductSegmentIds((current) => (current.size === 0 ? current : new Set()));
    setSelectionAnchorSegmentId(null);
  }, []);

  const focusProductSegment = useCallback((segmentId: string) => {
    const segmentNode = productSegmentRefs.current.get(segmentId);
    const cardNode = segmentNode?.querySelector<HTMLElement>(
      '[data-assembly-product-segment-card="true"]'
    );
    cardNode?.focus();
  }, []);

  const handleProductSegmentKeyDown = useCallback(
    (segmentId: string, event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        updateProductSegmentSelection(segmentId, event);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        clearProductSegmentSelection();
        return;
      }

      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

      const currentIndex = productSegmentIds.indexOf(segmentId);
      if (currentIndex < 0) return;
      event.preventDefault();
      const nextIndex =
        event.key === 'ArrowUp'
          ? Math.max(0, currentIndex - 1)
          : Math.min(productSegmentIds.length - 1, currentIndex + 1);
      focusProductSegment(productSegmentIds[nextIndex]);
    },
    [
      clearProductSegmentSelection,
      focusProductSegment,
      productSegmentIds,
      updateProductSegmentSelection,
    ]
  );

  const isCurrentProductSegmentTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    const segmentCard = target.closest('[data-assembly-product-segment-card="true"]');
    return Boolean(segmentCard && productSectionRef.current?.contains(segmentCard));
  }, []);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (isCurrentProductSegmentTarget(event.target)) return;
      clearProductSegmentSelection();
    };
    document.addEventListener('click', handleDocumentClick);
    return () => document.removeEventListener('click', handleDocumentClick);
  }, [clearProductSegmentSelection, isCurrentProductSegmentTarget]);

  const clearProductDrag = useCallback(() => {
    setProductDrag(null);
    productDragRef.current = null;
    productDragMetaRef.current = null;
    if (bodyCursorBeforePartDragRef.current !== null) {
      document.body.style.cursor = bodyCursorBeforePartDragRef.current;
      bodyCursorBeforePartDragRef.current = null;
    }
  }, []);

  const previewProductDragAt = useCallback(
    (segmentId: string, clientY: number) => {
      const meta = productDragMetaRef.current;
      const segmentIds = meta?.segmentIds ?? productSegmentIds;
      const sourceIndex = meta?.sourceIndex ?? segmentIds.indexOf(segmentId);
      const draggedSegmentIds = meta?.draggedSegmentIds ?? [segmentId];
      if (sourceIndex < 0) return;
      const insertSlot = insertionSlotForProductClientY({
        clientY,
        sourceIndex,
        draggedIndices: productSegmentIndicesForIds(segmentIds, draggedSegmentIds),
        segmentIds,
        segmentRefs: productSegmentRefs.current,
        stableRects: meta?.cardRects,
      });
      const nextDrag = {
        segmentId,
        sourceIndex,
        draggedSegmentIds,
        insertSlot,
        offsetPx: meta ? clientY - meta.startClientY : 0,
        stableCardTops: stableCardTopsFromRects(meta?.cardRects, segmentIds),
      };
      productDragRef.current = nextDrag;
      setProductDrag(nextDrag);
    },
    [productSegmentIds]
  );

  const commitProductReorder = useCallback(
    (insertionSlot: number) => {
      const activeDrag = productDragRef.current;
      const meta = productDragMetaRef.current;
      if (!activeDrag) {
        clearProductDrag();
        return;
      }
      const segmentIds = meta?.segmentIds ?? productSegmentIds;
      const draggedSegmentIds = meta?.draggedSegmentIds ?? [activeDrag.segmentId];
      const reorderedIds = reorderGroupByInsertionSlot(
        segmentIds,
        productSegmentIndicesForIds(segmentIds, draggedSegmentIds),
        insertionSlot
      );
      if (reorderedIds.some((id, index) => id !== segmentIds[index])) {
        reorderProductLayoutSegments(design.id, reorderedIds);
      }
      clearProductDrag();
    },
    [clearProductDrag, design.id, productSegmentIds, reorderProductLayoutSegments]
  );

  const beginProductPointerDrag = useCallback(
    (segmentId: string, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== undefined && event.button !== 0) return;
      const sourceIndex = productSegmentIds.indexOf(segmentId);
      if (sourceIndex < 0) return;
      const segment = productSegments[sourceIndex];
      if (
        segment.kind === 'spacer' &&
        !design.spacers.some((spacer) => spacer.id === segment.spacer.id)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      bodyCursorBeforePartDragRef.current = document.body.style.cursor;
      document.body.style.cursor = 'grabbing';
      const selectedDragIds = selectedProductSegmentIds.has(segmentId)
        ? productSegmentIds.filter((id) => selectedProductSegmentIds.has(id))
        : [segmentId];
      if (!selectedProductSegmentIds.has(segmentId)) {
        setSelectedProductSegmentIds(new Set([segmentId]));
        setSelectionAnchorSegmentId(segmentId);
      }
      const startClientY = pointerClientYOrProductSegmentMidpoint(
        segmentId,
        event.clientY,
        productSegmentRefs.current
      );
      productDragMetaRef.current = {
        segmentId,
        sourceIndex,
        startClientY,
        segmentIds: productSegmentIds,
        draggedSegmentIds: selectedDragIds,
        cardRects: captureDragRects(productSegmentRefs.current),
      };
      previewProductDragAt(segmentId, startClientY);
    },
    [
      design.spacers,
      previewProductDragAt,
      productSegmentIds,
      productSegments,
      selectedProductSegmentIds,
    ]
  );

  const productDragSegmentId = productDrag?.segmentId ?? null;

  useEffect(() => {
    if (productDragSegmentId === null) return;
    const handlePointerMove = (event: PointerEvent) => {
      event.preventDefault();
      previewProductDragAt(
        productDragSegmentId,
        pointerClientYOrProductSegmentMidpoint(
          productDragSegmentId,
          event.clientY,
          productSegmentRefs.current
        )
      );
    };
    const handlePointerUp = (event: PointerEvent) => {
      event.preventDefault();
      const meta = productDragMetaRef.current;
      const segmentIds = meta?.segmentIds ?? productSegmentIds;
      const sourceIndex = meta?.sourceIndex ?? segmentIds.indexOf(productDragSegmentId);
      const clientY = pointerClientYOrProductSegmentMidpoint(
        productDragSegmentId,
        event.clientY,
        productSegmentRefs.current
      );
      const insertionSlot = insertionSlotForProductClientY({
        clientY,
        sourceIndex,
        draggedIndices: productSegmentIndicesForIds(
          segmentIds,
          meta?.draggedSegmentIds ?? [productDragSegmentId]
        ),
        segmentIds,
        segmentRefs: productSegmentRefs.current,
        stableRects: meta?.cardRects,
      });
      commitProductReorder(insertionSlot);
    };
    const handlePointerCancel = () => clearProductDrag();
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
      if (bodyCursorBeforePartDragRef.current !== null) {
        document.body.style.cursor = bodyCursorBeforePartDragRef.current;
        bodyCursorBeforePartDragRef.current = null;
      }
    };
  }, [
    clearProductDrag,
    commitProductReorder,
    previewProductDragAt,
    productDragSegmentId,
    productSegmentIds,
  ]);

  const handleDeleteRegion = useCallback(
    (regionId: string) => {
      removeRegion(design.id, regionId);
    },
    [design.id, removeRegion]
  );

  const handleClearRegion = useCallback(
    (regionId: string) => {
      clearRegion(design.id, regionId);
    },
    [design.id, clearRegion]
  );

  const productHighlights = useMemo(() => productHighlightsByRegionIndex(design), [design]);

  const locatePartInProduct = useCallback(
    (regionIndex: number) => {
      const target = productHighlights[regionIndex];
      if (!target) return;
      navigateAndHighlight(design.id, target.position, target.start, target.end, false);
    },
    [design.id, navigateAndHighlight, productHighlights]
  );

  const openSourceRegion = useCallback(
    (region: DesignRegion) =>
      openAssemblySourceRegion(region).catch((reason: unknown) => {
        useToastStore
          .getState()
          .addToast(toUserMessage(reason, 'failure.source-sequence-could-not-be-opened'), {
            definition: 'assembly-parts-section-could-not-open-the-source-sequence',
          });
      }),
    []
  );

  const buildCopiedRegionForCurrentAssembly = useCallback((): Omit<DesignRegion, 'id'> | null => {
    if (!lastCopied) return null;
    if (lastCopied.sourceType === 'rd') {
      const blockReason = rdFragmentAssemblyBlockReason(design.assemblyMethod, lastCopied.ggType);
      if (blockReason) {
        refuseDigestTransfer(lastCopied);
        return null;
      }
    }
    if (
      design.assemblyMethod === 'goldengate' &&
      lastCopied.sourceType === 'rd' &&
      lastCopied.rdSourceEnzyme
    ) {
      const existingRdFragments = design.regions.filter(
        (region) => (region.sourceType === 'rd' || region.rdOverhangs) && region.rdSourceEnzyme
      );
      const existingEnzyme = existingRdFragments[0]?.rdSourceEnzyme;
      if (existingEnzyme && existingEnzyme !== lastCopied.rdSourceEnzyme) {
        refuseDigestTransfer(lastCopied);
        return null;
      }
      if (
        existingRdFragments.length === 0 &&
        design.goldenGateConfig?.enzyme !== lastCopied.rdSourceEnzyme
      ) {
        setAssemblyMethod(design.id, 'goldengate', lastCopied.rdSourceEnzyme);
      }
    }
    const regionData = copiedRegionToDesignRegion(lastCopied);
    inheritDigestTransfer(regionData, lastCopied);
    return regionData;
  }, [
    design.assemblyMethod,
    design.goldenGateConfig?.enzyme,
    design.id,
    design.regions,
    lastCopied,
    setAssemblyMethod,
  ]);

  const pasteCopiedRegionIntoPlaceholder = useCallback(
    (regionId: string) => {
      const regionData = buildCopiedRegionForCurrentAssembly();
      if (!regionData) return;
      placeDigestTransfer(
        regionData,
        () => useDesignStore.getState().designs[design.id]?.regions,
        () => updateRegion(design.id, regionId, regionData)
      );
    },
    [buildCopiedRegionForCurrentAssembly, design.id, updateRegion]
  );

  const chooseMocloPart = useCallback(
    (slotIndex: number, candidate: MocloCatalogCandidate) => {
      const region = design.regions[slotIndex];
      const schema = design.goldenGateSchema;
      if (!region || !schema) return;
      const replacement = mocloCatalogCandidateToRegion(candidate, schema.enzyme);
      updateRegion(design.id, region.id, {
        ...replacement,
        sourceSequenceName: candidate.source.name,
        isPlaceholder: false,
      });
      setOpenSchemaSlotIndex(null);
    },
    [design.goldenGateSchema, design.id, design.regions, updateRegion]
  );

  const pasteCopiedRegionAsFirstPart = useCallback(() => {
    const regionData = buildCopiedRegionForCurrentAssembly();
    if (!regionData) return;
    placeDigestTransfer(
      regionData,
      () => useDesignStore.getState().designs[design.id]?.regions,
      () => addRegion(design.id, regionData)
    );
  }, [buildCopiedRegionForCurrentAssembly, design.id, addRegion]);

  const pasteBlockReason =
    lastCopied?.sourceType === 'rd'
      ? rdFragmentAssemblyBlockReason(design.assemblyMethod, lastCopied.ggType)
      : null;

  const addBlankPartAt = useCallback(
    (insertIndex: number) => {
      const regionData = emptyDesignRegion();
      if (insertIndex >= regions.length) {
        addRegion(design.id, regionData);
      } else {
        insertRegionAt(design.id, insertIndex, regionData);
      }
    },
    [addRegion, design.id, insertRegionAt, regions.length]
  );

  const addBlankPartAtProductBoundary = useCallback(
    (boundaryId: string) => {
      const regionData = emptyDesignRegion();
      insertRegionAtProductBoundary(design.id, boundaryId, regionData);
    },
    [design.id, insertRegionAtProductBoundary]
  );

  const addSpacerAt = useCallback(
    (junctionIndex: number) => {
      if (junctionIndex < 0) return;
      setSelectedJunction(design.id, junctionIndex);
    },
    [design.id, setSelectedJunction]
  );

  const setSpacerAt = useCallback(
    (junctionIndex: number, sequence: string) => {
      const normalizedSequence = normalizeDnaInput(sequence);
      setJunctionSpacer(design.id, junctionIndex, normalizedSequence);
      if (design.selectedJunctionIndex !== null) {
        setSelectedJunction(design.id, null);
      }
    },
    [design.id, design.selectedJunctionIndex, setJunctionSpacer, setSelectedJunction]
  );

  if (regions.length === 0) {
    return (
      <>
        {design.assemblyMethod === 'goldengate' ? (
          <MocloSchemaSelector design={design} projectRoot={projectRoot} />
        ) : null}
        <div
          data-testid="assembly-empty-parts-cue"
          className={`relative border border-dashed text-sm py-4 text-center rounded-md transition-colors ${
            externalDragOverIndex !== null
              ? 'bg-blue-500/20 border-blue-400 ring-1 ring-blue-400 text-blue-300'
              : 'border-border bg-bg-subtle text-fg-muted'
          }`}
          onDrop={(e) => handleExternalDrop(e, 0)}
          onDragOver={(e) => handleExternalDragOver(e, 0)}
          onDragLeave={handleDragLeave}
        >
          <div
            className={`flex flex-col items-center gap-2 ${externalDragOverIndex !== null ? 'invisible' : ''}`}
          >
            <span>No parts yet.</span>
            {lastCopied ? (
              <div className="flex w-full max-w-sm items-center justify-between gap-2">
                <span
                  data-testid="assembly-empty-paste-context"
                  className="min-w-0 truncate text-fg-subtle"
                  title={copiedRegionKind(lastCopied)}
                >
                  {copiedRegionContext(lastCopied)}
                </span>
                <button
                  type="button"
                  data-testid="assembly-paste-as-part"
                  data-paste-source-name={copiedRegionName(lastCopied)}
                  data-paste-source-kind={lastCopied.sourceType === 'rd' ? 'rd' : 'pcr'}
                  data-paste-sequence-length={lastCopied.sequence.length}
                  onClick={pasteCopiedRegionAsFirstPart}
                  disabled={!!pasteBlockReason}
                  aria-label={`Paste ${copiedRegionName(lastCopied)} into the assembly as a part`}
                  title={
                    pasteBlockReason != null
                      ? toUserMessage(pasteBlockReason, 'assembly.failed')
                      : userMessageWithValues('notice.paste-value-into-the-assembly-as-a-part', {
                          value0: userMessageValue(copiedRegionName(lastCopied)),
                        })
                  }
                  className="h-7 shrink-0 rounded bg-accent px-2.5 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Paste
                </button>
              </div>
            ) : (
              <span className="text-xs text-fg-subtle">
                Copy a sequence region to paste it here.
              </span>
            )}
            <button
              type="button"
              data-testid="assembly-add-blank-part-empty"
              onClick={() => addBlankPartAt(0)}
              className="rounded border border-border bg-bg-base px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:border-accent hover:text-accent"
            >
              Add blank part
            </button>
          </div>
          {externalDragOverIndex !== null && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              Drop to add part
            </span>
          )}
        </div>

        {}
        {pendingRDFragment && (
          <RDConfirmDialog
            pending={pendingRDFragment}
            onConfirm={handleConfirmRDFragment}
            onCancel={handleCancelRDFragment}
          />
        )}
      </>
    );
  }

  return (
    <>
      {design.assemblyMethod === 'goldengate' ? (
        <MocloSchemaSelector design={design} projectRoot={projectRoot} />
      ) : null}
      <div
        data-testid="assembly-product-segment-list"
        ref={productSectionRef}
        className="space-y-0"
        onDragLeave={handleDragLeave}
      >
        {}
        {productLayoutItems.map((item) => {
          if (item.kind === 'boundary') {
            const boundaryActive = activeBoundaryId === item.id;
            return (
              <ProductBoundaryControl
                key={item.id}
                boundary={item}
                isActive={boundaryActive}
                isSpacerDropTarget={externalDragOverIndex === item.partInsertIndex}
                isUpperActive={
                  item.leftRegionIndex !== null && hoveredPartIndex === item.leftRegionIndex
                }
                isLowerActive={
                  item.rightRegionIndex !== null && hoveredPartIndex === item.rightRegionIndex
                }
                onHoverChange={(active) =>
                  setActiveBoundaryId((current) => {
                    if (active) return item.id;
                    return current === item.id ? null : current;
                  })
                }
                onRegisterBoundary={registerBoundary}
                onAddPart={addBlankPartAtProductBoundary}
                onAddSpacer={addSpacerAt}
                onExternalDragOver={handleExternalDragOver}
                onExternalDrop={handleExternalDrop}
                schemaOverhang={
                  design.goldenGateSchema
                    ? (schemaSlotForRegion(
                        design,
                        design.regions[item.leftRegionIndex ?? item.junctionIndex]
                      )?.outgoingOverhang ?? null)
                    : undefined
                }
              />
            );
          }

          if (item.kind === 'spacer') {
            const segmentId = productLayoutSegmentId(item);
            const visual = productDragVisualForSegment(productDrag, segmentId, productSegmentIds);
            const insets = segmentInsetsById.get(segmentId) ?? EMPTY_SEGMENT_INSETS;
            return (
              <SpacerSegment
                key={`assembly-spacer-junction-${item.junctionIndex}`}
                segment={item}
                dragVisual={visual}
                topInset={insets.top}
                bottomInset={insets.bottom}
                onRegisterCard={(_spacerId, node) => registerProductSegment(segmentId, node)}
                onBeginPointerDrag={(_spacerId, event) => beginProductPointerDrag(segmentId, event)}
                isSelected={selectedProductSegmentIds.has(segmentId)}
                onSelect={(event) => updateProductSegmentSelection(segmentId, event)}
                onKeyDown={(event) => handleProductSegmentKeyDown(segmentId, event)}
                onCommit={setSpacerAt}
                onClear={(junctionIndex) => setSpacerAt(junctionIndex, '')}
              />
            );
          }

          const index = item.regionIndex;
          const region = item.region;
          const isPcr = region.sourceType !== 'rd';
          const showExternalDropIndicator = externalDragOverIndex === index;
          const regionIssues = issuesByRegionId.get(region.id) ?? [];
          const hasConflict = regionIssues.length > 0;
          const conflictSeverity = highestIssueSeverity(regionIssues);
          const color = getFragmentHexForRegion(region, index, assemblyColorScheme);
          const segmentId = productLayoutSegmentId(item);
          const visual = productDragVisualForSegment(productDrag, segmentId, productSegmentIds);
          const insets = segmentInsetsById.get(segmentId) ?? EMPTY_SEGMENT_INSETS;
          const schemaPickerAnchorRef = schemaPickerAnchorRefFor(index);
          const schemaPickerAnchorCallback = schemaPickerAnchorCallbackFor(segmentId, index);

          return (
            <div key={segmentId}>
              <div
                ref={schemaPickerAnchorCallback}
                data-testid="assembly-part-card-item"
                data-region-index={index}
                data-schema-picker-open={openSchemaSlotIndex === index ? 'true' : 'false'}
                data-reorder-shift={visual.kind}
                data-reorder-transform-y={visual.translateY}
                style={productDragItemStyle(visual)}
                onDragOver={
                  design.goldenGateSchema ? undefined : (e) => handleExternalDragOver(e, index)
                }
                onDrop={(e) => {
                  if (!design.goldenGateSchema && isExternalDrag(e)) {
                    handleExternalDrop(e, index);
                  }
                }}
              >
                {showExternalDropIndicator && (
                  <div className="h-1 bg-blue-400 rounded-full mb-2 animate-pulse" />
                )}

                <PartCard
                  region={region}
                  index={index}
                  isPcr={isPcr}
                  hasConflict={hasConflict}
                  conflictSeverity={conflictSeverity}
                  regionIssues={regionIssues}
                  color={color}
                  isDragging={visual.kind === 'dragging'}
                  isSelected={selectedProductSegmentIds.has(segmentId)}
                  copiedRegion={lastCopied}
                  onDelete={() => handleDeleteRegion(region.id)}
                  onClear={() => handleClearRegion(region.id)}
                  onOpenSource={() => {
                    void openSourceRegion(region).catch((error: unknown) => {
                      useToastStore
                        .getState()
                        .addToast(
                          toUserMessage(error, 'failure.could-not-open-the-source-sequence'),
                          {
                            definition: 'assembly-parts-section-could-not-open-the-source-sequence',
                          }
                        );
                    });
                  }}
                  onLocateInProduct={
                    productHighlights[index] ? () => locatePartInProduct(index) : null
                  }
                  onPasteCopiedRegion={() => pasteCopiedRegionIntoPlaceholder(region.id)}
                  onRegisterCard={() => undefined}
                  onHoverChange={handlePartHoverChange}
                  onSelect={(event) => {
                    updateProductSegmentSelection(segmentId, event);
                    if (design.goldenGateSchema && region.isPlaceholder) {
                      setOpenSchemaSlotIndex((current) => (current === index ? null : index));
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      design.goldenGateSchema &&
                      region.isPlaceholder &&
                      event.target === event.currentTarget &&
                      (event.key === 'Enter' || event.key === ' ')
                    ) {
                      event.preventDefault();
                      setOpenSchemaSlotIndex((current) => (current === index ? null : index));
                      return;
                    }
                    handleProductSegmentKeyDown(segmentId, event);
                  }}
                  onBeginPointerDrag={(_index, event) => beginProductPointerDrag(segmentId, event)}
                  schemaSlot={schemaSlotForRegion(design, region) ?? null}
                  onOpenSchemaPicker={
                    design.goldenGateSchema
                      ? () =>
                          setOpenSchemaSlotIndex((current) => (current === index ? null : index))
                      : null
                  }
                  topInset={insets.top}
                  bottomInset={insets.bottom}
                />
                <PortalMenu
                  open={openSchemaSlotIndex === index}
                  anchorRef={schemaPickerAnchorRef}
                  onRequestClose={() => setOpenSchemaSlotIndex(null)}
                  role="dialog"
                  horizontalAlign="start"
                  preferredSide="bottom"
                  data-testid={`moclo-drawer-part-picker-menu-${index}`}
                  className="flex w-[480px] flex-col !overflow-hidden !bg-bg"
                >
                  <MocloSlotPartPicker
                    design={design}
                    catalog={mocloCatalog}
                    slotIndex={index}
                    onChoose={(candidate) => chooseMocloPart(index, candidate)}
                    onClose={() => setOpenSchemaSlotIndex(null)}
                  />
                </PortalMenu>
              </div>
            </div>
          );
        })}

        {}
        {pendingRDFragment && (
          <RDConfirmDialog
            pending={pendingRDFragment}
            onConfirm={handleConfirmRDFragment}
            onCancel={handleCancelRDFragment}
          />
        )}
      </div>
    </>
  );
}

function copiedRegionToDesignRegion(copied: CopiedRegion): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: copied.sourceId,
    sourceSequenceName: copied.sourceName,
    sourceStart: copied.start,
    sourceEnd: copied.end,
    sequence: copied.sequence,
    annotations: copied.annotations,
    sourceSequence: copied.sourceSequence,
    sourceAnnotations: copied.sourceAnnotations,
    sourceIsCircular: copied.sourceIsCircular,
    isPlaceholder: false,
    sourceType: copied.sourceType ?? 'pcr',
    ...(copied.sourceType === 'rd' && {
      sourceType: 'rd' as const,
      ggType: copied.ggType,
      rdOverhangs: copied.rdOverhangs,
      rdSourceEnzyme: copied.rdSourceEnzyme,
      rdSourceEnzymeName: copied.rdSourceEnzymeName,
      rdEnds: copied.rdEnds,
      rdSiblingOverhangs: copied.rdSiblingOverhangs,
    }),
  };
}

function normalizeDnaInput(rawSequence: string): string {
  return rawSequence.toUpperCase().replace(/[^ATCG]/g, '');
}

function insertionSlotForProductClientY(input: {
  clientY: number;
  sourceIndex: number;
  draggedIndices?: readonly number[];
  segmentIds: readonly string[];
  segmentRefs: Map<string, HTMLDivElement>;
  stableRects?: Map<string, DragRect>;
}): number {
  const draggedIndices = new Set(input.draggedIndices ?? [input.sourceIndex]);
  const entries = input.segmentIds
    .map((segmentId, index) => ({
      segmentId,
      index,
      node: input.segmentRefs.get(segmentId) ?? null,
    }))
    .filter(({ index, node }) => !draggedIndices.has(index) && node)
    .map(({ index, node, segmentId }) => ({
      index,
      rect: input.stableRects?.get(segmentId) ?? rectSnapshot(node!.getBoundingClientRect()),
    }))
    .filter(({ rect }) => rect.height > 0)
    .sort((a, b) => a.rect.top - b.rect.top);

  for (const entry of entries) {
    const midpoint = entry.rect.top + entry.rect.height / 2;
    if (input.clientY < midpoint) return entry.index;
  }
  return input.segmentIds.length;
}

function productSegmentIndicesForIds(
  segmentIds: readonly string[],
  selectedSegmentIds: readonly string[]
): number[] {
  const selected = new Set(selectedSegmentIds);
  return segmentIds.flatMap((segmentId, index) => (selected.has(segmentId) ? [index] : []));
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!right.has(item)) return false;
  }
  return true;
}

function captureDragRects(cardRefs: Map<string, HTMLDivElement>): Map<string, DragRect> {
  return new Map(
    [...cardRefs.entries()].map(([segmentId, node]) => [
      segmentId,
      rectSnapshot(node.getBoundingClientRect()),
    ])
  );
}

function rectSnapshot(rect: DOMRect): DragRect {
  return { top: rect.top, height: rect.height };
}

function stableCardTopsFromRects(
  rects: Map<string, DragRect> | undefined,
  segmentIds: readonly string[]
): number[] {
  if (!rects) return [];
  return segmentIds.map((segmentId) => rects.get(segmentId)?.top ?? Number.NaN);
}

function productDragVisualForSegment(
  drag: ProductSegmentDragState | null,
  segmentId: string,
  segmentIds: readonly string[]
): ProductSegmentDragVisual {
  if (!drag) return { kind: 'none', translateY: 0 };
  if (drag.draggedSegmentIds.includes(segmentId)) {
    return { kind: 'dragging', translateY: drag.offsetPx };
  }

  const originalIndex = segmentIds.indexOf(segmentId);
  if (originalIndex < 0) return { kind: 'none', translateY: 0 };

  const previewIds = reorderGroupByInsertionSlot(
    segmentIds,
    productSegmentIndicesForIds(segmentIds, drag.draggedSegmentIds),
    drag.insertSlot
  );
  const previewIndex = previewIds.indexOf(segmentId);
  if (previewIndex < 0 || previewIndex === originalIndex) {
    return { kind: 'none', translateY: 0 };
  }
  return {
    kind: previewIndex < originalIndex ? 'up' : 'down',
    translateY: cardSlotShift(drag.stableCardTops, originalIndex, previewIndex),
  };
}

function cardSlotShift(stableCardTops: number[], fromIndex: number, toIndex: number): number {
  const fromTop = stableCardTops[fromIndex];
  const toTop = stableCardTops[toIndex];
  if (!Number.isFinite(fromTop) || !Number.isFinite(toTop)) return 0;
  return toTop - fromTop;
}

function productDragItemStyle(visual: ProductSegmentDragVisual): React.CSSProperties {
  return {
    position: 'relative',
    zIndex: visual.kind === 'dragging' ? 20 : undefined,
    transform: visual.translateY ? `translateY(${visual.translateY}px)` : undefined,
    pointerEvents: visual.kind === 'dragging' ? 'none' : undefined,
  };
}

function productSegmentInsetsForPreviewOrder(
  orderedSegmentIds: readonly string[]
): Map<string, { top: boolean; bottom: boolean }> {
  return new Map(
    orderedSegmentIds.map((segmentId, index) => [
      segmentId,
      {
        top: index > 0,
        bottom: true,
      },
    ])
  );
}

function pointerClientYOrProductSegmentMidpoint(
  segmentId: string,
  clientY: number,
  segmentRefs?: Map<string, HTMLDivElement>
): number {
  if (Number.isFinite(clientY)) return clientY;
  const sourceNode = segmentRefs?.get(segmentId);
  if (!sourceNode) return 0;
  const rect = sourceNode.getBoundingClientRect();
  return rect.top + rect.height / 2;
}
