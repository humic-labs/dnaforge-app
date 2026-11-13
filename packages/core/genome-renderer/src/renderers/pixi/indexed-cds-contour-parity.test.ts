import { describe, expect, it, vi } from 'vitest';
import {
  buildChevronStripOuterPath,
  cdsReplacementZoomPresentation,
  cdsZoomBandCenterOffset,
  CODON_CHEVRON_DEPTH_RATIO,
  type OutlinePoint,
} from '@waypoint/platform';
import { computeCodonCells } from '../../../../workspace-editor/src/codon-rendering';
import { drawIndexedCdsZoomGlyph } from './overlays/indexed-cds-zoom-drawing';
import type { ImmediateDrawHost } from './overlays/indexed-annotation-draw-host';
import type { OutlineCommand } from './overlays/annotation-feature-geometry';
import type { PathMapper } from './shared/path-mapper';
import type { Feature, RenderState } from '../../types';

const sequence = 'GCT'.repeat(300);

describe('indexed coding contour matches actual codon cells', () => {
  for (const direction of ['forward', 'reverse'] as const)
    for (const type of ['CDS', 'mRNA'])
      for (const viewStart of [0, 202])
        it(`${direction} ${type} retains the joined codon envelope from view ${viewStart}`, () => {
          const segments = [
            { start: 101, end: 107 },
            { start: 201, end: 208 },
          ];
          const feature: Feature = {
            id: 1,
            type,
            start: type === 'CDS' ? 100 : 80,
            end: type === 'CDS' ? 208 : 228,
            direction,
            displayName: 'split codon',
            color: 0x3b82f6,
            lane: 0,
            ...(type === 'CDS' ? { segments } : { cds: segments }),
          };
          const pose = cdsReplacementZoomPresentation(8, 655);
          const center = cdsZoomBandCenterOffset(pose);
          const top = center - pose.aaHeight / 2;
          const path = {
            cdsZoomPresentation: pose,
            pixelsPerBp: 8,
            isArcMode: false,
            viewStartBp: viewStart,
            viewEndBp: viewStart + 655 / 8,
            featureLabelPosAt: (bp: number, offset: number) => ({
              x: (bp + 0.5 - viewStart) * 8,
              y: offset,
              angle: 0,
            }),
            isFeatureVisible: () => true,
          } as unknown as PathMapper;
          const outlines: OutlineCommand[] = [];
          const host = {
            featureOffset: () => 0,
            setFeatureOutline: (_id: number, commands: OutlineCommand[]) => {
              outlines.push(...commands);
            },
            drawCDSLabelStrip: vi.fn(),
            featureLevelLabelCenterBp: () => 154,
          } as unknown as ImmediateDrawHost;
          drawIndexedCdsZoomGlyph(
            host,
            { fillPoly: vi.fn(), strokePoly: vi.fn() },
            feature,
            path,
            {} as RenderState,
            feature.color,
            1,
            [],
            feature.end - feature.start
          );
          const cells = computeCodonCells(
            { start: 100, end: 207, direction: direction === 'forward' ? 1 : -1, segments },
            0,
            sequence.length,
            -viewStart * 8,
            8,
            sequence,
            sequence.length,
            { type: 'normal' }
          );
          for (let index = 0; index < segments.length; index++) {
            const segment = segments[index];
            const left = (segment.start - 1 - viewStart) * 8;
            const right = (segment.end - viewStart) * 8;
            const expected: OutlinePoint[] = [];
            buildChevronStripOuterPath(
              {
                beginPath: () => undefined,
                moveTo: (x, y) => expected.push({ x, y }),
                lineTo: (x, y) => expected.push({ x, y }),
                closePath: () => undefined,
              },
              cells.filter((cell) => cell.codonX < right && cell.codonX + cell.visibleWidth > left),
              top,
              pose.aaHeight,
              Math.round(pose.aaHeight * CODON_CHEVRON_DEPTH_RATIO),
              direction === 'forward' ? 1 : -1
            );
            expect(outlines[index * 2]).toEqual({
              kind: 'poly',
              pts: expected.flatMap(({ x, y }) => [x, y]),
            });
          }
        });
});
