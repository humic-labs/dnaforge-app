const SHA256_PREFIX = 'sha256:';
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/i;

export type ContentHashFn = (input: {
  workspaceRoot: string;
  workspaceRelativePath: string;
}) => Promise<string>;

export function needsRehash(catalogHash: string | null | undefined): boolean {
  return !catalogHash || !SHA256_FINGERPRINT.test(catalogHash);
}

export async function resolveReferenceContentHash({
  catalogHash,
  workspaceRoot,
  workspaceRelativePath,
  contentHash,
}: {
  catalogHash: string | null;
  workspaceRoot: string | null;
  workspaceRelativePath: string;
  contentHash: ContentHashFn;
}): Promise<string | null> {
  if (!needsRehash(catalogHash)) return catalogHash;
  if (!workspaceRoot) return null;

  try {
    const hashed = await contentHash({ workspaceRoot, workspaceRelativePath });
    if (!SHA256_FINGERPRINT.test(hashed)) {
      console.error(
        `[reference] Refusing a content hash that is not ${SHA256_PREFIX}-namespaced:`,
        hashed
      );
      return null;
    }
    return hashed;
  } catch (error) {
    console.error('[reference] Failed to hash referenced file:', error);
    return null;
  }
}
