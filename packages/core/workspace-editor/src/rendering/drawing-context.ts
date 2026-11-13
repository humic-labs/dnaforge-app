export type SequenceDrawingContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'globalAlpha'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'lineDashOffset'
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'rect'
  | 'roundRect'
  | 'arc'
  | 'fill'
  | 'stroke'
  | 'clip'
  | 'fillRect'
  | 'strokeRect'
  | 'clearRect'
  | 'setLineDash'
  | 'getLineDash'
  | 'createLinearGradient'
  | 'fillText'
  | 'measureText'
> & {
  prepareRepeatedPath?: (
    points: readonly [number, number][],
    mode: 'fill' | 'stroke',
    closed?: boolean
  ) => ((offsetX: number) => void) | null;
  prepareRepeatedText?: (
    text: string,
    y: number,
    maxWidth?: number
  ) => ((x: number) => void) | null;
  setGeometryLayer?: (layer: string | null) => void;
  capturePresentationBackground?: () => void;
  setRowMorphBands?: (
    bands: import('../predictive-wrap-layout').RowMorphBands,
    origin: number
  ) => void;
};
