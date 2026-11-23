import { binaryCoordinateByteLength } from './binary-coordinates';

export const MOLECULAR_COORDINATE_MAX_BYTES = 64 * 1024 * 1024;
export const MOLECULAR_COORDINATE_MAX_ENCODED_LENGTH =
  Math.ceil(MOLECULAR_COORDINATE_MAX_BYTES / 3) * 4;
export const MOLECULAR_DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
export const MOLECULAR_DOCUMENT_SIZE_MESSAGE =
  'The molecular document exceeds the 128 MiB file limit, including its saved revisions.';

export class MolecularStorageError extends Error {
  constructor(
    readonly code: 'MVS_VIEW_TOO_LARGE' | 'MVS_DOCUMENT_TOO_LARGE',
    message: string
  ) {
    super(message);
  }
}

export type MolecularCoordinateText = { format: 'pdb' | 'cif' | 'bcif'; text: string };

export function molecularCoordinateByteLength({ format, text }: MolecularCoordinateText): number {
  return format === 'bcif' ? binaryCoordinateByteLength(text) : utf8ByteLength(text);
}

export function assertMolecularCoordinateSize(coordinates: MolecularCoordinateText): void {
  const bytes = molecularCoordinateByteLength(coordinates);
  if (bytes > MOLECULAR_COORDINATE_MAX_BYTES)
    throw new MolecularStorageError(
      'MVS_VIEW_TOO_LARGE',
      `A molecular document can hold up to 64 MiB per coordinate source. This source is ${bytes.toLocaleString('en-US')} bytes.`
    );
}

export function assertMolecularDocumentSize(bytes: number): void {
  if (bytes > MOLECULAR_DOCUMENT_MAX_BYTES)
    throw new MolecularStorageError('MVS_DOCUMENT_TOO_LARGE', MOLECULAR_DOCUMENT_SIZE_MESSAGE);
}

export function utf8ByteLength(text: string): number {
  if (!/[^\x00-\x7f]/.test(text)) return text.length;
  let bytes = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index)!;
    if (codePoint >= 0x10000) {
      index += 1;
      bytes += 2;
    } else if (codePoint >= 0x800) bytes += 2;
    else if (codePoint >= 0x80) bytes += 1;
  }
  return bytes;
}

export function jsonStringByteLength(text: string): number {
  const encoder = new TextEncoder();
  let bytes = 2;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 64 * 1024, text.length);
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1;
    bytes += encoder.encode(JSON.stringify(text.slice(start, end))).byteLength - 2;
    start = end;
  }
  return bytes;
}
