export interface LaneBand {
  topPx: number;
  heightPx: number;
}

export interface LaneScreenBands {
  reference?: LaneBand;
  annotation?: LaneBand;
  sequence?: LaneBand;
  dataBounds: Readonly<Record<string, LaneBand>>;
  annotationSearchFocusPresentation?: {
    trackId: string;
    canonicalIdentity: string;
    lane: number;
  } | null;
}

export interface PresentedTrackScrollReceipt {
  completedFrameEpoch: number;
  trackScrollTop: number;
}

interface OverlayLayoutish {
  offset?: number;
  totalHeight?: number;
  annotationHeight?: number;
  strandEnvelopeTop?: number;
  strandEnvelopeBottom?: number;
  fwdStrandTop?: number;
  revStrandBottom?: number;
}

interface RendererSnapshotish {
  annotationOverlay?: {
    annotationSearchFocusResolvedTrackId?: string | null;
    annotationSearchFocusResolvedCanonicalIdentity?: string | null;
    annotationSearchFocusPresentationLane?: number | null;
  };
  trackScreenBounds?: Record<
    string,
    { topPx: number; heightPx: number; scrollsVertically?: boolean }
  >;
  overlayLayout?: OverlayLayoutish;
  laneContract?: {
    trackScreenBounds?: Record<
      string,
      { topPx: number; heightPx: number; scrollsVertically?: boolean }
    >;
    overlayLayout?: OverlayLayoutish;
  };
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function normalizeLaneScreenBands(snapshot: unknown): LaneScreenBands {
  const snap = (snapshot ?? {}) as RendererSnapshotish;
  const tsb = snap.trackScreenBounds ?? snap.laneContract?.trackScreenBounds ?? {};
  const ov = snap.overlayLayout ?? snap.laneContract?.overlayLayout ?? null;
  const trackScrollTop =
    ov && isFiniteNum((ov as OverlayLayoutish & { trackScrollTop?: number }).trackScrollTop)
      ? Math.max(0, (ov as OverlayLayoutish & { trackScrollTop: number }).trackScrollTop)
      : 0;

  const dataBounds: Record<string, LaneBand> = {};
  for (const [id, b] of Object.entries(tsb)) {
    if (b && isFiniteNum(b.topPx) && isFiniteNum(b.heightPx) && b.heightPx > 0) {
      dataBounds[id] = {
        topPx: b.topPx + (b.scrollsVertically === false ? 0 : trackScrollTop),
        heightPx: b.heightPx,
      };
    }
  }

  let reference: LaneBand | undefined;
  if (ov && isFiniteNum(ov.offset) && isFiniteNum(ov.totalHeight) && ov.totalHeight > 0) {
    reference = { topPx: ov.offset + trackScrollTop, heightPx: ov.totalHeight };
  }

  let annotation: LaneBand | undefined;
  if (ov && isFiniteNum(ov.offset) && isFiniteNum(ov.annotationHeight) && ov.annotationHeight > 0) {
    annotation = { topPx: ov.offset + trackScrollTop, heightPx: ov.annotationHeight };
  }

  let sequence: LaneBand | undefined;
  const sequenceTop = ov?.strandEnvelopeTop ?? ov?.fwdStrandTop;
  const sequenceBottom = ov?.strandEnvelopeBottom ?? ov?.revStrandBottom;
  if (isFiniteNum(sequenceTop) && isFiniteNum(sequenceBottom) && sequenceBottom > sequenceTop) {
    sequence = {
      topPx: sequenceTop + trackScrollTop,
      heightPx: sequenceBottom - sequenceTop,
    };
  }

  const focusTrackId = snap.annotationOverlay?.annotationSearchFocusResolvedTrackId;
  const focusCanonicalIdentity =
    snap.annotationOverlay?.annotationSearchFocusResolvedCanonicalIdentity;
  const focusLane = snap.annotationOverlay?.annotationSearchFocusPresentationLane;
  const annotationSearchFocusPresentation =
    typeof focusTrackId === 'string' &&
    focusTrackId.length > 0 &&
    typeof focusCanonicalIdentity === 'string' &&
    focusCanonicalIdentity.length > 0 &&
    Number.isSafeInteger(focusLane) &&
    (focusLane ?? -1) >= 0
      ? {
          trackId: focusTrackId,
          canonicalIdentity: focusCanonicalIdentity,
          lane: focusLane as number,
        }
      : null;

  return {
    reference,
    annotation,
    sequence,
    dataBounds,
    ...(annotationSearchFocusPresentation ? { annotationSearchFocusPresentation } : {}),
  };
}
