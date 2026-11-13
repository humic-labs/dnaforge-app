import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assemblyAccession,
  sourceId,
  trackBindingId,
  type CatalogRecord,
  type PromoterRecord,
  type TerminatorRecord,
} from '@waypoint/genome-data/annotation-catalog';

import {
  clearAnnotationCatalogWiring,
  publishAnnotationCatalogWiring,
  type HoverableCatalogTrack,
} from './annotation-catalog-wiring-status';
import { buildStrandHoverIndexes, sortRecordsBySpanStart } from './record-hover-index';
import {
  SequenceAnnotationCatalogHover,
  type AnnotationCatalogHoverRenderer,
} from './SequenceAnnotationCatalogHover';
import {
  annotationCatalogForAccession,
  loadAnnotationCatalogs,
} from './annotation-catalog-registry';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';

beforeAll(async () => {
  await loadAnnotationCatalogs(bundledStoreBridge());
});

const TAB_ID = 'tab:hover-test';
const VIEW_START_BP = 4_175_800;
const PIXELS_PER_BP = 2;
const xAt = (bp: number) => (bp - VIEW_START_BP) * PIXELS_PER_BP;

const forwardTerminator: TerminatorRecord = {
  id: 'termite:forward',
  kind: 'terminator',
  strand: '+',
  name: 'tufB terminator',
  score: 1000,
  conditions: [],
  location: { shape: 'region', start: 4_175_899, end: 4_175_940 },
  mechanism: 'intrinsic',
  parts: [],
  terminationBp: 4_175_930,
  peakBp: null,
};

const reverseTerminator: TerminatorRecord = {
  ...forwardTerminator,
  id: 'termite:reverse',
  strand: '-',
  name: 'reverse terminator',
  score: null,
  location: { shape: 'region', start: 4_175_910, end: 4_175_925 },
  terminationBp: null,
  peakBp: null,
};

const promoter: PromoterRecord = {
  id: 'window:tufB',
  kind: 'promoter',
  strand: '+',
  name: null,
  score: null,
  conditions: [],
  location: { shape: 'region', start: 4_175_860, end: 4_175_921 },
  transcriptionStartBp: 4_175_920,
  boxes: [],
  sigmaFactor: null,
};

const TERMINATOR_BOX = { topPx: 100, heightPx: 60, bottomPx: 160, scrollsVertically: true };
const PROMOTER_BOX = { topPx: 200, heightPx: 40, bottomPx: 240, scrollsVertically: true };

function hoverTrack(
  trackId: string,
  kind: CatalogRecord['kind'],
  records: CatalogRecord[],
  source: { label: string; spdx: string; attribution: string }
): HoverableCatalogTrack {
  return {
    trackId,
    bindingId: trackBindingId(trackId.split(':')[0]),
    kind,
    sourceLabel: source.label,
    evidence: 'measured',
    licenseSpdx: source.spdx,
    attribution: source.attribution,
    indexByStrand: buildStrandHoverIndexes(sortRecordsBySpanStart(records)),
  };
}

function fakeRenderer(lodByTrack: Record<string, 'detail' | 'aggregate'>) {
  const diagnostics = (lod: 'detail' | 'aggregate', baselineYPx: number) => ({
    lod,
    camera: { viewStartBp: VIEW_START_BP, pixelsPerBp: PIXELS_PER_BP, widthPx: 1_000 },
    rowLayout: { rowHeightPx: 14, forwardRows: 2, reverseRows: 2, baselineYPx },
  });
  const renderer = {
    getLaneScreenSnapshot: () => ({
      overlayLayout: null,
      trackScreenBounds: {
        'terminators:terminator-hairpin': TERMINATOR_BOX,
        'promoters:promoter-arrow': PROMOTER_BOX,
      },
    }),
    getTrackDiagnostics: (trackId: string) =>
      trackId === 'terminators:terminator-hairpin'
        ? diagnostics(lodByTrack[trackId] ?? 'detail', 30)
        : diagnostics(lodByTrack[trackId] ?? 'detail', 20),
  };
  return renderer as unknown as AnnotationCatalogHoverRenderer;
}

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  clearAnnotationCatalogWiring(TAB_ID);
  vi.unstubAllGlobals();
});

function termiteSource() {
  const definition = annotationCatalogForAccession('NC_000913.3')?.sources.get(
    sourceId('termite-ecoli-terminators')
  );
  if (!definition) throw new Error('the TERMITe source must be in the bundled store');
  return {
    label: definition.label,
    spdx: definition.provenance.license.spdx,
    attribution: definition.provenance.license.attribution,
  };
}

function setUp(lodByTrack: Record<string, 'detail' | 'aggregate'> = {}) {
  const termite = termiteSource();
  publishAnnotationCatalogWiring(TAB_ID, {
    assembly: { accession: assemblyAccession('NC_000913.3'), lengthBp: 4_641_652 },
    displayName: 'E. coli K-12 MG1655',
    drawing: { phase: 'active' },
    tracks: new Map(),
    hoverTracks: [
      hoverTrack(
        'terminators:terminator-hairpin',
        'terminator',
        [forwardTerminator, reverseTerminator],
        termite
      ),
      hoverTrack('promoters:promoter-arrow', 'promoter', [promoter], {
        label: 'Promoter windows',
        spdx: 'LicenseRef-DNAForge-generated',
        attribution: 'Promoter windows computed by DNAForge from start sites.',
      }),
    ],
  });
  const mapRef = { current: { getLinearRenderer: () => fakeRenderer(lodByTrack) } };
  const { container } = render(
    <div data-testid="map-pane">
      <SequenceAnnotationCatalogHover ownerTabId={TAB_ID} mapRef={mapRef} />
    </div>
  );
  const pane = container.querySelector<HTMLElement>('[data-testid="map-pane"]');
  if (!pane) throw new Error('pane should render');
  return { pane, termite };
}

function hover(pane: HTMLElement, clientX: number, clientY: number) {
  fireEvent.mouseMove(pane, { clientX, clientY });
  act(() => {
    for (const callback of frames.splice(0)) callback(0);
  });
}

const text = (testId: string) => screen.getByTestId(testId).textContent;

describe('SequenceAnnotationCatalogHover', () => {
  it('shows the exact attribution, a plain license name, and 1-based positions with the measured 3′ end', () => {
    const { pane, termite } = setUp();

    hover(pane, xAt(4_175_920.5), TERMINATOR_BOX.topPx + 10);

    expect(screen.getByTestId('annotation-catalog-tooltip').textContent).toContain(
      'tufB terminator'
    );
    expect(text('annotation-catalog-tooltip-position')).toBe(
      'Positions 4,175,900–4,175,940 · 3′ end at 4,175,931'
    );
    expect(text('annotation-catalog-tooltip-license')).toBe('CC BY 4.0');
    expect(text('annotation-catalog-tooltip-attribution')).toBe(termite.attribution);
  });

  it('answers with a record from the strand half under the pointer only', () => {
    const { pane } = setUp();

    hover(pane, xAt(4_175_920.5), TERMINATOR_BOX.topPx + 45);

    expect(screen.getByTestId('annotation-catalog-tooltip').textContent).toContain(
      'reverse terminator'
    );
    expect(text('annotation-catalog-tooltip-position')).toBe('Positions 4,175,911–4,175,925');
  });

  it('shows the promoter start as a 1-based position', () => {
    const { pane } = setUp();

    hover(pane, xAt(4_175_900.5), PROMOTER_BOX.topPx + 5);

    expect(text('annotation-catalog-tooltip-position')).toBe(
      'Positions 4,175,861–4,175,921 · Starts at 4,175,921'
    );
    expect(text('annotation-catalog-tooltip-license')).toBe('Computed by DNAForge');
  });

  it('stays silent while the track draws zoomed-out density bars', () => {
    const { pane } = setUp({ 'terminators:terminator-hairpin': 'aggregate' });

    hover(pane, xAt(4_175_920.5), TERMINATOR_BOX.topPx + 10);

    expect(screen.queryByTestId('annotation-catalog-tooltip')).toBeNull();
  });
});
