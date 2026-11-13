export async function snapshotPdfBytes(
  bytes: Uint8Array
): Promise<{ bytes: Uint8Array<ArrayBuffer>; sha256: string }> {
  const snapshot = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', snapshot);
  return {
    bytes: snapshot,
    sha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
      ''
    ),
  };
}
