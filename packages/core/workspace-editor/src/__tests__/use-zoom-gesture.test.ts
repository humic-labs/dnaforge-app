import { describe, it, expect, vi } from 'vitest';
import {
  applyTransform,
  clearTransform,
  applyCommitEffects,
  bpAtCursorForZoom,
  clampZoomLocal,
  computeBpOffsetForAnchor,
  computeCursorCol,
} from '../use-zoom-gesture';
import { MIN_ZOOM, MAX_ZOOM } from '../zoom-controller';
import { DEFAULT_EDITOR_CONFIG, type SequenceLayout, type WorkspaceEditorConfig } from '../types';
import type { TransformEffect, CommitEffect, ResetEffect } from '../zoom-controller';

function mkDeps(
  overrides: {
    currentZoom?: number;
    onZoomLevelChange?: (next: number) => void;
  } = {}
): Parameters<typeof applyCommitEffects>[1] {
  return {
    currentZoom: overrides.currentZoom ?? 50,
    onZoomLevelChange: overrides.onZoomLevelChange ?? vi.fn(),
  };
}

function mkCanvas() {
  return {
    style: { transform: '', transformOrigin: '' },
  };
}

function mkContainer(scrollTop = 0): HTMLElement {
  return {
    scrollTop,
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 500,
      height: 400,
      right: 510,
      bottom: 420,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLElement;
}

describe('clampZoomLocal', () => {
  it('clamps to [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(clampZoomLocal(0)).toBe(MIN_ZOOM);
    expect(clampZoomLocal(500)).toBe(MAX_ZOOM);
    expect(clampZoomLocal(75)).toBe(75);
  });

  it('falls back to 100 on NaN', () => {
    expect(clampZoomLocal(NaN)).toBe(100);
  });
});

describe('applyTransform', () => {
  it('writes scale and transform-origin to the canvas element', () => {
    const canvas = mkCanvas();
    const e: TransformEffect = {
      kind: 'setTransform',
      scale: 1.23,
      origin: { x: 150, y: 250 },
    };
    applyTransform(canvas, e);
    expect(canvas.style.transform).toBe('scale(1.23)');
    expect(canvas.style.transformOrigin).toBe('150px 250px');
  });

  it('is a no-op when canvas is null', () => {
    expect(() =>
      applyTransform(null, {
        kind: 'setTransform',
        scale: 1,
        origin: { x: 0, y: 0 },
      })
    ).not.toThrow();
  });
});

describe('clearTransform', () => {
  it('resets transform and transform-origin to empty', () => {
    const canvas = mkCanvas();
    canvas.style.transform = 'scale(1.5)';
    canvas.style.transformOrigin = '100px 100px';
    clearTransform(canvas);
    expect(canvas.style.transform).toBe('');
    expect(canvas.style.transformOrigin).toBe('');
  });
});

describe('bpAtCursorForZoom', () => {
  it('returns a row-level bp when the cursor is outside the sub-pixel nucleotide row', () => {
    const config: WorkspaceEditorConfig = {
      ...DEFAULT_EDITOR_CONFIG,
      charWidth: 2,
      rowHeight: 0.04,
      showAnnotations: false,
      showTranslation: false,
      showReverseComplement: false,
      showPrimers: false,
    };
    const layout: SequenceLayout = {
      lines: [
        {
          lineIndex: 0,
          startPos: 100,
          endPos: 200,
          sequence: 'A'.repeat(100),
          complementSequence: '',
          y: 100,
          annotations: [],
          annotationLaneCount: 0,
          translationLaneCount: 0,
        },
      ],
      totalHeight: 220,
      totalWidth: 500,
      sequenceLength: 1000,
      isCircular: false,
    };
    const container = mkContainer(0);
    const clientX = 10 + config.marginLeft + 20 * config.charWidth;
    const clientY = 20 + 130;

    expect(bpAtCursorForZoom(layout, config, container, clientX, clientY)).toBe(120);
  });
});

describe('applyCommitEffects', () => {
  it('calls onZoomLevelChange with clampedZoom(currentZoom × scaleDelta) and flags reset', () => {
    const onZoomLevelChange = vi.fn();
    const effects: Array<CommitEffect | ResetEffect> = [
      {
        kind: 'commit',
        scaleDelta: 1.5,
        anchorBp: 100,
        anchorCursorX: 500,
        anchorCursorY: 250,
      },
      { kind: 'resetTransform' },
    ];
    const { pendingAnchor, resetPending } = applyCommitEffects(
      effects,
      mkDeps({ currentZoom: 50, onZoomLevelChange })
    );
    expect(onZoomLevelChange).toHaveBeenCalledTimes(1);
    expect(onZoomLevelChange).toHaveBeenCalledWith(75);
    expect(pendingAnchor).toEqual({ bp: 100, cursorX: 500, cursorY: 250 });
    expect(resetPending).toBe(true);
  });

  it('clamps to MAX_ZOOM when scaleDelta would exceed it', () => {
    const onZoomLevelChange = vi.fn();
    applyCommitEffects(
      [{ kind: 'commit', scaleDelta: 10, anchorBp: 0, anchorCursorX: 0, anchorCursorY: 0 }],
      mkDeps({ currentZoom: 80, onZoomLevelChange })
    );
    expect(onZoomLevelChange).toHaveBeenCalledWith(MAX_ZOOM);
  });

  it('clamps to MIN_ZOOM when scaleDelta would drop below MIN_ZOOM', () => {
    const onZoomLevelChange = vi.fn();
    applyCommitEffects(
      [{ kind: 'commit', scaleDelta: 0.001, anchorBp: 0, anchorCursorX: 0, anchorCursorY: 0 }],
      mkDeps({ currentZoom: 100, onZoomLevelChange })
    );
    expect(onZoomLevelChange).toHaveBeenCalledWith(MIN_ZOOM);
  });

  it('returns null pendingAnchor when there is no commit effect', () => {
    const { pendingAnchor } = applyCommitEffects([{ kind: 'resetTransform' }], mkDeps());
    expect(pendingAnchor).toBeNull();
  });

  it('pendingAnchor reflects the LAST commit when multiple are in the array', () => {
    const { pendingAnchor } = applyCommitEffects(
      [
        {
          kind: 'commit',
          scaleDelta: 1.1,
          anchorBp: 10,
          anchorCursorX: 100,
          anchorCursorY: 100,
        },
        {
          kind: 'commit',
          scaleDelta: 1.2,
          anchorBp: 20,
          anchorCursorX: 200,
          anchorCursorY: 200,
        },
      ],
      mkDeps({ currentZoom: 100 })
    );
    expect(pendingAnchor).toEqual({ bp: 20, cursorX: 200, cursorY: 200 });
  });

  it('pendingAnchor carries cursorX so the post-commit effect can compute bpOffset', () => {
    const { pendingAnchor } = applyCommitEffects(
      [
        {
          kind: 'commit',
          scaleDelta: 1,
          anchorBp: 42,
          anchorCursorX: 555,
          anchorCursorY: 777,
        },
      ],
      mkDeps()
    );
    expect(pendingAnchor).toEqual({ bp: 42, cursorX: 555, cursorY: 777 });
  });
});

describe('computeBpOffsetForAnchor', () => {
  it('returns 0 when anchorBp ≡ cursorColNew (mod cpl)', () => {
    expect(computeBpOffsetForAnchor(80, 0, 80)).toBe(0);
    expect(computeBpOffsetForAnchor(160, 0, 80)).toBe(0);
  });

  it('shifts by cursorCol when anchor is far from row boundary', () => {
    expect(computeBpOffsetForAnchor(100, 40, 80)).toBe(60);
  });

  it('result is always in [0, cpl)', () => {
    for (const anchorBp of [0, 1, 79, 80, 200, 999]) {
      for (const cursorCol of [0, 10, 79]) {
        for (const cpl of [10, 40, 80, 100]) {
          const bp = computeBpOffsetForAnchor(anchorBp, cursorCol, cpl);
          expect(bp).toBeGreaterThanOrEqual(0);
          expect(bp).toBeLessThan(cpl);
        }
      }
    }
  });

  it('handles circularOffset correctly', () => {
    expect(computeBpOffsetForAnchor(200, 10, 80, 20)).toBe((200 - 10 - 20) % 80);
  });

  it('round-trip invariant: the row containing anchor at col X starts at startPos such that startPos + X = anchorBp (mod cpl)', () => {
    const anchorBp = 1523;
    const cursorCol = 25;
    const cpl = 60;
    const circularOffset = 100;
    const bpOffset = computeBpOffsetForAnchor(anchorBp, cursorCol, cpl, circularOffset);
    const startPosBase = circularOffset + bpOffset;
    const N = Math.floor((anchorBp - startPosBase) / cpl);
    const startPos = startPosBase + N * cpl;
    expect(anchorBp - startPos).toBe(cursorCol);
  });
});

describe('computeCursorCol', () => {
  it('returns 0 when cursor is at the left of the margin', () => {
    expect(computeCursorCol(40, 0, 40, 8, 80)).toBe(0);
  });

  it('computes column from clientX, containerLeft, marginLeft, charWidth', () => {
    expect(computeCursorCol(200, 0, 40, 8, 80)).toBe(20);
  });

  it('clamps to [0, charsPerLine)', () => {
    expect(computeCursorCol(1_000_000, 0, 40, 8, 80)).toBe(79);
  });

  it('returns 0 for invalid charWidth or cpl', () => {
    expect(computeCursorCol(200, 0, 40, 0, 80)).toBe(0);
    expect(computeCursorCol(200, 0, 40, 8, 0)).toBe(0);
  });
});
