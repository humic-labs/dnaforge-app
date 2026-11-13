/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { DEFAULT_EDITOR_CONFIG } from '@waypoint/workspace-editor';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import { useDesignStore } from '../design/store';
import { useSequenceStore } from '../sequence/store';
import {
  REAL_ASSEMBLY_PIPELINE_SCENARIOS,
  REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
  type RealAssemblyPipelineScenarioId,
  realAssemblyPipelineAppScenario,
} from '../../test/scenarios/assembly-real-pipeline';
import {
  type CanvasOp,
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../../../../../packages/core/workspace-editor/src/testing/recording-canvas-context';
import { JunctionWorkbench } from './JunctionWorkbench';
import { SOURCE_ROW_BUFFER_BP } from './registered-window';
import { JUNCTION_WORKBENCH_HORIZONTAL_PADDING } from './coord-mapping';

const VIEWPORT_WIDTH = 720;
const VIEWPORT_HEIGHT = 420;
const SOURCE_ROW_BUFFER_WIDTH = SOURCE_ROW_BUFFER_BP * DEFAULT_EDITOR_CONFIG.charWidth * 2;
const REAL_ASSEMBLY_PIPELINE_SEQUENCE_DOCUMENT_ID = 'fixture:sequence:puc19-real-assembly';

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
      if (
        element.closest?.('[data-registered-source-register-content-layer="true"]') ||
        element.closest?.('[data-linked-source-register-content-layer="true"]')
      ) {
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
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
  useSequenceStore.setState({
    sequences: {},
    loadingDocumentIds: new Set(),
    scrollPositions: {},
    sequenceVersions: {},
    dirtyPaths: {},
  });
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
});

describe('JunctionWorkbench source context rendering', () => {
  const sourceContextScenarioIds = REAL_ASSEMBLY_PIPELINE_SCENARIOS.filter(
    (scenario) => scenario.expected.valid
  ).map((scenario) => scenario.id);

  it('keeps NEBuilder RD/spacer drag affordances wired through field-level capabilities', async () => {
    const scenario = realAssemblyPipelineAppScenario('nebuilder-rd-spacer', { drafted: false });
    const design = scenario.designs.designs[scenario.designs.activeDesignId!];
    const draft = computeDraftAssembly(design);
    const draftedDesign = {
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
      goldenGateJunctions: draft.goldenGateJunctions,
      assemblyState: 'ready' as const,
      status: 'computed' as const,
      version: 1,
    };
    const sequence = scenario.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID] as AnnotatedSequence;

    useDesignStore.setState({
      designs: { [draftedDesign.id]: draftedDesign },
      activeDesignId: draftedDesign.id,
      pendingDispatchId: null,
    });
    useSequenceStore.setState({
      sequences: { [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: sequence },
      loadingDocumentIds: new Set(),
      scrollPositions: {},
      sequenceVersions: {},
      dirtyPaths: {},
    });

    render(<JunctionWorkbench design={draftedDesign} />);

    await act(async () => {
      await flushFrames();
    });

    const cards = screen.getAllByTestId('junction-workbench-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.dataset.method === 'nebuilder')).toBe(true);
    expect(cards.some((card) => card.dataset.editable === 'true')).toBe(true);

    const productSurfaces = screen.getAllByTestId('registered-assembly-pan-surface-product');
    expect(
      productSurfaces.some(
        (surface) => surface.dataset.registeredDragAction === 'product-source-template'
      )
    ).toBe(true);
    expect(productSurfaces.some((surface) => surface.className.includes('cursor-grab'))).toBe(
      false
    );
    expect(productSurfaces.every((surface) => surface.className.includes('cursor-default'))).toBe(
      true
    );
    expect(
      productSurfaces.every((surface) => surface.dataset.registeredCrossoverDragArmed === 'false')
    ).toBe(true);
    expect(
      document.querySelectorAll('[data-testid^="junction-field-handle-"]').length
    ).toBeGreaterThan(0);
  });

  it.each(sourceContextScenarioIds)(
    'renders provenance-partitioned source context after expanding source rows: %s',
    async (scenarioId: RealAssemblyPipelineScenarioId) => {
      const scenario = realAssemblyPipelineAppScenario(scenarioId, { drafted: false });
      const design = scenario.designs.designs[scenario.designs.activeDesignId!];
      const draft = computeDraftAssembly(design);
      const draftedDesign = {
        ...design,
        homologyRegions: draft.homologyRegions,
        designPrimers: draft.designPrimers,
        goldenGateJunctions: draft.goldenGateJunctions,
        assemblyState: 'ready' as const,
        status: 'computed' as const,
        version: 1,
      };
      const sequence = scenario.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID] as AnnotatedSequence;

      useDesignStore.setState({
        designs: { [draftedDesign.id]: draftedDesign },
        activeDesignId: draftedDesign.id,
        pendingDispatchId: null,
      });
      useSequenceStore.setState({
        sequences: { [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: sequence },
        loadingDocumentIds: new Set(),
        scrollPositions: {},
        sequenceVersions: {},
        dirtyPaths: {},
      });

      render(<JunctionWorkbench design={draftedDesign} />);

      await act(async () => {
        await flushFrames();
      });
      for (const toggle of screen.getAllByTestId('registered-assembly-source-rows-toggle')) {
        fireEvent.click(toggle);
      }

      await waitFor(() => {
        expect(screen.getAllByTestId('junction-row-left-source').length).toBeGreaterThan(0);
      });

      const leftRows = screen.getAllByTestId('junction-row-left-source');
      const rightRows = screen.getAllByTestId('junction-row-right-source');
      expect(leftRows).toHaveLength(rightRows.length);
      for (const row of [...leftRows, ...rightRows]) {
        expect(row).toHaveAttribute(
          'data-source-context-status',
          expect.stringMatching(/full|windowed/)
        );
        assertSourceRowPartition(row);
      }
      assertSourceBackgroundMasks(
        leftRows,
        screen.getAllByTestId('registered-assembly-source-lane-background-left-source')
      );
      assertSourceBackgroundMasks(
        rightRows,
        screen.getAllByTestId('registered-assembly-source-lane-background-right-source')
      );
      const canvasLogs = Array.from(document.querySelectorAll('canvas')).map((canvas) =>
        getRecordingLog(canvas as HTMLCanvasElement)
      );
      expect(canvasLogs.some((log) => hasFillTextPaintedWithColor(log, '#9ca3af'))).toBe(true);
    }
  );

  it('rehydrates PCR and RD source context after a persisted real assembly reopens without sequence cache', async () => {
    const scenario = realAssemblyPipelineAppScenario('goldengate-pcr-rd-pcr', { drafted: false });
    const scenarioDesign = scenario.designs.designs[scenario.designs.activeDesignId!];
    const design: SequenceDesign = {
      ...scenarioDesign,
      regions: scenarioDesign.regions.map((region) => ({
        ...region,
        sourceSequenceId:
          region.sourceSequenceId === REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID
            ? REAL_ASSEMBLY_PIPELINE_SEQUENCE_DOCUMENT_ID
            : region.sourceSequenceId,
      })),
    };
    const draft = computeDraftAssembly(design);
    const draftedDesign = {
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
      goldenGateJunctions: draft.goldenGateJunctions,
      assemblyState: 'ready' as const,
      status: 'computed' as const,
      version: 1,
    };

    useDesignStore.setState({
      designs: { [draftedDesign.id]: draftedDesign },
      activeDesignId: draftedDesign.id,
      pendingDispatchId: null,
    });
    useSequenceStore.setState({
      sequences: {},
      loadingDocumentIds: new Set(),
      scrollPositions: {},
      sequenceVersions: {},
      dirtyPaths: {},
    });

    render(<JunctionWorkbench design={draftedDesign} />);

    await act(async () => {
      await flushFrames();
    });
    for (const toggle of screen.getAllByTestId('registered-assembly-source-rows-toggle')) {
      fireEvent.click(toggle);
    }

    await waitFor(() => {
      const sourceRows = [
        ...screen.getAllByTestId('junction-row-left-source'),
        ...screen.getAllByTestId('junction-row-right-source'),
      ];
      expect(sourceRows.length).toBeGreaterThan(0);
      expect(sourceRows.every((row) => row.dataset.sourceContextStatus !== 'missing')).toBe(true);
      sourceRows.forEach(assertSourceRowPartition);
      assertSourceBackgroundMasks(
        screen.getAllByTestId('junction-row-left-source'),
        screen.getAllByTestId('registered-assembly-source-lane-background-left-source')
      );
      assertSourceBackgroundMasks(
        screen.getAllByTestId('junction-row-right-source'),
        screen.getAllByTestId('registered-assembly-source-lane-background-right-source')
      );
    });
  });

  it('renders RD source cut geometry with the same sticky-end path as the sequence viewer', async () => {
    const scenario = realAssemblyPipelineAppScenario('gibson-rd-5prime-pcr', { drafted: false });
    const design = scenario.designs.designs[scenario.designs.activeDesignId!];
    const draft = computeDraftAssembly(design);
    const draftedDesign = {
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
      goldenGateJunctions: draft.goldenGateJunctions,
      assemblyState: 'ready' as const,
      status: 'computed' as const,
      version: 1,
    };
    const sequence = scenario.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID] as AnnotatedSequence;

    useDesignStore.setState({
      designs: { [draftedDesign.id]: draftedDesign },
      activeDesignId: draftedDesign.id,
      pendingDispatchId: null,
    });
    useSequenceStore.setState({
      sequences: { [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: sequence },
      loadingDocumentIds: new Set(),
      scrollPositions: {},
      sequenceVersions: {},
      dirtyPaths: {},
    });

    render(<JunctionWorkbench design={draftedDesign} />);

    await act(async () => {
      await flushFrames();
    });
    for (const toggle of screen.getAllByTestId('registered-assembly-source-rows-toggle')) {
      fireEvent.click(toggle);
    }
    await act(async () => {
      await flushFrames();
    });

    const sourceRows = [
      ...screen.getAllByTestId('junction-row-left-source'),
      ...screen.getAllByTestId('junction-row-right-source'),
    ];
    expect(sourceRows.some((row) => Number(row.dataset.restrictionCutSiteCount) > 0)).toBe(true);
    expect(sourceRows.some((row) => row.dataset.restrictionCutSites?.includes('EcoRI:'))).toBe(
      true
    );
    const rdCutRows = sourceRows.filter((row) => Number(row.dataset.restrictionCutSiteCount) > 0);
    expect(rdCutRows.length).toBeGreaterThan(0);
    for (const row of rdCutRows) {
      expect(Number(row.dataset.contributingColumnCount)).toBeGreaterThan(0);
      expect(Number(row.dataset.mutedColumnCount)).toBeLessThan(
        Number(row.dataset.visibleColumnCount)
      );
    }

    const canvasLogs = Array.from(document.querySelectorAll('canvas')).map((canvas) =>
      getRecordingLog(canvas as HTMLCanvasElement)
    );
    expect(
      canvasLogs.some((log) => log.some((op) => op.op === 'fillText' && op.text === 'EcoRI'))
    ).toBe(true);
    expect(canvasLogs.some(hasVerticalHorizontalVerticalCutPath)).toBe(true);
  });

  it.each(['gibson-rd-spacer-pcr', 'nebuilder-rd-spacer'] as const)(
    'keeps RD/spacer source bases, contribution masks, and primer overlays locked while side-scrolling: %s',
    async (scenarioId) => {
      const scenario = realAssemblyPipelineAppScenario(scenarioId, { drafted: false });
      const design = scenario.designs.designs[scenario.designs.activeDesignId!];
      const draft = computeDraftAssembly(design);
      const draftedDesign = {
        ...design,
        homologyRegions: draft.homologyRegions,
        designPrimers: draft.designPrimers,
        goldenGateJunctions: draft.goldenGateJunctions,
        assemblyState: 'ready' as const,
        status: 'computed' as const,
        version: 1,
      };
      const sequence = scenario.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID] as AnnotatedSequence;

      useDesignStore.setState({
        designs: { [draftedDesign.id]: draftedDesign },
        activeDesignId: draftedDesign.id,
        pendingDispatchId: null,
      });
      useSequenceStore.setState({
        sequences: { [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: sequence },
        loadingDocumentIds: new Set(),
        scrollPositions: {},
        sequenceVersions: {},
        dirtyPaths: {},
      });

      render(<JunctionWorkbench design={draftedDesign} />);

      await act(async () => {
        await flushFrames();
      });
      for (const toggle of screen.getAllByTestId('registered-assembly-source-rows-toggle')) {
        fireEvent.click(toggle);
      }
      await act(async () => {
        await flushFrames();
      });

      const targetCard = screen.getAllByTestId('junction-workbench-card').find((card) => {
        const product = within(card).queryByTestId('junction-row-product');
        const left = within(card).queryByTestId('junction-row-left-source');
        const right = within(card).queryByTestId('junction-row-right-source');
        return (
          Number(product?.dataset.spacerColumnCount ?? 0) > 0 &&
          Number(left?.dataset.restrictionCutSiteCount ?? 0) > 0 &&
          Number(right?.dataset.primerCount ?? 0) > 0
        );
      });
      expect(targetCard).toBeTruthy();
      const card = targetCard!;

      assertSourceRenderFrameLocked(card, 'left-source');
      assertSourceRenderFrameLocked(card, 'right-source');

      fireEvent.wheel(within(card).getByTestId('registered-assembly-pan-surface-product'), {
        deltaX: 120,
        deltaY: 0,
      });
      await act(async () => {
        await flushFrames();
      });

      assertSourceRenderFrameLocked(card, 'left-source');
      assertSourceRenderFrameLocked(card, 'right-source');
    }
  );
});

async function flushFrames(count = 4) {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function hasFillTextPaintedWithColor(log: CanvasOp[], color: string): boolean {
  let fillStyle: unknown = null;
  for (const op of log) {
    if (op.op === 'set' && op.prop === 'fillStyle') {
      fillStyle = op.value;
      continue;
    }
    if (op.op === 'fillText' && op.text.trim().length > 0 && fillStyle === color) {
      return true;
    }
  }
  return false;
}

function assertSourceBackgroundMasks(rows: HTMLElement[], backgrounds: HTMLElement[]) {
  expect(backgrounds).toHaveLength(rows.length);
  rows.forEach((row, index) => {
    const contributingCount = Number(row.dataset.contributingColumnCount);
    const mutedCount = Number(row.dataset.mutedColumnCount);
    const segments = Array.from(
      backgrounds[index].querySelectorAll<HTMLElement>('[data-source-lane-background-segment]')
    );
    const mutedSegments = segments.filter(
      (segment) => segment.dataset.sourceLaneBackgroundSegment === 'muted'
    );
    const sourceSegments = segments.filter(
      (segment) => segment.dataset.sourceLaneBackgroundSegment === 'source'
    );

    if (mutedCount > 0) {
      expect(mutedSegments.length).toBeGreaterThan(0);
    } else {
      expect(mutedSegments).toHaveLength(0);
    }
    if (contributingCount > 0) {
      expect(sourceSegments.length).toBeGreaterThan(0);
    } else {
      expect(sourceSegments).toHaveLength(0);
    }
    if (mutedCount > 0 && contributingCount > 0) {
      expect(
        new Set(segments.map((segment) => segment.style.backgroundColor)).size
      ).toBeGreaterThan(1);
    }
  });
}

function assertSourceRowPartition(row: HTMLElement) {
  const visibleCount = Number(row.dataset.visibleColumnCount);
  const contributingCount = Number(row.dataset.contributingColumnCount);
  const mutedCount = Number(row.dataset.mutedColumnCount);
  const rowSequenceLength = row.dataset.rowSequence?.replace(/\s/g, '').length ?? 0;

  expect(visibleCount).toBeGreaterThan(0);
  expect(contributingCount).toBeGreaterThanOrEqual(0);
  expect(mutedCount).toBeGreaterThanOrEqual(0);
  expect(contributingCount + mutedCount).toBe(visibleCount);
  expect(contributingCount).toBeLessThanOrEqual(visibleCount);
  expect(mutedCount).toBeLessThanOrEqual(visibleCount);
  expect(rowSequenceLength).toBeGreaterThan(0);

  if (Number(row.dataset.restrictionCutSiteCount) > 0) {
    expect(contributingCount).toBeGreaterThan(0);
  }
}

function assertSourceRenderFrameLocked(card: HTMLElement, rowKind: 'left-source' | 'right-source') {
  const row = within(card).getByTestId(`junction-row-${rowKind}`);
  const content = within(card).getByTestId(
    `registered-assembly-source-register-content-layer-${rowKind}`
  );
  const viewerPointer = content.querySelector<HTMLElement>(
    '[data-testid="sequence-viewer-1d-pointer"]'
  );
  expect(viewerPointer).toBeTruthy();
  const requestedCanvasScroll = Number(content.dataset.registeredSourceRegisterCanvasScrollLeft);
  const effectiveCanvasScroll = Number(viewerPointer!.dataset.sequenceViewer1dEffectiveScrollLeft);
  expect(effectiveCanvasScroll).toBeCloseTo(requestedCanvasScroll, 2);

  const pxPerBase = DEFAULT_EDITOR_CONFIG.charWidth;
  const anchorRowPosition = Number(row.dataset.anchorRowPosition);
  const contentLeft = parseCssPx(content.style.left);
  const background = within(card).getByTestId(
    `registered-assembly-source-lane-background-${rowKind}`
  );
  const segment = Array.from(
    background.querySelectorAll<HTMLElement>('[data-source-lane-background-segment]')
  ).find((candidate) => candidate.dataset.sourceLaneBackgroundSegment === 'source');
  expect(segment).toBeTruthy();
  const startBioCol = Number(segment!.dataset.sourceLaneBackgroundStartBioCol);
  const segmentRowPosition = anchorRowPosition + startBioCol;
  const canvasSegmentLeft =
    contentLeft +
    JUNCTION_WORKBENCH_HORIZONTAL_PADDING +
    segmentRowPosition * pxPerBase -
    effectiveCanvasScroll;
  expect(parseCssPx(segment!.style.left)).toBeCloseTo(canvasSegmentLeft, 2);
  const productX = productCanvasXForBioCol(card, startBioCol, pxPerBase);
  expect(canvasSegmentLeft).toBeCloseTo(productX, 2);

  const overlay = within(card).getByTestId(`workbench-primer-overlay-${row.dataset.rowId}`);
  const primerSegments = parsePrimerSegments(overlay.dataset.workbenchPrimerOverlayDrawnSegments);
  if (primerSegments.length === 0) return;
  const primerSegment = primerSegments[0]!;
  const primerOverlayScrollLeft = Number(overlay.dataset.workbenchPrimerOverlayScrollLeft);
  const canvasPrimerLeft = contentLeft + primerSegment.x - effectiveCanvasScroll;
  const overlayPrimerLeft = primerSegment.x - primerOverlayScrollLeft;
  expect(overlayPrimerLeft).toBeCloseTo(canvasPrimerLeft, 2);
}

function productCanvasXForBioCol(card: HTMLElement, bioCol: number, pxPerBase: number): number {
  const product = within(card).getByTestId('junction-row-product');
  const content = within(card).getByTestId(
    'registered-assembly-source-register-content-layer-product'
  );
  const viewerPointer = content.querySelector<HTMLElement>(
    '[data-testid="sequence-viewer-1d-pointer"]'
  );
  expect(viewerPointer).toBeTruthy();
  const effectiveCanvasScroll = Number(viewerPointer!.dataset.sequenceViewer1dEffectiveScrollLeft);
  const anchorRowPosition = Number(product.dataset.anchorRowPosition);
  const rowPosition = anchorRowPosition + bioCol;
  return JUNCTION_WORKBENCH_HORIZONTAL_PADDING + rowPosition * pxPerBase - effectiveCanvasScroll;
}

function parsePrimerSegments(value: string | undefined): Array<{ x: number }> {
  if (!value) return [];
  const parsed = JSON.parse(value) as Array<{ x: number }>;
  return parsed.filter((segment) => Number.isFinite(segment.x));
}

function parseCssPx(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace('px', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasVerticalHorizontalVerticalCutPath(log: CanvasOp[]): boolean {
  for (let i = 0; i < log.length - 4; i++) {
    const move = log[i];
    const first = log[i + 1];
    const second = log[i + 2];
    const third = log[i + 3];
    const stroke = log[i + 4];
    if (
      move.op !== 'moveTo' ||
      first.op !== 'lineTo' ||
      second.op !== 'lineTo' ||
      third.op !== 'lineTo' ||
      stroke.op !== 'stroke'
    ) {
      continue;
    }
    const firstVertical = nearlyEqual(move.x, first.x) && !nearlyEqual(move.y, first.y);
    const horizontal = !nearlyEqual(first.x, second.x) && nearlyEqual(first.y, second.y);
    const secondVertical = nearlyEqual(second.x, third.x) && !nearlyEqual(second.y, third.y);
    if (firstVertical && horizontal && secondVertical) return true;
  }
  return false;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}
