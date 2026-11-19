import type { ImportDestination } from './resolve-import-destination';
import type { ImportBlock } from './import-format-guard';
import type { ImportDedupDecision } from '../../shared/import-dedup';
import type { DnaSequenceImportIntent } from '../import-wizard/public/entity-import-intent';
import type { SequenceImportPreviewPackage } from '../../shared/workspace-git-types';

export type DedupResolution = 'skip' | 'replace' | 'keep-both' | 'import-anyway';

export type SpreadsheetImport =
  | { kind: 'file' }
  | {
      kind: 'records';
      phase: 'preparing' | 'ready' | 'failed';
      review?: { id: string; revision: string };
      count: number;
      canApply: boolean;
      entityKind?: string;
      error?: string;
    };

export interface ImportItem {
  path: string;
  sourcePath?: string;
  packageInputPath?: string;
  expectedSourceSha256?: string;
  confirmedDnaSourceSha256?: string;
  confirmedNucleicAcid?: import('@waypoint/sequence-utils').NucleicAcid;
  name: string;
  kind: 'file' | 'folder';
  format?: string;
  block?: ImportBlock;
  dedup?: ImportDedupDecision;
  dedupResolution?: DedupResolution;
  target?: import('../import-wizard/public/import-item-target').ImportItemTarget;
  size?: number;
  plannedSequencePackage?: SequenceImportPreviewPackage;
  spreadsheetImport?: SpreadsheetImport;
}

export function importItemSourcePath(item: ImportItem): string {
  return item.sourcePath ?? item.path;
}

export interface ImportWizardState {
  items: ImportItem[];
  destination: ImportDestination;
  importIntent?: DnaSequenceImportIntent;
  availableRoots?: { path: string; name: string }[];
  requiresExplicitChoice: boolean;
  destinationChosen: boolean;
  agentRequested: boolean;
}

export type CanConfirmReason =
  | 'no-items'
  | 'choose-destination'
  | 'all-blocked'
  | 'all-skipped'
  | 'resolve-collisions';

export interface CanConfirmResult {
  canConfirm: boolean;
  reason?: CanConfirmReason;
}

export function importItemSkipReason(item: ImportItem): 'blocked' | 'duplicate' | undefined {
  if (item.block) return 'blocked';
  if (item.spreadsheetImport?.kind === 'records') return undefined;
  if (item.dedup?.action === 'skip-duplicate' && item.dedupResolution !== 'import-anyway') {
    return 'duplicate';
  }
  return undefined;
}

export function isImportableItem(item: ImportItem): boolean {
  return importItemSkipReason(item) === undefined;
}

export function hasUnresolvedImportCollision(item: ImportItem): boolean {
  return (
    item.spreadsheetImport?.kind !== 'records' &&
    item.dedup?.action === 'name-collision' &&
    item.dedupResolution !== 'replace' &&
    item.dedupResolution !== 'keep-both'
  );
}

export function canConfirmImport(state: ImportWizardState): CanConfirmResult {
  if (state.items.length === 0) {
    return { canConfirm: false, reason: 'no-items' };
  }

  const importable = state.items.filter(isImportableItem);
  if (importable.length === 0) {
    return {
      canConfirm: false,
      reason: state.items.every((item) => importItemSkipReason(item) === 'duplicate')
        ? 'all-skipped'
        : 'all-blocked',
    };
  }

  if (importable.some(hasUnresolvedImportCollision)) {
    return { canConfirm: false, reason: 'resolve-collisions' };
  }

  return { canConfirm: true };
}
