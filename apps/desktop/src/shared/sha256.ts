export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
