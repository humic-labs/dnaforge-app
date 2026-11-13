import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export type Sha256HexImplementation = (...parts: Array<string | Uint8Array>) => string;

function nobleSha256Hex(...parts: Array<string | Uint8Array>): string {
  const hash = sha256.create();
  for (const part of parts) hash.update(typeof part === 'string' ? utf8ToBytes(part) : part);
  return bytesToHex(hash.digest());
}

let implementation: Sha256HexImplementation = nobleSha256Hex;

export function sha256Hex(...parts: Array<string | Uint8Array>): string {
  return implementation(...parts);
}

export function installSha256HexImplementation(next: Sha256HexImplementation): void {
  implementation = next;
}
