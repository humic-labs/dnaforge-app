export interface SequenceWheelZoomRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SequenceWheelBridge {
  nativeGestureOwnership: boolean;
  nativeDiscreteWheelMotion: boolean;
  setZoomRegions(regions: SequenceWheelZoomRegion[]): void;
  onMouseWheel(handler: (packet: SequenceMouseWheelPacket) => void): () => void;
  returnMouseWheel(packet: SequenceMouseWheelPacket): void;
}

export interface BrowserWheelInput {
  type: 'mouseWheel';
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  wheelTicksX: number;
  wheelTicksY: number;
  hasPreciseScrollingDeltas: boolean;
  modifiers: Array<'control' | 'meta' | 'shift' | 'alt'>;
}

export function browserWheelInput(
  packet: SequenceMouseWheelPacket | null | undefined
): BrowserWheelInput | null {
  if (!packet || typeof packet !== 'object') return null;
  const { x, y, deltaX, deltaY } = packet;
  if (![x, y, deltaX, deltaY].every(Number.isFinite) || (!deltaX && !deltaY)) return null;
  const modifiers: BrowserWheelInput['modifiers'] = [];
  if (packet.ctrlKey === true) modifiers.push('control');
  if (packet.metaKey === true) modifiers.push('meta');
  if (packet.shiftKey === true) modifiers.push('shift');
  if (packet.altKey === true) modifiers.push('alt');
  return {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX: -deltaX,
    deltaY: -deltaY,
    wheelTicksX: -deltaX / 40,
    wheelTicksY: -deltaY / 40,
    hasPreciseScrollingDeltas: packet.precise === true,
    modifiers,
  };
}

export interface SequenceMouseWheelPacket {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  precise: boolean;
  phase: number;
  momentumPhase: number;
  ordinal: number;
}
