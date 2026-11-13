import {
  importItemSkipReason,
  hasUnresolvedImportCollision,
  type ImportItem,
} from '../workspace-loader/public/import-wizard-state';
import { isPlaced } from './import-placement';

export type ImportReadiness = 'ready' | 'unplaced' | 'blocked' | 'duplicate' | 'conflict';

export function importReadiness(item: ImportItem): ImportReadiness {
  const skipped = importItemSkipReason(item);
  if (skipped === 'blocked') return 'blocked';
  if (skipped === 'duplicate') return 'duplicate';
  if (hasUnresolvedImportCollision(item)) return 'conflict';
  return isPlaced(item) ? 'ready' : 'unplaced';
}

export const IMPORT_READINESS_LABELS: Record<ImportReadiness, string> = {
  ready: 'Ready to import',
  unplaced: 'Choose a location',
  blocked: 'Cannot import',
  duplicate: 'Already imported · will skip',
  conflict: 'Resolve name conflict',
};

export function summarizeImportReadiness(items: ImportItem[]): Record<ImportReadiness, number> {
  const counts = { ready: 0, unplaced: 0, blocked: 0, duplicate: 0, conflict: 0 };
  for (const item of items) counts[importReadiness(item)]++;
  return counts;
}
