import { isImportableItem, type ImportItem } from '../workspace-loader/public/import-wizard-state';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';

export function isPlaced(item: ImportItem): boolean {
  return !!item.target && item.target.kind !== 'default';
}

export function itemDestination(item: ImportItem): ImportDestination | null {
  if (!item.target || item.target.kind === 'default') return null;
  if (item.target.kind === 'existing-root') {
    return { kind: 'existing-root', rootPath: item.target.rootPath };
  }
  if (item.target.kind === 'registry') return { kind: 'registry' };
  return { kind: 'new-workspace' };
}

export function unplacedItems(items: ImportItem[]): ImportItem[] {
  return items.filter((i) => !isPlaced(i));
}

export function itemsPlacedAt(items: ImportItem[], rootPath: string): ImportItem[] {
  return items.filter((i) => i.target?.kind === 'existing-root' && i.target.rootPath === rootPath);
}

export function itemsPlacedNewWorkspace(items: ImportItem[]): ImportItem[] {
  return items.filter((i) => i.target?.kind === 'new-workspace');
}

export function allImportablePlaced(items: ImportItem[]): boolean {
  return items.filter(isImportableItem).every(isPlaced);
}
