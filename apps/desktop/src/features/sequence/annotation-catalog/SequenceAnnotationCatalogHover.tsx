import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import {
  ANNOTATION_EVIDENCE_LABELS,
  type CatalogRecord,
  type FeatureKind,
  type Strand,
} from '@waypoint/genome-data/annotation-catalog';
import type {
  AnnotationCatalogRendererDiagnostics,
  PixiLinearRenderer,
} from '@waypoint/genome-renderer';

import {
  readAnnotationCatalogWiring,
  type HoverableCatalogTrack,
} from './annotation-catalog-wiring-status';
import { SequenceAnnotationCatalogTrackLabels } from './SequenceAnnotationCatalogTrackLabels';
import { friendlyLicenseName } from './license-names';
import { nearestRecordAt } from './record-hover-index';

const HOVER_TOLERANCE_PX = 4;

const KIND_NAMES: Readonly<Record<FeatureKind, string>> = {
  promoter: 'Promoter',
  terminator: 'Terminator',
  transcription_unit: 'Transcription unit',
  tss: 'Transcription start site',
};

export type AnnotationCatalogHoverRenderer = Pick<
  PixiLinearRenderer,
  'getLaneScreenSnapshot' | 'getTrackDiagnostics'
>;

interface HoveredRecord {
  readonly record: CatalogRecord;
  readonly track: HoverableCatalogTrack;
  readonly x: number;
  readonly y: number;
  readonly paneWidth: number;
  readonly paneHeight: number;
}

const TOOLTIP_MAX_WIDTH = 340;
const CURSOR_OFFSET = 12;
const PANE_MARGIN = 4;

export function tooltipPosition(
  hovered: Pick<HoveredRecord, 'x' | 'y' | 'paneWidth' | 'paneHeight'>,
  size: { readonly width: number; readonly height: number }
): { left: number; top: number } {
  let left = hovered.x + CURSOR_OFFSET;
  if (left + size.width > hovered.paneWidth - PANE_MARGIN) {
    left = Math.max(PANE_MARGIN, hovered.x - CURSOR_OFFSET - size.width);
  }
  let top = hovered.y + CURSOR_OFFSET;
  if (top + size.height > hovered.paneHeight - PANE_MARGIN) {
    top = Math.max(PANE_MARGIN, hovered.y - CURSOR_OFFSET - size.height);
  }
  return { left, top };
}

const formatBase = (bp0: number) => (bp0 + 1).toLocaleString('en-US');

function positionText(record: CatalogRecord): string {
  if (record.location.shape === 'point') return `Position ${formatBase(record.location.bp)}`;
  return `Positions ${formatBase(record.location.start)}–${record.location.end.toLocaleString('en-US')}`;
}

function measuredEndText(record: CatalogRecord): string | null {
  if (record.kind === 'terminator' && record.terminationBp !== null) {
    return `3′ end at ${formatBase(record.terminationBp)}`;
  }
  if (record.kind === 'terminator' && record.peakBp !== null) {
    return `Peak at ${formatBase(record.peakBp)}, measured over the whole window`;
  }
  if (record.kind === 'transcription_unit' && record.endEvidence === 'gene-derived') {
    return 'End taken from the last gene in this unit, not measured';
  }
  if (record.kind === 'promoter' && record.transcriptionStartBp !== null) {
    return `Starts at ${formatBase(record.transcriptionStartBp)}`;
  }
  return null;
}

export function findHoveredRecord(input: {
  readonly renderer: AnnotationCatalogHoverRenderer;
  readonly tracks: readonly HoverableCatalogTrack[];
  readonly x: number;
  readonly y: number;
}): { record: CatalogRecord; track: HoverableCatalogTrack } | null {
  const bounds = input.renderer.getLaneScreenSnapshot().trackScreenBounds;
  for (const track of input.tracks) {
    const box = bounds[track.trackId];
    if (!box || input.y < box.topPx || input.y >= box.bottomPx) continue;
    const diagnostics = input.renderer.getTrackDiagnostics(
      track.trackId
    ) as AnnotationCatalogRendererDiagnostics | null;
    if (!diagnostics || diagnostics.lod !== 'detail') return null;
    const camera = diagnostics.camera;
    if (!camera || !(camera.pixelsPerBp > 0)) return null;
    const baselineYPx = diagnostics.rowLayout?.baselineYPx ?? box.heightPx / 2;
    const strand: Strand = input.y - box.topPx < baselineYPx ? '+' : '-';
    const bp = camera.viewStartBp + input.x / camera.pixelsPerBp;
    const record = nearestRecordAt(
      track.indexByStrand[strand],
      bp,
      HOVER_TOLERANCE_PX / camera.pixelsPerBp
    );
    return record ? { record, track } : null;
  }
  return null;
}

const TOOLTIP_STYLE: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  width: 'max-content',
  maxWidth: TOOLTIP_MAX_WIDTH,
  padding: '6px 10px',
  borderRadius: 4,
  border: '1px solid hsl(var(--color-border))',
  backgroundColor: 'hsl(var(--color-bg-subtle))',
  color: 'hsl(var(--color-fg))',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  fontSize: 11,
  lineHeight: 1.4,
  pointerEvents: 'none',
};

const SUBTEXT_STYLE: CSSProperties = { color: 'hsl(var(--color-fg-subtle))', fontSize: 10 };
const CREDIT_STYLE: CSSProperties = { ...SUBTEXT_STYLE, marginTop: 4 };

function CatalogRecordTooltip({ hovered }: { hovered: HoveredRecord }) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { record, track } = hovered;
  const measuredEnd = measuredEndText(record);

  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element) return;
    const { left, top } = tooltipPosition(hovered, {
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [hovered]);

  return (
    <div ref={tooltipRef} data-testid="annotation-catalog-tooltip" style={TOOLTIP_STYLE}>
      <div style={{ fontWeight: 600 }}>{record.name ?? KIND_NAMES[record.kind]}</div>
      <div style={SUBTEXT_STYLE}>
        {KIND_NAMES[record.kind]} · {record.strand === '+' ? 'Forward strand' : 'Reverse strand'}
        {record.score !== null ? ` · Score ${record.score.toLocaleString('en-US')}` : ''}
      </div>
      <div style={SUBTEXT_STYLE} data-testid="annotation-catalog-tooltip-position">
        {positionText(record)}
        {measuredEnd ? ` · ${measuredEnd}` : ''}
      </div>
      <div style={CREDIT_STYLE}>
        {track.sourceLabel} · {ANNOTATION_EVIDENCE_LABELS[track.evidence]}
      </div>
      <div style={SUBTEXT_STYLE} data-testid="annotation-catalog-tooltip-license">
        {friendlyLicenseName(track.licenseSpdx)}
      </div>
      <div style={SUBTEXT_STYLE} data-testid="annotation-catalog-tooltip-attribution">
        {track.attribution}
      </div>
    </div>
  );
}

export function SequenceAnnotationCatalogHover({
  ownerTabId,
  mapRef,
}: {
  ownerTabId: string;
  mapRef: {
    readonly current: { getLinearRenderer?: () => AnnotationCatalogHoverRenderer | null } | null;
  };
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<HoveredRecord | null>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const pane = overlay?.parentElement;
    if (!overlay || !pane) return;
    let rafId = 0;
    let pointer: { clientX: number; clientY: number } | null = null;

    const evaluate = () => {
      rafId = 0;
      const tracks = readAnnotationCatalogWiring(ownerTabId)?.hoverTracks ?? [];
      const renderer = mapRef.current?.getLinearRenderer?.() ?? null;
      if (!pointer || tracks.length === 0 || !renderer) {
        setHovered(null);
        return;
      }
      const host = pane.querySelector<HTMLElement>('[data-testid="webgl-render-host"]') ?? pane;
      const hostRect = host.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const found = findHoveredRecord({
        renderer,
        tracks,
        x: pointer.clientX - hostRect.left,
        y: pointer.clientY - hostRect.top,
      });
      setHovered((previous) => {
        if (!found) return null;
        const x = pointer ? pointer.clientX - overlayRect.left : 0;
        const y = pointer ? pointer.clientY - overlayRect.top : 0;
        if (previous?.record === found.record && previous.x === x && previous.y === y) {
          return previous;
        }
        return { ...found, x, y, paneWidth: overlayRect.width, paneHeight: overlayRect.height };
      });
    };

    const onMove = (event: MouseEvent) => {
      const host = pane.querySelector('[data-testid="webgl-render-host"]');
      const overMap = !host || (event.target instanceof Node && host.contains(event.target));
      if (!overMap || (readAnnotationCatalogWiring(ownerTabId)?.hoverTracks.length ?? 0) === 0) {
        pointer = null;
        setHovered((previous) => (previous ? null : previous));
        return;
      }
      pointer = { clientX: event.clientX, clientY: event.clientY };
      if (!rafId) rafId = requestAnimationFrame(evaluate);
    };
    const onLeave = () => {
      pointer = null;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      setHovered(null);
    };

    pane.addEventListener('mousemove', onMove, { passive: true });
    pane.addEventListener('mouseleave', onLeave);
    return () => {
      pane.removeEventListener('mousemove', onMove);
      pane.removeEventListener('mouseleave', onLeave);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [mapRef, ownerTabId]);

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <SequenceAnnotationCatalogTrackLabels ownerTabId={ownerTabId} mapRef={mapRef} />
      {hovered ? <CatalogRecordTooltip hovered={hovered} /> : null}
    </div>
  );
}
