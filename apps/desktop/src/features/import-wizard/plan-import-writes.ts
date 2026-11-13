import type { ImportWizardOutcome } from './import-wizard-store';
import {
  importItemSourcePath,
  type ImportItem,
  type DedupResolution,
} from '../workspace-loader/public/import-wizard-state';
import type { ImportFileDedup } from '../../shared/workspace-git-types';
import { resolveItemTarget } from './import-item-target';

export type ImportWriteAction =
  | {
      kind: 'import-file';
      sourcePath: string;
      targetRoot: string;
      dedup: ImportFileDedup | undefined;
    }
  | { kind: 'import-folder'; sourcePath: string; targetRoot: string }
  | { kind: 'new-workspace-from-folder'; sourcePath: string }
  | { kind: 'new-workspace-then-file'; sourcePath: string }
  | {
      kind: 'import-records';
      sourcePath: string;
      targetRoot: string;
      review: { id: string; revision: string };
    }
  | {
      kind: 'register-entities';
      sourcePath: string;
      targetRoot?: string;
      dedup?: ImportFileDedup;
      expectedSourceSha256?: string;
      confirmedDnaSourceSha256?: string;
      confirmedNucleicAcid?: import('@waypoint/sequence-utils').NucleicAcid;
    }
  | { kind: 'skip'; reason: 'blocked' | 'duplicate'; sourcePath: string };

function dedupFor(item: ImportItem): ImportFileDedup | undefined {
  const r: DedupResolution | undefined = item.dedupResolution;
  if (r === 'replace') {
    const expectedRelPath =
      item.dedup && 'existingRelPath' in item.dedup ? item.dedup.existingRelPath : undefined;
    return { mode: 'replace', expectedRelPath };
  }
  if (r === 'keep-both' || r === 'import-anyway') {
    return { mode: 'keep-both' };
  }
  return undefined;
}

export function planImportWrites(outcome: ImportWizardOutcome): ImportWriteAction[] {
  const { items, destination } = outcome;
  const actions: ImportWriteAction[] = [];
  const plannedDnaSources = new Set<string>();

  for (const item of items) {
    const sourcePath = importItemSourcePath(item);
    if (outcome.importIntent?.entityType === 'dna-sequences') {
      if (plannedDnaSources.has(sourcePath)) continue;
      plannedDnaSources.add(sourcePath);

      const siblings = items.filter((candidate) => importItemSourcePath(candidate) === sourcePath);
      const destinationKeys = new Set(
        siblings.map((candidate) =>
          JSON.stringify(resolveItemTarget(candidate.target, destination))
        )
      );
      if (destinationKeys.size !== 1) {
        throw new Error('Every sequence package from one source must share one destination.');
      }
    }

    if (item.block) {
      actions.push({ kind: 'skip', reason: 'blocked', sourcePath });
      continue;
    }
    if (
      item.spreadsheetImport?.kind !== 'records' &&
      item.dedup?.action === 'skip-duplicate' &&
      item.dedupResolution !== 'import-anyway'
    ) {
      actions.push({ kind: 'skip', reason: 'duplicate', sourcePath });
      continue;
    }

    const dest = resolveItemTarget(item.target, destination);

    if (item.spreadsheetImport?.kind === 'records') {
      const review = item.spreadsheetImport;
      if (
        review.phase !== 'ready' ||
        !review.canApply ||
        !review.review ||
        dest.kind !== 'existing-root'
      )
        throw new Error(
          'Review the spreadsheet records and choose their project before importing.'
        );
      actions.push({
        kind: 'import-records',
        sourcePath,
        targetRoot: dest.rootPath,
        review: review.review,
      });
      continue;
    }

    if (dest.kind === 'new-workspace') {
      if (outcome.importIntent?.entityType === 'dna-sequences') {
        throw new Error(
          'DNA sequence new-project destinations must be resolved before write planning.'
        );
      }
      actions.push(
        item.kind === 'folder'
          ? { kind: 'new-workspace-from-folder', sourcePath }
          : { kind: 'new-workspace-then-file', sourcePath }
      );
      continue;
    }

    if (dest.kind === 'registry') {
      actions.push({
        kind: 'register-entities',
        sourcePath,
        ...(item.expectedSourceSha256 ? { expectedSourceSha256: item.expectedSourceSha256 } : {}),
        ...(item.confirmedDnaSourceSha256
          ? {
              confirmedDnaSourceSha256: item.confirmedDnaSourceSha256,
              ...(item.confirmedNucleicAcid
                ? { confirmedNucleicAcid: item.confirmedNucleicAcid }
                : {}),
            }
          : {}),
      });
      continue;
    }

    if (outcome.importIntent?.entityType === 'dna-sequences' && item.kind === 'file') {
      actions.push({
        kind: 'register-entities',
        sourcePath,
        targetRoot: dest.rootPath,
        dedup: dedupFor(item),
        ...(item.expectedSourceSha256 ? { expectedSourceSha256: item.expectedSourceSha256 } : {}),
        ...(item.confirmedDnaSourceSha256
          ? {
              confirmedDnaSourceSha256: item.confirmedDnaSourceSha256,
              ...(item.confirmedNucleicAcid
                ? { confirmedNucleicAcid: item.confirmedNucleicAcid }
                : {}),
            }
          : {}),
      });
      continue;
    }
    if (item.kind === 'folder') {
      actions.push({ kind: 'import-folder', sourcePath, targetRoot: dest.rootPath });
      continue;
    }
    actions.push({
      kind: 'import-file',
      sourcePath,
      targetRoot: dest.rootPath,
      dedup: dedupFor(item),
    });
  }
  return actions;
}
