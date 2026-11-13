import { utf8ToBytes } from '@noble/hashes/utils';

import { isUnicodeScalarString } from './unicode';

export function parseRadixKey(key: string): Uint8Array {
  if (key.length === 0 || !isUnicodeScalarString(key) || key !== key.normalize('NFC')) {
    throw new TypeError('Radix keys must be nonempty scalar NFC strings.');
  }
  return utf8ToBytes(key);
}

export function sharedPrefixLength(left: Uint8Array, right: Uint8Array): number {
  const bound = Math.min(left.length, right.length);
  let index = 0;
  while (index < bound && left[index] === right[index]) index += 1;
  return index;
}

export function matchesBytesAt(input: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset + expected.length > input.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (input[offset + index] !== expected[index]) return false;
  }
  return true;
}
