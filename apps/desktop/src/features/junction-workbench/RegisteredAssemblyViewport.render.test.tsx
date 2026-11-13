/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EDITOR_CONFIG, type PrimerDisplay } from '@waypoint/workspace-editor';
import { reverseComplement } from '@waypoint/sequence-utils';
import { RegisteredAssemblyViewport } from './RegisteredAssemblyViewport';
import {
  JUNCTION_WORKBENCH_HORIZONTAL_PADDING as JUNCTION_TEST_PADDING,
  makeMappingPoint,
  type CoordMappingRow,
} from './coord-mapping';
import { buildJunctionWorkbenchModels, type JunctionWorkbenchRow } from './model';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import { SOURCE_ROW_BUFFER_BP } from './registered-window';
import { buildRealAssemblyPipelineDesign } from '../../test/scenarios/assembly-real-pipeline';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../../../../../packages/core/workspace-editor/src/testing/recording-canvas-context';

const VIEWPORT_WIDTH = 720;
const VIEWPORT_HEIGHT = 420;
const SOURCE_ROW_BUFFER_WIDTH = SOURCE_ROW_BUFFER_BP * DEFAULT_EDITOR_CONFIG.charWidth * 2;

class ImmediateResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.cb(
      [
        {
          target,
          contentRect: {
            x: 0,
            y: 0,
            width: VIEWPORT_WIDTH,
            height: VIEWPORT_HEIGHT,
            top: 0,
            left: 0,
            bottom: VIEWPORT_HEIGHT,
            right: VIEWPORT_WIDTH,
            toJSON() {
              return {};
            },
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      if (element.closest?.('[data-registered-source-register-content-layer="true"]')) {
        return VIEWPORT_WIDTH + SOURCE_ROW_BUFFER_WIDTH;
      }
      return VIEWPORT_WIDTH;
    },
  });
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  });
});

beforeEach(() => {
  installRecordingCanvas();
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
});

describe('RegisteredAssemblyViewport', () => {
  it('renders a fixed-crossover viewport without creating a linked camera or scrollbar', async () => {
    const rows = makeRows();

    render(<RegisteredAssemblyViewport rows={rows} editableFields={[sourceBoundaryField()]} />);

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    expect(viewport).toHaveAttribute('data-registered-scroll-authority', 'fixed-crossover');
    expect(viewport).toHaveAttribute('data-registered-camera-bio-col', '0');
    expect(viewport).toHaveAttribute('data-registered-source-rows-visible', 'false');
    expect(screen.getAllByTestId('sequence-viewer-1d')).toHaveLength(1);
    expect(
      screen.getByTestId('registered-assembly-source-register-product-owner-layer-left')
    ).toHaveAttribute('data-registered-source-register-product-owner-rendered', 'false');
    expect(
      screen.getByTestId('registered-assembly-source-register-product-owner-layer-right')
    ).toHaveAttribute('data-registered-source-register-product-owner-rendered', 'false');
    expect(screen.queryByTestId('junction-row-left-source')).toBeNull();
    expect(screen.queryByTestId('junction-row-right-source')).toBeNull();
    expect(screen.queryByTestId('linked-camera-group')).toBeNull();
    expect(screen.queryByTestId('linked-camera-scrollbar')).toBeNull();
    expect(screen.getByTestId('junction-row-label-product')).toContainElement(
      screen.getByTestId('registered-assembly-source-rows-toggle')
    );

    fireEvent.click(screen.getByTestId('registered-assembly-source-rows-toggle'));

    expect(viewport).toHaveAttribute('data-registered-source-rows-visible', 'true');
    expect(screen.getAllByTestId('sequence-viewer-1d')).toHaveLength(3);
    expect(readRegisteredScrollLefts()).toEqual({
      left: 288,
      right: 288,
      product: 288,
    });
    expect(screen.getByTestId('junction-row-left-source')).toHaveAttribute(
      'data-anchor-row-position',
      '80'
    );
  });

  it('centers registered rows on the explicit viewport focus instead of the bioCol zero anchor', async () => {
    const focusBioCol = 12;
    const rows = makeRows().map((item) => ({
      ...item,
      viewportFocusBioCol: focusBioCol,
      viewportFocusRowPosition: item.anchorRowPosition + focusBioCol,
    }));

    render(<RegisteredAssemblyViewport rows={rows} editableFields={[sourceBoundaryField()]} />);

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    expect(viewport).toHaveAttribute('data-registered-camera-bio-col', String(focusBioCol));
    fireEvent.click(screen.getByTestId('registered-assembly-source-rows-toggle'));

    const expectedScrollLeft =
      JUNCTION_TEST_PADDING +
      (80 + focusBioCol) * DEFAULT_EDITOR_CONFIG.charWidth -
      VIEWPORT_WIDTH / 2;
    expect(readRegisteredScrollLefts()).toEqual({
      left: expectedScrollLeft,
      right: expectedScrollLeft,
      product: expectedScrollLeft,
    });
    expect(screen.getByTestId('junction-row-product')).toHaveAttribute(
      'data-viewport-focus-row-position',
      String(80 + focusBioCol)
    );
  });

  it('side-scrolls the registered junction window while keeping all visible rows linked', async () => {
    const rows = makeRows();

    render(<RegisteredAssemblyViewport rows={rows} editableFields={[sourceBoundaryField()]} />);

    await act(async () => {
      await flushFrames();
    });

    fireEvent.click(screen.getByTestId('registered-assembly-source-rows-toggle'));
    fireEvent.wheel(screen.getByTestId('registered-assembly-pan-surface-product'), {
      deltaX: 32,
      deltaY: 0,
    });

    expect(screen.getByTestId('registered-assembly-viewport')).toHaveAttribute(
      'data-registered-side-scroll-offset',
      '32'
    );
    expect(readRegisteredScrollLefts()).toEqual({
      left: 320,
      right: 320,
      product: 320,
    });
  });

  it('does not side-scroll RD/spacer source rows past their real sequence extent', async () => {
    const design = buildRealAssemblyPipelineDesign('nebuilder-rd-spacer');
    const model = buildJunctionWorkbenchModels(design).find((item) => item.junctionIndex === 0);
    expect(model).toBeDefined();
    expect(model!.rows[0].kind).toBe('left-source');
    expect(model!.rows[2].kind).toBe('product');
    expect(model!.rows[2].spacerColumns?.length).toBeGreaterThan(0);
    expect(model!.rows[0].sourceProvenance?.digestBoundaries.length).toBeGreaterThan(0);
    expect(model!.rows[1].sourceProvenance?.digestBoundaries.length ?? 0).toBe(0);

    render(<RegisteredAssemblyViewport rows={model!.rows} defaultSourceRowsVisible />);

    await act(async () => {
      await flushFrames();
    });

    const before = sourceRowOverlaySnapshot('left-source');
    fireEvent.wheel(screen.getByTestId('registered-assembly-pan-surface-product'), {
      deltaX: 100_000,
      deltaY: 0,
    });
    await act(async () => {
      await flushFrames();
    });
    const after = sourceRowOverlaySnapshot('left-source');

    for (const row of [
      screen.getByTestId('junction-row-left-source'),
      screen.getByTestId('junction-row-right-source'),
      screen.getByTestId('junction-row-product'),
    ]) {
      assertNoBlankSideScroll(row);
    }
    expect(after.scrollLeft).toBeGreaterThan(before.scrollLeft);
    expect(after.sourceSegmentLeft - before.sourceSegmentLeft).toBeCloseTo(
      -(after.scrollLeft - before.scrollLeft),
      4
    );
    expect(after.primerOverlayScrollLeft).toBe(after.scrollLeft);
    expect(after.contentCanvasScrollLeft + after.contentBufferPx).toBeCloseTo(after.scrollLeft, 4);
  });

  it('ignores vertical wheel deltas in registered junction card viewers', async () => {
    const rows = makeRows();

    render(<RegisteredAssemblyViewport rows={rows} editableFields={[sourceBoundaryField()]} />);

    await act(async () => {
      await flushFrames();
    });

    fireEvent.click(screen.getByTestId('registered-assembly-source-rows-toggle'));
    fireEvent.wheel(screen.getByTestId('registered-assembly-pan-surface-product'), {
      deltaX: 0,
      deltaY: 48,
    });

    expect(screen.getByTestId('registered-assembly-viewport')).toHaveAttribute(
      'data-registered-side-scroll-offset',
      '0'
    );
    expect(readRegisteredScrollLefts()).toEqual({
      left: 288,
      right: 288,
      product: 288,
    });
  });

  it('renders junction controls inside a narrow product side overview', async () => {
    const rows = makeRows();

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        productControls={<button type="button">J1</button>}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    expect(screen.getByTestId('junction-row-product-controls')).toHaveTextContent('J1');
    expect(screen.getByTestId('junction-row-label-product')).toHaveAttribute(
      'data-side-overview-tone',
      'control'
    );
    expect(screen.queryByTestId('junction-row-product-accent-rail')).not.toBeInTheDocument();
    expect(screen.getByTestId('junction-row-label-product')).toHaveStyle({
      borderColor: 'transparent',
    });
    expect(screen.getByTestId('junction-row-label-product')).toContainElement(
      screen.getByTestId('junction-row-product-controls')
    );
    expect(screen.getByTestId('junction-row-label-left-source')).not.toHaveTextContent('J1');
    expect(screen.getByTestId('junction-row-label-right-source')).not.toHaveTextContent('J1');
  });

  it('masks source-row backgrounds per contribution column instead of painting the whole row', async () => {
    const rows = makeRows();

    render(<RegisteredAssemblyViewport rows={rows} defaultSourceRowsVisible />);

    await act(async () => {
      await flushFrames();
    });

    const productBackground = screen.getByTestId(
      'registered-assembly-source-lane-background-product'
    );
    expect(productBackground).toHaveAttribute('data-source-lane-background-segment-count', '2');
    expect(
      productBackground.querySelectorAll('[data-source-lane-background-segment="left"]')
    ).toHaveLength(1);
    expect(
      productBackground.querySelectorAll('[data-source-lane-background-segment="right"]')
    ).toHaveLength(1);
    expect(
      productBackground.querySelector<HTMLElement>('[data-source-lane-background-segment="left"]')
        ?.style.backgroundColor
    ).toBe('rgba(56, 189, 248, 0.14)');

    const leftSourceBackground = screen.getByTestId(
      'registered-assembly-source-lane-background-left-source'
    );
    expect(leftSourceBackground).toHaveAttribute('data-source-lane-background-segment-count', '3');
    expect(
      leftSourceBackground.querySelectorAll('[data-source-lane-background-segment="muted"]')
    ).toHaveLength(2);
    expect(
      leftSourceBackground.querySelectorAll('[data-source-lane-background-segment="source"]')
    ).toHaveLength(1);
    expect(
      leftSourceBackground.querySelector<HTMLElement>(
        '[data-source-lane-background-segment="muted"]'
      )?.style.backgroundColor
    ).toBe('rgba(156, 163, 175, 0.12)');
    expect(
      leftSourceBackground.querySelector<HTMLElement>('[data-source-lane-background-segment]')
        ?.style.backgroundColor
    ).not.toBe('rgba(56, 189, 248, 0.14)');
    for (const viewer of screen.getAllByTestId('sequence-viewer-1d')) {
      expect(viewer).toHaveAttribute('data-transparent-background', 'true');
    }
  });

  it('keeps the settled product row stable while product drag preview uses preview CDSs', async () => {
    const rows = makeRows();
    rows[2] = {
      ...rows[2],
      annotations: [
        {
          name: 'settled-product-cds',
          type: 'CDS',
          start: 8,
          end: 32,
          direction: 1,
          color: '#16a34a',
        },
      ],
      productDragPreview: {
        owner: 'left',
        sequence: rows[2].sequence.replace(/A/g, 'T'),
        annotations: [
          {
            name: 'drag-repacked-cds-1',
            type: 'CDS',
            start: 2,
            end: 24,
            direction: 1,
            color: '#dc2626',
          },
          {
            name: 'drag-repacked-cds-2',
            type: 'CDS',
            start: 18,
            end: 36,
            direction: 1,
            color: '#dc2626',
          },
        ],
      },
    };

    render(<RegisteredAssemblyViewport rows={rows} />);

    await act(async () => {
      await flushFrames();
    });

    expect(screen.getByTestId('junction-row-product')).toHaveAttribute(
      'data-row-annotation-count',
      '1'
    );
    expect(
      screen.getByTestId('registered-assembly-source-register-product-owner-layer-left')
    ).toHaveAttribute('data-registered-source-register-product-owner-annotation-count', '2');
    const content = screen
      .getByTestId('registered-assembly-source-register-product-owner-layer-left')
      .querySelector<HTMLElement>('[data-registered-source-register-product-owner-content]');
    expect(content?.dataset.registeredSourceRegisterProductOwnerVerticalOffsetPx).toBe('0');
    const previewViewer = screen
      .getByTestId('registered-assembly-source-register-product-owner-layer-left')
      .querySelector<HTMLElement>('[data-testid="sequence-viewer-1d"]');
    expect(previewViewer).toHaveAttribute('data-layout-anchor-active', 'true');
    expect(previewViewer).toHaveAttribute('data-layout-content-translation-lane-count', '2');
    expect(previewViewer).toHaveAttribute('data-layout-anchor-translation-lane-count', '1');
    expect(previewViewer).toHaveAttribute('data-layout-translation-lane-count', '1');
    expect(previewViewer).toHaveAttribute('data-transparent-background', 'true');
  });

  it('anchors source-row drag-shifted annotation previews to settled source layout', async () => {
    const rows = makeRows();
    rows[0] = {
      ...rows[0],
      continuousAnnotations: [
        {
          name: 'settled-source-cds',
          type: 'CDS',
          start: 8,
          end: 32,
          direction: 1,
          color: '#16a34a',
        },
      ],
      dragShiftedContinuousAnnotations: [
        {
          name: 'drag-source-cds-1',
          type: 'CDS',
          start: 2,
          end: 24,
          direction: 1,
          color: '#dc2626',
        },
        {
          name: 'drag-source-cds-2',
          type: 'CDS',
          start: 18,
          end: 36,
          direction: 1,
          color: '#dc2626',
        },
      ],
    };

    render(<RegisteredAssemblyViewport rows={rows} defaultSourceRowsVisible />);

    await act(async () => {
      await flushFrames();
    });

    const sourceViewer = screen
      .getByTestId('junction-row-left-source')
      .querySelector<HTMLElement>('[data-testid="sequence-viewer-1d"]');
    expect(sourceViewer).toHaveAttribute('data-layout-anchor-active', 'true');
    expect(sourceViewer).toHaveAttribute('data-layout-content-translation-lane-count', '2');
    expect(sourceViewer).toHaveAttribute('data-layout-anchor-translation-lane-count', '1');
    expect(sourceViewer).toHaveAttribute('data-layout-translation-lane-count', '1');
  });

  it('projects spacer-aware Gibson 3-prime virtual cuts on the product row', async () => {
    const rows = makeRows();
    rows[2] = {
      ...rows[2],
      spacerColumns: [80, 81, 82],
      constraints: [
        {
          kind: 'homology-width',
          startBioCol: -2,
          endBioCol: 7,
          editable: true,
          label: '6 bp overlap',
        },
      ],
    };

    render(<RegisteredAssemblyViewport rows={rows} />);

    await act(async () => {
      await flushFrames();
    });

    const product = screen.getByTestId('junction-row-product');
    expect(product).toHaveAttribute('data-virtual-cut-site-count', '1');
    expect(product).toHaveAttribute('data-virtual-cut-renderer', 'layout-neutral-overlay');
    expect(product).toHaveAttribute('data-virtual-cut-sites', 'gibson-resection:87:78');

    const overlay = screen.getByTestId('gibson-virtual-cut-overlay');
    expect(overlay).toHaveAttribute('data-gibson-virtual-cut-count', '1');
    expect(overlay).toHaveClass('text-fg');
    const cut = screen.getByTestId('gibson-virtual-cut-gibson-resection');
    expect(cut).toHaveAttribute('data-top-bio-col', '7');
    expect(cut).toHaveAttribute('data-bottom-bio-col', '-2');
    expect(cut).toHaveAttribute('stroke', 'currentColor');
    expect(cut).toHaveAttribute('stroke-width', '3');
    expect(cut).toHaveAttribute('data-overhang-direction', 'three-prime');
  });

  it('renders RD-to-PCR spacer cargo outside the Gibson overlap and virtual cut bounds', async () => {
    const rows = makeRows();
    rows[2] = {
      ...rows[2],
      spacerColumns: [80, 81, 82, 83],
      constraints: [
        {
          kind: 'homology-width',
          startBioCol: -6,
          endBioCol: 0,
          editable: true,
          label: '6 bp RD homology',
          spacerLength: 4,
          leftHomologyEndBioCol: 0,
          rightHomologyStartBioCol: 4,
          leftTailEndBioCol: 4,
          rightTailStartBioCol: 0,
          leftTailPresent: true,
          rightTailPresent: false,
        },
      ],
    };

    render(<RegisteredAssemblyViewport rows={rows} />);

    await act(async () => {
      await flushFrames();
    });

    const product = screen.getByTestId('junction-row-product');
    expect(product).toHaveAttribute('data-virtual-cut-site-count', '1');
    expect(product).toHaveAttribute('data-virtual-cut-sites', 'gibson-resection:80:74');

    const cut = screen.getByTestId('gibson-virtual-cut-gibson-resection');
    expect(cut).toHaveAttribute('data-top-bio-col', '0');
    expect(cut).toHaveAttribute('data-bottom-bio-col', '-6');
    expect(cut).not.toHaveAttribute('data-top-bio-col', '4');
    expectHighlightCursorAtBioCol(product, 'start', -6);
    expectHighlightCursorAtBioCol(product, 'end', 0);
  });

  it('renders PCR-to-RD spacer cargo outside the Gibson overlap and virtual cut bounds', async () => {
    const rows = makeRows();
    rows[2] = {
      ...rows[2],
      spacerColumns: [80, 81, 82, 83],
      constraints: [
        {
          kind: 'homology-width',
          startBioCol: 4,
          endBioCol: 10,
          editable: true,
          label: '6 bp RD homology',
          spacerLength: 4,
          leftHomologyEndBioCol: 0,
          rightHomologyStartBioCol: 4,
          leftTailEndBioCol: 4,
          rightTailStartBioCol: 0,
          leftTailPresent: false,
          rightTailPresent: true,
        },
      ],
    };

    render(<RegisteredAssemblyViewport rows={rows} />);

    await act(async () => {
      await flushFrames();
    });

    const product = screen.getByTestId('junction-row-product');
    expect(product).toHaveAttribute('data-virtual-cut-site-count', '1');
    expect(product).toHaveAttribute('data-virtual-cut-sites', 'gibson-resection:90:84');

    const cut = screen.getByTestId('gibson-virtual-cut-gibson-resection');
    expect(cut).toHaveAttribute('data-top-bio-col', '10');
    expect(cut).toHaveAttribute('data-bottom-bio-col', '4');
    expect(cut).not.toHaveAttribute('data-bottom-bio-col', '0');
    expectHighlightCursorAtBioCol(product, 'start', 4);
    expectHighlightCursorAtBioCol(product, 'end', 10);
  });

  it('sizes junction rows to fit stacked annotation lanes', async () => {
    const rows = makeRows().map((item) =>
      item.kind === 'product'
        ? {
            ...item,
            annotations: Array.from({ length: 10 }, (_, index) => ({
              name: `stacked-${index}`,
              type: 'misc_feature',
              start: 40,
              end: 120,
              direction: 1,
              color: '#22c55e',
            })),
          }
        : item
    );

    render(<RegisteredAssemblyViewport rows={rows} />);
    await act(async () => {
      await flushFrames();
    });

    const productRow = screen.getByTestId('junction-row-product');
    const visualLayer = screen.getByTestId(
      'registered-assembly-source-register-visual-layer-product'
    );
    const height = Number(productRow.dataset.registeredRowViewerHeight);

    expect(height).toBeGreaterThan(132);
    expect(visualLayer.style.height).toBe(`${height}px`);
  });

  it('live-sync-previews spacer-inclusive product overlap drags and primer overlays before commit', async () => {
    const {
      rows,
      productSequence,
      activeAnchor,
      spacerLength,
      productForwardPrimer,
      leftReversePrimer,
    } = makeHomologyPrimerRows();
    rows[2] = {
      ...rows[2],
      spacerColumns: [activeAnchor, activeAnchor + 1, activeAnchor + 2],
      constraints: [
        {
          kind: 'homology-width',
          startBioCol: -2,
          endBioCol: 7,
          editable: true,
          label: '9 bp crossover',
        },
      ],
    };
    const preview = vi.fn();
    const commit = vi.fn();
    const fields = [
      homologyArmField({ id: 'left-homology', side: 'left', value: 5, oppositeValue: 4 }),
      homologyArmField({ id: 'right-homology', side: 'right', value: 4, oppositeValue: 5 }),
    ];

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={fields}
        onFieldPreview={preview}
        onFieldCommit={commit}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-product');
    const leftOverlapHandle = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    const startCursor = screen.getByTestId('junction-assembly-highlight-cursor-product-start');
    const endCursor = screen.getByTestId('junction-assembly-highlight-cursor-product-end');
    const gibsonCut = screen.getByTestId('gibson-virtual-cut-gibson-resection');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const initialStartLeft = Number.parseFloat(startCursor.style.left);
    const initialEndLeft = Number.parseFloat(endCursor.style.left);

    fireEvent.mouseDown(leftOverlapHandle, { button: 0, buttons: 1, clientX: 200 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200 - pxPerBase * 2 });

    expect(preview).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute('data-live-overlap-preview-active', 'true');
    expect(surface).toHaveAttribute('data-live-overlap-start-bio-col', '-4');
    expect(surface).toHaveAttribute('data-live-overlap-end-bio-col', '7');
    expect(surface).toHaveAttribute('data-live-overlap-spacer-length', '3');
    expect(surface).toHaveAttribute('data-live-overlap-crossover-length', '11');
    expect(startCursor).toHaveAttribute('data-live-overlap-bio-col', '-4');
    expect(startCursor.style.left).toBe(`${initialStartLeft - pxPerBase * 2}px`);
    expect(endCursor).toHaveAttribute('data-live-overlap-bio-col', '7');
    expect(endCursor.style.left).toBe(`${initialEndLeft}px`);
    expect(gibsonCut).toHaveAttribute('data-bottom-bio-col', '-4');
    expect(gibsonCut).toHaveAttribute('data-top-bio-col', '7');
    expect(readPrimerOverlayBases('product', productForwardPrimer.id)).toBe(
      productSequence.slice(activeAnchor - 4, activeAnchor + spacerLength) +
        productSequence.slice(activeAnchor + spacerLength, activeAnchor + spacerLength + 10)
    );
    expect(readPrimerOverlayBases('right', productForwardPrimer.id)).toBe(
      productSequence.slice(activeAnchor - 4, activeAnchor + spacerLength) +
        productSequence.slice(activeAnchor + spacerLength, activeAnchor + spacerLength + 10)
    );
    expect(readPrimerOverlayBases('product', leftReversePrimer.id)).toBe(leftReversePrimer.bases);

    fireEvent.mouseUp(window, { button: 0, buttons: 0, clientX: 200 - pxPerBase * 2 });
    expect(commit).toHaveBeenCalledWith(fields[0], 7);
    await act(async () => {
      await flushFrames();
    });
    expect(surface).not.toHaveAttribute('data-live-overlap-preview-active');
  });

  it('live-sync-previews RD-to-PCR product overlap without rendering spacer cargo as overlap', async () => {
    const rows = makeRows();
    const productSequence = dnaPattern(rows[2].sequence.length);
    const activeAnchor = 80;
    const spacerLength = 3;
    const leftHomologyLength = 5;
    const pbsLength = 10;
    const forwardPbsStart = activeAnchor + spacerLength;
    const productForwardPrimer: PrimerDisplay = {
      id: 'right-forward-rd-spacer',
      name: 'right forward RD spacer primer',
      start: activeAnchor - leftHomologyLength,
      end: forwardPbsStart + pbsLength,
      direction: 'forward',
      bases:
        productSequence.slice(activeAnchor - leftHomologyLength, forwardPbsStart) +
        productSequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
      tm: 60,
      gc: 50,
      overhangLength: leftHomologyLength + spacerLength,
      spacerLength,
      junctionIndex: 0,
    };
    rows[2] = {
      ...rows[2],
      sequence: productSequence,
      spacerColumns: [activeAnchor, activeAnchor + 1, activeAnchor + 2],
      primers: [productForwardPrimer],
      constraints: [
        {
          kind: 'homology-width',
          startBioCol: -leftHomologyLength,
          endBioCol: 0,
          editable: true,
          label: '5 bp RD homology',
          spacerLength,
          leftHomologyEndBioCol: 0,
          rightHomologyStartBioCol: spacerLength,
          leftTailEndBioCol: spacerLength,
          rightTailStartBioCol: 0,
          leftTailPresent: true,
          rightTailPresent: false,
        },
      ],
    };
    const fields = [
      homologyArmField({ id: 'left-homology', side: 'left', value: 5, oppositeValue: 0 }),
    ];

    render(
      <RegisteredAssemblyViewport rows={rows} editableFields={fields} defaultSourceRowsVisible />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-product');
    const leftOverlapHandle = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    const startCursor = screen.getByTestId('junction-assembly-highlight-cursor-product-start');
    const endCursor = screen.getByTestId('junction-assembly-highlight-cursor-product-end');
    const gibsonCut = screen.getByTestId('gibson-virtual-cut-gibson-resection');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const initialStartLeft = Number.parseFloat(startCursor.style.left);
    const initialEndLeft = Number.parseFloat(endCursor.style.left);

    fireEvent.mouseDown(leftOverlapHandle, { button: 0, buttons: 1, clientX: 200 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200 - pxPerBase * 2 });

    expect(surface).toHaveAttribute('data-live-overlap-preview-active', 'true');
    expect(surface).toHaveAttribute('data-live-overlap-start-bio-col', '-7');
    expect(surface).toHaveAttribute('data-live-overlap-end-bio-col', '0');
    expect(surface).toHaveAttribute('data-live-overlap-crossover-length', '7');
    expect(surface).toHaveAttribute('data-live-overlap-spacer-length', '3');
    expect(startCursor).toHaveAttribute('data-live-overlap-bio-col', '-7');
    expect(startCursor.style.left).toBe(`${initialStartLeft - pxPerBase * 2}px`);
    expect(endCursor).toHaveAttribute('data-live-overlap-bio-col', '0');
    expect(endCursor.style.left).toBe(`${initialEndLeft}px`);
    expect(gibsonCut).toHaveAttribute('data-bottom-bio-col', '-7');
    expect(gibsonCut).toHaveAttribute('data-top-bio-col', '0');
    expect(readPrimerOverlayBases('product', productForwardPrimer.id)).toBe(
      productSequence.slice(activeAnchor - 7, forwardPbsStart) +
        productSequence.slice(forwardPbsStart, forwardPbsStart + pbsLength)
    );
    expect(readPrimerOverlayPrimer('product', productForwardPrimer.id)).toMatchObject({
      start: forwardPbsStart - 10,
      end: productForwardPrimer.end,
      overhangLength: 10,
    });

    fireEvent.mouseUp(window, { button: 0, buttons: 0, clientX: 200 - pxPerBase * 2 });
    await act(async () => {
      await flushFrames();
    });
    expect(surface).not.toHaveAttribute('data-live-overlap-preview-active');
  });

  it('live-sync-previews PCR-to-RD product overlap without rendering spacer cargo as overlap', async () => {
    const rows = makeRows();
    const productSequence = dnaPattern(rows[2].sequence.length);
    const activeAnchor = 80;
    const spacerLength = 3;
    const rightHomologyLength = 5;
    const pbsLength = 10;
    const reversePbsEnd = activeAnchor;
    const productReversePrimer: PrimerDisplay = {
      id: 'left-reverse-rd-spacer',
      name: 'left reverse RD spacer primer',
      start: reversePbsEnd - pbsLength,
      end: activeAnchor + spacerLength + rightHomologyLength,
      direction: 'reverse',
      bases:
        reverseComplement(
          productSequence.slice(activeAnchor, activeAnchor + spacerLength + rightHomologyLength)
        ) + reverseComplement(productSequence.slice(reversePbsEnd - pbsLength, reversePbsEnd)),
      tm: 60,
      gc: 50,
      overhangLength: rightHomologyLength + spacerLength,
      spacerLength,
      junctionIndex: 0,
    };
    rows[2] = {
      ...rows[2],
      sequence: productSequence,
      spacerColumns: [activeAnchor, activeAnchor + 1, activeAnchor + 2],
      primers: [productReversePrimer],
      constraints: [
        {
          kind: 'homology-width',
          startBioCol: spacerLength,
          endBioCol: spacerLength + rightHomologyLength,
          editable: true,
          label: '5 bp RD homology',
          spacerLength,
          leftHomologyEndBioCol: 0,
          rightHomologyStartBioCol: spacerLength,
          leftTailEndBioCol: spacerLength,
          rightTailStartBioCol: 0,
          leftTailPresent: false,
          rightTailPresent: true,
        },
      ],
    };
    const fields = [
      homologyArmField({ id: 'right-homology', side: 'right', value: 5, oppositeValue: 0 }),
    ];

    render(
      <RegisteredAssemblyViewport rows={rows} editableFields={fields} defaultSourceRowsVisible />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-product');
    const rightOverlapHandle = screen.getByTestId('junction-field-handle-homologyArm-tail-end');
    const startCursor = screen.getByTestId('junction-assembly-highlight-cursor-product-start');
    const endCursor = screen.getByTestId('junction-assembly-highlight-cursor-product-end');
    const gibsonCut = screen.getByTestId('gibson-virtual-cut-gibson-resection');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const initialStartLeft = Number.parseFloat(startCursor.style.left);
    const initialEndLeft = Number.parseFloat(endCursor.style.left);

    fireEvent.mouseDown(rightOverlapHandle, { button: 0, buttons: 1, clientX: 200 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200 + pxPerBase * 2 });

    expect(surface).toHaveAttribute('data-live-overlap-preview-active', 'true');
    expect(surface).toHaveAttribute('data-live-overlap-start-bio-col', '3');
    expect(surface).toHaveAttribute('data-live-overlap-end-bio-col', '10');
    expect(surface).toHaveAttribute('data-live-overlap-crossover-length', '7');
    expect(surface).toHaveAttribute('data-live-overlap-spacer-length', '3');
    expect(startCursor).toHaveAttribute('data-live-overlap-bio-col', '3');
    expect(startCursor.style.left).toBe(`${initialStartLeft}px`);
    expect(endCursor).toHaveAttribute('data-live-overlap-bio-col', '10');
    expect(endCursor.style.left).toBe(`${initialEndLeft + pxPerBase * 2}px`);
    expect(gibsonCut).toHaveAttribute('data-bottom-bio-col', '3');
    expect(gibsonCut).toHaveAttribute('data-top-bio-col', '10');
    expect(readPrimerOverlayBases('product', productReversePrimer.id)).toBe(
      reverseComplement(productSequence.slice(activeAnchor, activeAnchor + 10)) +
        reverseComplement(productSequence.slice(reversePbsEnd - pbsLength, reversePbsEnd))
    );
    expect(readPrimerOverlayPrimer('product', productReversePrimer.id)).toMatchObject({
      start: productReversePrimer.start,
      end: activeAnchor + 10,
      overhangLength: 10,
    });

    fireEvent.mouseUp(window, { button: 0, buttons: 0, clientX: 200 + pxPerBase * 2 });
    await act(async () => {
      await flushFrames();
    });
    expect(surface).not.toHaveAttribute('data-live-overlap-preview-active');
  });

  it('live-sync-previews Golden Gate product overhang drags with spacer-aware scar geometry', async () => {
    const { rows, leftReversePrimer, productForwardPrimer } = makeGoldenGatePrimerRows();
    rows[2] = {
      ...rows[2],
      spacerColumns: [80, 81, 82],
      constraints: [
        {
          kind: 'fixed-overhang',
          startBioCol: 1,
          endBioCol: 5,
          editable: true,
          label: 'PCR-designed overhang',
        },
      ],
    };
    const preview = vi.fn();
    const commit = vi.fn();
    const fields = [goldenGateOverhangField()];

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={fields}
        onFieldPreview={preview}
        onFieldCommit={commit}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-product');
    const handle = screen.getByTestId('junction-field-handle-goldenGateOverhang-boundary');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    expect(handle).toHaveAttribute('data-handle-variant', 'goldenGateOverhang');
    expect(
      screen.getByTestId('junction-field-handle-span-goldenGateOverhang-boundary')
    ).toBeTruthy();
    expect(
      screen.getByTestId('junction-field-handle-line-goldenGateOverhang-boundary')
    ).toHaveStyle({
      width: '1px',
    });
    expect(screen.queryByTestId('junction-assembly-highlight-cursor-product-start')).toBeNull();
    expect(screen.queryByTestId('junction-assembly-highlight-cursor-product-end')).toBeNull();

    fireEvent.mouseDown(handle, { button: 0, buttons: 1, clientX: 240 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 240 + pxPerBase * 2 });

    expect(preview).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute('data-live-overlap-preview-active', 'true');
    expect(surface).toHaveAttribute('data-live-overlap-kind', 'goldengate-overhang');
    expect(surface).toHaveAttribute('data-live-overlap-start-bio-col', '3');
    expect(surface).toHaveAttribute('data-live-overlap-end-bio-col', '7');
    expect(surface).toHaveAttribute('data-live-overlap-spacer-length', '3');
    expect(surface).toHaveAttribute('data-live-overlap-crossover-length', '4');
    const productSequence = rows[2].sequence;
    const overhang = productSequence.slice(83, 87);
    const forwardCut = productForwardPrimer.cutPositionInOverhang!;
    const reverseCut = leftReversePrimer.cutPositionInOverhang!;
    expect(readPrimerOverlayBases('product', productForwardPrimer.id)).toBe(
      productForwardPrimer.bases.slice(0, forwardCut) + overhang + productSequence.slice(87, 97)
    );
    expect(readPrimerOverlayBases('product', leftReversePrimer.id)).toBe(
      leftReversePrimer.bases.slice(0, reverseCut) +
        reverseComplement(overhang) +
        reverseComplement(productSequence.slice(80, 83)) +
        reverseComplement(productSequence.slice(70, 80))
    );
    expect(readPrimerOverlayBases('left', leftReversePrimer.id)).toBe(
      leftReversePrimer.bases.slice(0, reverseCut) +
        reverseComplement(overhang) +
        reverseComplement(productSequence.slice(80, 83)) +
        reverseComplement(rows[0].sequence.slice(70, 80))
    );

    fireEvent.mouseUp(window, { button: 0, buttons: 0, clientX: 240 + pxPerBase * 2 });
    expect(commit).toHaveBeenCalledWith(fields[0], 2);
    await act(async () => {
      await flushFrames();
    });
    expect(surface).not.toHaveAttribute('data-live-overlap-preview-active');
  });

  it('reserves workbench row height for Golden Gate product cut labels without the ruler band', async () => {
    const { rows, productForwardPrimer } = makeGoldenGatePrimerRows();
    const rowsWithVisibleLabel = rows.map((row) =>
      row.kind === 'product'
        ? {
            ...row,
            primers: row.primers?.map((primer) =>
              primer.id === productForwardPrimer.id
                ? { ...primer, enzymeName: 'BsaI', suppressCutSiteRendering: false }
                : primer
            ),
          }
        : row
    );
    const rowsWithSuppressedLabel = rows.map((row) =>
      row.kind === 'product'
        ? {
            ...row,
            primers: row.primers?.map((primer) =>
              primer.id === productForwardPrimer.id
                ? { ...primer, enzymeName: 'BsaI', suppressCutSiteRendering: true }
                : primer
            ),
          }
        : row
    );

    const { unmount } = render(
      <RegisteredAssemblyViewport rows={rowsWithSuppressedLabel} defaultSourceRowsVisible />
    );
    await act(async () => {
      await flushFrames();
    });
    const suppressedOverlayHeight = Number(
      screen
        .getByTestId('workbench-primer-overlay-product')
        .getAttribute('data-workbench-primer-overlay-css-height')
    );
    unmount();

    render(<RegisteredAssemblyViewport rows={rowsWithVisibleLabel} defaultSourceRowsVisible />);
    await act(async () => {
      await flushFrames();
    });
    const productRow = screen.getByTestId('junction-row-product');
    const visibleOverlayHeight = Number(
      screen
        .getByTestId('workbench-primer-overlay-product')
        .getAttribute('data-workbench-primer-overlay-css-height')
    );
    const productRowHeight = Number(productRow.getAttribute('data-registered-row-viewer-height'));

    expect(visibleOverlayHeight).toBeGreaterThan(suppressedOverlayHeight);
    expect(productRowHeight).toBeGreaterThanOrEqual(visibleOverlayHeight);
  });

  it('keeps the mouseup-sampled Golden Gate primer preview through release', async () => {
    const { rows, leftReversePrimer, productForwardPrimer } = makeGoldenGatePrimerRows();
    const preview = vi.fn();
    const commit = vi.fn();
    const fields = [
      goldenGateOverhangField({
        previewStartBioCol: -2,
        previewEndBioCol: 2,
        spacerLength: 0,
        anchorBioCol: 0,
      }),
    ];

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={fields}
        onFieldPreview={preview}
        onFieldCommit={commit}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const handle = screen.getByTestId('junction-field-handle-goldenGateOverhang-boundary');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);

    fireEvent.mouseDown(handle, { button: 0, buttons: 1, clientX: 240 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 240 + pxPerBase });

    const forwardDuringMove = readPrimerOverlayPrimer('product', productForwardPrimer.id);
    const reverseDuringMove = readPrimerOverlayPrimer('product', leftReversePrimer.id);
    expect(forwardDuringMove?.end).toBe(93);
    expect(reverseDuringMove?.start).toBe(69);

    fireEvent.mouseUp(window, { button: 0, buttons: 0, clientX: 240 + pxPerBase * 2 });

    const forwardAfterRelease = readPrimerOverlayPrimer('product', productForwardPrimer.id);
    const reverseAfterRelease = readPrimerOverlayPrimer('product', leftReversePrimer.id);
    expect(preview).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(fields[0], 2);
    expect(forwardAfterRelease?.end).toBe(94);
    expect(reverseAfterRelease?.start).toBe(70);
  });

  it('drags the active source template as a compositor-only transaction until commit', async () => {
    const rows = makeRows();
    const previewImmediate = vi.fn();
    const commit = vi.fn();
    const fields = [sourceBoundaryField()];

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={fields}
        onFieldPreview={previewImmediate}
        onFieldCommit={commit}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-left-source');
    const contentLayers = {
      left: screen.getByTestId('registered-assembly-source-register-content-layer-left-source'),
      right: screen.getByTestId('registered-assembly-source-register-content-layer-right-source'),
      product: screen.getByTestId('registered-assembly-source-register-content-layer-product'),
    };
    const productOwnerLayers = {
      left: screen.getByTestId('registered-assembly-source-register-product-owner-layer-left'),
      right: screen.getByTestId('registered-assembly-source-register-product-owner-layer-right'),
    };
    const visualLayers = {
      left: screen.getByTestId('registered-assembly-source-register-visual-layer-left-source'),
      right: screen.getByTestId('registered-assembly-source-register-visual-layer-right-source'),
      product: screen.getByTestId('registered-assembly-source-register-visual-layer-product'),
    };
    const before = readRegisteredScrollLefts();
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);

    expect(surface).toHaveAttribute('data-registered-drag-action', 'source-template');
    expect(surface).toHaveAttribute('data-registered-source-register-field-id', 'source-field');
    expect(surface).toHaveClass('cursor-ew-resize');
    expect(surface).toHaveAttribute('data-registered-crossover-drag-armed', 'true');
    expect(surface).toHaveAttribute('title', 'Drag to move the crossover point');
    const sourcePointer = surface.querySelector('[data-testid="sequence-viewer-1d-pointer"]');
    expect(sourcePointer).toBeInstanceOf(HTMLDivElement);
    expect((sourcePointer as HTMLDivElement).style.cursor).toBe('inherit');
    fireEvent.pointerMove(sourcePointer!, { pointerId: 3, clientX: 320, clientY: 64 });
    expect((sourcePointer as HTMLDivElement).style.cursor).toBe('inherit');

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: 320, clientY: 64 });
    expect(surface).toHaveAttribute('data-registered-source-register-dragging', 'true');
    expectRegisteredContentOffsets(contentLayers, { left: '0', right: '0', product: '0' });
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '0' });
    expect(productOwnerLayers.left).toHaveAttribute(
      'data-registered-source-register-product-owner-rendered',
      'true'
    );
    expect(productOwnerLayers.right).toHaveAttribute(
      'data-registered-source-register-product-owner-rendered',
      'false'
    );

    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: 320 + pxPerBase * 2 + 3,
      clientY: 64,
    });
    expect(previewImmediate).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute('data-registered-source-register-value', '118');
    expect(surface).toHaveAttribute('data-registered-source-register-rendered-value', '120');
    expect(surface).toHaveAttribute('data-registered-source-register-visual-offset-px', '19');
    expectRegisteredContentOffsets(contentLayers, { left: '16', right: '0', product: '0' });
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '16', right: '0' });
    expectRegisteredVisualTransforms(visualLayers, '');

    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: 320 - pxPerBase * 4 - 3,
      clientY: 64,
    });
    expect(previewImmediate).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute('data-registered-source-register-value', '124');
    expect(surface).toHaveAttribute('data-registered-source-register-rendered-value', '120');
    expect(surface).toHaveAttribute('data-registered-source-register-visual-offset-px', '-35');
    expectRegisteredContentOffsets(contentLayers, { left: '-32', right: '0', product: '0' });
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '-32', right: '0' });
    expectRegisteredVisualTransforms(visualLayers, '');
    expect(readRegisteredScrollLefts()).toEqual(before);

    fireEvent.mouseUp(surface, {
      button: 0,
      buttons: 0,
      clientX: 320 - pxPerBase * 4,
      clientY: 64,
    });

    expect(commit).toHaveBeenCalledWith(fields[0], 124);
    expect(surface).toHaveAttribute('data-registered-source-register-dragging', 'false');
    expect(surface).toHaveAttribute('data-registered-source-register-visual-offset-px', '0');
    expectRegisteredContentOffsets(contentLayers, { left: '0', right: '0', product: '0' });
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '0' });
    expect(productOwnerLayers.left).toHaveAttribute(
      'data-registered-source-register-product-owner-rendered',
      'false'
    );
    expect(readRegisteredScrollLefts()).toEqual(before);
    expect(viewport).toHaveAttribute('data-registered-source-register-last-end-commit', 'true');
  });

  it('drags product-row source-owner regions through the same source register preview path', async () => {
    const rows = makeRows();
    const commit = vi.fn();
    const override = vi.fn();
    const fields = [sourceBoundaryField()];

    const { rerender } = render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={fields}
        onFieldCommit={commit}
        onSourceDragOverride={override}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-product');
    const productOwnerLayers = {
      left: screen.getByTestId('registered-assembly-source-register-product-owner-layer-left'),
      right: screen.getByTestId('registered-assembly-source-register-product-owner-layer-right'),
    };
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const startX = 320;

    expect(viewport).toHaveAttribute('data-registered-source-rows-visible', 'true');
    expect(screen.getByTestId('registered-assembly-pan-surface-left-source')).toBeInTheDocument();
    expect(surface).toHaveAttribute('data-registered-drag-action', 'product-source-template');

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: startX, clientY: 64 });
    expect(surface).toHaveAttribute('data-registered-source-register-dragging', 'true');

    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX + pxPerBase * 2 + 3,
      clientY: 64,
    });

    expect(surface).toHaveAttribute('data-registered-source-register-value', '118');
    expect(viewport).toHaveAttribute(
      'data-registered-source-register-active-row-kind',
      'left-source'
    );
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '16', right: '0' });
    expect(override).toHaveBeenLastCalledWith({ rowKind: 'left-source', offsetBp: -2 });

    fireEvent.mouseUp(surface, {
      button: 0,
      buttons: 0,
      clientX: startX + pxPerBase * 2,
      clientY: 64,
    });

    expect(commit).toHaveBeenCalledWith(fields[0], 118);
    expect(override).toHaveBeenLastCalledWith(null);
    expect(surface).toHaveAttribute('data-registered-source-register-dragging', 'false');
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '0' });

    rerender(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={[{ ...fields[0], value: 120 }]}
        onFieldCommit={commit}
        onSourceDragOverride={override}
        defaultSourceRowsVisible
      />
    );
    await act(async () => {
      await flushFrames();
    });
    expect(surface).toHaveAttribute('data-registered-source-register-field-id', fields[0].id);
    expect(surface).toHaveAttribute('data-registered-source-register-value', '120');
  });

  it('gates the crossover (source-register) drag behind Edit Crossover ', async () => {
    const rows = makeRows();
    const commit = vi.fn();
    const override = vi.fn();
    const fields = [sourceBoundaryField()];

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={fields}
        onFieldCommit={commit}
        onSourceDragOverride={override}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-product');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const startX = 320;
    const productScrollLeftBefore =
      screen.getByTestId('junction-row-product').dataset.registeredScrollLeft;

    expect(viewport).toHaveAttribute('data-registered-source-rows-visible', 'false');
    expect(surface).toHaveAttribute('data-registered-drag-action', 'product-source-template');
    expect(surface).toHaveAttribute('data-registered-crossover-drag-armed', 'false');
    expect(surface).toHaveClass('cursor-default');
    expect(surface).not.toHaveClass('cursor-ew-resize');
    expect(surface).not.toHaveAttribute('title');

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: startX, clientY: 64 });
    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX + pxPerBase * 2 + 3,
      clientY: 64,
    });
    expect(surface).toHaveAttribute('data-registered-source-register-dragging', 'false');
    expect(override).not.toHaveBeenCalled();
    fireEvent.mouseUp(surface, {
      button: 0,
      buttons: 0,
      clientX: startX + pxPerBase * 2,
      clientY: 64,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByTestId('junction-row-product').dataset.registeredScrollLeft).toBe(
      productScrollLeftBefore
    );

    fireEvent.click(screen.getByTestId('registered-assembly-source-rows-toggle'));
    await act(async () => {
      await flushFrames();
    });
    expect(viewport).toHaveAttribute('data-registered-source-rows-visible', 'true');
    expect(surface).toHaveAttribute('data-registered-crossover-drag-armed', 'true');
    expect(surface).toHaveClass('cursor-ew-resize');
    expect(surface).toHaveAttribute('title', 'Drag to move the crossover point');

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: startX, clientY: 64 });
    expect(surface).toHaveAttribute('data-registered-source-register-dragging', 'true');
    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX + pxPerBase * 2 + 3,
      clientY: 64,
    });
    expect(override).toHaveBeenLastCalledWith({ rowKind: 'left-source', offsetBp: -2 });
    fireEvent.mouseUp(surface, {
      button: 0,
      buttons: 0,
      clientX: startX + pxPerBase * 2,
      clientY: 64,
    });
    expect(commit).toHaveBeenCalledWith(fields[0], 118);
  });

  it('labels the source toggle as Edit Crossover / Done ', async () => {
    render(
      <RegisteredAssemblyViewport rows={makeRows()} editableFields={[sourceBoundaryField()]} />
    );

    await act(async () => {
      await flushFrames();
    });

    const toggle = screen.getByTestId('registered-assembly-source-rows-toggle');
    expect(toggle).toHaveTextContent('Edit Crossover');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('Done');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent('Edit Crossover');
  });

  it('does not advertise crossover editing when no source boundary is editable', async () => {
    const rows = makeRows();
    const editableFields = [sourceBoundaryField()];
    const { rerender } = render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={editableFields}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    expect(screen.getByTestId('registered-assembly-source-rows-toggle')).toHaveTextContent('Done');
    expect(screen.getByTestId('registered-assembly-viewport')).toHaveAttribute(
      'data-registered-source-rows-visible',
      'true'
    );

    rerender(<RegisteredAssemblyViewport rows={rows} editableFields={[]} />);

    await act(async () => {
      await flushFrames();
    });

    expect(screen.queryByTestId('registered-assembly-source-rows-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('junction-row-left-source')).not.toBeInTheDocument();
    expect(screen.queryByTestId('junction-row-right-source')).not.toBeInTheDocument();
    expect(screen.getByTestId('registered-assembly-viewport')).toHaveAttribute(
      'data-registered-source-rows-visible',
      'false'
    );

    rerender(<RegisteredAssemblyViewport rows={rows} editableFields={editableFields} />);

    await act(async () => {
      await flushFrames();
    });

    expect(screen.getByTestId('registered-assembly-source-rows-toggle')).toHaveTextContent(
      'Edit Crossover'
    );
  });

  it('maps product-row right-owner drags to the right source register field', async () => {
    const rows = makeRows();
    const commit = vi.fn();
    const override = vi.fn();
    const fields = [rightSourceBoundaryField()];

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={fields}
        onFieldCommit={commit}
        onSourceDragOverride={override}
        defaultSourceRowsVisible
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-product');
    const productOwnerLayers = {
      left: screen.getByTestId('registered-assembly-source-register-product-owner-layer-left'),
      right: screen.getByTestId('registered-assembly-source-register-product-owner-layer-right'),
    };
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const startX = 400;

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: startX, clientY: 64 });
    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX + pxPerBase * 2 + 3,
      clientY: 64,
    });

    expect(viewport).toHaveAttribute(
      'data-registered-source-register-active-row-kind',
      'right-source'
    );
    expect(surface).toHaveAttribute('data-registered-source-register-value', '58');
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '16' });
    expect(override).toHaveBeenLastCalledWith({ rowKind: 'right-source', offsetBp: -2 });

    fireEvent.mouseUp(surface, {
      button: 0,
      buttons: 0,
      clientX: startX + pxPerBase * 2,
      clientY: 64,
    });

    expect(commit).toHaveBeenLastCalledWith(fields[0], 58);
    expectRegisteredProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '0' });
  });

  it('computes live primer previews from the drag-start source sequence across multiple snaps', async () => {
    const canonicalRows = makePrimerRows();
    const canonicalLeft = canonicalRows.find((row) => row.kind === 'left-source')!;
    const activePrimer = canonicalLeft.primers![0];
    const field = sourceBoundaryField();

    function Harness() {
      const [rows, setRows] = useState(canonicalRows);
      return (
        <RegisteredAssemblyViewport
          rows={rows}
          editableFields={[field]}
          defaultSourceRowsVisible
          onSourceDragOverride={(override) => {
            if (!override) {
              setRows(canonicalRows);
              return;
            }
            setRows(
              canonicalRows.map((row) =>
                row.kind === override.rowKind
                  ? { ...row, sequence: shiftedSequence(row.sequence, override.offsetBp) }
                  : row
              )
            );
          }}
        />
      );
    }

    render(<Harness />);
    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-left-source');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const startX = 320;

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: startX, clientY: 64 });

    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX - pxPerBase,
      clientY: 64,
    });
    await act(async () => {
      await flushFrames();
    });
    expect(readPrimerOverlayBases('left', activePrimer.id)).toBe(
      expectedLiveActivePrimerBases(canonicalLeft.sequence, activePrimer, 1)
    );

    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX - pxPerBase * 2,
      clientY: 64,
    });
    await act(async () => {
      await flushFrames();
    });
    expect(readPrimerOverlayBases('left', activePrimer.id)).toBe(
      expectedLiveActivePrimerBases(canonicalLeft.sequence, activePrimer, 2)
    );
  });

  it('live-previews Golden Gate source drags by updating only the active 4bp overhang bases', async () => {
    const { rows, leftReversePrimer, productForwardPrimer, activeAnchor, overhang } =
      makeGoldenGatePrimerRows();
    const field = sourceBoundaryField();

    render(
      <RegisteredAssemblyViewport rows={rows} editableFields={[field]} defaultSourceRowsVisible />
    );
    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-left-source');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const startX = 320;

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: startX, clientY: 64 });
    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX - pxPerBase * 2,
      clientY: 64,
    });

    const activeBases = rows[0].sequence.slice(activeAnchor, activeAnchor + 2);
    const forwardCut = productForwardPrimer.cutPositionInOverhang!;
    const reverseCut = leftReversePrimer.cutPositionInOverhang!;
    expect(readPrimerOverlayBases('product', productForwardPrimer.id)).toBe(
      productForwardPrimer.bases.slice(0, forwardCut) +
        activeBases +
        overhang.slice(2) +
        productForwardPrimer.bases.slice(forwardCut + 4)
    );
    expect(readPrimerOverlayBases('left', leftReversePrimer.id)).toBe(
      leftReversePrimer.bases.slice(0, reverseCut) +
        leftReversePrimer.bases.slice(reverseCut, reverseCut + 2) +
        reverseComplement(activeBases) +
        reverseComplement(rows[0].sequence.slice(activeAnchor + 2 - 10, activeAnchor + 2))
    );
  });

  it('sources Golden Gate 4bp live preview from the source crossover, not the PBS boundary', async () => {
    const {
      rows,
      leftReversePrimer,
      productForwardPrimer,
      pbsAnchor,
      sourceBoundaryAnchor,
      overhang,
    } = makeGoldenGatePrimerRowsWithSeparatedBoundaryAnchors();
    const field = sourceBoundaryField();

    render(
      <RegisteredAssemblyViewport rows={rows} editableFields={[field]} defaultSourceRowsVisible />
    );
    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const surface = screen.getByTestId('registered-assembly-pan-surface-left-source');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
    const startX = 320;

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: startX, clientY: 64 });
    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: startX - pxPerBase * 2,
      clientY: 64,
    });

    const sourceSideBases = rows[0].sequence.slice(sourceBoundaryAnchor, sourceBoundaryAnchor + 2);
    const pbsBases = reverseComplement(rows[0].sequence.slice(pbsAnchor - 8, pbsAnchor + 2));
    const forwardCut = productForwardPrimer.cutPositionInOverhang!;
    const reverseCut = leftReversePrimer.cutPositionInOverhang!;

    expect(readPrimerOverlayBases('product', productForwardPrimer.id)).toBe(
      productForwardPrimer.bases.slice(0, forwardCut) +
        sourceSideBases +
        overhang.slice(2) +
        productForwardPrimer.bases.slice(forwardCut + 4)
    );
    expect(readPrimerOverlayBases('left', leftReversePrimer.id)).toBe(
      leftReversePrimer.bases.slice(0, reverseCut) +
        leftReversePrimer.bases.slice(reverseCut, reverseCut + 2) +
        reverseComplement(sourceSideBases) +
        pbsBases
    );
  });

  it('live-previews source-row primer handle drags without semantic preview rebuilds', async () => {
    const rows = makePrimerRows();
    const leftRow = rows.find((row) => row.kind === 'left-source')!;
    const primer = leftRow.primers![0];
    const rowsWithProductPrimer = rows.map((row) =>
      row.kind === 'product' ? { ...row, sequence: leftRow.sequence, primers: [primer] } : row
    );
    const bindingLength = primer.bases.length - (primer.overhangLength ?? 0);
    const field = primerPbsField(primer, bindingLength);
    const preview = vi.fn();
    const commit = vi.fn();
    const livePreview = vi.fn();
    const livePreviewEnd = vi.fn();

    render(
      <RegisteredAssemblyViewport
        rows={rowsWithProductPrimer}
        editableFields={[field]}
        onFieldPreview={preview}
        onFieldCommit={commit}
        onFieldLivePreview={livePreview}
        onFieldLivePreviewEnd={livePreviewEnd}
        defaultSourceRowsVisible
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const handle = screen.getByTestId('junction-field-handle-primerPbs-pbs-start');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);

    fireEvent.mouseDown(handle, { button: 0, buttons: 1, clientX: 320, clientY: 64 });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 320 - pxPerBase * 2,
      clientY: 64,
    });

    expect(preview).not.toHaveBeenCalled();
    expect(livePreview).toHaveBeenCalledWith(
      field,
      expect.objectContaining({
        value: bindingLength + 2,
        primerTms: expect.arrayContaining([expect.objectContaining({ tm: expect.any(Number) })]),
      })
    );
    expect(readPrimerOverlayBases('left', primer.id)).toBe(
      expectedPrimerPbsHandleBases(leftRow.sequence, primer, bindingLength + 2)
    );

    fireEvent.mouseUp(window, {
      button: 0,
      buttons: 0,
      clientX: 320 - pxPerBase * 2,
      clientY: 64,
    });
    expect(commit).toHaveBeenCalledWith(field, bindingLength + 2);
    await act(async () => {
      await flushFrames();
    });
    expect(livePreviewEnd).toHaveBeenCalledOnce();
  });

  it('renders and live-previews the right source 3-prime PBS handle', async () => {
    const rows = makeRightPrimerRows();
    const rightRow = rows.find((row) => row.kind === 'right-source')!;
    const primer = rightRow.primers![0];
    const bindingLength = primer.bases.length - (primer.overhangLength ?? 0);
    const field = rightPrimerPbsField(primer, bindingLength);
    const preview = vi.fn();
    const commit = vi.fn();

    render(
      <RegisteredAssemblyViewport
        rows={rows}
        editableFields={[field]}
        onFieldPreview={preview}
        onFieldCommit={commit}
        defaultSourceRowsVisible
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const viewport = screen.getByTestId('registered-assembly-viewport');
    const handle = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    const pxPerBase = Number(viewport.dataset.registeredPxPerBase);

    fireEvent.mouseDown(handle, { button: 0, buttons: 1, clientX: 320, clientY: 64 });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 320 + pxPerBase * 2,
      clientY: 64,
    });

    expect(preview).not.toHaveBeenCalled();
    expect(readPrimerOverlayBases('right', primer.id)).toBe(
      expectedForwardPrimerPbsHandleBases(rightRow.sequence, primer, bindingLength + 2)
    );

    fireEvent.mouseUp(window, {
      button: 0,
      buttons: 0,
      clientX: 320 + pxPerBase * 2,
      clientY: 64,
    });
    expect(commit).toHaveBeenCalledWith(field, bindingLength + 2);
  });
});

function makeRows(): JunctionWorkbenchRow[] {
  return [
    row('left', 'left-source', 80),
    row('right', 'right-source', 80),
    row('product', 'product', 80),
  ];
}

function makePrimerRows(): JunctionWorkbenchRow[] {
  const rows = makeRows();
  const sequence = dnaPattern(rows[0].sequence.length);
  const overhang = 'ttg';
  const bindingLength = 11;
  const activeAnchor = 80;
  const primer: PrimerDisplay = {
    id: 'left-reverse-primer',
    name: 'left reverse primer',
    start: activeAnchor - bindingLength,
    end: activeAnchor + overhang.length,
    direction: 'reverse',
    bases: overhang + reverseComplement(sequence.slice(activeAnchor - bindingLength, activeAnchor)),
    tm: 60,
    gc: 50,
    overhangLength: overhang.length,
  };
  return rows.map((item) =>
    item.kind === 'left-source'
      ? {
          ...item,
          sequence,
          primers: [primer],
        }
      : item
  );
}

function makeRightPrimerRows(): JunctionWorkbenchRow[] {
  const rows = makeRows();
  const sequence = dnaPattern(rows[1].sequence.length);
  const overhang = 'ttg';
  const bindingLength = 11;
  const activeAnchor = 80;
  const primer: PrimerDisplay = {
    id: 'right-forward-primer',
    name: 'right forward primer',
    start: activeAnchor - overhang.length,
    end: activeAnchor + bindingLength,
    direction: 'forward',
    bases: overhang + sequence.slice(activeAnchor, activeAnchor + bindingLength),
    tm: 60,
    gc: 50,
    overhangLength: overhang.length,
  };
  return rows.map((item) =>
    item.kind === 'right-source'
      ? {
          ...item,
          sequence,
          primers: [primer],
        }
      : item
  );
}

function makeHomologyPrimerRows(): {
  rows: JunctionWorkbenchRow[];
  productSequence: string;
  activeAnchor: number;
  spacerLength: number;
  leftReversePrimer: PrimerDisplay;
  productForwardPrimer: PrimerDisplay;
} {
  const rows = makeRows();
  const productSequence = dnaPattern(rows[0].sequence.length);
  const activeAnchor = 80;
  const spacerLength = 3;
  const leftHomologyLength = 5;
  const rightHomologyLength = 4;
  const pbsLength = 10;
  const forwardPbsStart = activeAnchor + spacerLength;
  const productForwardPrimer: PrimerDisplay = {
    id: 'right-forward-homology',
    name: 'right forward homology primer',
    start: forwardPbsStart - leftHomologyLength,
    end: forwardPbsStart + pbsLength,
    direction: 'forward',
    bases:
      productSequence.slice(forwardPbsStart - leftHomologyLength, forwardPbsStart) +
      productSequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
    tm: 60,
    gc: 50,
    overhangLength: leftHomologyLength,
    spacerLength,
    junctionIndex: 0,
  };
  const reversePbsEnd = activeAnchor;
  const reverseOverhangLength = spacerLength + rightHomologyLength;
  const leftReversePrimer: PrimerDisplay = {
    id: 'left-reverse-homology',
    name: 'left reverse homology primer',
    start: reversePbsEnd - pbsLength,
    end: reversePbsEnd + reverseOverhangLength,
    direction: 'reverse',
    bases:
      reverseComplement(productSequence.slice(activeAnchor, activeAnchor + reverseOverhangLength)) +
      reverseComplement(productSequence.slice(reversePbsEnd - pbsLength, reversePbsEnd)),
    tm: 60,
    gc: 50,
    overhangLength: reverseOverhangLength,
    spacerLength,
    junctionIndex: 0,
  };

  return {
    rows: rows.map((item) => {
      if (item.kind === 'left-source') {
        return {
          ...item,
          sequence: productSequence,
          primers: [leftReversePrimer],
        };
      }
      if (item.kind === 'right-source') {
        return {
          ...item,
          sequence: productSequence,
          primers: [productForwardPrimer],
        };
      }
      if (item.kind === 'product') {
        return {
          ...item,
          sequence: productSequence,
          primers: [leftReversePrimer, productForwardPrimer],
        };
      }
      return item;
    }),
    productSequence,
    activeAnchor,
    spacerLength,
    leftReversePrimer,
    productForwardPrimer,
  };
}

function makeGoldenGatePrimerRows(): {
  rows: JunctionWorkbenchRow[];
  leftReversePrimer: PrimerDisplay;
  productForwardPrimer: PrimerDisplay;
  activeAnchor: number;
  overhang: string;
} {
  const rows = makeRows();
  const sequence = dnaPattern(rows[0].sequence.length);
  const activeAnchor = 80;
  const cut = 11;
  const prefix = 'GCGCGGTCTCA';
  const overhang = 'AACG';
  const pbsLength = 10;
  const tailLength = prefix.length + overhang.length;
  const leftReversePrimer: PrimerDisplay = {
    id: 'left-reverse-goldengate',
    name: 'left reverse Golden Gate primer',
    start: activeAnchor - pbsLength,
    end: activeAnchor + tailLength,
    direction: 'reverse',
    bases:
      prefix +
      reverseComplement(overhang) +
      reverseComplement(sequence.slice(activeAnchor - pbsLength, activeAnchor)),
    tm: 60,
    gc: 50,
    overhangLength: tailLength,
    cutPositionInOverhang: cut,
    cognate4bpLength: 2,
    synthetic4bpSpacerLength: 0,
    junctionIndex: 0,
  };
  const productForwardPrimer: PrimerDisplay = {
    id: 'right-forward-goldengate',
    name: 'right forward Golden Gate primer',
    start: activeAnchor - tailLength,
    end: activeAnchor + pbsLength,
    direction: 'forward',
    bases: prefix + overhang + sequence.slice(activeAnchor, activeAnchor + pbsLength),
    tm: 60,
    gc: 50,
    overhangLength: tailLength,
    cutPositionInOverhang: cut,
    cognate4bpLength: 2,
    synthetic4bpSpacerLength: 0,
    junctionIndex: 0,
  };
  return {
    rows: rows.map((item) => {
      if (item.kind === 'left-source') {
        return {
          ...item,
          sequence,
          primers: [leftReversePrimer],
        };
      }
      if (item.kind === 'product') {
        return {
          ...item,
          sequence,
          primers: [leftReversePrimer, productForwardPrimer],
        };
      }
      return item;
    }),
    leftReversePrimer,
    productForwardPrimer,
    activeAnchor,
    overhang,
  };
}

function makeGoldenGatePrimerRowsWithSeparatedBoundaryAnchors(): {
  rows: JunctionWorkbenchRow[];
  leftReversePrimer: PrimerDisplay;
  productForwardPrimer: PrimerDisplay;
  pbsAnchor: number;
  sourceBoundaryAnchor: number;
  overhang: string;
} {
  const rows = makeRows();
  const sequence = dnaPattern(rows[0].sequence.length);
  const sourceBoundaryAnchor = 80;
  const pbsAnchor = sourceBoundaryAnchor - 2;
  const cut = 11;
  const prefix = 'GCGCGGTCTCA';
  const partnerBases = 'CG';
  const overhang = sequence.slice(sourceBoundaryAnchor - 2, sourceBoundaryAnchor) + partnerBases;
  const pbsLength = 10;
  const tailLength = prefix.length + overhang.length;
  const leftReversePrimer: PrimerDisplay = {
    id: 'left-reverse-goldengate-separated',
    name: 'left reverse Golden Gate primer',
    start: pbsAnchor - pbsLength,
    end: pbsAnchor + tailLength,
    direction: 'reverse',
    bases:
      prefix +
      reverseComplement(overhang) +
      reverseComplement(sequence.slice(pbsAnchor - pbsLength, pbsAnchor)),
    tm: 60,
    gc: 50,
    overhangLength: tailLength,
    cutPositionInOverhang: cut,
    cognate4bpLength: 2,
    synthetic4bpSpacerLength: 0,
    junctionIndex: 0,
  };
  const productForwardPrimer: PrimerDisplay = {
    id: 'right-forward-goldengate-separated',
    name: 'right forward Golden Gate primer',
    start: sourceBoundaryAnchor - tailLength,
    end: sourceBoundaryAnchor + pbsLength,
    direction: 'forward',
    bases:
      prefix + overhang + sequence.slice(sourceBoundaryAnchor, sourceBoundaryAnchor + pbsLength),
    tm: 60,
    gc: 50,
    overhangLength: tailLength,
    cutPositionInOverhang: cut,
    cognate4bpLength: 2,
    synthetic4bpSpacerLength: 0,
    junctionIndex: 0,
  };
  return {
    rows: rows.map((item) => {
      if (item.kind === 'left-source') {
        return {
          ...item,
          sequence,
          primers: [leftReversePrimer],
        };
      }
      if (item.kind === 'product') {
        return {
          ...item,
          sequence,
          primers: [leftReversePrimer, productForwardPrimer],
        };
      }
      return item;
    }),
    leftReversePrimer,
    productForwardPrimer,
    pbsAnchor,
    sourceBoundaryAnchor,
    overhang,
  };
}

function dnaPattern(length: number): string {
  const seed = 'ATGCCGTAACGTTGCAAGTCGATCGGCTA';
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

function shiftedSequence(sequence: string, offsetBp: number): string {
  if (offsetBp === 0) return sequence;
  if (offsetBp > 0) return sequence.slice(offsetBp) + 'N'.repeat(offsetBp);
  const leftPad = 'N'.repeat(Math.abs(offsetBp));
  return `${leftPad}${sequence.slice(0, sequence.length + offsetBp)}`;
}

function expectedLiveActivePrimerBases(
  sequence: string,
  primer: PrimerDisplay,
  delta: number
): string {
  const overhangLength = primer.overhangLength ?? 0;
  const bindingLength = primer.bases.length - overhangLength;
  const activeAnchor = primer.end - overhangLength;
  const pbs = reverseComplement(
    sequence.slice(activeAnchor + delta - bindingLength, activeAnchor + delta)
  );
  return primer.bases.slice(0, overhangLength) + pbs;
}

function expectedPrimerPbsHandleBases(
  sequence: string,
  primer: PrimerDisplay,
  pbsLength: number
): string {
  const overhangLength = primer.overhangLength ?? 0;
  const pbsEnd = primer.end - overhangLength;
  return (
    primer.bases.slice(0, overhangLength) +
    reverseComplement(sequence.slice(pbsEnd - pbsLength, pbsEnd))
  );
}

function expectedForwardPrimerPbsHandleBases(
  sequence: string,
  primer: PrimerDisplay,
  pbsLength: number
): string {
  const overhangLength = primer.overhangLength ?? 0;
  const pbsStart = primer.start + overhangLength;
  return primer.bases.slice(0, overhangLength) + sequence.slice(pbsStart, pbsStart + pbsLength);
}

function readPrimerOverlayBases(rowId: string, primerId: string): string | null {
  const overlay = screen.getByTestId(`workbench-primer-overlay-${rowId}`);
  const raw = overlay.dataset.workbenchPrimerOverlayDrawnBases ?? '[]';
  const drawn = JSON.parse(raw) as Array<{ id: string; bases: string }>;
  return drawn.find((item) => item.id === primerId)?.bases ?? null;
}

function readPrimerOverlayPrimer(rowId: string, primerId: string) {
  const overlay = screen.getByTestId(`workbench-primer-overlay-${rowId}`);
  const raw = overlay.dataset.workbenchPrimerOverlayDrawnPrimers ?? '[]';
  const drawn = JSON.parse(raw) as Array<{
    id: string;
    dir: string;
    start: number;
    end: number;
    overhangLength?: number;
    bases: string;
  }>;
  return drawn.find((item) => item.id === primerId) ?? null;
}

function sourceBoundaryField(): AssemblyWorkbenchEditableField {
  return {
    id: 'source-field',
    kind: 'sourceContributionBoundary',
    label: 'Source boundary',
    target: { junctionIndex: 0, regionId: 'r1', side: 'downstream' },
    value: 120,
    units: 'bp',
    range: { min: 80, max: 180, step: 1, largeStep: 10 },
    anchors: [{ rowId: 'left', rowKind: 'left-source', bioCol: 0, role: 'boundary' }],
    command: {
      type: 'setSourceContributionBoundary',
      payload: { regionId: 'r1', side: 'downstream', sourcePosition: 120 },
      valueKey: 'sourcePosition',
    },
    constraints: [],
  };
}

function rightSourceBoundaryField(): AssemblyWorkbenchEditableField {
  return {
    id: 'right-source-field',
    kind: 'sourceContributionBoundary',
    label: 'Right source boundary',
    target: { junctionIndex: 0, regionId: 'r2', side: 'upstream' },
    value: 60,
    units: 'bp',
    range: { min: 0, max: 120, step: 1, largeStep: 10 },
    anchors: [{ rowId: 'right', rowKind: 'right-source', bioCol: 0, role: 'boundary' }],
    command: {
      type: 'setSourceContributionBoundary',
      payload: { regionId: 'r2', side: 'upstream', sourcePosition: 60 },
      valueKey: 'sourcePosition',
    },
    constraints: [],
  };
}

function homologyArmField({
  id,
  side,
  value,
  oppositeValue,
}: {
  id: string;
  side: 'left' | 'right';
  value: number;
  oppositeValue: number;
}): AssemblyWorkbenchEditableField {
  const rowId = side === 'left' ? 'left' : 'right';
  const rowKind = side === 'left' ? 'left-source' : 'right-source';
  const encoding =
    side === 'left'
      ? { onLeft: value, onRight: oppositeValue }
      : { onLeft: oppositeValue, onRight: value };
  return {
    id,
    kind: 'homologyArm',
    label: `${side} homology`,
    target: { junctionIndex: 0, side },
    value,
    units: 'bp',
    range: { min: 0, max: 12, step: 1, largeStep: 5 },
    anchors: [
      {
        rowId,
        rowKind,
        bioCol: side === 'left' ? -value : 0,
        role: 'tail-start',
      },
      {
        rowId,
        rowKind,
        bioCol: side === 'left' ? 0 : value,
        role: 'tail-end',
      },
    ],
    command: {
      type: 'setHomologyEncoding',
      payload: { junctionIndex: 0, encoding },
      valueKey: side === 'left' ? 'encoding.onLeft' : 'encoding.onRight',
    },
    constraints: [],
  };
}

function goldenGateOverhangField(
  input: {
    previewStartBioCol?: number;
    previewEndBioCol?: number;
    spacerLength?: number;
    anchorBioCol?: number;
  } = {}
): AssemblyWorkbenchEditableField {
  const previewStartBioCol = input.previewStartBioCol ?? 1;
  const previewEndBioCol = input.previewEndBioCol ?? 5;
  const spacerLength = input.spacerLength ?? 3;
  return {
    id: 'goldengate-overhang-field',
    kind: 'goldenGateOverhang',
    label: 'Golden Gate overhang offset',
    target: { junctionIndex: 0 },
    value: 0,
    units: 'bp',
    range: { min: -24, max: 24, step: 1, largeStep: 5 },
    anchors: [
      {
        rowId: 'product',
        rowKind: 'product',
        bioCol: input.anchorBioCol ?? (previewStartBioCol + previewEndBioCol) / 2,
        role: 'boundary',
      },
    ],
    command: {
      type: 'setGoldenGateOffset',
      payload: {
        junctionIndex: 0,
        offset: 0,
        previewRange: {
          startBioCol: previewStartBioCol,
          endBioCol: previewEndBioCol,
          spacerLength,
        },
      },
      valueKey: 'offset',
    },
    constraints: [],
  };
}

function primerPbsField(
  primer: PrimerDisplay,
  bindingLength: number
): AssemblyWorkbenchEditableField {
  return {
    id: 'primer-pbs-field',
    kind: 'primerPbs',
    label: 'Primer PBS',
    target: { junctionIndex: 0, primerId: primer.id, side: 'left' },
    value: bindingLength,
    units: 'bp',
    range: { min: 4, max: 40, step: 1, largeStep: 5 },
    anchors: [
      { rowId: 'left', rowKind: 'left-source', bioCol: -bindingLength, role: 'pbs-start' },
      { rowId: 'left', rowKind: 'left-source', bioCol: 0, role: 'pbs-end' },
    ],
    command: {
      type: 'setPrimerPbsLength',
      payload: { primerId: primer.id, length: bindingLength },
      valueKey: 'length',
    },
    constraints: [],
  };
}

function rightPrimerPbsField(
  primer: PrimerDisplay,
  bindingLength: number
): AssemblyWorkbenchEditableField {
  return {
    id: 'right-primer-pbs-field',
    kind: 'primerPbs',
    label: 'Right primer PBS',
    target: { junctionIndex: 0, primerId: primer.id, side: 'right' },
    value: bindingLength,
    units: 'bp',
    range: { min: 4, max: 40, step: 1, largeStep: 5 },
    anchors: [
      { rowId: 'right', rowKind: 'right-source', bioCol: 0, role: 'pbs-start' },
      { rowId: 'right', rowKind: 'right-source', bioCol: bindingLength, role: 'pbs-end' },
    ],
    command: {
      type: 'setPrimerPbsLength',
      payload: { primerId: primer.id, length: bindingLength },
      valueKey: 'length',
    },
    constraints: [],
  };
}

function row(
  id: string,
  kind: CoordMappingRow['kind'],
  anchorRowPosition: number
): JunctionWorkbenchRow {
  const sequence = 'ACGT'.repeat(60);
  return {
    id,
    kind,
    label: id,
    sequence,
    coordinateStart: 0,
    anchorRowPosition,
    annotations: [
      {
        name: `${id} annotation`,
        type: 'misc_feature',
        start: anchorRowPosition - 4,
        end: anchorRowPosition + 4,
        direction: 1,
        color: '#22c55e',
      },
    ],
    continuousAnnotations: [
      {
        name: `${id} continuous annotation`,
        type: 'misc_feature',
        start: anchorRowPosition - 6,
        end: anchorRowPosition + 6,
        direction: 1,
        color: '#22c55e',
      },
    ],
    primers: [],
    points: Array.from({ length: sequence.length }, (_, rowPosition) =>
      makeMappingPoint(id, rowPosition, rowPosition - anchorRowPosition, rowPosition, 'valid')
    ),
    ...(kind === 'product'
      ? {
          productOwners: Array.from({ length: sequence.length }, (_, rowPosition) =>
            rowPosition < anchorRowPosition ? 'left' : 'right'
          ),
        }
      : {}),
    ...(kind === 'left-source' || kind === 'right-source'
      ? {
          visibleColumns: Array.from({ length: sequence.length }, (_, index) => index),
          contributingColumns: [78, 79, 80, 81],
          mutedColumns: Array.from({ length: sequence.length }, (_, index) => index).filter(
            (index) => index < 78 || index > 81
          ),
        }
      : {}),
  };
}

function readRegisteredScrollLefts() {
  return {
    left: Number(screen.getByTestId('junction-row-left-source').dataset.registeredScrollLeft),
    right: Number(screen.getByTestId('junction-row-right-source').dataset.registeredScrollLeft),
    product: Number(screen.getByTestId('junction-row-product').dataset.registeredScrollLeft),
  };
}

function assertNoBlankSideScroll(row: HTMLElement): void {
  const viewport = screen.getByTestId('registered-assembly-viewport');
  const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
  const viewportWidth = Number(viewport.dataset.registeredViewportWidth);
  const rowLength = Number(row.dataset.rowBp);
  const scrollLeft = Number(row.dataset.registeredScrollLeft);
  const noBlankMax = JUNCTION_TEST_PADDING * 2 + rowLength * pxPerBase - Math.max(0, viewportWidth);
  expect(scrollLeft).toBeLessThanOrEqual(Math.max(0, noBlankMax) + 0.5);
}

function sourceRowOverlaySnapshot(rowKind: 'left-source' | 'right-source') {
  const row = screen.getByTestId(`junction-row-${rowKind}`);
  const background = screen.getByTestId(`registered-assembly-source-lane-background-${rowKind}`);
  const sourceSegment = background.querySelector<HTMLElement>(
    '[data-source-lane-background-segment="source"]'
  );
  const content = screen.getByTestId(
    `registered-assembly-source-register-content-layer-${rowKind}`
  );
  const primerOverlay = screen.getByTestId(`workbench-primer-overlay-${row.dataset.rowId}`);
  expect(sourceSegment).toBeTruthy();
  return {
    scrollLeft: Number(row.dataset.registeredScrollLeft),
    sourceSegmentLeft: parseFloat(sourceSegment!.style.left),
    contentBufferPx: Number(content.dataset.registeredSourceRegisterContentBufferPx),
    contentCanvasScrollLeft: Number(content.dataset.registeredSourceRegisterCanvasScrollLeft),
    primerOverlayScrollLeft: Number(primerOverlay.dataset.workbenchPrimerOverlayScrollLeft),
  };
}

function expectHighlightCursorAtBioCol(
  productRow: HTMLElement,
  cursorId: 'start' | 'end',
  bioCol: number
) {
  const viewport = screen.getByTestId('registered-assembly-viewport');
  const cursor = screen.getByTestId(`junction-assembly-highlight-cursor-product-${cursorId}`);
  const anchor = Number(productRow.dataset.anchorRowPosition);
  const scrollLeft = Number(productRow.dataset.registeredScrollLeft);
  const pxPerBase = Number(viewport.dataset.registeredPxPerBase);
  const expectedLeftPx = JUNCTION_TEST_PADDING + (anchor + bioCol) * pxPerBase - scrollLeft;

  expect(Number(cursor.dataset.overlapCanonicalLeftPx)).toBeCloseTo(expectedLeftPx, 4);
}

function expectRegisteredContentOffsets(
  layers: Record<string, HTMLElement>,
  expectedOffsetPxByLayer: Record<string, string>
): void {
  for (const [name, layer] of Object.entries(layers)) {
    const expectedOffsetPx = expectedOffsetPxByLayer[name] ?? '0';
    expect(layer.dataset.registeredSourceRegisterContentOffsetPx).toBe(expectedOffsetPx);
    expect(layer.style.transform).toBe('');
  }
}

function expectRegisteredVisualTransforms(
  layers: Record<string, HTMLElement>,
  expectedTransform: string
): void {
  for (const layer of Object.values(layers)) {
    expect(layer.style.transform).toBe(expectedTransform);
  }
}

function expectRegisteredProductOwnerPreviewOffsets(
  layers: Record<string, HTMLElement>,
  expectedOffsetPxByLayer: Record<string, string>
): void {
  for (const [name, layer] of Object.entries(layers)) {
    const expectedOffsetPx = expectedOffsetPxByLayer[name] ?? '0';
    expect(layer.dataset.registeredSourceRegisterProductOwnerOffsetPx).toBe(expectedOffsetPx);
    expect(layer.dataset.registeredSourceRegisterProductOwnerActive).toBe(
      expectedOffsetPx === '0' ? 'false' : 'true'
    );
    const content = layer.querySelector<HTMLElement>(
      '[data-registered-source-register-product-owner-content="true"]'
    );
    expect(content).not.toBeNull();
    expect(content?.style.transform).toBe('');
  }
}

async function flushFrames() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
