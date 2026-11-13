/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGenBankFull, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { computeLineTrackPositions } from '../line-track-layout';
import { renderSequence } from '../canvas-renderer';
import { computeScaledConfig } from '../zoom-math';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorConfig } from '../types';
import {
  getRecordingLog,
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const mg1655 = parseGenBankFull(
  readFileSync(
    join(__dirname, '../../../../../test-fixtures/sequences/circular/ecoli-mg1655-complete.gb'),
    'utf8'
  )
);
const width = 655;
const initialCapacity = 118.07406453033478;
const initialCharWidth = 5.513488525947623;
const anchorBp = 4_608_061;
const anchorX = 4 + 59 * initialCharWidth;
const anchorRow = 4;

function build(capacity: number, direction: -1 | 1 = -1, centerBp = anchorBp) {
  const charWidth = (width - 4) / capacity;
  const presentation = cdsReplacementZoomPresentation(charWidth, width);
  const config: WorkspaceEditorConfig = {
    ...computeScaledConfig(DEFAULT_EDITOR_CONFIG, (charWidth / 8) * 100),
    charsPerLine: Math.floor(capacity),
    linearWrapPhase: true,
    wrapCapacity: capacity,
    wrapAnchorBp: centerBp,
    wrapAnchorViewportX: anchorX,
    wrapAnchorCapacityBias: 118 - initialCapacity,
    wrapForecastDirection: direction,
    showTranslation: true,
    cdsDetailProgress: presentation.progress,
    cdsZoomPresentation: presentation,
  };
  const column = Math.round((anchorX - config.marginLeft) / charWidth);
  const layout = computeSequenceLayoutImpl(
    mg1655,
    config,
    centerBp - column,
    anchorRow,
    [],
    false,
    [],
    0,
    { firstRowIndex: 0, lastRowIndex: 8, emitOnlyViewportLines: true }
  );
  return { config, layout };
}

function paintName(
  frame: ReturnType<typeof build>,
  slot: number,
  name: string,
  subject: AnnotatedSequence = mg1655,
  surfaceWidth = width + 128
) {
  const row = frame.layout.lines.find((r) => r.lineIndex === anchorRow + slot)!;
  const cds = row.classifiedCDSs.find((c) => c.name === name)!;
  expect(cds).toBeDefined();
  const canvas = document.createElement('canvas');
  renderSequence(canvas.getContext('2d')!, {
    linePositions: [computeLineTrackPositions(row, frame.config)],
    config: frame.config,
    layout: frame.layout,
    canvasWidth: surfaceWidth,
    canvasHeight: frame.layout.totalHeight,
    sequenceLength: subject.sequence.length,
    fullSequence: subject.sequence,
    cutSites: [],
    scannedCutSites: [],
    primers: [],
    mutations: [],
    rulerSegments: [],
    insertedRanges: [],
    deletedRanges: [],
    showCutSites: false,
    highlightedRange: null,
    hoveredCodon: null,
    viewCursor: null,
    hoveredCutSite: null,
    hoveredGGProductLabel: null,
    hoveredEnzymeName: null,
    hoveredPositionInfo: null,
    viewport: { scrollTop: 0, height: frame.layout.totalHeight },
  });
  let state = { x: 0, scale: 1, alpha: 1 };
  const stack: (typeof state)[] = [],
    names: { x: number; alpha: number }[] = [];
  for (const op of getRecordingLog(canvas)) {
    if (op.op === 'save') stack.push({ ...state });
    if (op.op === 'restore') state = stack.pop()!;
    if (op.op === 'translate') state.x += op.x * state.scale;
    if (op.op === 'scale') state.scale *= op.x;
    if (op.op === 'set' && op.prop === 'globalAlpha') state.alpha = Number(op.value);
    if (op.op === 'fillText' && op.text === name)
      names.push({ x: op.x * state.scale + state.x, alpha: state.alpha });
  }
  expect(names).toHaveLength(1);
  expect(names[0].alpha).toBe(1);
  return { x: names[0].x, row, cds };
}

beforeEach(installRecordingCanvas);
afterEach(uninstallRecordingCanvas);

describe('wrapped CDS names during slight zoom', () => {
  it('centers the reported yicH continuation in the visible pane, independently of canvas overscan', () => {
    const frame = build(92.6689251533268, -1, 3_831_591);
    for (const surfaceWidth of [width, width + 128]) {
      const actual = paintName(frame, 0, 'yicH', mg1655, surfaceWidth);
      expect(actual.cds).toMatchObject({ start: 3_830_457, end: 3_832_166 });
      expect(actual.x, `surface width ${surfaceWidth}`).toBeCloseTo((4 + width) / 2, 8);
    }
  });

  it('keeps a real continuation label centered when 118 bases become 119', () => {
    const before = paintName(build(118.999999), -1, 'holD');
    const after = paintName(build(119.000001), -1, 'holD');
    expect(
      Math.abs(after.x - before.x),
      JSON.stringify({ before: before.x, after: after.x })
    ).toBeLessThan(0.001);
    expect(after.x).toBeCloseTo((4 + width) / 2, 8);
  });

  it.each([-1, 1] as const)(
    'keeps first, full and last CDS fragments continuous in zoom direction %i',
    (direction) => {
      const capacities = direction === -1 ? [118.999999, 119.000001] : [119.000001, 118.999999];
      const names = [
        [-3, 'rsmC'],
        [-2, 'holD'],
        [-1, 'holD'],
        [0, 'holD'],
        [1, 'holD'],
        [1, 'rimI'],
        [2, 'rimI'],
      ] as const;
      for (const [slot, name] of names) {
        const positions = capacities.map((capacity) => {
          const frame = build(capacity, direction);
          const actual = paintName(frame, slot, name);
          const left =
            frame.config.marginLeft +
            (actual.row.xOffset ?? 0) +
            (actual.cds.start - 1 - actual.row.startPos) * frame.config.charWidth;
          const right =
            frame.config.marginLeft +
            (actual.row.xOffset ?? 0) +
            (actual.cds.end - actual.row.startPos) * frame.config.charWidth;
          const expected = (Math.max(frame.config.marginLeft, left) + Math.min(width, right)) / 2;
          expect(actual.x, `${name}, row ${slot}, capacity ${capacity}`).toBeCloseTo(expected, 8);
          return actual.x;
        });
        expect(Math.abs(positions[1] - positions[0]), `${name}, row ${slot}`).toBeLessThan(0.001);
      }
    }
  );

  it.each([-1, 1] as const)(
    'starts lifting the name from its original inline X on strand %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'first label lift',
        sequence: 'ATG'.repeat(2000),
        circular: false,
        annotations: [{ name: 'protein', type: 'CDS', start: 101, end: 5000, direction }],
      };
      const onset = (width + 256) / 3000;
      const names = [0.75, 0.750000001].map((phase) => {
        const charWidth = onset * phase;
        const presentation = cdsReplacementZoomPresentation(charWidth, width);
        const config = {
          ...computeScaledConfig(DEFAULT_EDITOR_CONFIG, (charWidth / 8) * 100),
          charsPerLine: Math.floor((width - 4) / charWidth),
          linearWrapPhase: true,
          showTranslation: true,
          cdsDetailProgress: presentation.progress,
          cdsZoomPresentation: presentation,
        } as WorkspaceEditorConfig;
        const layout = computeSequenceLayoutImpl(subject, config, 0, 0, [], false, [], 0, {
          firstRowIndex: 0,
          lastRowIndex: 0,
          emitOnlyViewportLines: true,
        });
        return paintName({ config, layout }, -anchorRow, 'protein', subject).x;
      });
      expect(Math.abs(names[1] - names[0]), JSON.stringify(names)).toBeLessThan(0.001);
    }
  );

  it.each([-1, 1] as const)(
    'keeps continuation names centered through an integer wrap during the lift in direction %i',
    (direction) => {
      const subject: AnnotatedSequence = {
        name: 'continuation during label lift',
        sequence: 'ATG'.repeat(12000),
        circular: false,
        annotations: [{ name: 'protein', type: 'CDS', start: 101, end: 35000, direction: 1 }],
      };
      const capacities = direction === -1 ? [2639.999999, 2640.000001] : [2640.000001, 2639.999999];
      for (const capacity of capacities) {
        const charWidth = (width - 4) / capacity;
        const presentation = cdsReplacementZoomPresentation(charWidth, width);
        expect(presentation.bandProgress).toBeGreaterThan(0.1);
        expect(presentation.bandProgress).toBeLessThan(0.9);
        const config: WorkspaceEditorConfig = {
          ...computeScaledConfig(DEFAULT_EDITOR_CONFIG, (charWidth / 8) * 100),
          charsPerLine: Math.floor(capacity),
          linearWrapPhase: true,
          wrapCapacity: capacity,
          wrapAnchorBp: 18000,
          wrapAnchorViewportX: (width + 4) / 2,
          wrapAnchorCapacityBias: 0,
          wrapForecastDirection: direction,
          showTranslation: true,
          cdsDetailProgress: presentation.progress,
          cdsZoomPresentation: presentation,
        };
        const column = Math.round((config.wrapAnchorViewportX! - config.marginLeft) / charWidth);
        const layout = computeSequenceLayoutImpl(
          subject,
          config,
          18000 - column,
          anchorRow,
          [],
          false,
          [],
          0,
          { firstRowIndex: 0, lastRowIndex: 8, emitOnlyViewportLines: true }
        );
        for (const slot of [-1, 0, 1]) {
          const actual = paintName({ config, layout }, slot, 'protein', subject);
          expect(actual.x, `row ${slot}, capacity ${capacity}`).toBeCloseTo((4 + width) / 2, 8);
        }
      }
    }
  );
});
