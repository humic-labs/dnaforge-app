import { useRef } from 'react';
import { Button } from '../../../components/ui';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  WorkspaceFolderPicker,
  type WorkspaceFolderPickerHandle,
} from '../../../components/WorkspaceFolderPicker';
import { soleWritableProjectRoot } from '../../../shared/project-root-selection';

export function ImportDestinationPicker({
  folders,
  value,
  onChange,
}: {
  folders: WorkspaceFolder[];
  value: string | null;
  onChange(path: string): void;
}) {
  const roots = folders.filter((f) => !f.pinned).map((f) => ({ path: f.path, name: f.name }));
  const pickerRef = useRef<WorkspaceFolderPickerHandle>(null);

  const soleProjectPath = soleWritableProjectRoot(roots)?.path ?? null;
  const newFolderParent = value ?? soleProjectPath;
  const initialDirRef = useRef(value ?? soleProjectPath ?? '');

  if (roots.length === 0) {
    return (
      <div
        data-testid="lims-import-destination"
        className="flex min-h-0 flex-1 flex-col items-center justify-center p-5 text-center"
      >
        <div className="text-sm font-medium text-fg">A new project will be created</div>
        <div className="mt-1 max-w-sm text-xs text-fg-muted">
          You have no open project, so this import lands in a fresh “My Project” that’s created for
          you.
        </div>
      </div>
    );
  }

  const selectedName = value ? (roots.find((r) => r.path === value)?.name ?? value) : null;

  return (
    <div data-testid="lims-import-destination" className="flex min-h-0 flex-1 flex-col p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-fg">Choose destination folder</div>
        <Button
          type="button"
          data-testid="lims-import-destination-new-folder"
          title="Create a new folder in the selected location"
          onClick={() => {
            if (newFolderParent) pickerRef.current?.newFolder(newFolderParent);
          }}
          disabled={!newFolderParent}
        >
          <span className="flex items-center gap-1">
            <NewFolderGlyph />
            New folder
          </span>
        </Button>
      </div>
      <WorkspaceFolderPicker
        ref={pickerRef}
        roots={roots}
        initialDir={initialDirRef.current}
        selectedDir={value ?? ''}
        onSelectFolder={onChange}
        idPrefix="lims-import-destination"
        containerTestId="lims-import-destination-tree"
        className="min-h-0 flex-1"
      />
      <div className="mt-2 text-[11px] text-fg-muted">
        {selectedName ? (
          <>
            Destination:{' '}
            <span data-testid="lims-import-destination-current" className="text-fg">
              {selectedName}
            </span>
          </>
        ) : (
          <span data-testid="lims-import-destination-unset" className="text-warning">
            Choose a folder to continue.
          </span>
        )}
      </div>
    </div>
  );
}

function NewFolderGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      className="flex-shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <path
        d="M1.75 4.25v8a1 1 0 0 0 1 1h10.5a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H7.5l-1.5-1.5H2.75a1 1 0 0 0-1 1Z"
        strokeLinejoin="round"
      />
      <path d="M8 7.5v3.5M6.25 9.25h3.5" strokeLinecap="round" />
    </svg>
  );
}
