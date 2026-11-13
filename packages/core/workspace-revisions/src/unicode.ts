import { utf8ToBytes } from '@noble/hashes/utils';

export const MAX_CANONICAL_TEXT_BYTES = 256;

export function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isValidCanonicalText(value: string, maxBytes = MAX_CANONICAL_TEXT_BYTES): boolean {
  return (
    value.length > 0 &&
    isUnicodeScalarString(value) &&
    value === value.normalize('NFC') &&
    !/\p{Cc}/u.test(value) &&
    utf8ToBytes(value).length <= maxBytes
  );
}
