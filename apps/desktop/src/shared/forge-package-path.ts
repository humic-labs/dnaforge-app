export const FORGE_PACKAGE_MARKER_DIR = '.forge';

export function isForgePackageMetaPath(path: string, metaName: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const meta = metaName.toLowerCase();
  return (
    normalized.endsWith(`/${FORGE_PACKAGE_MARKER_DIR}/${meta}`) ||
    normalized === `${FORGE_PACKAGE_MARKER_DIR}/${meta}`
  );
}
