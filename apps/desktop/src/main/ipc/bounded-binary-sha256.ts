import { createHash } from 'node:crypto';

import type { PartitionedTranscriptSceneBinarySha256V4 } from '@waypoint/genome-renderer/pure';

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const YIELD_AFTER_BYTES = 16 * 1024 * 1024;

export const sha256BoundedNodeV1 = async (
  bytes: Parameters<PartitionedTranscriptSceneBinarySha256V4>[0],
  options?: { readonly signal?: AbortSignal }
): Promise<string> => {
  options?.signal?.throwIfAborted();
  const hash = createHash('sha256');
  let bytesSinceYield = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += HASH_CHUNK_BYTES) {
    options?.signal?.throwIfAborted();
    const end = Math.min(offset + HASH_CHUNK_BYTES, bytes.byteLength);
    hash.update(bytes.subarray(offset, end));
    bytesSinceYield += end - offset;
    if (bytesSinceYield >= YIELD_AFTER_BYTES && end < bytes.byteLength) {
      bytesSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  options?.signal?.throwIfAborted();
  return hash.digest('hex');
};
