import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../presentation/PresentationSurface';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type {
  EntityImportRequest,
  EntityImportType,
} from '../features/import-wizard/entity-import-intent';
import {
  ChatTabIcon,
  AssemblyTabIcon,
  ChevronRightIcon,
  FolderOpenIcon,
  GenericFileIcon,
  ImportIcon,
  OpenExternalIcon,
  PlusIcon,
  iconForEntityKind,
} from './icons';
import { useMenuAim } from '@waypoint/ui-components';
import { isHostedCapabilityShown } from '../hosted/capabilities';
import { isElectron } from '../utils/environment';
import { SpreadsheetFileIcon } from './icons/glyphs';

export type ExplorerAddPickerLaunchSource = 'context-menu' | 'registry';
export type ExplorerEntityImportRequest = EntityImportRequest;
export type ExplorerEntityCreateType = EntityImportType | 'notebook' | 'assembly' | 'table';
export interface ExplorerEntityCreateRequest {
  entityType: ExplorerEntityCreateType;
  destinationPath: string | null;
  name?: string;
  creationId?: string;
  sequenceCreation?: import('../features/sequence/create-empty-dna-sequence').CapturedSequenceCreation;
}
export interface ExplorerAssemblyCreateRequest {
  mode: 'blank' | 'schema';
  destinationPath: string | null;
}

interface ExplorerAddPickerProps {
  open: boolean;
  anchorRef?: RefObject<HTMLButtonElement | null>;
  anchorPoint?: { x: number; y: number } | null;
  launchSource: ExplorerAddPickerLaunchSource;
  destinationLabel?: string | null;
  destinationPath?: string | null;
  hasWorkspace: boolean;
  onRequestClose: () => void;
  onCommitAction?: () => void;
  onCreateEntity?: (request: ExplorerEntityCreateRequest) => void;
  onCreateAssembly?: (request: ExplorerAssemblyCreateRequest) => void;
  canCreateEntity?: (entityType: ExplorerEntityCreateType) => boolean;
  onImportEntity?: (request: ExplorerEntityImportRequest) => void;
  onImportProject?: () => void;
  onImportProjectWithAgent?: () => void;
  onMigrateFromBenchling?: () => void;
}

interface PickerPlacement {
  top: number;
  left: number;
}

type PickerEntityType =
  | { id: EntityImportType; label: string; importAvailable: true }
  | { id: 'notebook' | 'assembly' | 'table'; label: string; importAvailable: false };

const ENTITY_TYPES: readonly PickerEntityType[] = [
  {
    id: 'notebook',
    label: 'Notebook Entry',
    importAvailable: false,
  },
  {
    id: 'assembly',
    label: 'Assembly',
    importAvailable: false,
  },
  { id: 'table', label: 'Table', importAvailable: false },
  {
    id: 'dna-sequences',
    label: 'DNA sequences',
    importAvailable: true,
  },
  {
    id: 'dna-oligos',
    label: 'DNA oligos',
    importAvailable: true,
  },
  {
    id: 'rna-oligos',
    label: 'RNA oligos',
    importAvailable: true,
  },
  {
    id: 'strains',
    label: 'Strains',
    importAvailable: true,
  },
  {
    id: 'proteins',
    label: 'Proteins',
    importAvailable: true,
  },
  {
    id: 'registry-types',
    label: 'More Registry types…',
    importAvailable: true,
  },
];

const TOP_MENU_WIDTH = 276;
const ACTION_MENU_WIDTH = 216;
const CASCADE_BORDER_OVERLAP = 1;
const CASCADE_WIDTH = TOP_MENU_WIDTH + ACTION_MENU_WIDTH - CASCADE_BORDER_OVERLAP;
const VIEWPORT_MARGIN = 10;
const MENU_ROW_HEIGHT = 32;
const TOP_MENU_HEADER_HEIGHT = 40;
const SUBMENU_HEADER_HEIGHT = 36;
const MENU_LIST_PADDING = 4;

const MENU_CLASS = 'border border-border bg-bg-subtle';
const MENU_ITEM_CLASS =
  'flex h-8 w-full items-center gap-2 whitespace-nowrap px-3 text-left text-sm text-fg outline-none hover:bg-bg-muted focus:bg-bg-muted focus:outline-none disabled:cursor-default disabled:text-fg-muted disabled:opacity-55';
const ACTIVE_MENU_ITEM_CLASS = 'bg-bg-muted';
const MENU_ICON_CLASS = 'flex h-5 w-5 flex-none items-center justify-center text-fg-muted';

function computePlacement(
  anchorRef: RefObject<HTMLButtonElement | null> | undefined,
  anchorPoint: { x: number; y: number } | null | undefined,
  launchSource: ExplorerAddPickerLaunchSource,
  menuHeight: number
): PickerPlacement | null {
  const anchor = anchorRef?.current?.getBoundingClientRect();
  if (!anchor && !anchorPoint) return null;

  const desiredLeft = anchorPoint?.x ?? anchor?.left ?? VIEWPORT_MARGIN;
  const contextHeaderOffset =
    launchSource === 'context-menu' ? TOP_MENU_HEADER_HEIGHT + MENU_LIST_PADDING : 0;
  const desiredTop = anchorPoint
    ? anchorPoint.y - contextHeaderOffset
    : (anchor?.bottom ?? VIEWPORT_MARGIN) + 4;
  return {
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(desiredLeft, window.innerWidth - CASCADE_WIDTH - VIEWPORT_MARGIN)
    ),
    top: Math.max(
      VIEWPORT_MARGIN,
      Math.min(desiredTop, window.innerHeight - menuHeight - VIEWPORT_MARGIN)
    ),
  };
}

function MenuChevron() {
  return (
    <ChevronRightIcon aria-hidden="true" className="ml-auto h-3 w-3 flex-none text-fg-muted" />
  );
}

export function ExplorerAddPicker({
  open,
  anchorRef,
  anchorPoint,
  launchSource,
  destinationLabel,
  destinationPath,
  hasWorkspace,
  onRequestClose,
  onCommitAction,
  onCreateEntity,
  onCreateAssembly,
  canCreateEntity,
  onImportEntity,
  onImportProject,
  onImportProjectWithAgent,
  onMigrateFromBenchling,
}: ExplorerAddPickerProps) {
  const presentationOverlay = usePresentationOverlay('keyboard');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const pickerRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PickerPlacement | null>(null);
  const [selectedTypeId, setSelectedTypeId] = useState<PickerEntityType['id'] | null>(null);
  const typeMenuAim = useMenuAim();
  const entityTypes = ENTITY_TYPES.filter(
    (entityType) =>
      (entityType.id !== 'table' || (isElectron() && launchSource === 'context-menu')) &&
      ((entityType.id !== 'dna-oligos' && entityType.id !== 'rna-oligos') ||
        isHostedCapabilityShown('primers'))
  );
  const projectActions =
    launchSource === 'registry'
      ? [
          { label: 'Import a project', action: onImportProject, icon: FolderOpenIcon },
          { label: 'Import with agent', action: onImportProjectWithAgent, icon: ChatTabIcon },
          {
            label: 'Migrate from Benchling',
            action: onMigrateFromBenchling,
            icon: OpenExternalIcon,
          },
        ].flatMap(({ action, ...item }) => (action ? [{ ...item, action }] : []))
      : [];
  const menuHeight =
    2 +
    TOP_MENU_HEADER_HEIGHT +
    MENU_LIST_PADDING * 2 +
    entityTypes.length * MENU_ROW_HEIGHT +
    (projectActions.length ? 9 + 28 + projectActions.length * MENU_ROW_HEIGHT : 0);
  const selectedType = entityTypes.find((entityType) => entityType.id === selectedTypeId) ?? null;
  const selectedTypeIndex = selectedType
    ? entityTypes.findIndex((entityType) => entityType.id === selectedType.id)
    : -1;
  const actionMenuTop =
    TOP_MENU_HEADER_HEIGHT +
    MENU_LIST_PADDING +
    selectedTypeIndex * MENU_ROW_HEIGHT -
    (SUBMENU_HEADER_HEIGHT + MENU_LIST_PADDING);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const place = () =>
      setPlacement(computePlacement(anchorRef, anchorPoint, launchSource, menuHeight));
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorPoint, anchorRef, launchSource, menuHeight, open]);

  useEffect(() => {
    if (!open) {
      setSelectedTypeId(null);
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef?.current?.contains(target) || pickerRef.current?.contains(target)) return;
      onRequestClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onRequestClose();
    };
    document.addEventListener('mousedown', handlePointerDown);
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      presentationEvents.remove(document, 'keydown', handleKeyDown);
    };
  }, [anchorRef, onRequestClose, open, presentationEvents]);

  if (!open || !placement) return null;

  const openTypeActions = (entityType: PickerEntityType) => {
    setSelectedTypeId(entityType.id);
  };
  const commitAction = () => {
    onRequestClose();
    onCommitAction?.();
  };
  const runExistingAction = (action: () => void) => {
    commitAction();
    action();
  };
  const runEntityImport = () => {
    if (!selectedType?.importAvailable || !onImportEntity) return;
    commitAction();
    onImportEntity({
      entityType: selectedType.id,
      destination: destinationPath
        ? { kind: 'explicit', path: destinationPath }
        : { kind: 'choose' },
    });
  };
  const selectedCanCreate = selectedType
    ? (canCreateEntity?.(selectedType.id) ?? Boolean(onCreateEntity))
    : false;
  const runEntityCreate = () => {
    if (!selectedType || !onCreateEntity || !selectedCanCreate) return;
    commitAction();
    onCreateEntity({
      entityType: selectedType.id,
      destinationPath: destinationPath ?? null,
    });
  };
  const runAssemblyCreate = (mode: ExplorerAssemblyCreateRequest['mode']) => {
    if (!onCreateAssembly) return;
    commitAction();
    onCreateAssembly({ mode, destinationPath: destinationPath ?? null });
  };
  const entityTypeIcon = (entityType: PickerEntityType) =>
    entityType.id === 'table' ? (
      <SpreadsheetFileIcon className="h-4 w-4" />
    ) : entityType.id === 'assembly' ? (
      <AssemblyTabIcon className="h-4 w-4" />
    ) : (
      (iconForEntityKind(entityType.id, 'h-4 w-4') ?? <GenericFileIcon className="h-4 w-4" />)
    );

  return createPortal(
    <div
      ref={presentationOverlay.bindRef(pickerRef, '0')}
      role="dialog"
      aria-label={`Add to ${destinationLabel ?? 'project'}`}
      data-testid="explorer-add-picker"
      data-placement="native-cascade"
      data-launch-source={launchSource}
      data-destination-path={destinationPath ?? undefined}
      data-file-context-linked-cascade={launchSource === 'context-menu' ? 'true' : undefined}
      onPointerLeave={() => {
        typeMenuAim.cancelPendingActivation();
        setSelectedTypeId(null);
      }}
      className="fixed z-[10050] flex items-start gap-0 drop-shadow-lg"
      style={{ left: placement.left, top: placement.top }}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="menu"
          aria-label={
            launchSource === 'context-menu'
              ? `Add to folder ${destinationLabel ?? 'project'}/`
              : `Add to ${destinationLabel ?? 'project'}`
          }
          className={`${MENU_CLASS} overflow-hidden rounded-md`}
          style={{ ...{ width: TOP_MENU_WIDTH } }}
        >
          <div className="flex h-10 items-center gap-2 border-b border-border px-3">
            {launchSource === 'context-menu' ? (
              <>
                <FolderOpenIcon className="h-4 w-4 flex-none text-fg-muted" />
                <div className="min-w-0 leading-tight">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-fg-muted">
                    Add to folder
                  </div>
                  <div
                    data-testid="explorer-add-picker-destination"
                    className="truncate font-mono text-sm font-semibold text-fg"
                  >
                    {(destinationLabel ?? 'project').replace(/\/+$/, '')}/
                  </div>
                </div>
              </>
            ) : (
              <div className="truncate text-sm font-semibold text-fg">
                Add to {destinationLabel ?? 'project'}
              </div>
            )}
          </div>

          <div className="py-1">
            {entityTypes.map((entityType) => {
              const selected = selectedTypeId === entityType.id;
              return (
                <button
                  key={entityType.id}
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={selected}
                  disabled={!hasWorkspace}
                  onPointerEnter={(event) => {
                    if (selected) return;
                    typeMenuAim.requestActivation({
                      pointer: event,
                      submenuElement: actionMenuRef.current,
                      activate: () => openTypeActions(entityType),
                    });
                  }}
                  onFocus={() => typeMenuAim.activateImmediately(() => openTypeActions(entityType))}
                  onClick={() => typeMenuAim.activateImmediately(() => openTypeActions(entityType))}
                  className={`${MENU_ITEM_CLASS} ${selected ? ACTIVE_MENU_ITEM_CLASS : ''}`}
                >
                  <span data-testid={`entity-icon-${entityType.id}`} className={MENU_ICON_CLASS}>
                    {entityTypeIcon(entityType)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entityType.label}</span>
                  <MenuChevron />
                </button>
              );
            })}
          </div>

          {projectActions.length > 0 && (
            <div
              onPointerEnter={(event) => {
                if (!selectedType) return;
                typeMenuAim.requestActivation({
                  pointer: event,
                  submenuElement: actionMenuRef.current,
                  activate: () => setSelectedTypeId(null),
                });
              }}
            >
              <div role="separator" className="my-1 h-px bg-border" />
              <div className="flex h-7 items-center px-3 text-sm font-semibold text-fg">
                Project-scale actions
              </div>
              {projectActions.map(({ label, action, icon: Icon }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  onClick={() => runExistingAction(action)}
                  className={MENU_ITEM_CLASS}
                >
                  <span className={MENU_ICON_CLASS}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </PresentationScopeContext.Provider>

      {selectedType && (
        <PresentationScopeContext.Provider value={presentationOverlay.scope}>
          <div
            ref={presentationOverlay.bindRef(actionMenuRef, '1')}
            role="menu"
            aria-label={`${selectedType.label} actions`}
            onPointerEnter={typeMenuAim.cancelPendingActivation}
            className={`${MENU_CLASS} -ml-px overflow-hidden rounded-none`}
            style={{ width: ACTION_MENU_WIDTH, marginTop: actionMenuTop }}
          >
            <div className="flex h-9 items-center gap-2 border-b border-border px-3 text-sm font-semibold text-fg">
              <span className={MENU_ICON_CLASS}>{entityTypeIcon(selectedType)}</span>
              <span className="truncate">{selectedType.label}</span>
            </div>
            <div className="py-1">
              {selectedType.id === 'assembly' && onCreateAssembly ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!onCreateAssembly}
                    onClick={() => runAssemblyCreate('blank')}
                    className={MENU_ITEM_CLASS}
                  >
                    <span className={MENU_ICON_CLASS}>
                      <PlusIcon className="h-4 w-4" />
                    </span>
                    <span>Blank assembly</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!onCreateAssembly}
                    onClick={() => runAssemblyCreate('schema')}
                    className={MENU_ITEM_CLASS}
                  >
                    <span className={MENU_ICON_CLASS}>
                      <AssemblyTabIcon className="h-4 w-4" />
                    </span>
                    <span>From schema…</span>
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!selectedCanCreate}
                    onClick={runEntityCreate}
                    className={MENU_ITEM_CLASS}
                  >
                    <span className={MENU_ICON_CLASS}>
                      <PlusIcon className="h-4 w-4" />
                    </span>
                    <span>Create</span>
                  </button>
                  {selectedType.importAvailable ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!onImportEntity}
                      onClick={runEntityImport}
                      className={MENU_ITEM_CLASS}
                    >
                      <span className={MENU_ICON_CLASS}>
                        <ImportIcon className="h-4 w-4" />
                      </span>
                      <span>Import</span>
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </PresentationScopeContext.Provider>
      )}
    </div>,
    document.body
  );
}
