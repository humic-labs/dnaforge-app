// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCustomGeneticCode,
  geneticCodeKey,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import { SequenceViewer1D } from '../SequenceViewer1D';
import {
  getRecordingLog,
  installRecordingCanvas,
  opsOf,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

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

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;
  for (const prop of ['clientWidth', 'clientHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return prop === 'clientWidth' ? VIEWPORT_WIDTH : VIEWPORT_HEIGHT;
      },
    });
  }
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});

beforeEach(() => {
  installRecordingCanvas();
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
});

async function flushFrames() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 20));
}

const SEQUENCE = 'ATGAAAGGTTTCCATGAACGTTAAGTTTGG';

const ochre = (() => {
  const built = buildCustomGeneticCode({
    id: 'gc-f11e0f1ea0b1',
    revision: 1,
    name: 'Ochre suppression (pBpa at TAA)',
    base: 1,
    changes: { TAA: { kind: 'residue', residue: 'pBpa' } },
    residues: [{ abbreviation: 'pBpa', name: 'p-benzoyl-L-phenylalanine', ccd: 'BPA' }],
  });
  if (!built.ok) throw new Error('fixture must build');
  return built.definition;
})();

function record(chosenGeneticCode?: AnnotatedSequence['chosenGeneticCode']): AnnotatedSequence {
  return {
    id: 'ochre-probe',
    name: 'OCHRE_PROBE',
    sequence: SEQUENCE,
    length: SEQUENCE.length,
    circular: false,
    ...(chosenGeneticCode ? { chosenGeneticCode } : {}),
    annotations: [
      {
        name: 'ochre probe',
        type: 'CDS',
        start: 1,
        end: SEQUENCE.length,
        direction: 1,
        color: '#2563eb',
      },
    ],
  };
}

async function paintedText(sequence: AnnotatedSequence): Promise<string[]> {
  const { container } = render(<SequenceViewer1D sequence={sequence} />);
  await act(async () => {
    await flushFrames();
  });
  const canvas = container
    .querySelector('[data-testid="sequence-viewer-1d"]')
    ?.querySelector('canvas');
  if (!canvas) throw new Error('canvas not found');
  return opsOf(getRecordingLog(canvas), 'fillText').map((op) => op.text);
}

describe('the 1D viewer and the record genetic code', () => {
  it('reads a stop as a stop when the record says nothing', async () => {
    const painted = await paintedText(record());
    expect(painted).toContain('*');
    expect(painted).not.toContain('pBpa');
  });

  it('names the residue the record’s custom code puts on that codon', async () => {
    const painted = await paintedText(record(ochre));
    expect(painted).toContain('pBpa');
  });

  it('says which code it read by, so a wrong reading is visible without pixels', async () => {
    const { container } = render(<SequenceViewer1D sequence={record(ochre)} />);
    await act(async () => {
      await flushFrames();
    });
    const viewer = container.querySelector('[data-testid="sequence-viewer-1d"]');
    expect(viewer?.getAttribute('data-genetic-code')).toBe(geneticCodeKey(ochre));
  });
});
