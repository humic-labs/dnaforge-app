import { toUserMessage, userMessage, renderUserMessage } from '@waypoint/user-messages';
import type { NucleicAcid } from '@waypoint/sequence-utils';
import { useState, type RefObject } from 'react';
import type { ImportItem } from '../workspace-loader/public/import-wizard-state';
import {
  importItemSourcePath,
  isImportableItem,
} from '../workspace-loader/public/import-wizard-state';
import type { WizardAction } from './wizard-reducer';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';
import { importReadiness } from './import-readiness';
import { ImportItemExplanation } from './ImportItemReadiness';
import { DedupControls } from './DedupControls';
import { FileTypeIcon } from '../../components/icons';
import { getFileIconCategory, isTabularDataFile } from '../../utils/fileTypes';
import { ImportDestinationField } from './ImportDestinationField';
import { resolveItemTarget } from './import-item-target';
import { SpreadsheetImportReview } from './SpreadsheetImportReview';

const BLOCK_LABELS = {
  unsupported_format: userMessage('import.label.unsupported-format'),
  unsupported_source_kind: userMessage('import.label.unsupported-source-kind'),
  read_failure: userMessage('import.label.read-failure'),
  parse_failure: userMessage('import.label.parse-failure'),
  unconfirmed_molecule_identity: userMessage('import.label.unconfirmed-molecule-identity'),
  non_dna_content: userMessage('import.label.non-dna-content'),
  lossless_conversion_blocked: userMessage('import.label.lossless-conversion-blocked'),
  source_too_large: userMessage('import.label.source-too-large'),
  automatic_split_required: userMessage('import.label.automatic-split-required'),
  record_name_conflict: userMessage('import.label.record-name-conflict'),
} as const;

export function importDestinationLabel(
  destination: ImportDestination,
  roots: { path: string; name: string }[]
): string {
  if (destination.kind === 'new-workspace') return 'New project';
  if (destination.kind === 'registry') return 'Registry';
  const root = roots
    .filter(
      (root) =>
        destination.rootPath === root.path || destination.rootPath.startsWith(`${root.path}/`)
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  return root
    ? `${root.name}${destination.rootPath.slice(root.path.length)}`
    : destination.rootPath.split('/').filter(Boolean).pop() || 'Choose a destination';
}

interface Props {
  items: ImportItem[];
  selected: ReadonlySet<string>;
  onSelection: (sources: Set<string>) => void;
  dispatch: (action: WizardAction) => void;
  destination: ImportDestination;
  roots: { path: string; name: string }[];
  onChooseLocation: (item: ImportItem, trigger: HTMLButtonElement) => void;
  locationPickerPath?: string;
  onConfirmDnaIdentity?: (item: ImportItem, nucleicAcid?: NucleicAcid) => void;
  confirmingDnaSources?: ReadonlySet<string>;
  submitted?: RefObject<boolean>;
  allowSpreadsheetChoices?: boolean;
}

export function ImportReviewList({
  items,
  selected,
  onSelection,
  dispatch,
  destination,
  roots,
  onChooseLocation,
  locationPickerPath,
  onConfirmDnaIdentity,
  confirmingDnaSources,
  submitted,
  allowSpreadsheetChoices = true,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const selectable = new Set(items.filter(isImportableItem).map(importItemSourcePath));
  const selectedCount = [...selectable].filter((path) => selected.has(path)).length;
  const allSelected = selectable.size > 0 && selectedCount === selectable.size;
  return (
    <table data-testid="import-review-list" className="w-full table-fixed text-left text-sm">
      <thead className="sticky top-0 bg-bg-subtle text-xs text-fg-muted">
        <tr className="border-y border-border/60">
          <th className="w-14 px-5 py-2.5">
            <input
              type="checkbox"
              aria-label="Select all files"
              title={allSelected ? 'Clear all' : 'Select all'}
              checked={allSelected}
              ref={(node) => {
                if (node) node.indeterminate = selectedCount > 0 && !allSelected;
              }}
              disabled={selectable.size === 0}
              onChange={() => onSelection(allSelected ? new Set() : selectable)}
              className="h-3.5 w-3.5 accent-accent"
            />
          </th>
          <th className="px-2 py-2.5 font-medium">File</th>
          <th className="w-44 px-2 py-2.5 font-medium">Destination</th>
          <th className="w-28 px-5 py-2.5 text-right font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const source = importItemSourcePath(item);
          const available = isImportableItem(item);
          const checked = available && selected.has(source);
          const readiness = importReadiness(item);
          const isExpanded = expanded.has(item.path);
          const sourceName = item.sourcePath?.split(/[\\/]/).pop() ?? item.name;
          const sourceHasMultipleRecords =
            items.filter((candidate) => importItemSourcePath(candidate) === source).length > 1;
          const name = sourceHasMultipleRecords ? item.name : sourceName;
          const issue =
            item.block?.kind === 'sequence-preview-failed' && item.block.reasonCode
              ? BLOCK_LABELS[item.block.reasonCode]
              : item.block?.kind === 'multi-record-fasta'
                ? userMessage('import.label.multipleRecords')
                : item.block
                  ? toUserMessage(item.block.message, 'import.readFailed')
                  : undefined;
          const canConfirmDna =
            item.block?.kind === 'sequence-preview-failed' &&
            item.block.canConfirmDnaIdentity &&
            item.expectedSourceSha256 &&
            onConfirmDnaIdentity;
          const canConvertToRna =
            canConfirmDna &&
            item.block?.kind === 'sequence-preview-failed' &&
            item.block.canConvertToRna === true;
          const status = item.block
            ? canConfirmDna
              ? 'Needs type'
              : 'Cannot import'
            : readiness === 'duplicate'
              ? 'Already imported'
              : readiness === 'conflict'
                ? 'Name conflict'
                : !checked
                  ? 'Not selected'
                  : readiness === 'unplaced'
                    ? 'Choose location'
                    : item.spreadsheetImport?.kind === 'records' &&
                        (item.spreadsheetImport.phase !== 'ready' ||
                          !item.spreadsheetImport.canApply)
                      ? 'Review records'
                      : 'Ready';
          const rowDestination = resolveItemTarget(item.target, destination);
          return (
            <tr
              key={item.path}
              data-testid="import-review-row"
              data-path={item.path}
              data-readiness={readiness}
              className="border-b border-border/60 last:border-b-0"
            >
              <td className="px-5 py-5 align-top">
                <input
                  type="checkbox"
                  aria-label={`Import ${item.name}`}
                  checked={checked}
                  disabled={!available}
                  onChange={() => {
                    const next = new Set(selected);
                    if (checked) next.delete(source);
                    else next.add(source);
                    onSelection(next);
                  }}
                  className="h-3.5 w-3.5 accent-accent disabled:opacity-35"
                />
              </td>
              <td className="min-w-0 px-2 py-2">
                <div className="flex min-h-10 min-w-0 items-center gap-2">
                  <FileTypeIcon
                    category={getFileIconCategory(source)}
                    path={source}
                    molecule={item.confirmedNucleicAcid}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="truncate text-fg" title={name}>
                    {name}
                  </span>
                </div>
                {sourceHasMultipleRecords && (
                  <p className="mt-1 pl-6 text-xs text-fg-muted">{sourceName}</p>
                )}
                {issue && (
                  <div className="mt-1 pl-6 text-xs text-fg-muted">
                    <span>{renderUserMessage(issue)}</span>
                    {' · '}
                    <button
                      type="button"
                      className="text-fg underline underline-offset-2"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (isExpanded) next.delete(item.path);
                          else next.add(item.path);
                          return next;
                        })
                      }
                    >
                      Details
                    </button>
                  </div>
                )}
                {canConfirmDna && (
                  <button
                    type="button"
                    className="ml-6 mt-2 rounded border border-border px-2 py-1 text-xs text-fg hover:bg-bg-muted disabled:opacity-40"
                    disabled={confirmingDnaSources?.has(source)}
                    onClick={() => onConfirmDnaIdentity?.(item, 'dna')}
                  >
                    {confirmingDnaSources?.has(source)
                      ? 'Validating…'
                      : canConvertToRna
                        ? 'Import as cDNA'
                        : 'Confirm DNA'}
                  </button>
                )}
                {canConvertToRna && (
                  <button
                    type="button"
                    className="ml-2 mt-2 rounded border border-border px-2 py-1 text-xs text-fg hover:bg-bg-muted disabled:opacity-40"
                    disabled={confirmingDnaSources?.has(source)}
                    onClick={() => onConfirmDnaIdentity?.(item, 'rna')}
                  >
                    Convert to RNA
                  </button>
                )}
                {isExpanded && (
                  <div className="mt-2">
                    <ImportItemExplanation item={item} />
                  </div>
                )}
                {allowSpreadsheetChoices && item.kind === 'file' && isTabularDataFile(name) && (
                  <SpreadsheetImportReview
                    item={item}
                    selected={checked}
                    submitted={submitted}
                    onChange={(value) =>
                      dispatch({ type: 'set-spreadsheet-import', path: item.path, value })
                    }
                  />
                )}
                {!item.block &&
                  item.spreadsheetImport?.kind !== 'records' &&
                  (item.dedup?.action === 'skip-duplicate' ||
                    item.dedup?.action === 'name-collision') && (
                    <div className="mt-2">
                      <DedupControls item={item} dispatch={dispatch} />
                    </div>
                  )}
              </td>
              <td className="px-2 py-2 align-top">
                <ImportDestinationField
                  disabled={!available}
                  data-testid="import-row-destination"
                  aria-label={`Destination for ${name}`}
                  title={importDestinationLabel(rowDestination, roots)}
                  open={locationPickerPath === item.path}
                  onClick={(event) => onChooseLocation(item, event.currentTarget)}
                  label={
                    item.target ? importDestinationLabel(rowDestination, roots) : 'Choose location'
                  }
                />
              </td>
              <td
                className={`px-5 py-5 text-right align-top text-xs ${item.block || readiness === 'conflict' ? 'text-warning' : checked && readiness === 'ready' ? 'text-success' : 'text-fg-muted'}`}
              >
                {status}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
