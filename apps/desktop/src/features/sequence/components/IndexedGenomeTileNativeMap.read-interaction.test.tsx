import { userMessage } from '@waypoint/user-messages';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Genome, ReadHitPayload } from '@waypoint/genome-renderer';
import { IndexedGenomeTileNativeMap } from './IndexedGenomeTileNativeMap';

const pixi = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  renderer: null as {
    locateRead: (read: unknown) => unknown;
    hitTestReadEvent?: (x: number, y: number) => ReadHitPayload | null;
    getLaneScreenSnapshot?: () => { canvasContentHeightPx: number | null };
  } | null,
  presentedListener: null as (() => void) | null,
}));

vi.mock('@waypoint/genome-renderer/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/genome-renderer/react')>();
  return {
    ...actual,
    useIndexedPixiMap: (options: Record<string, unknown>) => {
      pixi.options = options;
      return {
        containerRef: { current: null },
        handle: {
          getState: () => ({
            width: 800,
            height: 400,
            highlightRange: null,
            cursorPosition: null,
          }),
          requestRender: vi.fn(),
          getViewCenter: () => 3_750,
          getViewportRange: () => ({ start: 3_650, end: 3_850 }),
          setCameraViewport: vi.fn(),
          setViewCenter: vi.fn(),
          setDisplaySize: vi.fn(),
          getLinearRenderer: () => pixi.renderer,
          subscribeToPresentedFrames: (listener: () => void) => {
            pixi.presentedListener = listener;
            return () => {
              if (pixi.presentedListener === listener) pixi.presentedListener = null;
            };
          },
          schedulePostPresentWork: (work: () => void) => work(),
        },
      };
    },
  };
});

const genome: Genome = {
  name: 'S. cerevisiae chrIV reads',
  sourceIdentity: 's288c-chriv',
  length: 1_531_933,
  circular: false,
  annotationLayerTypes: [],
  features: [],
};

const hit: ReadHitPayload = {
  trackId: 'cram-track',
  sourceGenerationKey: '',
  readId: 'chrIV-read-00',
  chrom: 'chrIV',
  referenceStart: 3_700,
  start: 3_700,
  end: 3_800,
  flag: 0,
  strand: '+',
  mapq: 60,
  bodyRect: { left: 120, top: 80, width: 240, height: 8 },
  trackRect: { left: 0, top: 60, width: 800, height: 100 },
  screenX: 220,
  screenY: 84,
};

const readSourcesByTrackId = new Map([
  [
    'cram-track',
    {
      bamPath: '/fixtures/reads.cram',
      indexPath: '/fixtures/reads.cram.crai',
      referencePath: '/fixtures/chrIV.fa',
    },
  ],
]);

function renderMap(themeMode: 'light' | 'dark' = 'light') {
  return render(
    <IndexedGenomeTileNativeMap
      genome={genome}
      themeMode={themeMode}
      width={800}
      height={400}
      readSourcesByTrackId={readSourcesByTrackId}
    />
  );
}

describe('IndexedGenomeTileNativeMap exact-read interaction', () => {
  it('passes residue numbering and shared codon identity through the actual native hook boundary', () => {
    const hoveredCodon = { start: 12, end: 14, strand: 1 as const };
    const selectedCodons = [{ start: 15, end: 17, strand: -1 as const }];
    const onCodonHover = vi.fn();
    render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        themeMode="light"
        width={800}
        height={400}
        showResidueNumbers
        hoveredCodon={hoveredCodon}
        selectedCodons={selectedCodons}
        onCodonHover={onCodonHover}
      />
    );
    expect(pixi.options?.showResidueNumbers).toBe(true);
    expect(pixi.options?.hoveredCodon).toBe(hoveredCodon);
    expect(pixi.options?.selectedCodons).toBe(selectedCodons);
    const mapCodonHover = pixi.options?.onCodonHover;
    if (typeof mapCodonHover !== 'function') throw new Error('Native codon hover is unavailable.');
    act(() => mapCodonHover(hoveredCodon));
    expect(onCodonHover).toHaveBeenCalledExactlyOnceWith(hoveredCodon);
    expect(onCodonHover.mock.calls[0][0]).toBe(hoveredCodon);
  });
  beforeEach(() => {
    pixi.renderer = null;
    pixi.presentedListener = null;
    vi.stubEnv('VITE_API_URL', 'http://sidecar.test');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps the full scroll host while the drawing canvas follows the track stack', () => {
    let contentHeight = 190;
    pixi.renderer = {
      locateRead: () => null,
      getLaneScreenSnapshot: () => ({ canvasContentHeightPx: contentHeight }),
    };
    const view = renderMap();

    act(() => pixi.presentedListener?.());
    expect(pixi.options?.height).toBe(190);
    expect(pixi.options?.geometryHeight).toBe(190);
    expect(pixi.options?.capCanvasToProvidedHeight).toBe(true);
    expect(screen.getByTestId('indexed-genome-webgl-map').style.height).toBe('400px');

    contentHeight = 600;
    act(() => pixi.presentedListener?.());
    expect(pixi.options?.height).toBe(400);

    contentHeight = 190;
    view.rerender(
      <IndexedGenomeTileNativeMap
        genome={genome}
        themeMode="light"
        width={800}
        height={400}
        allowSparseCanvasCrop={false}
        readSourcesByTrackId={readSourcesByTrackId}
      />
    );
    act(() => pixi.presentedListener?.());
    expect(pixi.options?.height).toBe(400);
  });

  it('forwards sequence selection and context-menu callbacks to the indexed renderer', () => {
    const onContextMenu = vi.fn();
    const onSelectionChange = vi.fn();
    const onSelectionClear = vi.fn();
    render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        themeMode="light"
        width={800}
        height={400}
        onContextMenu={onContextMenu}
        onSelectionChange={onSelectionChange}
        onSelectionClear={onSelectionClear}
      />
    );

    expect(pixi.options?.onContextMenu).toBe(onContextMenu);
    expect(pixi.options?.onSelectionChange).toBe(onSelectionChange);
    expect(pixi.options?.onPositionClick).toBe(onSelectionClear);
    expect(pixi.options?.onOrfClick).toBe(onSelectionClear);
  });

  it('uses resident metadata for whole-read hover without requesting details', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const locateRead = vi.fn((): ReadHitPayload | null => hit);
    pixi.renderer = { locateRead };
    renderMap();

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(hit);
    });

    expect(screen.getByTestId('indexed-read-hover-highlight').style.cssText).toContain(
      'left: 120px'
    );
    expect(screen.getByTestId('indexed-read-hover-highlight').style.cssText).toContain('top: 80px');
    expect(screen.getByTestId('indexed-read-hover-highlight').style.cssText).toContain(
      'width: 240px'
    );
    expect(screen.getByTestId('indexed-read-hover-highlight').style.cssText).toContain(
      'height: 8px'
    );
    expect(screen.queryByTestId('indexed-read-selection')).toBeNull();
    const tooltip = screen.getByTestId('indexed-read-tooltip');
    expect(tooltip.textContent).toContain('chrIV-read-00');
    expect(tooltip.textContent).toContain('chrIV:3701-3800');
    expect(tooltip.textContent).toContain('MAPQ 60');
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)({
        ...hit,
        event: { pos: 3_750, kind: 'sub', refBase: 'A', readBase: 'G' },
      });
    });
    expect(screen.getByTestId('read-difference-tooltip').textContent).toContain('chrIV:3751');
    expect(screen.getByTestId('read-difference-tooltip').textContent).toContain('A → G');
    expect(screen.getByTestId('read-difference-tooltip').textContent).toContain('BAM column:');
    expect(fetchSpy).not.toHaveBeenCalled();

    locateRead.mockReturnValue(null);
    act(() => pixi.presentedListener?.());
    expect(screen.queryByTestId('indexed-read-tooltip')).toBeNull();
    expect(screen.queryByTestId('indexed-read-hover-highlight')).toBeNull();

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(hit);
    });
    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(null);
    });
    expect(screen.queryByTestId('indexed-read-tooltip')).toBeNull();
    expect(screen.queryByTestId('indexed-read-hover-highlight')).toBeNull();
  });

  it('fetches a spliced read by its complete alignment start while labeling the clicked exon', async () => {
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchSpy);
    renderMap();
    const laterExonHit: ReadHitPayload = {
      ...hit,
      referenceStart: 2_459,
      referenceBlockStart: 3_700,
      start: 3_700,
      end: 3_800,
    };

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(laterExonHit);
    });

    expect(screen.getByTestId('indexed-read-details').textContent).toContain('chrIV:3701-3800');
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://sidecar.test/tiles/alignment/read',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            bamPath: '/fixtures/reads.cram',
            indexPath: '/fixtures/reads.cram.crai',
            referencePath: '/fixtures/chrIV.fa',
            chrom: 'chrIV',
            readId: 'chrIV-read-00',
            referenceStart: 2_459,
            flag: 0,
          }),
        })
      );
    });
  });

  it('keeps hover mounted while the pointer crosses the read-owned half of a row gap', () => {
    const gapHit: ReadHitPayload = {
      ...hit,
      hitRect: { left: 120, top: 79.5, width: 240, height: 9 },
      screenY: 88.25,
    };
    const locateRead = vi.fn((): ReadHitPayload | null => gapHit);
    pixi.renderer = { locateRead };
    renderMap();

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(gapHit);
    });
    expect(screen.getByTestId('indexed-read-tooltip')).toBeTruthy();

    act(() => pixi.presentedListener?.());

    expect(locateRead).toHaveBeenCalled();
    expect(screen.getByTestId('indexed-read-tooltip')).toBeTruthy();
    expect(screen.getByTestId('indexed-read-hover-highlight')).toBeTruthy();
  });

  it('uses persistent selected markup that is distinct from transient hover markup', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    renderMap();

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(hit);
    });
    const hoverMarkup = screen.getByTestId('indexed-read-hover-highlight');
    expect(hoverMarkup.dataset.readState).toBe('hovered');

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    const trackClip = screen.getByTestId('indexed-read-selection-track-clip');
    const selectedMarkup = screen.getByTestId('indexed-read-selection');
    expect(trackClip.style.overflow).toBe('hidden');
    expect(trackClip.style.left).toBe('0px');
    expect(trackClip.style.top).toBe('60px');
    expect(trackClip.style.width).toBe('800px');
    expect(trackClip.style.height).toBe('100px');
    expect(selectedMarkup.dataset.readState).toBe('selected');
    expect(screen.queryByTestId('indexed-read-tooltip')).toBeNull();
    expect(selectedMarkup.style.cssText).not.toBe(hoverMarkup.style.cssText);
    expect(selectedMarkup.style.outline).toBe('');
    expect(selectedMarkup.style.border).toBe('');
    expect(hoverMarkup.style.backgroundColor).toBe('transparent');
    expect(selectedMarkup.style.backgroundColor).toBe('transparent');
    expect(hoverMarkup.style.backdropFilter).toBe('brightness(0.82) saturate(2)');
    expect(selectedMarkup.style.backdropFilter).toBe('brightness(0.82) saturate(2)');
    expect(selectedMarkup.style.boxShadow).toContain('9999px');
    expect(selectedMarkup.style.boxShadow).toContain('var(--color-bg) / 0.42');
    expect(selectedMarkup.style.left).toBe('120px');
    expect(selectedMarkup.style.top).toBe('20px');
    expect(`${hoverMarkup.style.cssText}${selectedMarkup.style.cssText}`).not.toContain(
      '--color-accent'
    );
    expect(Number(hoverMarkup.style.zIndex)).toBeGreaterThan(Number(selectedMarkup.style.zIndex));
    expect(selectedMarkup.childElementCount).toBe(0);

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)({
        ...hit,
        readId: 'chrIV-read-01',
        referenceStart: 3_703,
        start: 3_703,
        end: 3_803,
        bodyRect: { left: 132, top: 88, width: 240, height: 8 },
      });
    });
    expect(screen.getByTestId('indexed-read-hover-highlight').style.cssText).toContain(
      'left: 132px'
    );
    expect(screen.getByTestId('indexed-read-selection').style.cssText).toContain('left: 120px');
    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(null);
    });
    expect(screen.queryByTestId('indexed-read-hover-highlight')).toBeNull();
    expect(screen.getByTestId('indexed-read-selection')).toBeTruthy();
  });

  it('pins the committed hover read when the canvas pointer path misses it', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    const hitTestReadEvent = vi.fn(() => null);
    pixi.renderer = { locateRead: vi.fn(() => hit), hitTestReadEvent };
    renderMap();

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(hit);
    });
    const map = screen.getByTestId('indexed-genome-webgl-map');
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 400,
        width: 800,
        height: 400,
        toJSON: () => undefined,
      }) as DOMRect;
    map.prepend(canvas);

    fireEvent(
      screen.getByTestId('indexed-read-hover-highlight'),
      new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: hit.screenX,
        clientY: hit.screenY,
      })
    );

    expect(hitTestReadEvent).not.toHaveBeenCalled();
    expect(screen.getByTestId('indexed-read-selection')).toBeTruthy();
    expect(screen.getByTestId('indexed-read-details')).toHaveTextContent('Loading read details…');
  });

  it('does not duplicate a read request after the canvas pointer path already handled it', async () => {
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchSpy);
    pixi.renderer = {
      locateRead: vi.fn(() => hit),
      hitTestReadEvent: vi.fn(() => hit),
    };
    renderMap();
    const map = screen.getByTestId('indexed-genome-webgl-map');
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 400,
        width: 800,
        height: 400,
        toJSON: () => undefined,
      }) as DOMRect;
    map.prepend(canvas);

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    fireEvent(
      canvas,
      new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: hit.screenX,
        clientY: hit.screenY,
      })
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  });

  it('keeps horizontal camera scrolling active over the pinned details card', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    renderMap();
    const host = screen.getByTestId('indexed-genome-webgl-map');
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const forwarded: WheelEvent[] = [];
    canvas.addEventListener('wheel', (event) => forwarded.push(event));

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    const details = screen.getByTestId('indexed-read-details');
    const ordinaryWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 200,
      deltaX: 0,
      deltaY: 120,
    });
    details.dispatchEvent(ordinaryWheel);

    expect(forwarded).toHaveLength(1);
    expect(ordinaryWheel.defaultPrevented).toBe(true);
    expect(forwarded[0]?.deltaY).toBe(120);
    expect(forwarded[0]?.clientX).toBe(400);

    const horizontalTrackpad = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: -80,
      deltaY: 2,
    });
    details.dispatchEvent(horizontalTrackpad);

    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]?.deltaX).toBe(-80);
  });

  it('keeps the dark-mode hover intensity at its existing level', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    renderMap('dark');

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(hit);
    });

    expect(screen.getByTestId('indexed-read-hover-highlight').style.backdropFilter).toBe(
      'brightness(1.18)'
    );
    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    expect(screen.getByTestId('indexed-read-selection').style.backdropFilter).toBe(
      'brightness(1.1)'
    );
  });

  it('keeps an adjacent-read hover preview beside the pointer when another read is pinned', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    renderMap();

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)({
        ...hit,
        readId: 'chrIV-read-01',
        referenceStart: 3_703,
        start: 3_703,
        end: 3_803,
        bodyRect: { left: 132, top: 88, width: 240, height: 8 },
      });
    });

    const adjacentTooltip = screen.getByTestId('indexed-read-tooltip');
    expect(adjacentTooltip.style.left).toBe('232px');
    expect(adjacentTooltip.style.top).toBe('18px');
    const pinnedCard = screen.getByTestId('indexed-read-details');
    expect(parseFloat(adjacentTooltip.style.top) + 54).toBeLessThanOrEqual(
      parseFloat(pinnedCard.style.top)
    );
  });

  it('keeps hover and pinned cards beside the pointer for a read wider than the viewport', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    renderMap();
    const wideRead: ReadHitPayload = {
      ...hit,
      bodyRect: { left: -2_000, top: 80, width: 5_000, height: 8 },
      screenX: 620,
      screenY: 84,
    };

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(wideRead);
    });
    const hoverCard = screen.getByTestId('indexed-read-tooltip');
    expect(hoverCard.style.left).toBe('358px');
    expect(hoverCard.style.top).toBe('96px');

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(wideRead);
    });
    const pinnedCard = screen.getByTestId('indexed-read-details');
    expect(pinnedCard.style.left).toBe('268px');
    expect(pinnedCard.style.top).toBe('96px');
  });

  it('pins resident metadata, loads richer details, survives pointer exit, and closes explicitly', async () => {
    const response = Promise.withResolvers<Response>();
    const fetchSpy = vi.fn(() => response.promise);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderMap();

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });

    expect(screen.getByTestId('indexed-read-details').textContent).toContain('chrIV-read-00');
    expect(screen.getByTestId('indexed-read-details').textContent).toContain(
      'Loading read details'
    );
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://sidecar.test/tiles/alignment/read',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            bamPath: '/fixtures/reads.cram',
            indexPath: '/fixtures/reads.cram.crai',
            referencePath: '/fixtures/chrIV.fa',
            chrom: 'chrIV',
            readId: 'chrIV-read-00',
            referenceStart: 3_700,
            flag: 0,
          }),
        })
      );
    });

    act(() => {
      (pixi.options?.onReadHoverChange as (value: ReadHitPayload | null) => void)(null);
    });
    expect(screen.getByTestId('indexed-read-details')).toBeTruthy();

    response.resolve(
      new Response(
        JSON.stringify({
          readId: 'chrIV-read-00',
          chrom: 'chrIV',
          start: 3_700,
          end: 3_800,
          strand: '+',
          mapq: 60,
          flag: 0,
          cigar: '100M',
          seq: 'ACG',
          baseQualities: [10, 15, 19],
          tags: { RG: 'fixture', NM: 0 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await waitFor(() => {
      expect(screen.getByTestId('indexed-read-details').textContent).toContain('100M');
    });
    const metadataGrid = screen.getByTestId('indexed-read-metadata-grid');
    const coreMetadata = screen.getByTestId('indexed-read-core-metadata');
    const tagMetadata = screen.getByTestId('indexed-read-tag-metadata');
    expect(metadataGrid.style.display).toBe('grid');
    expect(metadataGrid.style.gridTemplateColumns).toContain('minmax(0, 1fr)');
    expect(metadataGrid).toContainElement(coreMetadata);
    expect(metadataGrid).toContainElement(tagMetadata);
    expect(coreMetadata.textContent).toContain('CIGAR');
    expect(coreMetadata.textContent).toContain('FLAG');
    expect(tagMetadata.textContent).toContain('Tags');
    expect(screen.getByTestId('indexed-read-details').textContent).toContain('RG fixture');
    expect(screen.getByTestId('indexed-read-details').textContent).toContain('ACG');
    const bases = screen.getAllByTestId('indexed-read-sequence-base');
    expect(bases.map((base) => base.dataset.phred)).toEqual(['10', '15', '19']);
    expect(bases[0]?.style.color).not.toBe(bases[1]?.style.color);
    expect(bases[1]?.style.color).not.toBe(bases[2]?.style.color);
    expect(bases[0]?.title).toContain('Phred Q10');
    expect(bases[2]?.title).toContain('Phred Q19');
    const sequenceHeader = screen.getByTestId('indexed-read-sequence-header');
    const qualityLegend = screen.getByTestId('indexed-read-phred-legend');
    expect(sequenceHeader).toContainElement(qualityLegend);
    expect(sequenceHeader.style.display).toBe('flex');
    expect(qualityLegend.style.display).toBe('inline-flex');
    expect(qualityLegend.style.marginTop).toBe('');
    expect(qualityLegend.style.marginLeft).toBe('auto');
    expect(qualityLegend).toHaveAttribute('aria-label', 'Phred base-quality color legend');
    const qualityLabel = screen.getByTestId('indexed-read-phred-label');
    expect(qualityLabel.textContent).toBe('Phred');
    expect(qualityLabel.style.textAlign).toBe('right');
    expect(qualityLegend.textContent).toContain('Q0');
    expect(qualityLegend.textContent).toContain('10');
    expect(qualityLegend.textContent).toContain('20');
    expect(qualityLegend.textContent).toContain('30');
    expect(qualityLegend.textContent).toContain('40+');
    const qualityScale = screen.getByTestId('indexed-read-phred-scale');
    const qualityTickRow = screen.getByTestId('indexed-read-phred-ticks');
    expect(qualityLegend).toContainElement(qualityScale);
    expect(qualityScale.style.position).toBe('relative');
    expect(qualityScale.style.width).toBe('100px');
    expect(qualityTickRow.style.position).toBe('absolute');
    const qualityGradient = screen.getByTestId('indexed-read-phred-gradient');
    expect(qualityGradient.style.backgroundImage).toContain('linear-gradient');
    expect(qualityGradient.style.height).toBe('3px');
    expect(qualityGradient.parentElement).toBe(qualityScale);
    const qualityTicks = screen.getAllByTestId('indexed-read-phred-tick');
    expect(qualityTicks).toHaveLength(5);
    expect(qualityTicks.every((tick) => qualityTickRow.contains(tick))).toBe(true);
    expect(qualityTicks.every((tick) => tick.style.fontSize === '7px')).toBe(true);
    expect(qualityTicks.every((tick) => !qualityGradient.contains(tick))).toBe(true);
    expect(screen.queryByTestId('indexed-read-phred-swatch')).toBeNull();

    const copyButton = screen.getByRole('button', { name: 'Copy all read details' });
    expect(copyButton.parentElement).toBe(
      screen.getByTestId('indexed-read-details-header-actions')
    );
    expect(copyButton.textContent).toBe('');
    expect(copyButton.dataset.copyState).toBe('idle');
    expect(copyButton.style.width).toBe('20px');
    expect(copyButton.style.height).toBe('20px');

    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(writeText.mock.calls[0]![0]) as Record<string, unknown>;
    expect(copied).toMatchObject({
      readId: 'chrIV-read-00',
      chrom: 'chrIV',
      start: 3_700,
      end: 3_800,
      strand: '+',
      mapq: 60,
      flag: 0,
      cigar: '100M',
      seq: 'ACG',
      baseQualities: [10, 15, 19],
      tags: { RG: 'fixture', NM: 0 },
    });
    expect(copyButton.dataset.copyState).toBe('copied');
    expect(copyButton.textContent).toBe('');
    expect(copyButton.querySelector('svg')).toBeTruthy();
    await waitFor(() => expect(copyButton.dataset.copyState).toBe('idle'), { timeout: 2_500 });
    expect(copyButton.title).toBe('Copy read details');

    fireEvent.click(screen.getByRole('button', { name: 'Close read details' }));
    expect(screen.queryByTestId('indexed-read-details')).toBeNull();
  });

  it('contains route failures in the pinned card and dismisses on Escape or empty click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'read no longer exists' }), { status: 404 })
      )
    );
    renderMap();

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    await waitFor(() => {
      expect(screen.getByTestId('indexed-read-details').textContent).toContain(
        userMessage('readDetails.notFound')
      );
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('indexed-read-details')).toBeNull();

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    expect(screen.getByTestId('indexed-read-details')).toBeTruthy();
    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(null);
    });
    expect(screen.queryByTestId('indexed-read-details')).toBeNull();
  });

  it('uses the read-body Phred palette from red through blue in both themes', async () => {
    const details = {
      readId: hit.readId,
      chrom: hit.chrom,
      start: hit.referenceStart,
      end: hit.referenceStart + 5,
      strand: hit.strand,
      mapq: hit.mapq,
      flag: hit.flag,
      cigar: '5M',
      seq: 'ACGTA',
      baseQualities: [0, 10, 20, 30, 40],
      tags: {},
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(details), { status: 200 }))
    );

    const lightView = renderMap('light');
    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('indexed-read-sequence-base')).toHaveLength(5)
    );
    const lightColors = screen
      .getAllByTestId('indexed-read-sequence-base')
      .map((base) => base.style.color);
    const lightGradient = screen.getByTestId('indexed-read-phred-gradient').style.backgroundImage;
    lightView.unmount();

    renderMap('dark');
    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('indexed-read-sequence-base')).toHaveLength(5)
    );
    const darkColors = screen
      .getAllByTestId('indexed-read-sequence-base')
      .map((base) => base.style.color);
    const darkGradient = screen.getByTestId('indexed-read-phred-gradient').style.backgroundImage;

    expect(lightColors).toEqual([
      'rgb(221, 44, 44)',
      'rgb(233, 100, 12)',
      'rgb(206, 150, 9)',
      'rgb(56, 159, 76)',
      'rgb(29, 78, 216)',
    ]);
    expect(darkColors).toEqual([
      'rgb(221, 44, 44)',
      'rgb(233, 100, 12)',
      'rgb(206, 150, 9)',
      'rgb(56, 159, 76)',
      'rgb(29, 78, 216)',
    ]);
    expect(lightGradient).toContain('rgb(221, 44, 44) 0%');
    expect(lightGradient).toContain('rgb(29, 78, 216) 100%');
    expect(darkGradient).toContain('rgb(221, 44, 44) 0%');
    expect(darkGradient).toContain('rgb(29, 78, 216) 100%');
  });

  it('rejects a partial quality array instead of miscoloring the sequence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              readId: hit.readId,
              chrom: hit.chrom,
              start: hit.referenceStart,
              end: hit.referenceStart + 2,
              strand: hit.strand,
              mapq: hit.mapq,
              flag: hit.flag,
              cigar: '2M',
              seq: 'AC',
              baseQualities: [40],
              tags: {},
            }),
            { status: 200 }
          )
      )
    );
    renderMap();

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });

    await waitFor(() => {
      expect(screen.getByTestId('indexed-read-details').textContent).toContain(
        'invalid base qualities'
      );
    });
    expect(screen.queryByTestId('indexed-read-sequence')).toBeNull();
  });

  it('replaces a pinned read and ignores the retired request completion', async () => {
    const firstResponse = Promise.withResolvers<Response>();
    const secondResponse = Promise.withResolvers<Response>();
    const fetchSpy = vi
      .fn()
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    vi.stubGlobal('fetch', fetchSpy);
    renderMap();
    const replacement: ReadHitPayload = {
      ...hit,
      readId: 'chrIV-read-01',
      referenceStart: 3_703,
      start: 3_703,
      end: 3_803,
      flag: 16,
      bodyRect: { left: 132, top: 88, width: 240, height: 8 },
    };

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(replacement);
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    firstResponse.resolve(
      new Response(
        JSON.stringify({
          readId: hit.readId,
          chrom: hit.chrom,
          start: hit.referenceStart,
          end: hit.referenceStart + 100,
          strand: hit.strand,
          mapq: hit.mapq,
          flag: hit.flag,
          cigar: 'retired',
          seq: '',
          tags: {},
        }),
        { status: 200 }
      )
    );
    await Promise.resolve();
    expect(screen.getByTestId('indexed-read-details').textContent).toContain('chrIV-read-01');
    expect(screen.getByTestId('indexed-read-details').textContent).not.toContain('retired');

    secondResponse.resolve(
      new Response(
        JSON.stringify({
          readId: replacement.readId,
          chrom: replacement.chrom,
          start: replacement.referenceStart,
          end: replacement.referenceStart + 100,
          strand: replacement.strand,
          mapq: replacement.mapq,
          flag: replacement.flag,
          cigar: 'replacement',
          seq: '',
          tags: {},
        }),
        { status: 200 }
      )
    );
    await waitFor(() => {
      expect(screen.getByTestId('indexed-read-details').textContent).toContain('replacement');
    });
  });

  it('reanchors after presentation and closes when the read or source leaves authority', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    const relocated: ReadHitPayload = {
      ...hit,
      bodyRect: { left: 333, top: 96, width: 240, height: 8 },
    };
    const locateRead = vi.fn((): ReadHitPayload | null => relocated);
    pixi.renderer = { locateRead };
    const view = renderMap();

    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    act(() => pixi.presentedListener?.());
    expect(screen.getByTestId('indexed-read-selection').style.cssText).toContain('left: 333px');
    expect(screen.getByTestId('indexed-read-details').style.left).toBe('445px');

    locateRead.mockReturnValue({
      ...relocated,
      trackRect: { left: 0, top: 60, width: 760, height: 120 },
    });
    act(() => pixi.presentedListener?.());
    expect(screen.getByTestId('indexed-read-selection-track-clip').style.width).toBe('760px');
    expect(screen.getByTestId('indexed-read-selection-track-clip').style.height).toBe('120px');

    locateRead.mockReturnValue(null);
    act(() => pixi.presentedListener?.());
    expect(screen.queryByTestId('indexed-read-details')).toBeNull();

    pixi.renderer = null;
    view.rerender(
      <IndexedGenomeTileNativeMap
        genome={genome}
        themeMode="light"
        width={800}
        height={400}
        readSourcesByTrackId={readSourcesByTrackId}
      />
    );
    act(() => {
      (pixi.options?.onReadClick as (value: ReadHitPayload | null) => void)(hit);
    });
    view.rerender(
      <IndexedGenomeTileNativeMap
        genome={genome}
        themeMode="light"
        width={800}
        height={400}
        readSourcesByTrackId={new Map()}
      />
    );
    expect(screen.queryByTestId('indexed-read-details')).toBeNull();
  });
});
