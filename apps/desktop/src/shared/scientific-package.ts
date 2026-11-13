import { FORGE_PACKAGE_MARKER_DIR, isForgePackageMetaPath } from './forge-package-path';
import { stripWorkspaceScope } from './workspace-scoped-identity';

export const PROTOCOL_PACKAGE_META_NAME = 'protocol.json' as const;
export const PROTOCOL_RUN_PACKAGE_META_NAME = 'protocol-run.json' as const;

export type ScientificPackageKind = 'protocol' | 'protocol-run';

export type ScientificPackageIdentity = {
  kind: ScientificPackageKind;
  rawId: string;
  title: string;
};

export function scientificPackageKindForMetaPath(path: string): ScientificPackageKind | null {
  if (isForgePackageMetaPath(path, PROTOCOL_PACKAGE_META_NAME)) return 'protocol';
  if (isForgePackageMetaPath(path, PROTOCOL_RUN_PACKAGE_META_NAME)) return 'protocol-run';
  return null;
}

export function scientificPackageMetaPath(
  packageRoot: string,
  kind: ScientificPackageKind
): string {
  const root = packageRoot.replace(/[\\/]+$/u, '');
  const metaName =
    kind === 'protocol' ? PROTOCOL_PACKAGE_META_NAME : PROTOCOL_RUN_PACKAGE_META_NAME;
  return `${root}/${FORGE_PACKAGE_MARKER_DIR}/${metaName}`;
}

export function parseScientificPackageIdentity(
  path: string,
  text: string
): ScientificPackageIdentity {
  const kind = scientificPackageKindForMetaPath(path);
  if (!kind) throw new Error('Path is not a native protocol package metadata file.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Native protocol package metadata is invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Native protocol package metadata must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const expectedSchema = kind === 'protocol' ? 'dnaforge.protocol.v1' : 'dnaforge.protocol-run.v1';
  const expectedKind = kind === 'protocol' ? 'protocol' : 'protocol_run';
  if (record.schema !== expectedSchema || record.kind !== expectedKind) {
    throw new Error('Native protocol package path and schema do not match.');
  }
  const embeddedId = requiredText(record.id, 'Native protocol package ID');
  const rawId = stripWorkspaceScope(embeddedId);
  if (!rawId)
    throw new Error('Native protocol package ID is empty after removing workspace scope.');
  return {
    kind,
    rawId,
    title: requiredText(record.title, 'Native protocol package title'),
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || containsControlCharacter(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}
