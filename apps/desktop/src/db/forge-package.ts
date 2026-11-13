import { FORGE_PACKAGE_MARKER_DIR } from '../shared/forge-package-path';

export { FORGE_PACKAGE_MARKER_DIR, isForgePackageMetaPath } from '../shared/forge-package-path';

export interface ForgePackagePaths {
  root: string;
  stem: string;
  sep: string;
  metaDir: string;
  metaPath: string;
}

export interface ForgePackageMemberSpec {
  metaName: string;
  memberDirs?: readonly string[];
  stemExtensions?: readonly string[];
}

export function forgePackagePaths(packageRoot: string, metaName: string): ForgePackagePaths {
  const root = packageRoot.replace(/[/\\]+$/, '');
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const metaDir = `${root}${sep}${FORGE_PACKAGE_MARKER_DIR}`;
  return {
    root,
    stem: forgePackageStem(root),
    sep,
    metaDir,
    metaPath: `${metaDir}${sep}${metaName}`,
  };
}

export function forgePackageStem(packageRoot: string): string {
  const normalized = packageRoot.replace(/[/\\]+$/, '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || packageRoot;
}

export function isForgePackageMemberRelativePath(
  relativePath: string,
  spec: ForgePackageMemberSpec
): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length < 2) return false;

  const fileName = parts[parts.length - 1];
  const parentName = parts[parts.length - 2];

  const markerIdx = parts.indexOf(FORGE_PACKAGE_MARKER_DIR);
  if (
    markerIdx >= 1 &&
    parts[markerIdx + 1]?.toLowerCase() === spec.metaName.toLowerCase() &&
    markerIdx + 1 === parts.length - 1
  ) {
    return true;
  }

  for (const extension of spec.stemExtensions ?? []) {
    if (fileName.toLowerCase() === `${parentName}${extension}`.toLowerCase()) {
      return true;
    }
  }

  for (const memberDir of spec.memberDirs ?? []) {
    const memberIdx = parts.indexOf(memberDir);
    if (memberIdx >= 1 && memberIdx < parts.length - 1) {
      return true;
    }
  }

  return false;
}

const PACKAGE_SCRATCH_DIR_NAME = /^\.[^/\\]+\.(?:staging|previous)-\d{10,}-[a-z0-9]{1,16}$/;

export function isForgePackageScratchDirName(name: string): boolean {
  return PACKAGE_SCRATCH_DIR_NAME.test(name);
}

export function isForgePackageScratchPath(path: string): boolean {
  const name =
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? '';
  return isForgePackageScratchDirName(name);
}
