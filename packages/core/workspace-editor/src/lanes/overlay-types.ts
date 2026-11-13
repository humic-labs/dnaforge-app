export const BUILTIN_OVERLAY_TARGETS = ['sequenceBand', 'ruler'] as const;
export type BuiltinOverlayTarget = (typeof BUILTIN_OVERLAY_TARGETS)[number];

export interface ReferenceColumnOverlay {
  id: string;
  target: BuiltinOverlayTarget | string;
  columns: ReadonlyArray<number>;
  color: string;
  kind: 'columnWash' | 'topMarker' | 'bottomMarker';
  alpha?: number;
  thickness?: number;
}
