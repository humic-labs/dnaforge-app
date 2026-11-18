import { useId, useMemo, useState } from 'react';
import {
  WorkspaceFolderPicker,
  type WorkspaceFolderPickerProps,
} from '../../../components/WorkspaceFolderPicker';
import { FolderIcon } from '../../../components/icons';
import { MenuTrigger } from '@waypoint/ui-components';
import { SETTINGS_SURFACE_CLASS } from '../../../components/SettingsSubsection';
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
        <MenuTrigger
          type="button"
          data-testid="primer-save-location-trigger"
          open={expanded}
          density="form"
          title={selectedLabel}
          icon={<FolderIcon expanded={expanded} className="text-fg-subtle" />}
          aria-controls={expandedRegionId}
          onClick={() => setExpanded((current) => !current)}
        >
          {selectedLabel}
        </MenuTrigger>

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
