import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { Button, TextField, UI_MODAL_LAYER_CLASS } from '../../../components/ui';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import { previewProteinArtifactPath } from '../record-proteins';
import { ProteinSaveLocationPicker } from './ProteinSaveLocationPicker';

export interface PendingAminoAcidCreation {
  suggestedName: string;
  sequence: string;
  workspaceRoot: string;
  sourceFilePath: string;
}

export interface CreateAminoAcidSequenceDialogProps {
  pending: PendingAminoAcidCreation | null;
  onCancel: () => void;
  onConfirm: (name: string, dir: string, workspaceRoot: string) => void;
  isCreating?: boolean;
  roots: ReadonlyArray<{ path: string; name: string }>;
}

function defaultProteinFolder(workspaceRoot: string, sourceFilePath: string): string {
  if (!sourceFilePath) return workspaceRoot.replace(/[\\/]+$/, '');
  const idx = Math.max(sourceFilePath.lastIndexOf('/'), sourceFilePath.lastIndexOf('\\'));
  return idx > 0 ? sourceFilePath.slice(0, idx) : workspaceRoot.replace(/[\\/]+$/, '');
}

function ownerWorkspaceRoot(
  dir: string,
  roots: ReadonlyArray<{ path: string; name: string }>
): string | undefined {
  return findContainingPathBoundary(roots, dir)?.path;
}

export function CreateAminoAcidSequenceDialog({
  pending,
  onCancel,
  onConfirm,
  isCreating = false,
  roots,
}: CreateAminoAcidSequenceDialogProps) {
  const presentationOverlay = usePresentationOverlay('modal');

  const [name, setName] = useState('');
  const [destinationPath, setDestinationPath] = useState<string | null>(null);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [chosenDir, setChosenDir] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pending) return;
    setName(pending.suggestedName);
    setChosenDir(null);
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    safeFocus(nameInputRef.current);
  }, [pending]);

  const defaultDir = pending
    ? defaultProteinFolder(pending.workspaceRoot, pending.sourceFilePath)
    : '';
  const effectiveWorkspaceRoot =
    pending && chosenDir
      ? (ownerWorkspaceRoot(chosenDir, roots) ?? pending.workspaceRoot)
      : (pending?.workspaceRoot ?? '');

  useEffect(() => {
    if (!pending || !name.trim()) {
      setDestinationPath(null);
      setDestinationError(null);
      return;
    }
    let cancelled = false;
    previewProteinArtifactPath(
      effectiveWorkspaceRoot,
      name,
      pending.sequence,
      chosenDir ?? defaultDir
    )
      .then((path) => {
        if (cancelled) return;
        setDestinationPath(path);
        setDestinationError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDestinationPath(null);
        setDestinationError(toUserMessage(error, 'failure.invalid-destination-folder'));
      });
    return () => {
      cancelled = true;
    };
  }, [pending, name, chosenDir, effectiveWorkspaceRoot, defaultDir]);

  if (!pending) return null;

  const trimmedName = name.trim();
  const canConfirm = trimmedName.length > 0 && !isCreating && !destinationError;

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} flex items-center justify-center bg-black/40`}
      data-testid="create-amino-acid-sequence-backdrop"
      onMouseDown={() => !isCreating && onCancel()}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-amino-acid-sequence-title"
          data-testid="create-amino-acid-sequence-dialog"
          className="mx-4 w-full max-w-lg rounded-lg border border-border bg-bg-subtle p-4 shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <h3 id="create-amino-acid-sequence-title" className="text-sm font-semibold text-fg">
            Create amino acid sequence
          </h3>

          <label
            className="mt-3 block text-xs font-medium text-fg-muted"
            htmlFor="aa-creation-name"
          >
            Name
          </label>
          <div className="mt-1">
            <TextField
              ref={nameInputRef}
              id="aa-creation-name"
              data-testid="create-amino-acid-sequence-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isCreating}
            />
          </div>

          <div className="mt-3 text-xs font-medium text-fg-muted">Sequence preview</div>
          <div
            data-testid="create-amino-acid-sequence-preview"
            className="mt-1 max-h-24 overflow-y-auto rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs leading-5 text-fg break-all"
          >
            {pending.sequence}
          </div>
          <div className="mt-1 text-xs text-fg-muted">{pending.sequence.length} residues</div>

          {roots.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-medium text-fg-muted">Save location</div>
              <div className="mt-1">
                <ProteinSaveLocationPicker
                  roots={roots}
                  initialDir={defaultDir}
                  selectedDir={chosenDir ?? defaultDir}
                  onSelectFolder={setChosenDir}
                />
              </div>
            </div>
          )}
          <div className="mt-2 text-xs font-medium text-fg-muted">Will be saved to</div>
          {destinationError ? (
            <div
              data-testid="create-amino-acid-sequence-destination-error"
              role="alert"
              className="mt-1 rounded border border-error/50 bg-error/10 px-2 py-1.5 text-xs text-error"
            >
              {toUserMessage(destinationError, 'failure.invalid-destination-folder')}
            </div>
          ) : (
            <div
              data-testid="create-amino-acid-sequence-destination"
              className="mt-1 truncate rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg"
              title={destinationPath ?? undefined}
            >
              {destinationPath ?? '…'}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              data-testid="create-amino-acid-sequence-cancel"
              onClick={onCancel}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="create-amino-acid-sequence-confirm"
              onClick={() =>
                canConfirm &&
                onConfirm(trimmedName, chosenDir ?? defaultDir, effectiveWorkspaceRoot)
              }
              disabled={!canConfirm}
              variant="primary"
            >
              {isCreating ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
