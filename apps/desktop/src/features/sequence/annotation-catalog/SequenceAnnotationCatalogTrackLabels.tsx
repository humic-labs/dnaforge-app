import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  ANNOTATION_EVIDENCE_LABELS,
  FEATURE_KIND_LABELS,
} from '@waypoint/genome-data/annotation-catalog';
import type { PixiLinearRenderer } from '@waypoint/genome-renderer';

import {
  readAnnotationCatalogWiring,
  subscribeAnnotationCatalogWiring,
  type HoverableCatalogTrack,
} from './annotation-catalog-wiring-status';

const LAYOUT_POLL_MS = 500;

export interface CatalogTrackLabel {
  readonly trackId: string;
  readonly topPx: number;
  readonly leftPx: number;
  readonly kindLabel: string;
  readonly sourceLabel: string;
  readonly evidenceLabel: string;
}

type LabelRenderer = Pick<PixiLinearRenderer, 'getLaneScreenSnapshot'>;

export function catalogTrackLabels(input: {
  readonly tracks: readonly HoverableCatalogTrack[];
  readonly bounds: Readonly<Record<string, { readonly topPx: number; readonly heightPx: number }>>;
  readonly hostOffset: { readonly left: number; readonly top: number };
}): CatalogTrackLabel[] {
  const labels: CatalogTrackLabel[] = [];
  for (const track of input.tracks) {
    const band = input.bounds[track.trackId];
    if (!band || band.heightPx <= 0) continue;
    labels.push({
      trackId: track.trackId,
      topPx: input.hostOffset.top + band.topPx + 1,
      leftPx: input.hostOffset.left + 6,
      kindLabel: FEATURE_KIND_LABELS[track.kind],
      sourceLabel: track.sourceLabel,
      evidenceLabel: ANNOTATION_EVIDENCE_LABELS[track.evidence],
    });
  }
  return labels;
}

const LABEL_STYLE: CSSProperties = {
  position: 'absolute',
  maxWidth: 360,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  padding: '0 4px',
  borderRadius: 3,
  backgroundColor: 'hsl(var(--color-bg-subtle) / 0.85)',
  color: 'hsl(var(--color-fg-subtle))',
  fontSize: 10,
  lineHeight: '14px',
  pointerEvents: 'none',
};

export function SequenceAnnotationCatalogTrackLabels({
  ownerTabId,
  mapRef,
}: {
  ownerTabId: string;
  mapRef: { readonly current: { getLinearRenderer?: () => LabelRenderer | null } | null };
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<readonly CatalogTrackLabel[]>([]);

  useEffect(() => {
    const update = () => {
      const root = rootRef.current;
      const tracks = readAnnotationCatalogWiring(ownerTabId)?.hoverTracks ?? [];
      const renderer = mapRef.current?.getLinearRenderer?.() ?? null;
      const host = root?.parentElement?.parentElement?.querySelector<HTMLElement>(
        '[data-testid="webgl-render-host"]'
      );
      if (!root || !renderer || !host || tracks.length === 0) {
        setLabels((previous) => (previous.length === 0 ? previous : []));
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const next = catalogTrackLabels({
        tracks,
        bounds: renderer.getLaneScreenSnapshot().trackScreenBounds,
        hostOffset: { left: hostRect.left - rootRect.left, top: hostRect.top - rootRect.top },
      });
      setLabels((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      );
    };
    update();
    const unsubscribe = subscribeAnnotationCatalogWiring(update);
    const timer = window.setInterval(update, LAYOUT_POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [mapRef, ownerTabId]);

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {labels.map((label) => (
        <div
          key={label.trackId}
          data-testid="annotation-catalog-track-label"
          style={{ ...LABEL_STYLE, top: label.topPx, left: label.leftPx }}
          title={`${label.kindLabel} · ${label.evidenceLabel} · ${label.sourceLabel}`}
        >
          <strong>{label.kindLabel}</strong> · {label.evidenceLabel} · {label.sourceLabel}
        </div>
      ))}
    </div>
  );
}
