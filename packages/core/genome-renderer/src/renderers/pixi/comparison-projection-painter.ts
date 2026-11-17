import { Container, Graphics, TextStyle } from 'pixi.js';
import { complementBase, TRACK_COLOR_PRESETS } from '@waypoint/sequence-utils';
import type { GenomeComparisonSide } from '@waypoint/genome-data';
import {
  comparisonColumnLoci,
  comparisonColumnX,
  comparisonPlot,
  type ComparisonCamera,
  type ComparisonProjection,
} from '../../comparison-projection';
import type { RenderState } from '../../types';
import {
  TextPool,
  LABEL_FONT_FAMILY,
  RULER_FONT_SIZE,
  computeTickStep,
  formatRulerLabel,
  webglThemeForMode,
} from './shared';

export class ComparisonProjectionPainter {
  readonly container = new Container();
  readonly graphics = new Graphics();
  private readonly labels: TextPool;
  private diagnostics: object | null = null;
  private theme: string | undefined;

  constructor() {
    this.container.eventMode = 'none';
    this.container.visible = false;
    this.container.addChild(this.graphics);
    this.labels = new TextPool(
      this.container,
      new TextStyle({ fontSize: RULER_FONT_SIZE, fontFamily: LABEL_FONT_FAMILY })
    );
  }

  paint(projection: ComparisonProjection, camera: ComparisonCamera, state: RenderState): void {
    this.container.visible = true;
    const g = this.graphics.clear();
    this.labels.reset();
    const theme = webglThemeForMode(state.themeMode);
    if (this.theme !== theme.mode) {
      this.theme = theme.mode;
      this.labels.setStyle(
        new TextStyle({
          fontSize: RULER_FONT_SIZE,
          fontFamily: LABEL_FONT_FAMILY,
          fill: theme.rulerText,
        })
      );
    }
    const plot = comparisonPlot(state.width, state.height);
    const x = (column: number) => comparisonColumnX(column, camera, plot);
    const color = (side: GenomeComparisonSide) =>
      Number.parseInt(TRACK_COLOR_PRESETS[side === 'target' ? 0 : 2].slice(1), 16);
    const label = (value: string, px: number, py: number, anchor = 0.5) => {
      const text = this.labels.acquire();
      text.text = value;
      text.anchor.set(anchor, 0.5);
      text.position.set(px, py);
    };
    const pixelsPerColumn = plot.width / (camera.endColumn - camera.startColumn);
    let blocksPainted = 0,
      gapsPainted = 0,
      joinsPainted = 0,
      annotationsPainted = 0,
      baseLetters = 0;
    const gapSamples: Array<{
      side: GenomeComparisonSide;
      startColumn: number;
      endColumn: number;
      boundary: number;
    }> = [];
    for (const entry of projection.layout.entries) {
      if (entry.columnEnd <= camera.startColumn || entry.columnStart >= camera.endColumn) continue;
      const left = Math.max(plot.x, x(entry.columnStart));
      const right = Math.min(plot.x + plot.width, x(entry.columnEnd));
      if (entry.kind === 'unaligned-join') {
        joinsPainted += 1;
        for (const y of [plot.targetY, plot.queryY]) {
          g.moveTo(left, y)
            .lineTo((left + right) / 2 - 2, y - 5)
            .lineTo((left + right) / 2 + 2, y + 5)
            .lineTo(right, y)
            .stroke({ color: theme.rulerText, width: 1, alpha: 0.6 });
        }
        continue;
      }
      const block = entry.block;
      blocksPainted += 1;
      const quality = block.mappingQuality === 255 ? 0 : Math.min(60, block.mappingQuality);
      const qualityAlpha = 0.06 + (quality / 60) * 0.18;
      const bend = Math.min(24, Math.max(2, (right - left) / 6));
      const midY = (plot.targetY + plot.queryY) / 2;
      g.moveTo(left, plot.targetY + plot.rowHeight / 2)
        .bezierCurveTo(left - bend, midY, left - bend, midY, left, plot.queryY - plot.rowHeight / 2)
        .lineTo(right, plot.queryY - plot.rowHeight / 2)
        .bezierCurveTo(
          right + bend,
          midY,
          right + bend,
          midY,
          right,
          plot.targetY + plot.rowHeight / 2
        )
        .closePath()
        .fill({ color: color(block.strand === '+' ? 'target' : 'query'), alpha: qualityAlpha });
      for (const segment of block.segments) {
        const startColumn = entry.columnStart + segment.columnStart;
        const endColumn = entry.columnStart + segment.columnEnd;
        if (endColumn <= camera.startColumn || startColumn >= camera.endColumn) continue;
        const segmentLeft = Math.max(plot.x, x(startColumn));
        const segmentRight = Math.min(plot.x + plot.width, x(endColumn));
        for (const side of ['target', 'query'] as const) {
          const y = side === 'target' ? plot.targetY : plot.queryY;
          const gap = side === 'target' ? segment.code === 'I' : segment.code === 'D';
          if (gap) {
            gapsPainted += 1;
            const boundary = side === 'target' ? segment.targetStart : segment.queryStart;
            if (gapSamples.length < 20) gapSamples.push({ side, startColumn, endColumn, boundary });
            g.moveTo(segmentLeft, y)
              .lineTo(segmentRight, y)
              .stroke({ color: theme.rulerText, width: 1, alpha: 0.35 });
            if (segmentRight - segmentLeft >= 2)
              g.rect(
                segmentLeft,
                y - plot.rowHeight / 2,
                segmentRight - segmentLeft,
                plot.rowHeight
              ).stroke({ color: theme.rulerText, width: 1, alpha: 0.4 });
          } else
            g.rect(
              segmentLeft,
              y - plot.rowHeight / 2,
              segmentRight - segmentLeft,
              plot.rowHeight
            ).fill({ color: color(side), alpha: segment.code === 'X' ? 0.45 : 0.8 });
        }
      }
      for (const side of ['target', 'query'] as const) {
        const y = side === 'target' ? plot.targetY : plot.queryY;
        for (const annotation of projection.annotations?.[side] ?? []) {
          if (annotation.end <= block[side].start || annotation.start >= block[side].end) continue;
          for (const segment of block.segments) {
            const start = side === 'target' ? segment.targetStart : segment.queryStart;
            const end = side === 'target' ? segment.targetEnd : segment.queryEnd;
            const lo = Math.max(start, annotation.start),
              hi = Math.min(end, annotation.end);
            if (lo >= hi) continue;
            const reverse = side === 'query' && block.strand === '-';
            const colStart =
              entry.columnStart + segment.columnStart + (reverse ? end - hi : lo - start);
            const colEnd =
              entry.columnStart + segment.columnStart + (reverse ? end - lo : hi - start);
            if (colEnd <= camera.startColumn || colStart >= camera.endColumn) continue;
            const ax = Math.max(plot.x, x(colStart)),
              bx = Math.min(plot.x + plot.width, x(colEnd));
            g.rect(ax, y - 7, bx - ax, 14).fill(
              annotation.color ? Number.parseInt(annotation.color.slice(1), 16) : color(side)
            );
            if (bx - ax > annotation.label.length * 7 + 8)
              label(annotation.label, (ax + bx) / 2, y - 24);
            annotationsPainted += 1;
          }
        }
      }
    }
    for (const side of ['target', 'query'] as const) {
      const y = side === 'target' ? plot.targetY : plot.queryY;
      const title = side === 'target' ? projection.targetLabel : projection.queryLabel;
      label(title ?? projection.comparison[side].id, plot.x, y - 46, 0);
      const step = computeTickStep(camera.endColumn - camera.startColumn, plot.width);
      for (
        let column = Math.ceil(camera.startColumn / step) * step;
        column < camera.endColumn;
        column += step
      ) {
        const locus = comparisonColumnLoci(projection, Math.floor(column))?.[side];
        if (!locus || locus.kind !== 'base') continue;
        g.moveTo(x(column), y + 13)
          .lineTo(x(column), y + 18)
          .stroke({ color: theme.rulerText, width: 1, alpha: 0.6 });
        label(formatRulerLabel(locus.position + 1, step), x(column), y + 31);
      }
    }
    if (pixelsPerColumn >= 10) {
      for (let column = Math.ceil(camera.startColumn); column < camera.endColumn; column += 1) {
        const loci = comparisonColumnLoci(projection, column);
        if (!loci) continue;
        for (const side of ['target', 'query'] as const) {
          const locus = loci[side];
          const sequence = side === 'target' ? projection.targetSequence : projection.querySequence;
          let base =
            locus.kind === 'gap'
              ? '-'
              : locus.kind === 'base' && sequence
                ? sequence[locus.position]
                : null;
          if (base && locus.kind === 'base' && side === 'query' && loci.strand === '-')
            base = complementBase(base);
          if (base) {
            label(
              base.toUpperCase(),
              x(column + 0.5),
              side === 'target' ? plot.targetY : plot.queryY
            );
            baseLetters += 1;
          }
        }
      }
    }
    for (const hit of [state.hoveredComparison, state.selectedComparison]) {
      if (hit?.projectionId !== projection.id) continue;
      const px = x(hit.column + 0.5);
      g.moveTo(px, plot.targetY - 14)
        .lineTo(px, plot.queryY + 14)
        .stroke({
          color: theme.rulerText,
          width: hit === state.selectedComparison ? 2 : 1,
          alpha: 0.7,
        });
    }
    this.diagnostics = {
      projectionId: projection.id,
      targetReference: projection.comparison.target,
      queryReference: projection.comparison.query,
      camera: { ...camera },
      plot,
      sourceBlockCount: projection.comparison.blocks.length,
      alignmentColumns: projection.layout.columnLength,
      blocksPainted,
      gapsPainted,
      joinsPainted,
      annotationsPainted,
      baseLetters,
      gapSamples,
      hoveredComparison: state.hoveredComparison ?? null,
      selectedComparison: state.selectedComparison ?? null,
      visible: true,
    };
  }

  getDiagnostics(): object | null {
    return this.container.visible ? this.diagnostics : null;
  }

  destroy(): void {
    this.labels.destroy();
    this.container.destroy({ children: true });
  }
}
