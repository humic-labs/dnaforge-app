import { useId, useMemo, useState } from 'react';
import {
  WorkspaceFolderPicker,
  type WorkspaceFolderPickerProps,
} from '../../../components/WorkspaceFolderPicker';
import { ChevronRotatableIcon, FolderIcon } from '../../../components/icons';
import {
  SETTINGS_SELECT_CARET_CLASS,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SETTINGS_SURFACE_CLASS,
} from '../../../components/SettingsSubsection';
import { findContainingPathBoundary, pathRelativeToBoundary } from '../../../shared/path-boundary';

type PrimerSaveLocationPickerProps = Pick<
  WorkspaceFolderPickerProps,
  'roots' | 'initialDir' | 'selectedDir' | 'onSelectFolder' | 'className'
>;

export function PrimerSaveLocationPicker({
  roots,
  initialDir,
  selectedDir,
  onSelectFolder,
  className,
}: PrimerSaveLocationPickerProps) {
  const [expanded, setExpanded] = useState(true);
  const expandedRegionId = useId();

  const selectedLabel = useMemo(() => {
    const owner = findContainingPathBoundary(roots, selectedDir);
    if (!owner) return selectedDir || 'Choose a folder';
    const relative = pathRelativeToBoundary(selectedDir, owner.path);
    if (!relative || relative === '.') return owner.name;
    return `${owner.name} / ${relative.replace(/[\\/]+/g, ' / ')}`;
  }, [roots, selectedDir]);

  return (
    <div className={`min-h-0 ${className ?? ''}`}>
      <div
        className={`overflow-hidden rounded-md bg-bg ${
          expanded ? 'flex h-full min-h-0 flex-col' : ''
        }`}
      >
        <button
          type="button"
          data-testid="primer-save-location-trigger"
          aria-expanded={expanded}
          aria-controls={expandedRegionId}
          onClick={() => setExpanded((current) => !current)}
          className={SETTINGS_SELECT_TRIGGER_CLASS}
        >
          <FolderIcon expanded={expanded} className="h-4 w-4 shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate" title={selectedLabel}>
            {selectedLabel}
          </span>
          <ChevronRotatableIcon expanded={expanded} className={SETTINGS_SELECT_CARET_CLASS} />
        </button>

        {expanded && (
          <div
            id={expandedRegionId}
            data-testid="primer-save-location-expanded"
            className={`min-h-0 flex-1 ${SETTINGS_SURFACE_CLASS}`}
          >
            <WorkspaceFolderPicker
              roots={roots}
              initialDir={selectedDir || initialDir}
              selectedDir={selectedDir}
              onSelectFolder={onSelectFolder}
              idPrefix="primer-picker"
              containerTestId="primer-save-location-picker"
              surface="bare"
              className="h-full min-h-0 max-h-none"
            />
          </div>
        )}
      </div>
    </div>
  );
}
