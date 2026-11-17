import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../../presentation/PresentationSurface';
import { useEffect, useMemo, useState } from 'react';
import { Button, TextField } from '../../../components/ui';
import { WorkspaceFolderPicker } from '../../../components/WorkspaceFolderPicker';
import type {
  ExplorerAssemblyCreateRequest,
  ExplorerEntityCreateRequest,
} from '../../../components/ExplorerAddPicker';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  soleWritableProjectRoot,
  writableProjectRoots,
} from '../../../shared/project-root-selection';
import { findContainingPathBoundary } from '../../../shared/path-boundary';

export type CreateDestinationRequest =
  | ExplorerEntityCreateRequest
  | (ExplorerAssemblyCreateRequest & { entityType: 'assemblies' });

interface RegistryCreateDestinationDialogProps<Request extends CreateDestinationRequest> {
  request: Request;
  folders: WorkspaceFolder[];
  onConfirm: (request: NoInfer<Request>) => void;
  onCancel: () => void;
}

const ENTITY_LABELS: Record<CreateDestinationRequest['entityType'], string> = {
  assemblies: 'assembly',
  notebook: 'notebook entry',
  assembly: 'assembly',
  table: 'table',
  'dna-sequences': 'DNA sequence',
  'dna-oligos': 'DNA oligo',
  'rna-oligos': 'RNA oligo',
  primers: 'primer',
  strains: 'strain',
  proteins: 'protein',
  'registry-types': 'Registry entity',
};

export function RegistryCreateDestinationDialog<Request extends CreateDestinationRequest>({
  request,
  folders,
  onConfirm,
  onCancel,
}: RegistryCreateDestinationDialogProps<Request>) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const roots = useMemo(
    () => writableProjectRoots(folders).map(({ path, name }) => ({ path, name })),
    [folders]
  );
  const [destinationPath, setDestinationPath] = useState<string | null>(null);
  const [name, setName] = useState('Untitled DNA sequence');
  const asksForName = request.entityType === 'dna-sequences';
  const destinationOwner = destinationPath
    ? findContainingPathBoundary(folders, destinationPath)
    : null;
  const canContinue =
    Boolean(destinationOwner && !destinationOwner.pinned) &&
    (!asksForName || name.trim().length > 0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [onCancel, presentationEvents]);

  const confirm = () => {
    if (!destinationPath || !canContinue) return;
    onConfirm({
      ...request,
      destinationPath,
      ...(asksForName ? { name: name.trim() } : {}),
    });
  };

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/40"
      data-testid="registry-create-destination-backdrop"
      onMouseDown={onCancel}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="registry-create-destination-title"
          data-testid="registry-create-destination-dialog"
          className="mx-4 flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-bg-subtle shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="border-b border-border px-4 py-3">
            <h2 id="registry-create-destination-title" className="text-sm font-semibold text-fg">
              Create {ENTITY_LABELS[request.entityType]}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              {request.entityType === 'assemblies'
                ? 'Choose the project or folder for this assembly.'
                : 'Registry indexes files in your projects. Choose where this entity’s authoritative file will be saved.'}
            </p>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {asksForName ? (
              <label className="block text-xs font-medium text-fg-muted">
                Name
                <span className="mt-1.5 block">
                  <TextField
                    autoFocus
                    data-testid="registry-create-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </span>
              </label>
            ) : null}

            {roots.length > 0 ? (
              <div className="flex min-h-72 flex-col">
                <div className="mb-2 text-xs font-medium text-fg-muted">Save location</div>
                <WorkspaceFolderPicker
                  roots={roots}
                  initialDir={soleWritableProjectRoot(roots)?.path ?? ''}
                  selectedDir={destinationPath ?? ''}
                  onSelectFolder={setDestinationPath}
                  idPrefix="registry-create-destination"
                  containerTestId="registry-create-destination-tree"
                  className="min-h-0 flex-1"
                />
                {destinationPath ? (
                  <div
                    data-testid="registry-create-destination-current"
                    className="mt-2 truncate text-[11px] text-fg-muted"
                    title={destinationPath}
                  >
                    Destination: {destinationPath}
                  </div>
                ) : (
                  <div
                    data-testid="registry-create-destination-unset"
                    className="mt-2 text-[11px] text-warning"
                  >
                    Choose a project or folder to continue.
                  </div>
                )}
              </div>
            ) : (
              <div role="alert" className="text-sm text-error">
                Open a writable project before creating{' '}
                {request.entityType === 'assemblies' ? 'an assembly.' : 'a Registry entity.'}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <Button type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="registry-create-destination-continue"
              disabled={!canContinue}
              onClick={confirm}
              variant="primary"
            >
              {asksForName ? 'Create DNA sequence' : 'Continue'}
            </Button>
          </div>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
