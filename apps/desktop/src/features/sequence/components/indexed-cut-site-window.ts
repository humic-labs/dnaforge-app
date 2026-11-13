export const INDEXED_CUT_SITE_MAX_BP_PER_PX = 40;

const PRELOAD_ZOOM_FACTOR = 4;

const WINDOW_PAD_VIEWS = 2;

const WINDOW_PAD_FLOOR_VIEWS = 2;

const REFRESH_PAD_FRACTION = 0.5;

export interface IndexedChromosomeSpan {
  readonly chrom: string;
  readonly length: number;
}

export interface IndexedScanWindow {
  readonly chrom: string;
  readonly start0: number;
  readonly end0: number;
  readonly chromGlobalStart: number;
}

export interface IndexedScanWindowPlan {
  readonly action: 'keep' | 'load' | 'none';
  readonly window?: IndexedScanWindow;
  readonly showable: boolean;
  readonly maxViewBp: number;
  readonly unavailable: boolean;
}

export function indexedCutSiteMaxViewBp(viewerWidthPx: number): number {
  return Math.max(0, Math.floor(viewerWidthPx * INDEXED_CUT_SITE_MAX_BP_PER_PX));
}

export function planIndexedCutSiteWindow(input: {
  viewport: Readonly<{ start: number; end: number }> | null;
  viewerWidthPx: number;
  chromosomes: ReadonlyArray<IndexedChromosomeSpan>;
  current: IndexedScanWindow | null;
}): IndexedScanWindowPlan {
  const { viewport, chromosomes, current } = input;
  const maxViewBp = indexedCutSiteMaxViewBp(input.viewerWidthPx);
  const span = viewport ? viewport.end - viewport.start : 0;
  if (!viewport || maxViewBp <= 0 || chromosomes.length === 0 || span <= 0) {
    return { action: 'none', showable: false, maxViewBp, unavailable: true };
  }
  const showable = span <= maxViewBp;
  if (span > maxViewBp * PRELOAD_ZOOM_FACTOR) {
    return { action: 'none', showable, maxViewBp, unavailable: false };
  }

  let chromGlobalStart = 0;
  for (const chromosome of chromosomes) {
    const chromGlobalEnd = chromGlobalStart + chromosome.length;
    if (viewport.start >= chromGlobalStart && viewport.start < chromGlobalEnd) {
      const viewStart0 = viewport.start - chromGlobalStart;
      const viewEnd0 = Math.min(chromosome.length, viewport.end - chromGlobalStart);
      const pad = Math.max(span * WINDOW_PAD_VIEWS, maxViewBp * WINDOW_PAD_FLOOR_VIEWS);
      const margin = pad * REFRESH_PAD_FRACTION;
      if (
        current &&
        current.chrom === chromosome.chrom &&
        (current.start0 === 0 || current.start0 <= viewStart0 - margin) &&
        (current.end0 === chromosome.length || current.end0 >= viewEnd0 + margin) &&
        current.start0 <= viewStart0 &&
        current.end0 >= viewEnd0
      ) {
        return { action: 'keep', showable, maxViewBp, unavailable: false };
      }
      return {
        action: 'load',
        window: {
          chrom: chromosome.chrom,
          start0: Math.max(0, Math.floor(viewStart0 - pad)),
          end0: Math.min(chromosome.length, Math.ceil(viewEnd0 + pad)),
          chromGlobalStart,
        },
        showable,
        maxViewBp,
        unavailable: false,
      };
    }
    chromGlobalStart = chromGlobalEnd;
  }
  return { action: 'none', showable: false, maxViewBp, unavailable: true };
}

export function formatIndexedScanWindow(
  window: Pick<IndexedScanWindow, 'chrom' | 'start0' | 'end0'>
): string {
  return `${window.chrom}:${(window.start0 + 1).toLocaleString()}–${window.end0.toLocaleString()}`;
}
