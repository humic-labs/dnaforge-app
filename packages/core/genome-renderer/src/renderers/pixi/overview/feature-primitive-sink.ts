import type { Graphics } from 'pixi.js';
import type { PathMapper } from '../shared/path-mapper';

export interface FeaturePrimitiveSink {
  fillPoly(pts: number[], color: number, alpha: number): void;
  strokePoly(pts: number[], color: number, alpha: number, width?: number): void;
}

export class GraphicsPrimitiveSink implements FeaturePrimitiveSink {
  constructor(
    private readonly g: Graphics,
    private readonly path: PathMapper
  ) {}

  fillPoly(pts: number[], color: number, alpha: number): void {
    this.g.poly(pts);
    this.g.fill({ color, alpha });
  }

  strokePoly(pts: number[], color: number, alpha: number, width = 1.5): void {
    this.g.poly(pts);
    this.g.setStrokeStyle({ width: this.path.scaleStroke(width), color, alpha });
    this.g.stroke();
  }
}
