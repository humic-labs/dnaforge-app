import { gunzipSync } from 'node:zlib';

export function decodeReplayValue(value) {
  const decoded = [];
  walk(value);
  return decoded;

  function walk(candidate) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) walk(entry);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;

    if (candidate.cv === '2024-10') {
      if (typeof candidate.data === 'string') decodeCompressedString(candidate.data);
      if (candidate.data !== null && typeof candidate.data === 'object') {
        for (const key of ['texts', 'attributes', 'removes', 'adds']) {
          if (typeof candidate.data[key] === 'string') decodeCompressedString(candidate.data[key]);
        }
      }
    }
    for (const entry of Object.values(candidate)) walk(entry);
  }

  function decodeCompressedString(compressed) {
    const buffer = gunzipSync(Buffer.from(compressed, 'latin1'));
    const parsed = JSON.parse(buffer.toString('utf8'));
    decoded.push({ bytes: buffer.byteLength, value: parsed });
  }
}
