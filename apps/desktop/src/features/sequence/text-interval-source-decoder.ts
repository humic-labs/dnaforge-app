import { Gunzip } from 'fflate';

export const MAX_TEXT_INTERVAL_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_TEXT_INTERVAL_DECODED_BYTES = 256 * 1024 * 1024;

export interface DecodedTextIntervalSource {
  readonly text: string;
  readonly sourceByteLength: number;
  readonly decodedByteLength: number;
  readonly contentSha256: string;
}

export async function decodeTextIntervalSource(
  sourceBytes: Uint8Array,
  maxDecodedBytes: number
): Promise<DecodedTextIntervalSource> {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1) {
    throw new Error('The decoded text byte limit must be a positive safe integer.');
  }
  const decodedBytes = isGzip(sourceBytes)
    ? gunzipBounded(sourceBytes, maxDecodedBytes)
    : assertBounded(sourceBytes, maxDecodedBytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
  } catch {
    throw new Error('The interval source is not valid UTF-8 text.');
  }
  return {
    text,
    sourceByteLength: sourceBytes.byteLength,
    decodedByteLength: decodedBytes.byteLength,
    contentSha256: await sha256(sourceBytes),
  };
}

function gunzipBounded(sourceBytes: Uint8Array, maxDecodedBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new Gunzip((chunk) => {
    total += chunk.byteLength;
    if (total > maxDecodedBytes) throw decodedLimitError(maxDecodedBytes);
    chunks.push(chunk);
  });
  try {
    decoder.push(sourceBytes, true);
  } catch (error) {
    if (error instanceof Error && error.message.includes('decoded text exceeds')) throw error;
    throw new Error(
      `The interval source is not a valid gzip/BGZF stream: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const decoded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoded;
}

function assertBounded(bytes: Uint8Array, maxDecodedBytes: number): Uint8Array {
  if (bytes.byteLength > maxDecodedBytes) throw decodedLimitError(maxDecodedBytes);
  return bytes;
}

function decodedLimitError(maxDecodedBytes: number): Error {
  return new Error(`The interval source decoded text exceeds ${maxDecodedBytes} bytes.`);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `sha256:${hex}`;
}
