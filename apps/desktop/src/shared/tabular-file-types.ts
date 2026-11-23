import { TABULAR_DATA_EXTENSIONS } from '@waypoint/scientific-artifacts/shared/entity-types';

export { TABULAR_DATA_EXTENSIONS };

export function isTabularRepresentation(
  kind: string | null | undefined,
  path: string | null | undefined
): boolean {
  if (kind && TABULAR_DATA_EXTENSIONS.has(kind.toLowerCase())) return true;
  const filename = path?.split(/[\\/]/).at(-1) ?? '';
  const separator = filename.lastIndexOf('.');
  return separator > 0 && TABULAR_DATA_EXTENSIONS.has(filename.slice(separator + 1).toLowerCase());
}
