import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../presentation/PresentationSurface';
import {
  toUserMessage,
  renderUserMessage,
  userMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import type { NucleicAcid } from '@waypoint/sequence-utils';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { safeFocus } from '../../shared/utils/safeFocus';
import type { ImportWizardState, ImportItem } from '../workspace-loader/public/import-wizard-state';
import {
  importItemSourcePath,
  isImportableItem,
} from '../workspace-loader/public/import-wizard-state';
import type { ImportDestination } from '../workspace-loader/public/resolve-import-destination';
import { wizardReducer, confirmButton, type WizardAction } from './wizard-reducer';
import { allImportablePlaced } from './import-placement';
import { WorkspaceFolderPicker } from '../../components/WorkspaceFolderPicker';
import { ImportReviewList, importDestinationLabel } from './ImportReviewList';
import type { ImportWizardOutcome } from './import-wizard-store';
import type { ImportItemTarget } from './import-item-target';
import { resolveItemTarget } from './import-item-target';
import type {
  SequenceImportPreviewRequest,
  SequenceImportPreviewResult,
} from '../../shared/workspace-git-types';
import { sequenceItemsFromPreview } from './build-import-wizard-state';
import { ImportDestinationField } from './ImportDestinationField';
import { PortalMenu } from '../../components/PortalMenu';
import { SettingsButton, SETTINGS_MENU_OPTION_CLASS } from '../../components/SettingsSubsection';

interface Props {
  requestId?: string;
  initial: ImportWizardState;
  onConfirm: (outcome: ImportWizardOutcome) => void;
  onCancel: () => void;
  previewSequenceImport?: (
    request: SequenceImportPreviewRequest
  ) => Promise<SequenceImportPreviewResult>;
}

function targetFor(destination: ImportDestination): ImportItemTarget {
  if (destination.kind === 'existing-root')
    return { kind: 'existing-root', rootPath: destination.rootPath };
  return { kind: destination.kind };
}

function initialReviewState(initial: ImportWizardState): ImportWizardState {
  if (!initial.destinationChosen || initial.requiresExplicitChoice) return initial;
  return wizardReducer(initial, {
    type: 'place-all-unplaced',
    target: targetFor(initial.destination),
  });
}

export function ImportWizardModal({
  requestId,
  initial,
  onConfirm,
  onCancel,
  previewSequenceImport,
}: Props) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const [state, dispatch] = useReducer(wizardReducer, initial, initialReviewState);
  const [selected, setSelected] = useState(
    () => new Set(initial.items.filter(isImportableItem).map(importItemSourcePath))
  );
  const [locationPicker, setLocationPicker] = useState<{
    item?: ImportItem;
    directory: string;
  } | null>(null);
  const destinationAnchorRef = useRef<HTMLButtonElement | null>(null);
  const destinationMenuRef = useRef<HTMLDivElement | null>(null);
  const [confirmingDnaSources, setConfirmingDnaSources] = useState<Set<string>>(() => new Set());
  const confirmRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const isDnaSequenceImport = state.importIntent?.entityType === 'dna-sequences';
  const roots = state.availableRoots ?? [];
  const confirmedItems = state.items.filter(
    (item) => !isImportableItem(item) || selected.has(importItemSourcePath(item))
  );
  const selectedItems = confirmedItems.filter(isImportableItem);
  const selectedCount = selectedItems.length;
  const allDestinations = new Map(
    state.items.map((item) => {
      const destination = resolveItemTarget(item.target, state.destination);
      return [JSON.stringify(destination), destination] as const;
    })
  );
  const destinationLabel =
    allDestinations.size > 1
      ? 'Multiple locations'
      : importDestinationLabel(allDestinations.values().next().value ?? state.destination, roots);
  const btn = confirmButton({ ...state, items: confirmedItems });
  const placed = allImportablePlaced(selectedItems);
  const recordsReady = selectedItems.every(
    (item) =>
      item.spreadsheetImport?.kind !== 'records' ||
      (item.spreadsheetImport.phase === 'ready' &&
        item.spreadsheetImport.canApply &&
        item.spreadsheetImport.review)
  );
  const enabled =
    selectedCount > 0 && btn.enabled && placed && recordsReady && confirmingDnaSources.size === 0;
  const reason: UserMessage | undefined =
    selectedCount === 0 && state.items.some(isImportableItem)
      ? userMessage('import.selectAtLeastOneFile')
      : btn.enabled && !placed
        ? userMessage('import.chooseDestination')
        : btn.reason;
  const blockedCount = state.items.filter((item) => item.block).length;
  const duplicateCount = state.items.filter(
    (item) =>
      !item.block &&
      item.dedup?.action === 'skip-duplicate' &&
      item.dedupResolution !== 'import-anyway'
  ).length;

  const handleDispatch = (action: WizardAction) => {
    dispatch(action);
    if (action.type === 'set-spreadsheet-import' && action.value?.kind === 'records') {
      const item = state.items.find((item) => item.path === action.path);
      if (item && item.spreadsheetImport?.kind !== 'records')
        setSelected((current) => new Set([...current, importItemSourcePath(item)]));
    }
    if (action.type === 'set-dedup-resolution' && action.resolution === 'import-anyway') {
      const item = state.items.find((item) => item.path === action.path);
      if (item) setSelected((current) => new Set([...current, importItemSourcePath(item)]));
      if (state.destinationChosen)
        dispatch({
          type: 'set-item-target',
          path: action.path,
          target: targetFor(state.destination),
        });
    }
  };

  const closeLocationPicker = useCallback(() => {
    setLocationPicker(null);
    safeFocus(destinationAnchorRef.current);
  }, []);

  const openLocationPicker = (trigger: HTMLButtonElement, item?: ImportItem) => {
    if (locationPicker && destinationAnchorRef.current === trigger) {
      closeLocationPicker();
      return;
    }
    destinationAnchorRef.current = trigger;
    const destination = item
      ? resolveItemTarget(item.target, state.destination)
      : allDestinations.size === 1
        ? (allDestinations.values().next().value ?? state.destination)
        : state.destination;
    setLocationPicker({
      item,
      directory:
        destination.kind === 'existing-root' && state.destinationChosen ? destination.rootPath : '',
    });
  };

  const chooseDestination = (destination: ImportDestination) => {
    if (locationPicker?.item)
      dispatch({
        type: 'set-item-target',
        path: locationPicker.item.path,
        target: targetFor(destination),
      });
    else dispatch({ type: 'set-all-destinations', destination });
    closeLocationPicker();
  };

  const confirmDnaIdentity = async (
    item: ImportItem,
    confirmedNucleicAcid: NucleicAcid = 'dna'
  ) => {
    const sourcePath = importItemSourcePath(item);
    const confirmedDnaSourceSha256 = item.expectedSourceSha256;
    if (!previewSequenceImport || !confirmedDnaSourceSha256 || confirmingDnaSources.has(sourcePath))
      return;
    setConfirmingDnaSources((current) => new Set([...current, sourcePath]));
    try {
      const preview = await previewSequenceImport({
        sourcePath,
        confirmedDnaSourceSha256,
        confirmedNucleicAcid,
      });
      const replacement = sequenceItemsFromPreview(
        item,
        preview,
        confirmedDnaSourceSha256,
        confirmedNucleicAcid
      );
      dispatch({ type: 'replace-source-preview', sourcePath, items: replacement });
      if (preview.kind === 'ready') {
        setSelected((current) => new Set([...current, sourcePath]));
        if (!item.target && state.destinationChosen)
          dispatch({
            type: 'set-item-target',
            path: replacement[0].path,
            target: targetFor(state.destination),
          });
      }
    } catch (error) {
      dispatch({
        type: 'replace-source-preview',
        sourcePath,
        items: [
          {
            ...item,
            expectedSourceSha256: undefined,
            block: {
              kind: 'sequence-preview-failed',
              reasonCode: 'read_failure',
              message: toUserMessage(
                error,
                'failure.the-file-could-not-be-revalidated-select-it-again'
              ),
            },
          },
        ],
      });
    } finally {
      setConfirmingDnaSources((current) => {
        const next = new Set(current);
        next.delete(sourcePath);
        return next;
      });
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCancel();
      }
    };
    presentationEvents.add(document, 'keydown', onKey, true);
    return () => presentationEvents.remove(document, 'keydown', onKey, true);
  }, [onCancel, presentationEvents]);

  useEffect(() => {
    safeFocus(confirmRef.current);
  }, []);

  useEffect(() => {
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId: string; items: ImportItem[] }>).detail;
      if (!requestId || detail?.requestId !== requestId) return;
      const items = detail.items;
      if (!Array.isArray(items) || items.length === 0) return;
      dispatch({ type: 'add-items', items });
      setSelected(
        (current) =>
          new Set([...current, ...items.filter(isImportableItem).map(importItemSourcePath)])
      );
      if (state.destinationChosen)
        dispatch({
          type: 'set-items-target',
          paths: items.map((item) => item.path),
          target: targetFor(state.destination),
        });
    };
    window.addEventListener('waypoint:import-wizard-add-items', onAdd);
    return () => window.removeEventListener('waypoint:import-wizard-add-items', onAdd);
  }, [requestId, state.destination, state.destinationChosen]);

  const confirm = () => {
    if (!enabled) return;
    submitted.current = true;
    onConfirm({
      items: confirmedItems,
      destination: state.destination,
      importIntent: state.importIntent,
      agentRequested: state.agentRequested,
    });
  };

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      data-testid="import-wizard-backdrop"
      onMouseDown={onCancel}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-wizard-title"
          data-testid="import-wizard"
          className={`mx-4 flex max-h-[80vh] w-full ${state.items.some((item) => item.spreadsheetImport?.kind === 'records') ? 'max-w-5xl' : 'max-w-2xl'} flex-col rounded-xl border border-border bg-bg-subtle shadow-xl`}
          onMouseDownCapture={(event) => {
            if (
              locationPicker &&
              !destinationAnchorRef.current?.contains(event.target as Node) &&
              !destinationMenuRef.current?.contains(event.target as Node)
            )
              setLocationPicker(null);
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="px-5 pb-4 pt-5">
            <h3 id="import-wizard-title" className="text-base font-semibold text-fg">
              {isDnaSequenceImport ? 'Import DNA sequences' : 'Import files'}
            </h3>
          </div>
          <div className="px-5 pb-4">
            <div className="flex items-center gap-3">
              <span className="shrink-0 text-xs text-fg-muted">Destination for all files</span>
              <ImportDestinationField
                data-testid="import-destination-button"
                aria-label="Destination for all files"
                open={locationPicker !== null && !locationPicker.item}
                onClick={(event) => openLocationPicker(event.currentTarget)}
                label={state.destinationChosen ? destinationLabel : 'Choose a project or folder'}
              />
            </div>
            <PortalMenu
              key={locationPicker?.item?.path ?? 'all'}
              open={locationPicker !== null}
              anchorRef={destinationAnchorRef}
              surfaceRef={destinationMenuRef}
              onRequestClose={() => setLocationPicker(null)}
              closeOnEscape
              role="dialog"
              aria-label="Choose destination"
              data-testid="import-location-picker"
              preferredSide="bottom"
              horizontalAlign="start"
              surfaceVariant="settings"
              className="w-96"
            >
              {locationPicker && (
                <>
                  <div className="p-1">
                    <button
                      type="button"
                      data-testid="dest-new-workspace"
                      className={`${SETTINGS_MENU_OPTION_CLASS} text-fg hover:bg-bg-muted`}
                      onClick={() => chooseDestination({ kind: 'new-workspace' })}
                    >
                      New project
                    </button>
                  </div>
                  <WorkspaceFolderPicker
                    roots={roots}
                    initialDir={locationPicker.directory}
                    selectedDir={locationPicker.directory}
                    onSelectFolder={(directory) =>
                      setLocationPicker((current) => (current ? { ...current, directory } : null))
                    }
                    idPrefix="import-folder-picker"
                    containerTestId="import-destination-tree"
                    surface="bare"
                    foldersOnly
                    readOnly
                    className="max-h-64 min-h-0"
                  />
                  <div className="flex items-center gap-3 border-t border-border/60 px-3 py-2">
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-fg-muted"
                      title={locationPicker.directory}
                    >
                      {locationPicker.directory
                        ? importDestinationLabel(
                            { kind: 'existing-root', rootPath: locationPicker.directory },
                            roots
                          )
                        : 'Choose a folder'}
                    </span>
                    <SettingsButton
                      variant="primary"
                      disabled={!locationPicker.directory}
                      onClick={() =>
                        chooseDestination({
                          kind: 'existing-root',
                          rootPath: locationPicker.directory,
                        })
                      }
                    >
                      Use folder
                    </SettingsButton>
                  </div>
                </>
              )}
            </PortalMenu>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ImportReviewList
              items={state.items}
              selected={selected}
              onSelection={setSelected}
              dispatch={handleDispatch}
              destination={state.destination}
              roots={roots}
              onChooseLocation={(item, trigger) => openLocationPicker(trigger, item)}
              locationPickerPath={locationPicker?.item?.path}
              onConfirmDnaIdentity={
                isDnaSequenceImport && previewSequenceImport ? confirmDnaIdentity : undefined
              }
              confirmingDnaSources={confirmingDnaSources}
              submitted={submitted}
              allowSpreadsheetChoices={!isDnaSequenceImport}
            />
            {!isDnaSequenceImport && (
              <label className="mx-5 my-3 flex items-center gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  data-testid="import-agent-toggle"
                  checked={state.agentRequested}
                  disabled={selectedCount === 0}
                  onChange={(event) =>
                    dispatch({ type: 'toggle-agent', value: event.target.checked })
                  }
                />
                Organize with an agent
              </label>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-4">
            <div className="min-w-0 text-xs text-fg-muted">
              <p data-testid="import-readiness-summary" role="status">
                {selectedCount} selected
                {blockedCount > 0 && <span> · {blockedCount} cannot import</span>}
                {duplicateCount > 0 && <span> · {duplicateCount} already imported</span>}
              </p>
              {!enabled && reason && (
                <p
                  id="import-confirm-reason"
                  data-testid="import-confirm-reason"
                  className="mt-1"
                  role="status"
                >
                  {renderUserMessage(reason)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-testid="import-cancel"
                onClick={onCancel}
                className="rounded-md border border-border px-3 py-2 text-sm text-fg hover:bg-bg-muted"
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                data-testid="import-confirm"
                onClick={confirm}
                disabled={!enabled}
                aria-describedby={reason ? 'import-confirm-reason' : undefined}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {selectedCount > 0
                  ? isDnaSequenceImport
                    ? `Import ${selectedCount} ${selectedCount === 1 ? 'sequence' : 'sequences'}`
                    : btn.label
                  : 'Import'}
              </button>
            </div>
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
