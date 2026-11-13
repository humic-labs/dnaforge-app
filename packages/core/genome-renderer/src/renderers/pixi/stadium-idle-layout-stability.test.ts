// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Application, Container } from 'pixi.js';
import { beforeAll, expect, it } from 'vitest';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { Feature, Genome, RenderState } from '../../types';
import { PixiStadiumRenderer } from './stadium-renderer';

beforeAll(() => {
  if (typeof CanvasRenderingContext2D === 'undefined') {
    (globalThis as unknown as { CanvasRenderingContext2D: unknown }).CanvasRenderingContext2D =
      class CanvasRenderingContext2D {};
  }
  HTMLCanvasElement.prototype.getContext = ((contextId: string) =>
    contextId === '2d'
      ? { font: '', measureText: (text: string) => ({ width: text.length * 7 }) }
      : null) as typeof HTMLCanvasElement.prototype.getContext;
});

it(' repeated fixed-camera draws retain circle geometry and label placement from the first frame', async () => {
  const source = parseGenBankFull(
    readFileSync(
      resolve(
        __dirname,
        '../../../../../../apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/kits/moclo-cidar/R0040_AB/R0040_AB.gb'
      ),
      'utf8'
    )
  );
  const retainedLanes = [0, 0, 1, 0, 1, 1, 1, 2, 1, 0, 1, 1, 1, 1];
  const genome: Genome = {
    name: source.name,
    length: source.length,
    circular: true,
    sequence: source.sequence,
    features: source.annotations.map(
      (feature, id): Feature => ({
        id,
        type: feature.type,
        start: feature.start - 1,
        end: feature.end,
        displayName: feature.name,
        direction:
          feature.direction === 1 ? 'forward' : feature.direction === -1 ? 'reverse' : 'none',
        color: 0x3b82f6,
        lane: retainedLanes[id],
      })
    ),
  };
  expect(genome.name).toBe('pTet');
  expect(genome.length).toBe(2162);
  expect(genome.features).toHaveLength(14);
  const state: RenderState = {
    morph: 1,
    viewOffset: 0.6047925,
    zoom: 0.9531337870775064,
    width: 455,
    height: 965,
    geometryHeight: 600,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
  const renderer = new PixiStadiumRenderer();
  await renderer.init(
    { stage: new Container(), canvas: document.createElement('canvas') } as unknown as Application,
    genome,
    () => state
  );
  const frames: string[] = [];
  try {
    for (let frame = 0; frame < 60; frame += 1) {
      renderer.render(state);
      const debug = renderer.getRendererDebugSnapshot() as {
        annotationOverlay: {
          floatingLabelFrame: {
            placedCount: number;
            fingerprint: string;
            assignmentFingerprint: string;
            assignmentZoomBandIndex: number;
          };
        };
        camera: { overviewLaneScale: number };
      };
      const labels = debug.annotationOverlay.floatingLabelFrame;
      expect(labels.placedCount).toBeGreaterThan(0);
      frames.push(
        JSON.stringify({
          dims: renderer.getFrameLayoutContract()?.topology,
          overviewLaneScale: debug.camera.overviewLaneScale,
          placed: labels.placedCount,
          band: labels.assignmentZoomBandIndex,
          assignment: labels.assignmentFingerprint,
          placement: labels.fingerprint,
        })
      );
    }
    expect(new Set(frames).size, JSON.stringify(frames.slice(0, 4), null, 2)).toBe(1);
    const labeledWidth = (
      renderer.getFrameLayoutContract()?.topology as { dims: { width: number } }
    ).dims.width;
    await renderer.loadGenome({
      ...genome,
      features: genome.features!.map((feature) => ({ ...feature, displayName: '' })),
    });
    renderer.render(state);
    const unlabeledWidth = (
      renderer.getFrameLayoutContract()?.topology as { dims: { width: number } }
    ).dims.width;
    expect(unlabeledWidth).toBeGreaterThan(labeledWidth);
  } finally {
    renderer.destroy();
  }
});
