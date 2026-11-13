import { BROAD_RASTER_WASM_BASE64 } from './broad-raster-wasm-bytes.generated';

interface WasmApi {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { readonly exports: unknown };
}
const WASM_GLOBAL: string = 'WebAssembly';
const wasmApi: WasmApi = Reflect.get(globalThis, WASM_GLOBAL);

interface BroadRasterExports {
  readonly memory: { readonly buffer: ArrayBuffer };
  broad_raster_alloc(length: number): number;
  broad_raster_free(pointer: number, length: number): void;
  broad_raster_last_wrote(): number;
  broad_raster_cell(
    payload: number,
    payloadLength: number,
    glyphOffset: number,
    glyphCount: number,
    prefixOffset: number,
    prefixCount: number,
    maxPrimitiveSpanBp: number,
    partitions: number,
    partitionCount: number,
    tileSpanBp: number,
    nominalStartBp: number,
    nominalEndBpExclusive: number,
    firstLaneRow: number,
    sourceLaneRowCount: number,
    tilePhysicalWidthPx: number,
    guardPx: number,
    dpr: number,
    laneRowStridePx: number,
    laneRowTailGutterPx: number,
    widthPx: number,
    heightPx: number,
    pixels: number
  ): number;
  broad_raster_cell_roles(
    payload: number,
    payloadLength: number,
    glyphOffset: number,
    glyphCount: number,
    prefixOffset: number,
    prefixCount: number,
    maxPrimitiveSpanBp: number,
    partitions: number,
    partitionCount: number,
    tileSpanBp: number,
    nominalStartBp: number,
    nominalEndBpExclusive: number,
    firstLaneRow: number,
    sourceLaneRowCount: number,
    tilePhysicalWidthPx: number,
    guardPx: number,
    dpr: number,
    laneRowStridePx: number,
    laneRowTailGutterPx: number,
    widthPx: number,
    heightPx: number,
    pixels: number,
    roles: number,
    accumulator: number
  ): number;
}

let compiled: object | null = null;
let sharedExports: BroadRasterExports | null = null;
function broadRasterExports(): BroadRasterExports {
  if (!sharedExports) {
    const instance = new wasmApi.Instance(broadRasterModule(), { env: { js_pow: Math.pow } });
    sharedExports = instance.exports as BroadRasterExports;
  }
  return sharedExports;
}
function broadRasterModule(): object {
  if (!compiled) {
    const binary = atob(BROAD_RASTER_WASM_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    compiled = new wasmApi.Module(bytes);
  }
  return compiled;
}

export interface BroadRasterPartitionV1 {
  readonly firstInstance: number;
  readonly minStartBp: number;
  readonly maxEndBp: number;
  readonly lanePrefixOffset: number;
  readonly lanePrefixCount: number;
}

export interface BroadRasterSectionV1 {
  readonly byteOffset: number;
  readonly count: number;
}

export interface WasmBroadRasterCellInputV1 {
  readonly glyphs: BroadRasterSectionV1;
  readonly lanePrefixes: BroadRasterSectionV1;
  readonly partitions: readonly BroadRasterPartitionV1[];
  readonly maxPrimitiveSpanBp: number;
  readonly tileSpanBp: number;
  readonly nominalStartBp: number;
  readonly nominalEndBpExclusive: number;
  readonly firstLaneRow: number;
  readonly sourceLaneRowCount: number;
  readonly tilePhysicalWidthPx: number;
  readonly guardPx: number;
  readonly dpr: number;
  readonly laneRowStridePx: number;
  readonly laneRowTailGutterPx: number;
  readonly roles?: Uint8Array;
}

export class WasmBroadRasterizerV1 {
  readonly #exports: BroadRasterExports;
  readonly #payload: number;
  readonly #payloadLength: number;
  readonly #pixels: number;
  readonly #pixelBytes: number;
  readonly #partitions = new Map<readonly BroadRasterPartitionV1[], number>();
  readonly #roles = new Map<Uint8Array, number>();
  #accumulator = 0;
  readonly #widthPx: number;
  readonly #heightPx: number;

  constructor(payload: Uint8Array, widthPx: number, heightPx: number) {
    this.#exports = broadRasterExports();
    this.#widthPx = widthPx;
    this.#heightPx = heightPx;
    this.#pixelBytes = widthPx * heightPx * 4;
    this.#payloadLength = payload.byteLength;
    this.#payload = this.#exports.broad_raster_alloc(payload.byteLength);
    new Uint8Array(this.#exports.memory.buffer, this.#payload, payload.byteLength).set(payload);
    this.#pixels = this.#exports.broad_raster_alloc(this.#pixelBytes);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#exports.broad_raster_free(this.#payload, this.#payloadLength);
    this.#exports.broad_raster_free(this.#pixels, this.#pixelBytes);
    for (const [partitions, pointer] of this.#partitions) {
      this.#exports.broad_raster_free(pointer, Math.max(8, partitions.length * 5 * 8));
    }
    this.#partitions.clear();
    for (const [roles, pointer] of this.#roles) {
      this.#exports.broad_raster_free(pointer, Math.max(8, roles.length));
    }
    this.#roles.clear();
    if (this.#accumulator) this.#exports.broad_raster_free(this.#accumulator, this.#pixelBytes * 8);
  }

  #disposed = false;

  pixels(): Uint8Array {
    return new Uint8Array(this.#exports.memory.buffer, this.#pixels, this.#pixelBytes);
  }

  rasterize(input: WasmBroadRasterCellInputV1): { primitiveCount: number; wrotePixel: boolean } {
    if (this.#disposed) throw new Error('compiled broad surface rasterizer was disposed');
    const partitions = this.#partitionPointer(input.partitions);
    if (input.roles && input.roles.length !== input.glyphs.count) {
      throw new Error('compiled broad surface role weights do not fit the glyph section');
    }
    const cell = input.roles
      ? (...args: Parameters<BroadRasterExports['broad_raster_cell']>) =>
          this.#exports.broad_raster_cell_roles(
            ...args,
            this.#rolePointer(input.roles as Uint8Array),
            this.#accumulatorPointer()
          )
      : (...args: Parameters<BroadRasterExports['broad_raster_cell']>) =>
          this.#exports.broad_raster_cell(...args);
    const count = cell(
      this.#payload,
      this.#payloadLength,
      input.glyphs.byteOffset,
      input.glyphs.count,
      input.lanePrefixes.byteOffset,
      input.lanePrefixes.count,
      input.maxPrimitiveSpanBp,
      partitions,
      input.partitions.length,
      input.tileSpanBp,
      input.nominalStartBp,
      input.nominalEndBpExclusive,
      input.firstLaneRow,
      input.sourceLaneRowCount,
      input.tilePhysicalWidthPx,
      input.guardPx,
      input.dpr,
      input.laneRowStridePx,
      input.laneRowTailGutterPx,
      this.#widthPx,
      this.#heightPx,
      this.#pixels
    );
    if (count === -1) throw new Error('compiled broad surface lane prefix index is invalid');
    if (count === -2) throw new Error('compiled broad surface glyph index is outside its section');
    return { primitiveCount: count, wrotePixel: this.#exports.broad_raster_last_wrote() === 1 };
  }

  #rolePointer(roles: Uint8Array): number {
    let pointer = this.#roles.get(roles);
    if (pointer === undefined) {
      pointer = this.#exports.broad_raster_alloc(Math.max(8, roles.length));
      new Uint8Array(this.#exports.memory.buffer, pointer, roles.length).set(roles);
      this.#roles.set(roles, pointer);
    }
    return pointer;
  }

  #accumulatorPointer(): number {
    if (!this.#accumulator)
      this.#accumulator = this.#exports.broad_raster_alloc(this.#pixelBytes * 8);
    return this.#accumulator;
  }

  #partitionPointer(partitions: readonly BroadRasterPartitionV1[]): number {
    let pointer = this.#partitions.get(partitions);
    if (pointer === undefined) {
      pointer = this.#exports.broad_raster_alloc(Math.max(8, partitions.length * 5 * 8));
      const values = new Float64Array(this.#exports.memory.buffer, pointer, partitions.length * 5);
      partitions.forEach((partition, index) => {
        values.set(
          [
            partition.firstInstance,
            partition.minStartBp,
            partition.maxEndBp,
            partition.lanePrefixOffset,
            partition.lanePrefixCount,
          ],
          index * 5
        );
      });
      this.#partitions.set(partitions, pointer);
    }
    return pointer;
  }
}
