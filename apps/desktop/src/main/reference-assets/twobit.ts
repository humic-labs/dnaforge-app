import { open, rm, type FileHandle } from 'node:fs/promises';

export const TWOBIT_SIGNATURE = 0x1a412743;
const HEADER_BYTES = 16;
const DEFAULT_LINE_WIDTH = 60;
const DEFAULT_MAX_SEQUENCES = 1_000_000;
const DEFAULT_MAX_TOTAL_BASES = 16_000_000_000;
const PACKED_CHUNK_BYTES = 1 << 20;
const MAX_BLOCK_COUNT = 50_000_000;

const BASE_CODES = [0x54, 0x43, 0x41, 0x47] as const;
const DECODE_TABLE = new Uint8Array(256 * 4);
for (let byte = 0; byte < 256; byte += 1) {
  DECODE_TABLE[byte * 4] = BASE_CODES[(byte >> 6) & 3]!;
  DECODE_TABLE[byte * 4 + 1] = BASE_CODES[(byte >> 4) & 3]!;
  DECODE_TABLE[byte * 4 + 2] = BASE_CODES[(byte >> 2) & 3]!;
  DECODE_TABLE[byte * 4 + 3] = BASE_CODES[byte & 3]!;
}

export class TwoBitFormatError extends Error {
  readonly code = 'TWOBIT_INVALID';
}

export interface TwoBitSequenceSummary {
  readonly name: string;
  readonly length: number;
}

export interface TwoBitConversionProgress {
  readonly sequenceName: string;
  readonly basesWritten: number;
  readonly totalBases: number;
}

export interface ConvertTwoBitToFastaInput {
  readonly twoBitPath: string;
  readonly fastaPath: string;
  readonly lineWidth?: number;
  readonly maxSequences?: number;
  readonly maxTotalBases?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TwoBitConversionProgress) => void;
}

export interface ConvertTwoBitToFastaResult {
  readonly sequences: ReadonlyArray<TwoBitSequenceSummary>;
  readonly totalBases: number;
}

export function hasTwoBitSignature(head: Uint8Array): boolean {
  if (head.byteLength < 4) return false;
  const view = new DataView(head.buffer, head.byteOffset, 4);
  return (
    view.getUint32(0, true) === TWOBIT_SIGNATURE || view.getUint32(0, false) === TWOBIT_SIGNATURE
  );
}

interface IndexEntry {
  readonly name: string;
  readonly offset: number;
}

interface Blocks {
  readonly starts: Uint32Array;
  readonly ends: Uint32Array;
}

interface RecordShape {
  readonly name: string;
  readonly dnaSize: number;
  readonly nBlockOffset: number;
  readonly packedOffset: number;
}

interface RecordDetail extends RecordShape {
  readonly nBlocks: Blocks;
  readonly maskBlocks: Blocks;
}

class TwoBitReader {
  private constructor(
    private readonly handle: FileHandle,
    readonly littleEndian: boolean,
    readonly version: number,
    readonly sequenceCount: number,
    readonly fileSize: number
  ) {}

  static async open(path: string): Promise<TwoBitReader> {
    const handle = await open(path, 'r');
    try {
      const fileSize = (await handle.stat()).size;
      if (fileSize < HEADER_BYTES) throw new TwoBitFormatError('The 2bit file is truncated.');
      const header = await readExact(handle, 0, HEADER_BYTES);
      let littleEndian: boolean;
      if (header.readUInt32LE(0) === TWOBIT_SIGNATURE) littleEndian = true;
      else if (header.readUInt32BE(0) === TWOBIT_SIGNATURE) littleEndian = false;
      else throw new TwoBitFormatError('The file is not a UCSC 2bit sequence file.');
      const u32 = (offset: number) =>
        littleEndian ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
      const version = u32(4);
      if (version !== 0 && version !== 1) {
        throw new TwoBitFormatError(`Unsupported 2bit version ${version}.`);
      }
      const sequenceCount = u32(8);
      if (u32(12) !== 0) throw new TwoBitFormatError('The 2bit header reserved field is not zero.');
      return new TwoBitReader(handle, littleEndian, version, sequenceCount, fileSize);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async readIndex(maxSequences: number): Promise<ReadonlyArray<IndexEntry>> {
    if (this.sequenceCount === 0) {
      throw new TwoBitFormatError('The 2bit file declares no sequences.');
    }
    if (this.sequenceCount > maxSequences) {
      throw new TwoBitFormatError(
        `The 2bit file declares ${this.sequenceCount} sequences; at most ${maxSequences} are supported.`
      );
    }
    const offsetBytes = this.version === 1 ? 8 : 4;
    const entries: IndexEntry[] = [];
    const seen = new Set<string>();
    let position = HEADER_BYTES;
    for (let index = 0; index < this.sequenceCount; index += 1) {
      const nameSize = (await readExact(this.handle, position, 1))[0]!;
      position += 1;
      if (nameSize === 0) throw new TwoBitFormatError('A 2bit sequence has an empty name.');
      const nameBytes = await readExact(this.handle, position, nameSize);
      position += nameSize;
      const name = nameBytes.toString('latin1');
      if (!/^[!-~]+$/u.test(name) || name.startsWith('>')) {
        throw new TwoBitFormatError(`The 2bit sequence name ${JSON.stringify(name)} is invalid.`);
      }
      if (seen.has(name)) throw new TwoBitFormatError(`The 2bit file repeats sequence ${name}.`);
      seen.add(name);
      const offsetBuffer = await readExact(this.handle, position, offsetBytes);
      position += offsetBytes;
      const offset =
        offsetBytes === 8
          ? Number(
              this.littleEndian ? offsetBuffer.readBigUInt64LE(0) : offsetBuffer.readBigUInt64BE(0)
            )
          : this.littleEndian
            ? offsetBuffer.readUInt32LE(0)
            : offsetBuffer.readUInt32BE(0);
      if (!Number.isSafeInteger(offset) || offset < HEADER_BYTES || offset >= this.fileSize) {
        throw new TwoBitFormatError(`The 2bit index points sequence ${name} outside the file.`);
      }
      entries.push({ name, offset });
    }
    return entries;
  }

  async readShape(entry: IndexEntry): Promise<RecordShape> {
    let position = entry.offset;
    const dnaSize = await this.readU32At(position);
    position += 4;
    const nBlockOffset = position;
    const nCount = await this.readU32At(position);
    this.assertBlockCount(entry.name, nCount, 'N');
    position += 4 + nCount * 8;
    const maskCount = await this.readU32At(position);
    this.assertBlockCount(entry.name, maskCount, 'mask');
    position += 4 + maskCount * 8;
    const reserved = await this.readU32At(position);
    if (reserved !== 0) {
      throw new TwoBitFormatError(
        `The 2bit record for ${entry.name} has a nonzero reserved field.`
      );
    }
    position += 4;
    if (position + Math.ceil(dnaSize / 4) > this.fileSize) {
      throw new TwoBitFormatError(`The 2bit record for ${entry.name} is truncated.`);
    }
    return { name: entry.name, dnaSize, nBlockOffset, packedOffset: position };
  }

  async readDetail(shape: RecordShape): Promise<RecordDetail> {
    const nBlocks = await this.readBlocks(shape, shape.nBlockOffset, 'N');
    const maskBlocks = await this.readBlocks(
      shape,
      shape.nBlockOffset + 4 + nBlocks.starts.length * 8,
      'mask'
    );
    return { ...shape, nBlocks, maskBlocks };
  }

  private async readBlocks(
    shape: RecordShape,
    position: number,
    kind: 'N' | 'mask'
  ): Promise<Blocks> {
    const count = await this.readU32At(position);
    const table = await readExact(this.handle, position + 4, count * 8);
    const starts = new Uint32Array(count);
    const ends = new Uint32Array(count);
    let previousEnd = 0;
    for (let index = 0; index < count; index += 1) {
      const start = this.u32(table, index * 4);
      const size = this.u32(table, (count + index) * 4);
      const end = start + size;
      if (size === 0 || start < previousEnd || end > shape.dnaSize) {
        throw new TwoBitFormatError(
          `The 2bit record for ${shape.name} has an invalid ${kind} block at position ${start}.`
        );
      }
      starts[index] = start;
      ends[index] = end;
      previousEnd = end;
    }
    return { starts, ends };
  }

  private assertBlockCount(name: string, count: number, kind: 'N' | 'mask'): void {
    if (count > MAX_BLOCK_COUNT) {
      throw new TwoBitFormatError(`The 2bit record for ${name} declares too many ${kind} blocks.`);
    }
  }

  private async readU32At(position: number): Promise<number> {
    if (position + 4 > this.fileSize) throw new TwoBitFormatError('The 2bit file is truncated.');
    return this.u32(await readExact(this.handle, position, 4), 0);
  }

  private u32(buffer: Buffer, offset: number): number {
    return this.littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  }

  readPacked(offset: number, length: number): Promise<Buffer> {
    return readExact(this.handle, offset, length);
  }
}

async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) throw new TwoBitFormatError('The 2bit file ended unexpectedly.');
    filled += bytesRead;
  }
  return buffer;
}

export async function readTwoBitSummary(
  twoBitPath: string,
  options: { readonly maxSequences?: number } = {}
): Promise<ReadonlyArray<TwoBitSequenceSummary>> {
  const reader = await TwoBitReader.open(twoBitPath);
  try {
    const entries = await reader.readIndex(options.maxSequences ?? DEFAULT_MAX_SEQUENCES);
    const summaries: TwoBitSequenceSummary[] = [];
    for (const entry of entries) {
      const shape = await reader.readShape(entry);
      summaries.push({ name: shape.name, length: shape.dnaSize });
    }
    return summaries;
  } finally {
    await reader.close();
  }
}

class LineWriter {
  private column = 0;

  private constructor(
    private readonly handle: FileHandle,
    private readonly lineWidth: number
  ) {}

  static async create(path: string, lineWidth: number): Promise<LineWriter> {
    return new LineWriter(await open(path, 'wx', 0o600), lineWidth);
  }

  async header(name: string): Promise<void> {
    if (this.column > 0) await this.handle.writeFile('\n');
    this.column = 0;
    await this.handle.writeFile(`>${name}\n`);
  }

  async bases(decoded: Uint8Array): Promise<void> {
    const lineWidth = this.lineWidth;
    const out = Buffer.allocUnsafe(decoded.length + Math.ceil(decoded.length / lineWidth) + 1);
    let written = 0;
    let index = 0;
    while (index < decoded.length) {
      const take = Math.min(lineWidth - this.column, decoded.length - index);
      out.set(decoded.subarray(index, index + take), written);
      written += take;
      index += take;
      this.column += take;
      if (this.column === lineWidth) {
        out[written] = 0x0a;
        written += 1;
        this.column = 0;
      }
    }
    await this.handle.writeFile(out.subarray(0, written));
  }

  async finish(): Promise<void> {
    if (this.column > 0) await this.handle.writeFile('\n');
    await this.handle.sync();
    await this.handle.close();
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

function applyBlocks(
  decoded: Uint8Array,
  chunkStart: number,
  blocks: Blocks,
  cursor: { index: number },
  apply: (from: number, to: number) => void
): void {
  const chunkEnd = chunkStart + decoded.length;
  while (cursor.index < blocks.starts.length) {
    const start = blocks.starts[cursor.index]!;
    const end = blocks.ends[cursor.index]!;
    if (start >= chunkEnd) break;
    const from = Math.max(start, chunkStart) - chunkStart;
    const to = Math.min(end, chunkEnd) - chunkStart;
    if (to > from) apply(from, to);
    if (end <= chunkEnd) cursor.index += 1;
    else break;
  }
}

export async function convertTwoBitToFasta(
  input: ConvertTwoBitToFastaInput
): Promise<ConvertTwoBitToFastaResult> {
  const lineWidth = input.lineWidth ?? DEFAULT_LINE_WIDTH;
  if (!Number.isSafeInteger(lineWidth) || lineWidth < 1 || lineWidth > 1_000_000) {
    throw new Error('The FASTA line width must be a positive integer.');
  }
  const maxTotalBases = input.maxTotalBases ?? DEFAULT_MAX_TOTAL_BASES;
  const reader = await TwoBitReader.open(input.twoBitPath);
  let writer: LineWriter | null = null;
  try {
    const entries = await reader.readIndex(input.maxSequences ?? DEFAULT_MAX_SEQUENCES);
    const shapes: RecordShape[] = [];
    let totalBases = 0;
    for (const entry of entries) {
      const shape = await reader.readShape(entry);
      totalBases += shape.dnaSize;
      if (totalBases > maxTotalBases) {
        throw new TwoBitFormatError(
          `The 2bit file holds more than ${maxTotalBases.toLocaleString('en-US')} bases.`
        );
      }
      shapes.push(shape);
    }

    throwIfAborted(input.signal);
    writer = await LineWriter.create(input.fastaPath, lineWidth);
    let basesWritten = 0;
    for (const shape of shapes) {
      throwIfAborted(input.signal);
      const record = await reader.readDetail(shape);
      await writer.header(record.name);
      const nCursor = { index: 0 };
      const maskCursor = { index: 0 };
      let baseStart = 0;
      let packedPosition = record.packedOffset;
      const packedTotal = Math.ceil(record.dnaSize / 4);
      let packedRead = 0;
      while (packedRead < packedTotal) {
        throwIfAborted(input.signal);
        const packedLength = Math.min(PACKED_CHUNK_BYTES, packedTotal - packedRead);
        const packed = await reader.readPacked(packedPosition, packedLength);
        const chunkBases = Math.min(packedLength * 4, record.dnaSize - baseStart);
        const decoded = new Uint8Array(chunkBases);
        for (let index = 0; index < packedLength; index += 1) {
          const at = index * 4;
          const table = packed[index]! * 4;
          decoded[at] = DECODE_TABLE[table]!;
          if (at + 1 < chunkBases) decoded[at + 1] = DECODE_TABLE[table + 1]!;
          if (at + 2 < chunkBases) decoded[at + 2] = DECODE_TABLE[table + 2]!;
          if (at + 3 < chunkBases) decoded[at + 3] = DECODE_TABLE[table + 3]!;
        }
        applyBlocks(decoded, baseStart, record.nBlocks, nCursor, (from, to) =>
          decoded.fill(0x4e, from, to)
        );
        applyBlocks(decoded, baseStart, record.maskBlocks, maskCursor, (from, to) => {
          for (let index = from; index < to; index += 1) decoded[index] = decoded[index]! | 0x20;
        });
        await writer.bases(decoded);
        baseStart += chunkBases;
        basesWritten += chunkBases;
        packedRead += packedLength;
        packedPosition += packedLength;
        input.onProgress?.({ sequenceName: record.name, basesWritten, totalBases });
      }
    }
    await writer.finish();
    writer = null;
    return {
      sequences: shapes.map((shape) => ({ name: shape.name, length: shape.dnaSize })),
      totalBases,
    };
  } catch (error) {
    if (writer) {
      await writer.abort();
      await rm(input.fastaPath, { force: true });
    }
    throw error;
  } finally {
    await reader.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('2bit conversion was cancelled.');
  error.name = 'AbortError';
  throw error;
}
