import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';

export type ImportItemTarget =
  | { kind: 'default' }
  | { kind: 'existing-root'; rootPath: string }
  | { kind: 'new-workspace' }
  | { kind: 'registry' };

export function resolveItemTarget(
  target: ImportItemTarget | undefined,
  batch: ImportDestination
): ImportDestination {
  if (!target || target.kind === 'default') return batch;
  if (target.kind === 'existing-root') {
    return { kind: 'existing-root', rootPath: target.rootPath };
  }
  if (target.kind === 'registry') return { kind: 'registry' };
  return { kind: 'new-workspace' };
}
