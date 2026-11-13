export interface MinimapSizingInput {
  paneHeightRaw: number;
  geometryHeightRaw: number;
  minHeight: number;
  maxHeight: number;
  geometryMinHeight?: number;
  paneMaxHeight?: number;
  geometryMaxHeight?: number;
}

export interface MinimapRawSizing {
  paneHeightRaw: number;
  geometryHeightRaw: number;
}

export interface MinimapSizing {
  paneHeight: number;
  geometryHeight: number;
  minimumHeight: number;
}

export function clampMinimapHeightValue(height: number, minHeight: number, maxHeight: number) {
  return Math.max(minHeight, Math.min(maxHeight, height));
}

export function withMinimapPaneHeight(
  state: MinimapRawSizing,
  paneHeightRaw: number
): MinimapRawSizing {
  return state.paneHeightRaw === paneHeightRaw ? state : { ...state, paneHeightRaw };
}

export function withMinimapGeometryHeight(
  state: MinimapRawSizing,
  geometryHeightRaw: number
): MinimapRawSizing {
  return state.geometryHeightRaw === geometryHeightRaw ? state : { ...state, geometryHeightRaw };
}

export function computeMinimapSizing(input: MinimapSizingInput): MinimapSizing {
  const geometryHeight = clampMinimapHeightValue(
    input.geometryHeightRaw,
    input.geometryMinHeight ?? input.minHeight,
    input.geometryMaxHeight ?? input.maxHeight
  );
  const minimumHeight = input.minHeight;
  const paneHeight = clampMinimapHeightValue(
    input.paneHeightRaw,
    input.minHeight,
    input.paneMaxHeight ?? input.maxHeight
  );

  return { paneHeight, geometryHeight, minimumHeight };
}
