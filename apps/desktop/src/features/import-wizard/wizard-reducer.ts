import { userMessage, type UserMessage } from '@waypoint/user-messages';
import {
  canConfirmImport,
  type ImportWizardState,
  type ImportItem,
  type DedupResolution,
  importItemSourcePath,
  isImportableItem,
} from '../workspace-loader/public/import-wizard-state';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';
import { importBucketFor, type ImportBucket } from './import-bucket';
import type { ImportItemTarget } from './import-item-target';

export type WizardAction =
  | { type: 'set-destination'; destination: ImportDestination }
  | { type: 'set-all-destinations'; destination: ImportDestination }
  | { type: 'set-dedup-resolution'; path: string; resolution: DedupResolution }
  | { type: 'set-spreadsheet-import'; path: string; value: ImportItem['spreadsheetImport'] }
  | { type: 'toggle-agent'; value: boolean }
  | { type: 'set-items'; items: ImportItem[] }
  | { type: 'add-items'; items: ImportItem[] }
  | { type: 'replace-source-preview'; sourcePath: string; items: ImportItem[] }
  | { type: 'set-item-target'; path: string; target: ImportItemTarget }
  | { type: 'set-group-target'; bucket: ImportBucket; target: ImportItemTarget }
  | { type: 'set-items-target'; paths: string[]; target: ImportItemTarget }
  | { type: 'unplace-items'; paths: string[] }
  | { type: 'place-all-unplaced'; target: ImportItemTarget };

function sourceGroupsForPaths(items: ImportItem[], paths: Iterable<string>): Set<string> {
  const selectedPaths = new Set(paths);
  return new Set(
    items.filter((item) => selectedPaths.has(item.path)).map((item) => importItemSourcePath(item))
  );
}

function itemBelongsToSourceGroups(item: ImportItem, sourceGroups: ReadonlySet<string>): boolean {
  return sourceGroups.has(importItemSourcePath(item));
}

export function wizardReducer(state: ImportWizardState, action: WizardAction): ImportWizardState {
  switch (action.type) {
    case 'set-spreadsheet-import':
      return {
        ...state,
        items: state.items.map((item) =>
          item.path === action.path ? { ...item, spreadsheetImport: action.value } : item
        ),
      };
    case 'set-destination':
      return { ...state, destination: action.destination, destinationChosen: true };
    case 'set-all-destinations':
      return {
        ...state,
        destination: action.destination,
        destinationChosen: true,
        items: state.items.map((item) => ({ ...item, target: action.destination })),
      };
    case 'set-dedup-resolution': {
      const sourceGroups = sourceGroupsForPaths(state.items, [action.path]);
      return {
        ...state,
        items: state.items.map((item) =>
          itemBelongsToSourceGroups(item, sourceGroups)
            ? { ...item, dedupResolution: action.resolution }
            : item
        ),
      };
    }
    case 'toggle-agent':
      return { ...state, agentRequested: action.value };
    case 'set-items':
      return { ...state, items: action.items };
    case 'replace-source-preview': {
      const current = state.items.find((item) => importItemSourcePath(item) === action.sourcePath);
      if (!current) return state;
      let inserted = false;
      return {
        ...state,
        items: state.items.flatMap((item) => {
          if (importItemSourcePath(item) !== action.sourcePath) return [item];
          if (inserted) return [];
          inserted = true;
          return action.items.map((replacement) => ({ ...replacement, target: current.target }));
        }),
      };
    }
    case 'add-items': {
      const seen = new Set(state.items.map(importItemSourcePath));
      const fresh = action.items.filter((item) => !seen.has(importItemSourcePath(item)));
      return fresh.length === 0 ? state : { ...state, items: [...state.items, ...fresh] };
    }
    case 'set-item-target': {
      const sourceGroups = sourceGroupsForPaths(state.items, [action.path]);
      return {
        ...state,
        items: state.items.map((item) =>
          isImportableItem(item) && itemBelongsToSourceGroups(item, sourceGroups)
            ? { ...item, target: action.target }
            : item
        ),
      };
    }
    case 'set-group-target':
      return {
        ...state,
        items: state.items.map((i) =>
          isImportableItem(i) && importBucketFor(i) === action.bucket
            ? { ...i, target: action.target }
            : i
        ),
      };
    case 'set-items-target': {
      const sourceGroups = sourceGroupsForPaths(state.items, action.paths);
      return {
        ...state,
        items: state.items.map((item) =>
          isImportableItem(item) && itemBelongsToSourceGroups(item, sourceGroups)
            ? { ...item, target: action.target }
            : item
        ),
      };
    }
    case 'unplace-items': {
      const sourceGroups = sourceGroupsForPaths(state.items, action.paths);
      return {
        ...state,
        items: state.items.map((item) =>
          itemBelongsToSourceGroups(item, sourceGroups) ? { ...item, target: undefined } : item
        ),
      };
    }
    case 'place-all-unplaced':
      return {
        ...state,
        items: state.items.map((i) =>
          isImportableItem(i) && (!i.target || i.target.kind === 'default')
            ? { ...i, target: action.target }
            : i
        ),
      };
    default:
      return state;
  }
}

export interface ConfirmButton {
  label: string;
  enabled: boolean;
  reason?: UserMessage;
}

const REASON_COPY: Record<string, UserMessage> = {
  'no-items': userMessage('import.nothing'),
  'choose-destination': userMessage('import.chooseDestination'),
  'all-blocked': userMessage('import.nothingImportable'),
  'all-skipped': userMessage('import.alreadyImported'),
  'resolve-collisions': userMessage('import.resolveCollision'),
};

export function confirmButton(state: ImportWizardState): ConfirmButton {
  const { canConfirm, reason } = canConfirmImport(state);
  if (!canConfirm) {
    return {
      enabled: false,
      label: state.agentRequested ? 'Import & bring an agent in' : 'Import',
      reason: reason ? REASON_COPY[reason] : undefined,
    };
  }

  const importableCount = state.items.filter(isImportableItem).length;
  const noun = importableCount === 1 ? 'item' : 'items';
  const label = state.agentRequested
    ? `Import ${importableCount} ${noun} & bring an agent in`
    : `Import ${importableCount} ${noun}`;
  return { enabled: true, label };
}
