export function normalizeProteinSearchQuery(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export function indexOfSubsequenceBmh(
  haystack: Uint8Array,
  needle: Uint8Array,
  fromIndex = 0
): number {
  if (needle.length === 0) return Math.min(Math.max(0, fromIndex), haystack.length);
  if (needle.length > haystack.length) return -1;
  const shifts = new Uint32Array(256);
  shifts.fill(needle.length);
  for (let index = 0; index < needle.length - 1; index += 1) {
    shifts[needle[index]] = needle.length - 1 - index;
  }
  let cursor = Math.max(0, fromIndex);
  const last = needle.length - 1;
  while (cursor <= haystack.length - needle.length) {
    let needleIndex = last;
    while (needleIndex >= 0 && haystack[cursor + needleIndex] === needle[needleIndex]) {
      needleIndex -= 1;
    }
    if (needleIndex < 0) return cursor;
    cursor += shifts[haystack[cursor + last]] || 1;
  }
  return -1;
}
