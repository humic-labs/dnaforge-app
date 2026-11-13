import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FORGE_PACKAGE_MARKER_DIR } from './forge-package';
import {
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  SEQUENCE_PACKAGE_META_ALIASES,
  SEQUENCE_PACKAGE_META_NAME,
} from './sequence-package';
import {
  WORKSPACE_CONTENT_KINDS,
  violationForPath,
  type ManifestViolation,
} from './workspace-content-manifest';

export function isPackageDir(absoluteDir: string): boolean {
  const forge = join(absoluteDir, FORGE_PACKAGE_MARKER_DIR);
  if (!existsSync(forge)) return false;
  return WORKSPACE_CONTENT_KINDS.some((kind) => {
    if (!kind.markerFile) return false;
    if (existsSync(join(forge, kind.markerFile))) return true;
    if (kind.kind !== 'sequence') return false;
    return SEQUENCE_PACKAGE_META_ALIASES.some((name) => existsSync(join(forge, name)));
  });
}

function sequencePackageFormatViolation(
  root: string,
  packageRoot: string
): ManifestViolation | null {
  const marker = join(packageRoot, FORGE_PACKAGE_MARKER_DIR, SEQUENCE_PACKAGE_META_NAME);
  if (!existsSync(marker)) return null;
  const relativePath = relative(root, marker).split(/[\\/]/).join('/');
  try {
    const parsed: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        path: relativePath,
        kind: 'sequence',
        expected: 'package',
        reason: 'sequence package marker is not a JSON object',
      };
    }
    const version = (parsed as { formatVersion?: unknown }).formatVersion;
    const found = version === undefined ? 1 : version;
    if (found === SEQUENCE_PACKAGE_FORMAT_VERSION) return null;
    return {
      path: relativePath,
      kind: 'sequence',
      expected: 'package',
      reason:
        `sequence package formatVersion is ${String(found)}; shipped templates must be ` +
        `${SEQUENCE_PACKAGE_FORMAT_VERSION} so first browse is no-write`,
    };
  } catch {
    return {
      path: relativePath,
      kind: 'sequence',
      expected: 'package',
      reason: 'sequence package marker is not valid JSON',
    };
  }
}

export function scanWorkspaceShape(root: string): ManifestViolation[] {
  const violations: ManifestViolation[] = [];

  const walk = (dir: string, insidePackage: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === '.git') continue;
      const absolute = join(dir, name);
      let entryStat;
      try {
        entryStat = statSync(absolute);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (name === FORGE_PACKAGE_MARKER_DIR) continue;
        if (isPackageDir(absolute)) {
          const formatViolation = sequencePackageFormatViolation(root, absolute);
          if (formatViolation) violations.push(formatViolation);
        }
        walk(absolute, insidePackage || isPackageDir(absolute));
        continue;
      }
      const violation = violationForPath({
        relativePath: relative(root, absolute).split(/[\\/]/).join('/'),
        insidePackage,
        siblingNames: entries,
      });
      if (violation) violations.push(violation);
    }
  };

  walk(root, false);
  return violations;
}

export function assertWorkspaceShape(root: string, context: string): void {
  const violations = scanWorkspaceShape(root);
  if (violations.length === 0) return;
  const detail = violations
    .slice(0, 10)
    .map((v) => `  ${v.path}: ${v.reason}`)
    .join('\n');
  throw new Error(
    `${context} produced ${violations.length} file(s) in a shape the app does not ` +
      `produce:\n${detail}${violations.length > 10 ? '\n  …' : ''}`
  );
}
