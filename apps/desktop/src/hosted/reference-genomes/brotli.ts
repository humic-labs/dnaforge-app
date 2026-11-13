import decompress from 'brotli/decompress';

export async function brotliDecompressV1(
  bytes: Uint8Array,
  maxOutputLength: number
): Promise<Uint8Array> {
  const decoded = decompress(bytes, maxOutputLength);
  if (decoded.byteLength > maxOutputLength) {
    throw new Error('Brotli output exceeded its declared length.');
  }
  return decoded;
}
