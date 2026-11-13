export interface ViewerRenderContract {
  projectX(bp: number): number;
  projectY(offsetPx: number): number;
  readonly pixelsPerBp: number;
  readonly xOriginBp?: number;
}

export interface LinearProjectionSource {
  bpLeftX(bp: number): number;
  readonly fwdStrandTop: number;
  readonly pixelsPerBp: number;
  readonly viewStartBp?: number;
}

export function linearViewerRenderContract(source: LinearProjectionSource): ViewerRenderContract {
  return {
    projectX: (bp) => source.bpLeftX(bp),
    projectY: (offsetPx) => source.fwdStrandTop + offsetPx,
    pixelsPerBp: source.pixelsPerBp,
    xOriginBp: source.viewStartBp ?? 0,
  };
}

export class ReusableLinearViewerRenderContract implements ViewerRenderContract {
  private source: LinearProjectionSource | null = null;

  update(source: LinearProjectionSource): void {
    this.source = source;
  }

  projectX(bp: number): number {
    if (!this.source) throw new Error('compiled broad raster projection is not initialized');
    return this.source.bpLeftX(bp);
  }

  projectY(offsetPx: number): number {
    if (!this.source) throw new Error('compiled broad raster projection is not initialized');
    return this.source.fwdStrandTop + offsetPx;
  }

  get pixelsPerBp(): number {
    return this.source?.pixelsPerBp ?? 0;
  }

  get xOriginBp(): number {
    return this.source?.viewStartBp ?? 0;
  }
}
