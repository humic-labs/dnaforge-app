// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findORFs,
  parseGenBankFull,
  type AnnotatedSequence,
  type ORF,
} from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import {
  createResidueSelectionsStore,
  ResidueSelectionsProvider,
  residueSelectionsToCodingDnaRanges,
} from '../residue-selection-store';
import {
  type CanvasOp,
  countOp,
  getRecordingLog,
  installRecordingCanvas,
  opsOf,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';
import { isApplePlatform } from '../platform-modifiers';

import { SELECTION_FILL_LIGHT } from '../selection-primitives';

function fillStyleAt(log: CanvasOp[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const e = log[j];
    if (e.op === 'set' && e.prop === 'fillStyle') {
      return String(e.value);
    }
  }
  return undefined;
}

function findSelectionFill(log: CanvasOp[]) {
  return log
    .map((e, i) => ({ e, i }))
    .find((pair) => pair.e.op === 'fillRect' && fillStyleAt(log, pair.i) === SELECTION_FILL_LIGHT);
}

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');

const LINEAR_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');
const CIRCULAR_FIXTURE = join(FIXTURES_DIR, 'sequences/circular/pUC19.gb');
const COMMAND_MODIFIER = isApplePlatform() ? { metaKey: true } : { ctrlKey: true };

function loadFixture(path: string) {
  const gb = readFileSync(path, 'utf8');
  return parseGenBankFull(gb);
}

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

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

function installClientWidthStub() {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return VIEWPORT_WIDTH;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return VIEWPORT_HEIGHT;
    },
  });
}

function installDevicePixelRatio() {
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  });
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;
  installClientWidthStub();
  installDevicePixelRatio();
});

beforeEach(() => {
  installRecordingCanvas();
  (window as unknown as { __test?: Record<string, unknown> }).__test = {};
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  delete (window as unknown as { __test?: Record<string, unknown> }).__test;
});

function getViewerCanvas(container: HTMLElement): HTMLCanvasElement {
  const viewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
  if (!viewer) throw new Error('SequenceViewer1D not found');
  const canvas = viewer.querySelector('canvas');
  if (!canvas) throw new Error('canvas not found');
  return canvas as HTMLCanvasElement;
}

async function flushFrames() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 20));
}

describe('SequenceViewer1D — L1 render test (rubisco linear fixture)', () => {
  it('paints physical strand gaps and protruding bases without manufacturing their partners', async () => {
    const sequence: AnnotatedSequence = {
      id: 'physical-strands',
      name: 'Physical ends',
      sequence: 'GCTA  ',
      length: 6,
      annotations: [],
      circular: false,
      strandOverrides: [{ start: 0, forward: 'GCTA  ', reverse: '  ATGC' }],
    };
    const { container } = render(<SequenceViewer1D sequence={sequence} showRuler={false} />);
    await act(async () => {
      await flushFrames();
    });
    const letters = opsOf(getRecordingLog(getViewerCanvas(container)), 'fillText').filter((op) =>
      /^[ACGT]$/.test(op.text)
    );
    const rows = [...new Set(letters.map((op) => op.y))].sort((a, b) => a - b);
    expect(rows).toHaveLength(2);
    const lastDraw = (y: number) =>
      [...new Map(letters.filter((op) => op.y === y).map((op) => [op.x, op.text])).entries()].sort(
        (a, b) => a[0] - b[0]
      );
    expect(
      lastDraw(rows[0])
        .map(([, base]) => base)
        .join('')
    ).toBe('GCTA');
    expect(
      lastDraw(rows[1])
        .map(([, base]) => base)
        .join('')
    ).toBe('ATGC');
    expect(lastDraw(rows[1])[0][0]).toBeGreaterThan(lastDraw(rows[0])[0][0]);
  });

  it('anchors transient preview layout geometry to the settled sequence while painting preview CDSs', async () => {
    const baseSequence = 'ATG'.repeat(48);
    const settled: AnnotatedSequence = {
      id: 'settled',
      name: 'settled',
      sequence: baseSequence,
      length: baseSequence.length,
      circular: false,
      annotations: [
        {
          name: 'settled-cds',
          type: 'CDS',
          start: 5,
          end: 95,
          direction: 1,
          color: '#16a34a',
        },
      ],
    };
    const preview: AnnotatedSequence = {
      ...settled,
      id: 'preview',
      name: 'preview',
      annotations: [
        {
          name: 'preview-cds-a',
          type: 'CDS',
          start: 5,
          end: 95,
          direction: 1,
          color: '#dc2626',
        },
        {
          name: 'preview-cds-b',
          type: 'CDS',
          start: 35,
          end: 125,
          direction: 1,
          color: '#dc2626',
        },
      ],
    };

    const { container } = render(
      <SequenceViewer1D sequence={preview} layoutAnchorSequence={settled} transparentBackground />
    );

    await act(async () => {
      await flushFrames();
    });

    const viewer = container.querySelector<HTMLElement>('[data-testid="sequence-viewer-1d"]');
    expect(viewer?.getAttribute('data-layout-anchor-active')).toBe('true');
    expect(viewer?.getAttribute('data-layout-content-translation-lane-count')).toBe('2');
    expect(viewer?.getAttribute('data-layout-anchor-translation-lane-count')).toBe('1');
    expect(viewer?.getAttribute('data-layout-translation-lane-count')).toBe('1');
    expect(viewer?.getAttribute('data-transparent-background')).toBe('true');
    expect(viewer?.style.background).toBe('transparent');
  });

  it('draws sequence letters and annotation lanes', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(<SequenceViewer1D sequence={sequence} />);

    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    expect(log.length, 'draw() must produce at least one op').toBeGreaterThan(10);

    expect(canvas.width, 'canvas backing was resized by draw()').not.toBe(300);
    expect(canvas.height, 'canvas backing was resized by draw()').not.toBe(150);

    expect(
      countOp(log, 'fillText'),
      'fillText must be called for each visible base'
    ).toBeGreaterThan(0);
    expect(countOp(log, 'fillRect'), 'annotation/selection fillRects expected').toBeGreaterThan(0);
    expect(countOp(log, 'moveTo'), 'ruler tick strokes expected').toBeGreaterThan(0);

    const firstClear = log.findIndex((e) => e.op === 'clearRect');
    const firstFillText = log.findIndex((e) => e.op === 'fillText');
    expect(firstClear, 'clearRect called').toBeGreaterThanOrEqual(0);
    expect(firstClear).toBeLessThan(firstFillText);
  });

  it('fillText positions in the sequence row are strictly increasing', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(<SequenceViewer1D sequence={sequence} />);
    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);
    const fillTexts = opsOf(log, 'fillText');

    const runs: Array<typeof fillTexts> = [];
    let current: typeof fillTexts = [];
    let lastX = -Infinity;
    for (const t of fillTexts) {
      if (t.x <= lastX) {
        if (current.length > 0) runs.push(current);
        current = [];
      }
      current.push(t);
      lastX = t.x;
    }
    if (current.length > 0) runs.push(current);

    const longestRun = runs.sort((a, b) => b.length - a.length)[0] ?? [];
    expect(longestRun.length, 'sequence-row run must include many letters').toBeGreaterThan(10);
    let prev = -Infinity;
    for (const t of longestRun) {
      expect(t.x, 'sequence-row x must strictly increase').toBeGreaterThan(prev);
      prev = t.x;
    }
  });

  it('draws the selection fill in yellow when a range selection is provided', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(
      <SequenceViewer1D sequence={sequence} selection={{ start: 10, end: 30 }} />
    );
    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    const hit = findSelectionFill(log);
    expect(hit, 'expected a fillRect with SELECTION_FILL_LIGHT style').toBeDefined();
    if (!hit) return;
    const rect = hit.e as Extract<CanvasOp, { op: 'fillRect' }>;
    expect(rect.w, 'selection width > 0').toBeGreaterThan(0);
    expect(rect.h, 'selection spans the full stack').toBeGreaterThan(60);
  });

  it('draws the view cursor line when viewCursor is set and no range selection', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(<SequenceViewer1D sequence={sequence} viewCursor={42} />);
    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    const hit = findSelectionFill(log);
    expect(hit, 'no selection fill when viewCursor only').toBeUndefined();
    expect(countOp(log, 'stroke')).toBeGreaterThan(0);
  });

  it('supports passive host-owned pointer surfaces without a hover cursor line', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        pointerInteractionsEnabled={false}
        passiveCursor="inherit"
      />
    );
    await act(async () => {
      await flushFrames();
    });

    const pointer = container.querySelector('[data-testid="sequence-viewer-1d-pointer"]');
    expect(pointer).toBeInstanceOf(HTMLDivElement);
    const canvas = getViewerCanvas(container);

    fireEvent.pointerMove(pointer!, { pointerId: 1, clientX: 200, clientY: 60 });

    expect((pointer as HTMLDivElement).style.cursor).toBe('inherit');
    expect(
      getRecordingLog(canvas).some(
        (op) => op.op === 'set' && op.prop === 'strokeStyle' && op.value === '#93C5FD'
      )
    ).toBe(false);
  });

  it('shows modification names on a read-only primer hover without changing selection', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const onSelectionChange = vi.fn();
    const { container } = render(
      <SequenceViewer1D
        sequence={sequence}
        primers={[
          {
            id: 'modified-preview',
            name: 'Modified preview',
            start: 10,
            end: 24,
            bases: 'cccccccccctccc',
            direction: 'forward',
            tm: 60,
            gc: 50,
            modificationMarkers: [
              {
                token: '/iBiodT/',
                label: 'Biotin dT',
                placement: 'internal',
                behavior: 'modified-base',
                anchor: { kind: 'base', index: 10 },
              },
            ],
          },
        ]}
        showPrimers
        zoomPercent={100}
        pointerInteractionsEnabled={false}
        primerHoverEnabled
        onSelectionChange={onSelectionChange}
      />
    );
    await act(async () => {
      await flushFrames();
    });
    const base = opsOf(getRecordingLog(getViewerCanvas(container)), 'fillText').find(
      (op) => op.text === 't'
    );
    expect(base).toBeDefined();
    const pointer = container.querySelector('[data-testid="sequence-viewer-1d-pointer"]')!;
    fireEvent(
      pointer,
      new MouseEvent('pointermove', { bubbles: true, clientX: base!.x, clientY: base!.y })
    );
    expect(screen.getByTestId('primer-hover-tooltip').textContent).toContain('Biotin dT /iBiodT/');
    fireEvent(
      pointer,
      new MouseEvent('pointerdown', { bubbles: true, clientX: base!.x, clientY: base!.y })
    );
    expect(onSelectionChange).not.toHaveBeenCalled();
    fireEvent(
      pointer,
      new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })
    );
    expect(screen.queryByTestId('primer-hover-tooltip')).toBeNull();
  });

  it('draws the active hover cursor with neutral chrome instead of blue', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const { container } = render(<SequenceViewer1D sequence={sequence} />);
    await act(async () => {
      await flushFrames();
    });

    const pointer = container.querySelector('[data-testid="sequence-viewer-1d-pointer"]');
    expect(pointer).toBeInstanceOf(HTMLDivElement);
    const canvas = getViewerCanvas(container);

    fireEvent.pointerMove(pointer!, { pointerId: 1, clientX: 200, clientY: 60 });
    await act(async () => {
      await flushFrames();
    });

    const strokeStyles = getRecordingLog(canvas)
      .filter((op) => op.op === 'set' && op.prop === 'strokeStyle')
      .map((op) => op.value);
    expect(strokeStyles).not.toContain('#93C5FD');
    expect(strokeStyles).not.toContain('rgba(147, 197, 253, 0.25)');
    expect(strokeStyles).toContain('#6b7280');
  });

  it('passes a fresh active selection range when opening the context menu', async () => {
    const sequence = loadFixture(LINEAR_FIXTURE);
    const selection = { start: 9, end: 27 };
    const onContextMenu = vi.fn();
    const { container } = render(
      <SequenceViewer1D sequence={sequence} selection={selection} onContextMenu={onContextMenu} />
    );
    await act(async () => {
      await flushFrames();
    });

    const pointer = container.querySelector('[data-testid="sequence-viewer-1d-pointer"]');
    expect(pointer).toBeInstanceOf(HTMLDivElement);

    fireEvent.contextMenu(pointer!, { clientX: 120, clientY: 20 });

    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][1]).toEqual(selection);
    expect(onContextMenu.mock.calls[0][1]).not.toBe(selection);
  });
});

describe('SequenceViewer1D — L1 render test (pUC19 circular fixture)', () => {
  it('reports an actual drawn ORF and an empty replacement after the 1D draw', async () => {
    const sequence = parseGenBankFull(
      [
        'LOCUS       drawn-orf 123 bp    DNA     linear   SYN 30-OCT-2026',
        'FEATURES             Location/Qualifiers',
        'ORIGIN',
        `        1 ${'atg'.repeat(40)}taa`,
        '//',
      ].join('\n')
    );
    const presented = vi.fn();
    const view = render(
      <SequenceViewer1D
        sequence={sequence}
        orfs={findORFs(sequence.sequence, 100)}
        onOrfsPresented={presented}
      />
    );
    await act(async () => {
      await flushFrames();
    });
    expect(presented).toHaveBeenCalledWith({ kind: 'orf_drawn', surface: 'sequence_tracks' });
    const empty = vi.fn();
    const emptyOrfs: ORF[] = [];
    view.rerender(
      <SequenceViewer1D sequence={sequence} orfs={emptyOrfs} onOrfsPresented={empty} />
    );
    await act(async () => {
      await flushFrames();
    });
    expect(empty).toHaveBeenCalledWith({ kind: 'empty_model', surface: 'sequence_tracks' });
    const nextEmpty = vi.fn();
    view.rerender(
      <SequenceViewer1D sequence={sequence} orfs={emptyOrfs} onOrfsPresented={nextEmpty} />
    );
    await act(async () => {
      await flushFrames();
    });
    expect(nextEmpty).toHaveBeenCalledWith({ kind: 'empty_model', surface: 'sequence_tracks' });
  });

  it('draws sequence letters for a circular plasmid (rendered linearly)', async () => {
    const sequence = loadFixture(CIRCULAR_FIXTURE);
    expect(sequence.circular, 'fixture should be circular').toBe(true);
    expect(sequence.sequence, 'pUC19 must carry all bases into Canvas 2D').toHaveLength(2_686);
    expect(sequence.length, 'declared and actual pUC19 lengths must agree').toBe(
      sequence.sequence.length
    );

    const { container } = render(<SequenceViewer1D sequence={sequence} />);
    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);

    expect(countOp(log, 'fillText'), 'circular fixture must render letters').toBeGreaterThan(0);
    expect(countOp(log, 'fillRect'), 'circular fixture must render lane rects').toBeGreaterThan(0);
  });
});

const AA_LETTERS = new Set([
  'A',
  'R',
  'N',
  'D',
  'C',
  'E',
  'Q',
  'G',
  'H',
  'I',
  'L',
  'K',
  'M',
  'F',
  'P',
  'S',
  'T',
  'W',
  'Y',
  'V',
  '*',
  'X',
]);

function countAALetterFillTexts(log: CanvasOp[]): number {
  let n = 0;
  for (const e of log) {
    if (e.op === 'fillText' && e.text.length === 1 && AA_LETTERS.has(e.text)) n++;
  }
  return n;
}

const LINEAR_AA_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/sfgfp-cds.gb');
const CIRCULAR_AA_FIXTURE = join(FIXTURES_DIR, 'sequences/circular/perf-medium-synthetic.gb');

describe('SequenceViewer1D — AA codon chevron rendering', () => {
  it('emits per-codon AA letters for sfGFP CDS translation (linear)', async () => {
    const sequence = loadFixture(LINEAR_AA_FIXTURE);
    const cdss = (sequence.annotations ?? []).filter((a) => a.type === 'CDS');
    expect(cdss.length, 'fixture must include at least one CDS').toBeGreaterThan(0);

    const { container } = render(<SequenceViewer1D sequence={sequence} />);
    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);
    const aaCount = countAALetterFillTexts(log);
    expect(
      aaCount,
      `expected ≥ 10 AA letter fillText ops for CDS translation; found ${aaCount}`
    ).toBeGreaterThanOrEqual(10);
  });

  it('emits per-codon AA letters for perf-medium circular fixture (bla CDS at col 0)', async () => {
    const sequence = loadFixture(CIRCULAR_AA_FIXTURE);
    const cdss = (sequence.annotations ?? []).filter((a) => a.type === 'CDS');
    expect(cdss.length, 'fixture must include at least one CDS').toBeGreaterThan(0);

    const { container } = render(<SequenceViewer1D sequence={sequence} />);
    await act(async () => {
      await flushFrames();
    });

    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);
    const aaCount = countAALetterFillTexts(log);
    expect(aaCount, `perf-medium AA letter count; found ${aaCount}`).toBeGreaterThanOrEqual(5);
  });

  it('Cmd-clicking an sfGFP CDS amino-acid cell writes a residue selection', async () => {
    const sequence = loadFixture(LINEAR_AA_FIXTURE);
    const store = createResidueSelectionsStore();
    const onViewCursorChange = vi.fn();
    const referenceId = '/fixtures/sfgfp-cds.gb';

    const { container } = render(
      <ResidueSelectionsProvider value={store}>
        <SequenceViewer1D
          sequence={sequence}
          residueSelectionReferenceId={referenceId}
          onViewCursorChange={onViewCursorChange}
        />
      </ResidueSelectionsProvider>
    );
    await act(async () => {
      await flushFrames();
    });

    const pointer = container.querySelector('[data-testid="sequence-viewer-1d-pointer"]');
    expect(pointer).toBeInstanceOf(HTMLDivElement);
    const viewer = container.querySelector<HTMLElement>('[data-testid="sequence-viewer-1d"]');
    expect(viewer).not.toBeNull();
    const sequenceRowY = Number(viewer!.dataset.layoutSequenceRowY);
    expect(Number.isFinite(sequenceRowY)).toBe(true);
    expect(sequenceRowY).toBeGreaterThan(0);
    expect(Number(viewer!.dataset.layoutTranslationLaneCount)).toBeGreaterThan(0);
    const canvas = getViewerCanvas(container);
    const log = getRecordingLog(canvas);
    const candidate = log.find(
      (op): op is Extract<CanvasOp, { op: 'fillText' }> =>
        op.op === 'fillText' &&
        op.text.length === 1 &&
        AA_LETTERS.has(op.text) &&
        Number.isFinite(op.x) &&
        Number.isFinite(op.y) &&
        op.y < sequenceRowY
    );
    expect(candidate, 'expected a rendered AA glyph above the sequence row').toBeDefined();
    if (!candidate) return;
    const { x, y } = candidate;

    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      ...COMMAND_MODIFIER,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    fireEvent(pointer!, pointerDown);
    const pointerUp = new MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      ...COMMAND_MODIFIER,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    });
    Object.defineProperty(pointerUp, 'pointerId', { value: 1 });
    fireEvent(pointer!, pointerUp);

    const snapshot = store.getSnapshot();
    const pointerDebug = (window as unknown as { __test?: { residueSelectionPointerDebug?: any } })
      .__test?.residueSelectionPointerDebug;
    expect(onViewCursorChange).not.toHaveBeenCalled();
    expect(pointerDebug).toMatchObject({
      viewer: '1d',
      stage: 'toggle',
      result: true,
      referenceId,
      coordinateMode: null,
      hasStore: true,
    });
    expect(snapshot).toHaveLength(1);
    const codonRanges = residueSelectionsToCodingDnaRanges(snapshot, referenceId);
    expect(codonRanges).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      source: { kind: 'translation-track', id: referenceId, surface: 'sequence-cds' },
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: codonRanges[0].start / 3, end: codonRanges[0].start / 3 }],
      },
    });
    expect(snapshot[0] && 'start' in snapshot[0]).toBe(false);
    expect(codonRanges[0]).toMatchObject({ strand: 1 });
    expect(codonRanges[0].end - codonRanges[0].start).toBe(2);
  });

  it('Cmd-Shift-clicking an sfGFP CDS amino-acid cell range-selects residues', async () => {
    const sequence = loadFixture(LINEAR_AA_FIXTURE);
    const store = createResidueSelectionsStore();
    const onViewCursorChange = vi.fn();
    const referenceId = '/fixtures/sfgfp-cds.gb';

    const { container } = render(
      <ResidueSelectionsProvider value={store}>
        <SequenceViewer1D
          sequence={sequence}
          residueSelectionReferenceId={referenceId}
          onViewCursorChange={onViewCursorChange}
        />
      </ResidueSelectionsProvider>
    );
    await act(async () => {
      await flushFrames();
    });

    const pointer = container.querySelector('[data-testid="sequence-viewer-1d-pointer"]');
    expect(pointer).toBeInstanceOf(HTMLDivElement);
    const viewer = container.querySelector<HTMLElement>('[data-testid="sequence-viewer-1d"]');
    expect(viewer).not.toBeNull();
    const sequenceRowY = Number(viewer!.dataset.layoutSequenceRowY);
    const canvas = getViewerCanvas(container);
    const candidates = getRecordingLog(canvas)
      .filter(
        (op): op is Extract<CanvasOp, { op: 'fillText' }> =>
          op.op === 'fillText' &&
          op.text.length === 1 &&
          AA_LETTERS.has(op.text) &&
          Number.isFinite(op.x) &&
          Number.isFinite(op.y) &&
          op.y < sequenceRowY
      )
      .sort((a, b) => a.x - b.x);
    expect(
      candidates.length,
      'expected multiple rendered AA glyphs above the sequence row'
    ).toBeGreaterThanOrEqual(5);
    const reverse = candidates[0];
    const first = candidates[1];
    const second = candidates[4];

    const clickResidue = (x: number, y: number, shiftKey = false) => {
      const pointerDown = new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        ...COMMAND_MODIFIER,
        shiftKey,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      });
      Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
      fireEvent(pointer!, pointerDown);
      const pointerUp = new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
        ...COMMAND_MODIFIER,
        shiftKey,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
      });
      Object.defineProperty(pointerUp, 'pointerId', { value: 1 });
      fireEvent(pointer!, pointerUp);
    };

    clickResidue(first.x, first.y);
    clickResidue(second.x, second.y, true);

    const snapshot = store.getSnapshot();
    const pointerDebug = (window as unknown as { __test?: { residueSelectionPointerDebug?: any } })
      .__test?.residueSelectionPointerDebug;
    expect(onViewCursorChange).not.toHaveBeenCalled();
    expect(pointerDebug).toMatchObject({
      viewer: '1d',
      stage: 'range',
      result: true,
      referenceId,
      coordinateMode: null,
      hasStore: true,
    });
    expect(snapshot).toHaveLength(1);
    const codonRanges = residueSelectionsToCodingDnaRanges(snapshot, referenceId);
    expect(codonRanges.length).toBeGreaterThanOrEqual(2);
    expect(snapshot[0]).toMatchObject({
      source: { kind: 'translation-track', id: referenceId, surface: 'sequence-cds' },
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [
          {
            start: codonRanges[0].start / 3,
            end: codonRanges[codonRanges.length - 1].start / 3,
          },
        ],
      },
    });
    for (let i = 1; i < codonRanges.length; i += 1) {
      expect(codonRanges[i].start).toBe(codonRanges[i - 1].start + 3);
      expect(codonRanges[i].end).toBe(codonRanges[i - 1].end + 3);
    }

    clickResidue(reverse.x, reverse.y, true);

    const grownSnapshot = store.getSnapshot();
    expect(grownSnapshot).toHaveLength(1);
    const grownCodonRanges = residueSelectionsToCodingDnaRanges(grownSnapshot, referenceId);
    expect(grownCodonRanges.length).toBeGreaterThan(codonRanges.length);
    expect(grownCodonRanges[0].start).toBeLessThan(codonRanges[0].start);
    expect(grownCodonRanges[grownCodonRanges.length - 1]).toEqual(
      codonRanges[codonRanges.length - 1]
    );
    expect(grownSnapshot[0]).toMatchObject({
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [
          {
            start: grownCodonRanges[0].start / 3,
            end: grownCodonRanges[grownCodonRanges.length - 1].start / 3,
          },
        ],
      },
    });
  });
});

describe('SequenceViewer1D — RNA complement strand ', () => {
  it('preserves physical strand overrides while complementing uncovered RNA bases', async () => {
    const sequence: AnnotatedSequence = {
      id: 'rna-physical-strands',
      name: 'RNA physical strands',
      sequence: 'AAGGAA',
      length: 6,
      circular: false,
      molecule: 'mRNA',
      annotations: [],
      strandOverrides: [{ start: 1, forward: '  ', reverse: 'GU' }],
    };
    const { container } = render(
      <SequenceViewer1D sequence={sequence} showRuler={false} showReverseComplement />
    );
    await act(async () => {
      await flushFrames();
    });
    const letters = opsOf(getRecordingLog(getViewerCanvas(container)), 'fillText').filter((op) =>
      /^[ACGTU]$/.test(op.text)
    );
    const rows = [...new Set(letters.map((op) => op.y))].sort((a, b) => a - b);
    expect(rows).toHaveLength(2);
    const strand = (y: number) =>
      [...new Map(letters.filter((op) => op.y === y).map((op) => [op.x, op.text])).entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, base]) => base)
        .join('');
    expect(strand(rows[0])).toBe('AGAA');
    expect(strand(rows[1])).toBe('UGUCUU');
    expect(sequence.sequence).toBe('AAGGAA');
  });

  it('draws the complement strand of an RNA record with U', async () => {
    const bases = 'AAGG'.repeat(12);
    const sequence: AnnotatedSequence = {
      id: 'rna',
      name: 'rna',
      sequence: bases,
      length: bases.length,
      circular: false,
      molecule: 'mRNA',
      annotations: [],
    };
    const { container } = render(
      <SequenceViewer1D sequence={sequence} showReverseComplement zoomPercent={100} />
    );
    await act(async () => {
      await flushFrames();
    });
    const letters = new Set(
      opsOf(getRecordingLog(getViewerCanvas(container)), 'fillText').map((op) => op.text)
    );
    expect(letters.has('U')).toBe(true);
    expect(letters.has('T')).toBe(false);
  });
});
