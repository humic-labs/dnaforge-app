import type { ParsedSequence, Ab1Metadata, TraceData } from './types';
import { SequenceParseError } from './types';

const ABIF_MAGIC = 0x41424946;

interface DirectoryEntry {
  tagName: string;
  tagNumber: number;
  elementType: number;
  elementSize: number;
  numElements: number;
  dataSize: number;
  dataOffset: number;
}

export function parseAb1(data: ArrayBuffer | Buffer, filename?: string): ParsedSequence {
  if (!data || data.byteLength === 0) {
    throw new SequenceParseError('Empty or invalid AB1 data', 'ab1');
  }

  if (data.byteLength < 128) {
    throw new SequenceParseError(
      `AB1 file too small: ${data.byteLength} bytes (minimum 128 bytes for valid header)`,
      'ab1'
    );
  }

  const buffer = data instanceof ArrayBuffer ? new DataView(data) : toDataView(data);
  const totalSize = buffer.byteLength;

  const magic = buffer.getUint32(0, false);
  if (magic !== ABIF_MAGIC) {
    throw new SequenceParseError(
      `Invalid AB1 file: expected magic number 0x41424946 (ABIF), got 0x${magic.toString(16)}`,
      'ab1'
    );
  }

  const version = buffer.getInt16(4, false);
  const numDirEntries = buffer.getInt32(18, false);
  const dirOffset = buffer.getInt32(26, false);

  if (version < 100 || version > 200) {
    throw new SequenceParseError(`Unsupported ABIF version: ${version}`, 'ab1');
  }

  if (dirOffset < 0 || dirOffset >= totalSize) {
    throw new SequenceParseError(
      `Invalid directory offset: ${dirOffset} (file size: ${totalSize})`,
      'ab1'
    );
  }

  if (numDirEntries < 0 || numDirEntries > 10000) {
    throw new SequenceParseError(`Invalid number of directory entries: ${numDirEntries}`, 'ab1');
  }

  const directory = readDirectory(buffer, dirOffset, numDirEntries);

  const sequence = extractSequence(buffer, directory);
  if (!sequence) {
    throw new SequenceParseError('No sequence data found in AB1 file', 'ab1');
  }

  const quality = extractQuality(buffer, directory);

  const metadata = extractMetadata(buffer, directory);

  const trace = extractTraceData(buffer, directory);

  const name =
    metadata.sampleName || deriveNameFromFilename(filename) || `AB1_${Date.now().toString(36)}`;
  const id = generateId(name);

  const ab1Meta: Ab1Metadata = {};
  if (metadata.instrumentModel) ab1Meta.instrumentModel = metadata.instrumentModel;
  if (metadata.sampleName) ab1Meta.sampleName = metadata.sampleName;
  if (metadata.spacing) ab1Meta.spacing = metadata.spacing;
  if (metadata.baseCaller) ab1Meta.baseCaller = metadata.baseCaller;
  if (trace) ab1Meta.trace = trace;

  return {
    id,
    name,
    sequence,
    length: sequence.length,
    format: 'ab1',
    quality,
    metadata: Object.keys(ab1Meta).length > 0 ? (ab1Meta as Record<string, unknown>) : undefined,
  };
}

export function isAb1Format(data: ArrayBuffer | Buffer): boolean {
  if (data.byteLength < 4) return false;

  const buffer = data instanceof ArrayBuffer ? new DataView(data) : toDataView(data);
  const magic = buffer.getUint32(0, false);

  return magic === ABIF_MAGIC;
}

function readDirectory(
  buffer: DataView,
  offset: number,
  count: number
): Map<string, DirectoryEntry> {
  const entries = new Map<string, DirectoryEntry>();
  const maxOffset = buffer.byteLength;

  const entrySize = 28;

  for (let i = 0; i < count; i++) {
    const entryOffset = offset + i * entrySize;

    if (entryOffset + entrySize > maxOffset) {
      break;
    }

    const tagName = readString(buffer, entryOffset, 4);
    const tagNumber = buffer.getInt32(entryOffset + 4, false);
    const elementType = buffer.getInt16(entryOffset + 8, false);
    const elementSize = buffer.getInt16(entryOffset + 10, false);
    const numElements = buffer.getInt32(entryOffset + 12, false);
    const dataSize = buffer.getInt32(entryOffset + 16, false);

    let dataOffset: number;
    if (dataSize <= 4) {
      dataOffset = entryOffset + 20;
    } else {
      dataOffset = buffer.getInt32(entryOffset + 20, false);
    }

    if (dataOffset < 0 || dataOffset >= maxOffset) {
      continue;
    }

    const key = `${tagName}${tagNumber}`;
    entries.set(key, {
      tagName,
      tagNumber,
      elementType,
      elementSize,
      numElements,
      dataSize,
      dataOffset,
    });
  }

  return entries;
}

function extractSequence(buffer: DataView, directory: Map<string, DirectoryEntry>): string | null {
  const entry = directory.get('PBAS2') || directory.get('PBAS1');

  if (!entry) return null;

  return readString(buffer, entry.dataOffset, entry.numElements);
}

function extractQuality(
  buffer: DataView,
  directory: Map<string, DirectoryEntry>
): number[] | undefined {
  const entry = directory.get('PCON2') || directory.get('PCON1');

  if (!entry) return undefined;

  const quality: number[] = [];
  const maxOffset = buffer.byteLength;

  for (let i = 0; i < entry.numElements; i++) {
    const pos = entry.dataOffset + i;
    if (pos >= maxOffset) break;
    quality.push(buffer.getUint8(pos));
  }

  return quality.length > 0 ? quality : undefined;
}

function extractMetadata(
  buffer: DataView,
  directory: Map<string, DirectoryEntry>
): {
  sampleName?: string;
  instrumentModel?: string;
  spacing?: number;
  baseCaller?: string;
} {
  const metadata: {
    sampleName?: string;
    instrumentModel?: string;
    spacing?: number;
    baseCaller?: string;
  } = {};

  const smpl = directory.get('SMPL1');
  if (smpl) {
    metadata.sampleName = readPascalString(buffer, smpl.dataOffset, smpl.dataSize);
  }

  const modl = directory.get('MODL1');
  if (modl) {
    metadata.instrumentModel = readPascalString(buffer, modl.dataOffset, modl.dataSize);
  }

  const spac = directory.get('SPAC1');
  if (spac) {
    metadata.spacing = buffer.getFloat32(spac.dataOffset, false);
  }

  const sver = directory.get('SVER1');
  if (sver) {
    metadata.baseCaller = readPascalString(buffer, sver.dataOffset, sver.dataSize);
  }

  return metadata;
}

function extractTraceData(
  buffer: DataView,
  directory: Map<string, DirectoryEntry>
): TraceData | undefined {
  const fwo = directory.get('FWO_1');
  let baseOrder = 'GATC';
  if (fwo && fwo.dataSize === 4) {
    baseOrder = readString(buffer, fwo.dataOffset, 4);
  }

  const data9 = directory.get('DATA9');
  const data10 = directory.get('DATA10');
  const data11 = directory.get('DATA11');
  const data12 = directory.get('DATA12');

  if (!data9 || !data10 || !data11 || !data12) {
    return undefined;
  }

  const channel1 = extractShortArray(buffer, data9);
  const channel2 = extractShortArray(buffer, data10);
  const channel3 = extractShortArray(buffer, data11);
  const channel4 = extractShortArray(buffer, data12);

  if (!channel1 || !channel2 || !channel3 || !channel4) {
    return undefined;
  }

  const channels: TraceData['channels'] = { A: [], C: [], G: [], T: [] };
  const channelArrays = [channel1, channel2, channel3, channel4];

  for (let i = 0; i < 4 && i < baseOrder.length; i++) {
    const base = baseOrder[i].toUpperCase() as 'A' | 'C' | 'G' | 'T';
    if (base in channels) {
      channels[base] = channelArrays[i];
    }
  }

  const ploc = directory.get('PLOC2') || directory.get('PLOC1');
  let peakPositions: number[] = [];

  if (ploc) {
    peakPositions = extractShortArray(buffer, ploc) || [];
  }

  let maxValue = 1;
  for (const channel of channelArrays) {
    for (const sample of channel) maxValue = Math.max(maxValue, Math.abs(sample));
  }

  return {
    channels,
    peakPositions,
    baseOrder,
    maxValue,
  };
}

function extractShortArray(buffer: DataView, entry: DirectoryEntry): number[] | undefined {
  if (entry.elementSize !== 2) {
    return undefined;
  }

  const result: number[] = [];
  const maxOffset = buffer.byteLength;

  for (let i = 0; i < entry.numElements; i++) {
    const pos = entry.dataOffset + i * 2;
    if (pos + 2 > maxOffset) break;
    result.push(buffer.getInt16(pos, false));
  }

  return result.length > 0 ? result : undefined;
}

function toDataView(buffer: Buffer): DataView {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new DataView(arrayBuffer);
}

function readString(buffer: DataView, offset: number, length: number): string {
  const chars: string[] = [];
  const maxOffset = buffer.byteLength;

  for (let i = 0; i < length; i++) {
    const pos = offset + i;
    if (pos >= maxOffset) break;
    const byte = buffer.getUint8(pos);
    if (byte === 0) break;
    chars.push(String.fromCharCode(byte));
  }
  return chars.join('');
}

function readPascalString(buffer: DataView, offset: number, maxLength: number): string {
  if (maxLength === 0) return '';
  if (offset >= buffer.byteLength) return '';

  const firstByte = buffer.getUint8(offset);

  if (maxLength <= 4 || (firstByte >= 32 && firstByte <= 126)) {
    return readString(buffer, offset, maxLength).trim();
  }

  const length = Math.min(firstByte, maxLength - 1);
  return readString(buffer, offset + 1, length).trim();
}

function deriveNameFromFilename(filename?: string): string | undefined {
  if (!filename) return undefined;

  const base = filename.split('/').pop() || filename;
  const name = base.replace(/\.(ab1|abi)$/i, '');

  return name || undefined;
}

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
