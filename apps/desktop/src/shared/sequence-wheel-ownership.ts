export interface SequenceWheelBridge {
  nativeWheelMetadata: boolean;
  onWheelMetadata(handler: (packet: NativeWheelMetadata) => void): () => void;
}

export interface NativeWheelMetadata {
  precise: boolean;
  phase: number;
  momentumPhase: number;
  ordinal: number;
  timestamp: number;
}
