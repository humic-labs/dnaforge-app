import {
  SEQUENCE_DATA_LAYER_DIRECTORY,
  SEQUENCE_DATA_LAYER_SUFFIX,
  sequenceDataLayerIdSchema,
} from './sequence-data-layer';
import { normalizeAbsolutePath } from './workspace-file-path';

export function parseSequenceDataLayerPath(
  path: string
): { workspaceRoot: string; id: string } | null {
  if (
    /[\u0000-\u001f\u007f]/u.test(path) ||
    (path.includes('/') && path.includes('\\')) ||
    (path.startsWith('\\') && !path.startsWith('\\\\'))
  )
    return null;
  const normalized = path.replace(/\\/gu, '/');
  if (normalizeAbsolutePath(path) !== normalized) return null;
  const marker = `/${SEQUENCE_DATA_LAYER_DIRECTORY}/`;
  const index = normalized.lastIndexOf(marker);
  if (index < 0 || !normalized.endsWith(SEQUENCE_DATA_LAYER_SUFFIX)) return null;
  const id = normalized.slice(index + marker.length, -SEQUENCE_DATA_LAYER_SUFFIX.length);
  if (!sequenceDataLayerIdSchema.safeParse(id).success) return null;
  let workspaceRoot = path.slice(0, index);
  if (!workspaceRoot || /^[A-Za-z]:$/u.test(workspaceRoot)) workspaceRoot += path[index];
  const root = workspaceRoot.replace(/\\/gu, '/');
  const absolute = root.startsWith('//')
    ? /^\/\/[^/]+\/[^/]+(?:\/|$)/u.test(root)
    : root.startsWith('/') || /^[A-Za-z]:\//u.test(root);
  return absolute ? { workspaceRoot, id } : null;
}
