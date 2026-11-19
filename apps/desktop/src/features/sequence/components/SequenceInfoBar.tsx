import { MenuNativeSelect } from '@waypoint/ui-components';
import type { ReactNode } from 'react';
import type { SequenceDisplayName } from '../../../shared/sequence-presentation';
import { EditIcon } from '../../../components/icons';
import { Button } from '../../../components/ui';
import {
  UI_DOCUMENT_PREVIEW_LABEL_CLASS,
  UI_DOCUMENT_PREVIEW_ROW_CLASS,
  UI_SEQUENCE_INFO_ROW_CLASS,
} from '../../../components/ui/styles';
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
  accessMode?:
    | { kind: 'read-only' }
    | { kind: 'external-preview'; sourceFileName: string; onImportToEdit: () => void };
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
  const preview = accessMode?.kind === 'external-preview' ? accessMode : undefined;
  const label = preview?.sourceFileName ?? documentLabel;
  if (!label) return null;

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
      role={preview ? 'group' : undefined}
      aria-label={preview ? 'Read-only preview · Not imported' : undefined}
      className={preview ? UI_DOCUMENT_PREVIEW_ROW_CLASS : UI_SEQUENCE_INFO_ROW_CLASS}
    >
      <span className={preview ? 'flex min-w-0 flex-[1_1_9rem] items-center gap-2' : 'contents'}>
        {preview && (
          <span title="Read-only · Not imported" className={UI_DOCUMENT_PREVIEW_LABEL_CLASS}>
            Preview
          </span>
        )}
        <span data-testid="sequence-info-path" className="truncate text-fg min-w-0" title={label}>
          {label}
        </span>
      </span>

      {(accessMode ||
        recordSelector ||
        limsBadge ||
        trailingContent ||
        onEdit ||
        showVisibilityToggle ||
        showMapLayout ||
        showToggle ||
        hasMeta) && (
        <div
          className={`ml-auto flex items-center gap-x-3 ${preview ? 'min-w-0 max-w-full flex-wrap justify-end gap-y-1' : 'flex-shrink-0'}`}
        >
          {recordSelector && recordSelector.records.length > 1 ? (
            <label className="flex min-w-0 max-w-full items-center gap-1.5">
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
          {accessMode?.kind === 'read-only' && (
            <span data-testid="sequence-read-only-indicator" className="font-medium text-fg">
              Read Only
            </span>
          )}
          {preview && (
            <Button
              variant="appbar"
              data-testid="quick-look-import-button"
              onClick={preview.onImportToEdit}
            >
              Import to Edit
            </Button>
          )}
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
