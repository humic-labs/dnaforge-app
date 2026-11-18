import { MenuNativeSelect } from '@waypoint/ui-components';
import type { ReactNode } from 'react';
import type { SequenceDisplayName } from '../../../shared/sequence-presentation';
import { EditIcon } from '../../../components/icons';
import { Button } from '../../../components/ui';
import { DOCUMENT_TAB_UNDERBAR_MIN_CLASS } from '../public/document-tab-underbar';
import { SequenceViewerModeToggle, type SequenceViewMode } from './SequenceViewerModeToggle';
import type {
  SequenceMapLayout,
  SequenceRendererVisibility,
} from '../view-state/sequence-view-state';

interface SequenceInfoBarProps {
  documentLabel: SequenceDisplayName | null;

  sequenceLength?: number;

  circular?: boolean;

  viewMode?: SequenceViewMode;
  onViewModeChange?: (next: SequenceViewMode) => void;
  rendererVisibility?: SequenceRendererVisibility;
  onRendererVisibilityChange?: (next: SequenceRendererVisibility) => void;
  mapLayout?: SequenceMapLayout;
  onMapLayoutChange?: (next: SequenceMapLayout) => void;
  showViewModeToggle?: boolean;
  showRendererVisibilityToggle?: boolean;
  showMapLayoutToggle?: boolean;
  accessMode?: {
    kind: 'read-only';
    onImportToEdit?: () => void;
  };
  recordSelector?: {
    readonly records: readonly {
      readonly recordId: string;
      readonly displayName: SequenceDisplayName;
      readonly sequenceLength: number;
    }[];
    readonly selectedRecordId: string;
    readonly onSelect: (recordId: string) => void;
  };
  limsBadge?: ReactNode;

  trailingContent?: ReactNode;

  onEdit?: () => void;
  editingPending?: boolean;
  editButtonTestId?: string;
}

const numberFmt = new Intl.NumberFormat();

export function SequenceInfoBar({
  documentLabel,
  sequenceLength,
  circular,
  viewMode,
  onViewModeChange,
  rendererVisibility,
  onRendererVisibilityChange,
  mapLayout,
  onMapLayoutChange,
  showViewModeToggle = true,
  showRendererVisibilityToggle = true,
  showMapLayoutToggle = true,
  accessMode,
  recordSelector,
  limsBadge,
  trailingContent,
  onEdit,
  editingPending = false,
  editButtonTestId = 'sequence-edit-button',
}: SequenceInfoBarProps) {
  if (!documentLabel) return null;

  const hasMeta = sequenceLength != null || circular != null;
  const showToggle = showViewModeToggle && viewMode != null && onViewModeChange != null;
  const showVisibilityToggle =
    showRendererVisibilityToggle &&
    rendererVisibility != null &&
    onRendererVisibilityChange != null;
  const showMapLayout =
    showMapLayoutToggle &&
    rendererVisibility === 'both' &&
    mapLayout != null &&
    onMapLayoutChange != null;

  return (
    <div
      data-testid="sequence-info-bar"
      className={`flex-shrink-0 flex items-center gap-3 px-3 py-0 ${DOCUMENT_TAB_UNDERBAR_MIN_CLASS} bg-bg border-b border-border-hover text-xs text-fg-muted`}
    >
      <span
        data-testid="sequence-info-path"
        className="truncate text-fg min-w-0"
        title={documentLabel}
      >
        {documentLabel}
      </span>

      {}
      {(accessMode ||
        recordSelector ||
        limsBadge ||
        trailingContent ||
        onEdit ||
        showVisibilityToggle ||
        showMapLayout ||
        showToggle ||
        hasMeta) && (
        <div className="ml-auto flex-shrink-0 flex items-center gap-3">
          {recordSelector && recordSelector.records.length > 1 ? (
            <label className="flex items-center gap-1.5">
              <span className="text-fg-muted">Record</span>
              <span className="inline-block min-w-0 max-w-56">
                <MenuNativeSelect
                  density="compact"
                  data-testid="quick-look-record-selector"
                  aria-label="Quick Look record"
                  value={recordSelector.selectedRecordId}
                  onChange={(event) => recordSelector.onSelect(event.target.value)}
                >
                  {recordSelector.records.map((record, index) => (
                    <option key={record.recordId} value={record.recordId}>
                      {index + 1}. {record.displayName} ({numberFmt.format(record.sequenceLength)}{' '}
                      bp)
                    </option>
                  ))}
                </MenuNativeSelect>
              </span>
            </label>
          ) : null}
          {accessMode?.kind === 'read-only' ? (
            <span className="flex items-center gap-2">
              <span data-testid="sequence-read-only-indicator" className="font-medium text-fg">
                Read Only
              </span>
              {accessMode.onImportToEdit ? (
                <button
                  type="button"
                  data-testid="quick-look-import-button"
                  onClick={accessMode.onImportToEdit}
                  className="rounded border border-accent/70 bg-accent/10 px-2 py-0.5 font-medium text-accent hover:bg-accent/20"
                >
                  Import to Edit
                </button>
              ) : null}
            </span>
          ) : null}
          {limsBadge}
          {trailingContent}
          {onEdit ? (
            <Button
              type="button"
              title={editingPending ? 'Loading sequence' : 'Edit sequence'}
              aria-label="Edit sequence"
              aria-busy={editingPending}
              disabled={editingPending}
              onClick={onEdit}
              data-testid={editButtonTestId}
            >
              <span className="inline-flex items-center gap-1">
                <EditIcon size={12} />
                <span>{editingPending ? 'Loading…' : 'Edit'}</span>
              </span>
            </Button>
          ) : null}
          {showVisibilityToggle && (
            <SequenceRendererVisibilityToggle
              value={rendererVisibility!}
              onChange={onRendererVisibilityChange!}
            />
          )}
          {showMapLayout && (
            <SequenceMapLayoutToggle value={mapLayout!} onChange={onMapLayoutChange!} />
          )}
          {showToggle && (
            <SequenceViewerModeToggle value={viewMode!} onChange={onViewModeChange!} />
          )}
          {hasMeta && (
            <span className="flex items-center gap-2 tabular-nums">
              {sequenceLength != null && <span>{numberFmt.format(sequenceLength)} bp</span>}
              {sequenceLength != null && circular != null && (
                <span className="text-fg-subtle">·</span>
              )}
              {circular != null && <span>{circular ? 'circular' : 'linear'}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CompactSegmentedButton<T extends string>({
  value,
  option,
  label,
  testId,
  onChange,
}: {
  value: T;
  option: T;
  label: string;
  testId: string;
  onChange: (next: T) => void;
}) {
  const active = value === option;
  return (
    <button
      type="button"
      aria-pressed={active}
      data-testid={testId}
      onClick={() => {
        if (!active) onChange(option);
      }}
      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
        active ? 'bg-bg text-fg shadow-sm dark:bg-bg-muted' : 'text-fg-muted wp-interactive'
      }`}
      title={label}
    >
      {label}
    </button>
  );
}

function CompactSegmentedGroup({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className="inline-flex items-center rounded bg-gray-100 p-px dark:bg-bg-subtle"
    >
      {children}
    </div>
  );
}

function SequenceMapLayoutToggle({
  value,
  onChange,
}: {
  value: SequenceMapLayout;
  onChange: (next: SequenceMapLayout) => void;
}) {
  return (
    <CompactSegmentedGroup label="Sequence and map layout" testId="sequence-map-layout-toggle">
      <CompactSegmentedButton
        value={value}
        option="vertical"
        label="Stack"
        testId="sequence-map-layout-vertical"
        onChange={onChange}
      />
      <CompactSegmentedButton
        value={value}
        option="horizontal"
        label="Side"
        testId="sequence-map-layout-horizontal"
        onChange={onChange}
      />
    </CompactSegmentedGroup>
  );
}

function SequenceRendererVisibilityToggle({
  value,
  onChange,
}: {
  value: SequenceRendererVisibility;
  onChange: (next: SequenceRendererVisibility) => void;
}) {
  return (
    <CompactSegmentedGroup
      label="Sequence viewer visibility"
      testId="sequence-renderer-visibility-toggle"
    >
      <CompactSegmentedButton
        value={value}
        option="sequence"
        label="Sequence"
        testId="sequence-renderer-visibility-sequence"
        onChange={onChange}
      />
      <CompactSegmentedButton
        value={value}
        option="both"
        label="Both"
        testId="sequence-renderer-visibility-both"
        onChange={onChange}
      />
      <CompactSegmentedButton
        value={value}
        option="map"
        label="Map"
        testId="sequence-renderer-visibility-map"
        onChange={onChange}
      />
    </CompactSegmentedGroup>
  );
}
