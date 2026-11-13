export interface PackedRecordBuffer {
  data: Float32Array | Uint8Array | Uint16Array | Uint32Array;
  recordCount: number;
  textureWidth: number;
  textureHeight: number;
  componentsPerRecord: number;
}

export interface PixelRuleTrack<TRecord> {
  type: string;

  maxRecordsPerTile: number;

  vertexShader: string;

  fragmentShader: string;

  packRecords(records: ReadonlyArray<TRecord>): PackedRecordBuffer;
}
