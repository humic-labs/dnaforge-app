import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, TextField } from '../../../components/ui';
import { WorkspaceFolderPicker } from '../../../components/WorkspaceFolderPicker';
import { platform } from '../../../platform';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import { TRACK_VIEW_SUFFIX, type SaveTrackViewRequest } from '../../../shared/track-view';
import { safeFocus } from '../../../shared/utils/safeFocus';

// eslint-disable-next-line no-control-regex
const invalidFileNameCharacters = /[<>:"/\\|?*\u0000-\u001f]/gu;

export function TrackViewSaveDialog({
  initialName,
  initialPath,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initialName: string;
  initialPath?: string;
  saving: boolean;
  error: string | null;
  onSave: (name: string, destination: NonNullable<SaveTrackViewRequest['destination']>) => void;
  onCancel: () => void;
}) {
  const folders = useWorkspaceStore((state) => state.folders);
  const [locations, setLocations] = useState<{
    defaultDirectory: string;
    homeDirectory: string;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(() =>
    initialName
      .replace(invalidFileNameCharacters, '-')
      .replace(/[. ]+$/u, '')
      .slice(0, 160)
  );
  const [directory, setDirectory] = useState('');
  const dialog = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    const previous = document.activeElement;
    safeFocus(input.current);
    input.current?.select();
    void platform()
      .trackViews.locations()
      .then((value) => {
        if (!active) return;
        setLocations(value);
        setDirectory(initialPath?.replace(/[\\/][^\\/]+$/, '') ?? value.defaultDirectory);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(toUserMessage(reason, 'failure.could-not-load-save-locations'));
      });
    return () => {
      active = false;
      if (previous instanceof HTMLElement) safeFocus(previous);
    };
  }, [initialPath]);
  const roots = useMemo(() => {
    const entries = [...folders.map(({ path, name }) => ({ path, name }))];
    if (locations)
      entries.push(
        { path: locations.defaultDirectory, name: 'My views' },
        { path: locations.homeDirectory, name: 'Home folder' }
      );
    const currentFolder = initialPath?.replace(/[\\/][^\\/]+$/, '');
    if (
      currentFolder &&
      !entries.some((entry) => isPathInsideBoundary(currentFolder, entry.path))
    ) {
      entries.push({ path: currentFolder, name: 'Current folder' });
    }
    return entries.filter(
      (entry, index) => entries.findIndex((other) => other.path === entry.path) === index
    );
  }, [folders, locations, initialPath]);
  const owner = roots
    .filter((root) => isPathInsideBoundary(directory, root.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const validName =
    Boolean(name.trim()) &&
    name.search(invalidFileNameCharacters) === -1 &&
    !/[. ]$/u.test(name) &&
    name.trim().length <= 160 &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6">
      <form
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Save Track view"
        data-testid="track-view-save-dialog"
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-border bg-bg text-fg shadow-xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!saving) onCancel();
          } else if (event.key === 'Tab') {
            const items = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
              ) ?? []
            );
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving && validName && owner)
            onSave(name.trim(), {
              workspaceRoot: owner.path,
              path: `${directory.replace(/[\\/]+$/, '')}/${name.trim()}${TRACK_VIEW_SUFFIX}`,
            });
        }}
      >
        <h2 className="border-b border-border px-5 py-4 text-base font-semibold">
          Save Track view
        </h2>
        <div className="flex min-h-0 flex-col gap-3 p-5">
          <label className="flex flex-col gap-1 text-sm">
            View name
            <TextField
              ref={input}
              aria-label="Track view name"
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {!validName && (
            <p role="alert" className="text-sm text-red-600">
              Enter a valid file name without slashes or reserved characters.
            </p>
          )}
          <p className="text-sm font-medium">Save in</p>
          {locations ? (
            <WorkspaceFolderPicker
              roots={roots}
              initialDir={directory}
              selectedDir={directory}
              onSelectFolder={setDirectory}
              idPrefix="track-view-picker"
              containerTestId="track-view-save-location-picker"
              className="min-h-40 max-h-72 overflow-auto"
            />
          ) : (
            <p className="text-sm text-fg-muted">Loading folders…</p>
          )}
          {directory && (
            <p className="break-all text-xs text-fg-muted" data-testid="track-view-save-directory">
              {directory}
            </p>
          )}
          {(error || loadError) && (
            <p role="alert" className="text-sm text-red-600">
              {error
                ? toUserMessage(error, 'tracks.loadFailed')
                : toUserMessage(loadError, 'tracks.loadFailed')}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={saving || !validName || !owner || !!loadError}
          >
            {saving ? 'Saving…' : 'Save Track view'}
          </Button>
        </div>
      </form>
    </div>,
    document.body
  );
}
