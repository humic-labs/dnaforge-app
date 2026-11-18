import type { RefObject } from 'react';
import type {
  EntityImportRequest,
  EntityImportType,
} from '../features/import-wizard/entity-import-intent';
import { ActionMenu, type ActionMenuEntry } from './ActionMenu';
import {
  ChatTabIcon,
  FolderOpenIcon,
  ImportIcon,
  OpenExternalIcon,
  PlusIcon,
  iconForEntityKind,
} from './icons';
import { isHostedCapabilityShown } from '../hosted/capabilities';
import { isElectron } from '../utils/environment';

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

export type ExplorerAddEntriesOptions = Omit<
  ExplorerAddPickerProps,
  'open' | 'anchorRef' | 'anchorPoint' | 'onRequestClose' | 'destinationLabel'
>;

function entityTypeIcon(entityType: PickerEntityType) {
  return iconForEntityKind(entityType.id, 'h-4 w-4') ?? iconForEntityKind('generic', 'h-4 w-4');
}

export function ExplorerAddHeader({
  launchSource,
  destinationLabel,
}: Pick<ExplorerAddPickerProps, 'launchSource' | 'destinationLabel'>) {
  return (
    <div className="flex min-h-10 items-center gap-2 border-b border-border px-3 py-2">
      {launchSource === 'context-menu' ? (
        <>
          <FolderOpenIcon className="h-4 w-4 flex-none" colorFamily="neutral" />
          <div className="min-w-0 leading-tight">
            <div className="font-medium uppercase tracking-wide text-fg-muted">Add to folder</div>
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
  );
}

export function buildExplorerAddEntries({
  launchSource,
  destinationPath,
  hasWorkspace,
  onCommitAction,
  onCreateEntity,
  onCreateAssembly,
  canCreateEntity,
  onImportEntity,
  onImportProject,
  onImportProjectWithAgent,
  onMigrateFromBenchling,
}: ExplorerAddEntriesOptions): ActionMenuEntry[] {
  const commit = (action: () => void) => () => {
    onCommitAction?.();
    action();
  };
  const entityTypes = ENTITY_TYPES.filter(
    (entityType) =>
      (entityType.id !== 'table' || (isElectron() && launchSource === 'context-menu')) &&
      ((entityType.id !== 'dna-oligos' && entityType.id !== 'rna-oligos') ||
        isHostedCapabilityShown('primers'))
  );
  const entries: ActionMenuEntry[] = entityTypes.map((entityType) => {
    const canCreate = canCreateEntity?.(entityType.id) ?? Boolean(onCreateEntity);
    const children: ActionMenuEntry[] =
      entityType.id === 'assembly' && onCreateAssembly
        ? [
            {
              id: 'blank',
              label: 'Blank assembly',
              icon: <PlusIcon className="h-4 w-4" />,
              onSelect: commit(() =>
                onCreateAssembly({ mode: 'blank', destinationPath: destinationPath ?? null })
              ),
            },
            {
              id: 'schema',
              label: 'From schema…',
              icon: iconForEntityKind('assembly', 'h-4 w-4'),
              onSelect: commit(() =>
                onCreateAssembly({ mode: 'schema', destinationPath: destinationPath ?? null })
              ),
            },
          ]
        : [
            {
              id: 'create',
              label: 'Create',
              icon: <PlusIcon className="h-4 w-4" />,
              disabled: !canCreate || !onCreateEntity,
              onSelect: commit(() =>
                onCreateEntity?.({
                  entityType: entityType.id,
                  destinationPath: destinationPath ?? null,
                })
              ),
            },
            ...(entityType.importAvailable
              ? [
                  {
                    id: 'import',
                    label: 'Import',
                    icon: <ImportIcon className="h-4 w-4" />,
                    disabled: !onImportEntity,
                    onSelect: commit(() =>
                      onImportEntity?.({
                        entityType: entityType.id,
                        destination: destinationPath
                          ? { kind: 'explicit', path: destinationPath }
                          : { kind: 'choose' },
                      })
                    ),
                  },
                ]
              : []),
          ];
    return {
      id: entityType.id,
      label: entityType.label,
      disabled: !hasWorkspace,
      icon: <span data-testid={`entity-icon-${entityType.id}`}>{entityTypeIcon(entityType)}</span>,
      submenuLabel: `${entityType.label} actions`,
      submenuHeader: (
        <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold">
          {entityTypeIcon(entityType)}
          <span className="truncate">{entityType.label}</span>
        </div>
      ),
      children,
    };
  });
  if (launchSource === 'registry') {
    const projectActions: ActionMenuEntry[] = [];
    if (onImportProject)
      projectActions.push({
        id: 'import-project',
        label: 'Import a project',
        icon: <FolderOpenIcon className="h-4 w-4" />,
        onSelect: commit(onImportProject),
      });
    if (onImportProjectWithAgent)
      projectActions.push({
        id: 'import-project-agent',
        label: 'Import with agent',
        icon: <ChatTabIcon className="h-4 w-4" />,
        onSelect: commit(onImportProjectWithAgent),
      });
    if (onMigrateFromBenchling)
      projectActions.push({
        id: 'migrate-benchling',
        label: 'Migrate from Benchling',
        icon: <OpenExternalIcon className="h-4 w-4" />,
        onSelect: commit(onMigrateFromBenchling),
      });
    if (projectActions.length)
      entries.push(
        { id: 'project-actions', separator: true, label: 'Project-scale actions' },
        ...projectActions
      );
  }
  return entries;
}

export function ExplorerAddPicker({
  open,
  anchorRef,
  anchorPoint,
  launchSource,
  destinationLabel,
  onRequestClose,
  ...actions
}: ExplorerAddPickerProps) {
  return (
    <ActionMenu
      open={open}
      label={
        launchSource === 'context-menu'
          ? `Add to folder ${destinationLabel ?? 'project'}/`
          : `Add to ${destinationLabel ?? 'project'}`
      }
      entries={buildExplorerAddEntries({ ...actions, launchSource })}
      anchorRef={anchorRef}
      anchorPoint={anchorPoint ?? undefined}
      onClose={onRequestClose}
      header={<ExplorerAddHeader launchSource={launchSource} destinationLabel={destinationLabel} />}
      testId="explorer-add-picker"
      dataAttributes={{
        'data-launch-source': launchSource,
        'data-destination-path': actions.destinationPath ?? undefined,
      }}
    />
  );
}
