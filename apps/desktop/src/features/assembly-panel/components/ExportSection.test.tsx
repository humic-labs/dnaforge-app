import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import { useDesignStore } from '../../design/store';
import { useDesignRecoveryStore } from '../../design/public/design-recovery';
import type { SequenceDesign } from '../../design/types';
import { useSequenceStore } from '../../sequence/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  planCatalogMemoryFileBinding,
  type CatalogFileBindingRequest,
  type CatalogFileBindingRow,
} from '../../../shared/catalog-binding';
import { BUILTIN_PLASMID_SCHEMA_SNAPSHOT } from '../../../shared/sequence-entity-schema';
import type { CatalogEntityRegistrationRequest } from '../../../shared/catalog-registration';
import type {
  CatalogEntityLinkInput,
  CatalogEntityPresentationInput,
  CatalogEventInput,
} from '../../../shared/catalog-associations';
import type { SequenceIndexRequest } from '../../../shared/sequence-index-command';
import type { LimsEntity, LimsRegisterEntityInput } from '../../../shared/lims';
import { clearMockData, MockDatabaseModule, seedMockData } from '../../../test/platform-mocks';
import { ExportSection } from './ExportSection';
import { platform } from '../../../platform';
import * as primerArtifacts from '../../assembly/public/primer-artifacts';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as string[],
  renames: [] as Array<[string, string]>,
  saveResult: null as string | null,
  saveCalls: [] as Array<{
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }>,
  saveOverride: null as null | (() => Promise<string | null>),
  lastInsertRowid: 1,
  onWriteTextFile: null as null | ((path: string, content: string) => void | Promise<void>),
  catalogFiles: [] as Array<Record<string, unknown>>,
  registryEntities: new Map<string, LimsEntity>(),
  sequenceRows: new Map<string, { id: number; file_id: number }>(),
}));

const operationMocks = vi.hoisted(() => ({
  beginToolOperation: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));
const workflowTelemetryMocks = vi.hoisted(() => ({
  beginWorkflowAction: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));
const confirmationMocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
}));
const finalizationPreviewMocks = vi.hoisted(() => ({
  prepareOverride: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
const productIntegrityMocks = vi.hoisted(() => ({
  ReplaceProductConfirmationRequired: class ReplaceProductConfirmationRequired extends Error {
    constructor(_details: Record<string, string>) {
      super('Replacing this accepted product requires confirmation.');
      this.name = 'ReplaceProductConfirmationRequired';
    }
  },
}));

const primerProjectionMocks = vi.hoisted(() => ({
  commitResult: 'not-git' as 'committed' | 'not-git' | 'failed',
  commitPrimerBatchHistory: vi.fn(),
}));

vi.mock('../../../lib/analytics-operation', () => ({
  beginToolOperation: operationMocks.beginToolOperation,
}));

vi.mock('../../../lib/workflow-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/workflow-telemetry')>()),
  beginWorkflowAction: workflowTelemetryMocks.beginWorkflowAction,
}));

vi.mock('../../../components/confirm-dialog-store', () => ({
  confirmDialog: confirmationMocks.confirmDialog,
}));

vi.mock('../../assembly/accepted-product-integrity', () => ({
  ReplaceProductConfirmationRequired: productIntegrityMocks.ReplaceProductConfirmationRequired,
}));

vi.mock('../../assembly/accepted-finalization-preview', async (importOriginal) => {
  const original = (await importOriginal()) as {
    prepareFinalizationCandidate: (...args: unknown[]) => Promise<unknown>;
    [key: string]: unknown;
  };
  return {
    ...original,
    prepareFinalizationCandidate: (
      ...args: Parameters<typeof original.prepareFinalizationCandidate>
    ) =>
      finalizationPreviewMocks.prepareOverride
        ? finalizationPreviewMocks.prepareOverride(...args)
        : original.prepareFinalizationCandidate(...args),
  };
});

const saveLocationPickerMocks = vi.hoisted(() => ({
  newFolder: vi.fn(),
}));

vi.mock('./AssemblySaveLocationPicker', () => ({
  AssemblySaveLocationPicker: forwardRef(function MockAssemblySaveLocationPicker(
    {
      roots,
      onSelectFolder,
      selectedDir,
    }: {
      roots: Array<{ path: string; name: string }>;
      onSelectFolder: (path: string) => void;
      selectedDir: string;
    },
    ref: React.Ref<{ newFolder(dir: string): void }>
  ) {
    useImperativeHandle(ref, () => ({ newFolder: saveLocationPickerMocks.newFolder }));
    return (
      <div data-testid="assembly-save-location-picker" data-selected-dir={selectedDir}>
        {roots.map((root) => (
          <button
            key={root.path}
            type="button"
            data-testid={`assembly-picker-folder-${root.path}`}
            onClick={() => onSelectFolder(root.path)}
          >
            {root.name}
          </button>
        ))}
      </div>
    );
  }),
}));

vi.mock('../../primers/primer-artifact-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../primers/primer-artifact-service')>()),
  currentDirtyLimsPaths: vi.fn(async () => new Set<string>()),
  commitPrimerBatchHistory: primerProjectionMocks.commitPrimerBatchHistory,
}));

vi.mock('../../lims/assembly-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lims/assembly-bridge')>()),
  recordAcceptedAssemblyPrimers: vi.fn(async () => ({
    recorded: [],
    skipped: [],
    failed: [],
  })),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    scientificObjects: { catalog: async () => ({ head: null, entries: [] }) },
    db: {
      registerCatalogEntity: vi.fn(async (input: CatalogEntityRegistrationRequest) => {
        const db = await MockDatabaseModule.load('assembly-export');
        return db.registerCatalogEntity(input);
      }),
      recordCatalogEvent: vi.fn(async (input: CatalogEventInput) => {
        const db = await MockDatabaseModule.load('assembly-export');
        return db.recordCatalogEvent(input);
      }),
      updateCatalogEntityPresentation: vi.fn(async (input: CatalogEntityPresentationInput) => {
        const db = await MockDatabaseModule.load('assembly-export');
        return db.updateCatalogEntityPresentation(input);
      }),
      linkCatalogEntities: vi.fn(async (input: CatalogEntityLinkInput) => {
        const db = await MockDatabaseModule.load('assembly-export');
        return db.linkCatalogEntities(input);
      }),
      ensureSequenceIndex: vi.fn(async (input: SequenceIndexRequest) => {
        const db = await MockDatabaseModule.load('assembly-export');
        const id = await db.ensureSequenceIndex(input);
        fsState.sequenceRows.set(input.documentId, { id, file_id: id });
        return id;
      }),
      settleEntityProjectionSource: vi.fn(async () => undefined),
      bindCatalogEntityFile: vi.fn(async (input: CatalogFileBindingRequest) => {
        const result = planCatalogMemoryFileBinding(
          input,
          1,
          fsState.catalogFiles as unknown as CatalogFileBindingRow[],
          Date.now(),
          () => crypto.randomUUID()
        );
        fsState.catalogFiles = result.files;
        return result.binding;
      }),
      select: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM sequences WHERE document_id')) {
          const documentId = String(params[0] ?? '');
          const row = fsState.sequenceRows.get(documentId);
          return row ? [row] : [];
        }
        if (sql.includes('FROM workspaces')) return [{ id: 1 }];
        if (sql.includes('FROM catalog_entity_events')) {
          return [
            {
              id: String(params[0] ?? 'event-1'),
              entity_id: 'construct-stub',
              event_type: 'assembly_finalized',
              actor: 'local-user',
              summary: 'finalized',
              payload: null,
              created_at: 1,
            },
          ];
        }
        if (sql.includes('FROM catalog_entity_files') && sql.includes('WHERE path')) {
          const path = String(params[0] ?? '');
          return [
            {
              id: 'catalog-file-1',
              entity_id: 'construct-stub',
              workspace_id: 1,
              path,
              relative_path: path.replace('/workspace/project/', ''),
              file_kind: 'waypoint-plasmid',
              content_hash: null,
              object_uuid: 'object-1',
              size_bytes: null,
              modified_at: null,
              status: 'current',
              last_seen_at: 1,
              missing_since: null,
              created_at: 1,
              updated_at: 1,
            },
          ];
        }
        if (sql.includes('FROM catalog_entity_files'))
          return sql.includes('entity_id = ?')
            ? fsState.catalogFiles.filter((file) => file.entity_id === params[0])
            : fsState.catalogFiles;
        if (sql.includes('FROM catalog_entities')) {
          const db = await MockDatabaseModule.load('assembly-export');
          return db.select(sql, params);
        }
        return [];
      }),
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        const lastInsertRowid = fsState.lastInsertRowid++;
        if (sql.includes('INSERT INTO sequences')) {
          fsState.sequenceRows.set(String(params[1] ?? ''), {
            id: lastInsertRowid,
            file_id: Number(params[0]),
          });
        }
        return { changes: 1, lastInsertRowid };
      }),
    },
    lims: {
      listSchemas: vi.fn(async () => [
        {
          ...BUILTIN_PLASMID_SCHEMA_SNAPSHOT,
          currentRevisionId: BUILTIN_PLASMID_SCHEMA_SNAPSHOT.schemaRevisionId,
          entityKind: BUILTIN_PLASMID_SCHEMA_SNAPSHOT.name,
        },
      ]),
      queryEntities: vi.fn(async (input: { id?: string; includeArchived?: boolean } = {}) =>
        [...fsState.registryEntities.values()].filter(
          (entity) =>
            (!input.id || entity.id === input.id) && (input.includeArchived || !entity.tombstone)
        )
      ),
      registerEntity: vi.fn(async (input: LimsRegisterEntityInput) => {
        const entity: LimsEntity = {
          id: input.id ?? 'lims-entity-1',
          kind: input.kind,
          schemaId: null,
          schemaRevisionId: 'schema-revision-1',
          registryId: null,
          name: input.name,
          fields: input.fields,
          registrationStatus: input.registrationStatus ?? 'registered',
          domainStatus: input.domainStatus ?? null,
          workspaceId: input.workspaceId ?? null,
          actor: input.actor ?? null,
          eventSeq: 1,
          tombstone: false,
          createdAt: 1234,
          updatedAt: 1234,
          archivedAt: null,
        };
        fsState.registryEntities.set(entity.id, entity);
        return entity;
      }),
    },
    fs: {
      readDir: vi.fn(async () => []),
      validateWorkspacePath: vi.fn(
        async ({ workspaceRoot, path }: { workspaceRoot: string; path: string }) =>
          path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)
      ),
      readTextFile: vi.fn(async (path: string) => {
        const content = fsState.files.get(path);
        if (content === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return content;
      }),
      exists: vi.fn(async (path: string) => fsState.files.has(path)),
      mkdir: vi.fn(async () => {}),
      stat: vi.fn(async (path: string) => {
        const content = fsState.files.get(path);
        if (content === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return {
          size: content.length,
          isFile: true,
          isDirectory: false,
          mtime: 1234,
        };
      }),
      writeTextFile: vi.fn(async (path: string, content: string) => {
        await fsState.onWriteTextFile?.(path, content);
        fsState.writes.push(path);
        fsState.files.set(path, content);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        fsState.renames.push([from, to]);
        if (fsState.files.has(from)) {
          const content = fsState.files.get(from) ?? '';
          fsState.files.delete(from);
          fsState.files.set(to, content);
          return;
        }
        const prefix = `${from}/`;
        for (const [path, content] of [...fsState.files.entries()]) {
          if (!path.startsWith(prefix)) continue;
          fsState.files.delete(path);
          fsState.files.set(`${to}/${path.slice(prefix.length)}`, content);
        }
      }),
    },
    dialog: {
      save: vi.fn(async (options) => {
        fsState.saveCalls.push(options);
        if (fsState.saveOverride) return fsState.saveOverride();
        return fsState.saveResult;
      }),
    },
  }),
}));

describe('ExportSection accepted assembly finalization', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    localStorage.clear();
    useDesignRecoveryStore.setState({ records: {} });
    fsState.files.clear();
    fsState.writes = [];
    fsState.renames = [];
    fsState.saveResult = null;
    fsState.saveCalls = [];
    fsState.saveOverride = null;
    fsState.sequenceRows.clear();
    fsState.lastInsertRowid = 1;
    fsState.onWriteTextFile = null;
    fsState.catalogFiles = [];
    fsState.registryEntities.clear();
    clearMockData();
    seedMockData('workspaces', [{ id: 1, path: '/workspace/project', repo_uuid: null }]);
    vi.clearAllMocks();
    confirmationMocks.confirmDialog.mockResolvedValue(true);
    finalizationPreviewMocks.prepareOverride = null;
    primerProjectionMocks.commitResult = 'not-git';
    primerProjectionMocks.commitPrimerBatchHistory.mockImplementation(
      async () => primerProjectionMocks.commitResult
    );
    operationMocks.beginToolOperation.mockReturnValue({
      operationId: '550e8400-e29b-41d4-a716-446655440030',
      consumed: false,
      complete: operationMocks.complete,
      fail: operationMocks.fail,
      cancel: operationMocks.cancel,
    });
    workflowTelemetryMocks.beginWorkflowAction.mockReturnValue({
      actionId: 'primer-csv-export-action',
      consumed: false,
      complete: workflowTelemetryMocks.complete,
      fail: workflowTelemetryMocks.fail,
      cancel: workflowTelemetryMocks.cancel,
    });
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
    useSequenceStore.setState({
      sequences: {},
      loadingDocumentIds: new Set(),
      scrollPositions: {},
      sequenceVersions: {},
      dirtyPaths: {},
    });
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace/project', name: 'Project', addedAt: 1 }],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [], activeTabId: null },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
  });

  it('qualifies a primer CSV export only after the selected file is written', async () => {
    const design = createDesign();
    fsState.saveResult = '/exports/primers.csv';

    render(<ExportSection design={design} primers={design.designPrimers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(fsState.files.has('/exports/primers.csv')).toBe(true));
    expect(workflowTelemetryMocks.beginWorkflowAction).toHaveBeenCalledWith({
      workflow: 'file',
      action: 'export',
      exportFormat: 'csv',
    });
    expect(workflowTelemetryMocks.complete).toHaveBeenCalledWith({ status: 'saved' });
    expect(workflowTelemetryMocks.fail).not.toHaveBeenCalled();
  });

  it('does not qualify a cancelled primer CSV save picker', async () => {
    const design = createDesign();

    render(<ExportSection design={design} primers={design.designPrimers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(fsState.saveCalls).toHaveLength(1));
    expect(workflowTelemetryMocks.beginWorkflowAction).toHaveBeenCalledOnce();
    expect(workflowTelemetryMocks.cancel).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(workflowTelemetryMocks.complete).not.toHaveBeenCalled();
    expect(workflowTelemetryMocks.fail).not.toHaveBeenCalled();
    expect(fsState.writes).toEqual([]);
  });

  it.each(['dialog', 'write'] as const)(
    'joins %s failure to a browser request without claiming a saved CSV',
    async (failure) => {
      const create = vi.fn(() => 'blob:synthetic-export');
      const revoke = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      if (failure === 'dialog')
        fsState.saveOverride = async () => {
          throw new Error('PRIVATE_DIALOG_FAILURE');
        };
      else {
        fsState.saveResult = '/exports/primers.csv';
        fsState.onWriteTextFile = () => {
          throw new Error('PRIVATE_WRITE_FAILURE');
        };
      }
      const design = createDesign();
      render(<ExportSection design={design} primers={design.designPrimers} />);
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(workflowTelemetryMocks.beginWorkflowAction).toHaveBeenCalledOnce();
      expect(workflowTelemetryMocks.fail).not.toHaveBeenCalled();
      expect(workflowTelemetryMocks.complete).toHaveBeenCalledWith({
        status: 'needs_action',
        outcomeKind:
          failure === 'dialog'
            ? 'export_browser_requested_after_dialog_failure'
            : 'export_browser_requested_after_write_failure',
        valueDelivered: false,
        usableResult: false,
      });
      expect(fsState.files.has('/exports/primers.csv')).toBe(false);
      expect(revoke).toHaveBeenCalledWith('blob:synthetic-export');
      expect(JSON.stringify(workflowTelemetryMocks.complete.mock.calls)).not.toContain('PRIVATE_');
    }
  );

  it('captures CSV serialization failure inside the handler without opening a picker', async () => {
    const serialize = vi
      .spyOn(primerArtifacts, 'serializePrimerRowsCsv')
      .mockImplementationOnce(() => {
        throw new Error('PRIVATE_SERIALIZER_FAILURE');
      });
    const design = createDesign();
    render(<ExportSection design={design} primers={design.designPrimers} />);
    expect(serialize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not prepare the CSV file');
    expect(workflowTelemetryMocks.beginWorkflowAction).toHaveBeenCalledOnce();
    expect(workflowTelemetryMocks.fail).toHaveBeenCalledWith('serialize_failed');
    expect(fsState.saveCalls).toEqual([]);
    expect(fsState.writes).toEqual([]);
    expect(workflowTelemetryMocks.complete).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'write'] as const)(
    'keeps %s fallback failure recoverable with one terminal per retry',
    async (failure) => {
      const create = vi
        .fn(() => 'blob:retry-export')
        .mockImplementationOnce(() => {
          throw new Error('PRIVATE_BROWSER_FAILURE');
        });
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      if (failure === 'dialog')
        fsState.saveOverride = async () => {
          throw new Error('PRIVATE_DIALOG_FAILURE');
        };
      else {
        fsState.saveResult = '/exports/primers.csv';
        fsState.onWriteTextFile = () => {
          throw new Error('PRIVATE_WRITE_FAILURE');
        };
      }
      const design = createDesign();
      render(<ExportSection design={design} primers={design.designPrimers} />);
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not download the CSV file');
      expect(workflowTelemetryMocks.fail).toHaveBeenCalledTimes(1);
      expect(workflowTelemetryMocks.fail).toHaveBeenCalledWith('unknown', {
        outcomeKind:
          failure === 'dialog'
            ? 'export_browser_failed_after_dialog_failure'
            : 'export_browser_failed_after_write_failure',
      });
      expect(workflowTelemetryMocks.complete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(workflowTelemetryMocks.beginWorkflowAction).toHaveBeenCalledTimes(2);
      expect(workflowTelemetryMocks.fail).toHaveBeenCalledTimes(1);
      expect(workflowTelemetryMocks.complete).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent('Download requested');
      expect(fsState.files.has('/exports/primers.csv')).toBe(false);
    }
  );

  it('waits for the native write acknowledgement and reads back exact intended CSV bytes', async () => {
    const design = createDesign();
    const expected = primerArtifacts.serializePrimerRowsCsv(
      primerArtifacts.buildPrimerArtifactRows(design.designPrimers, design.pcrPolymerase)
    );
    let acknowledge!: () => void;
    fsState.saveResult = '/exports/captured.csv';
    fsState.onWriteTextFile = () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
    render(<ExportSection design={design} primers={design.designPrimers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    expect(workflowTelemetryMocks.complete).not.toHaveBeenCalled();
    expect(fsState.files.has('/exports/captured.csv')).toBe(false);
    await act(async () => acknowledge());
    await waitFor(() =>
      expect(workflowTelemetryMocks.complete).toHaveBeenCalledWith({ status: 'saved' })
    );
    expect(await platform().fs.readTextFile('/exports/captured.csv')).toBe(expected);
    expect(fsState.writes).toEqual(['/exports/captured.csv']);
  });

  it('keeps the captured CSV name and bytes when source data changes during the picker', async () => {
    const design = createDesign();
    const expectedName = `${design.name}_primers.csv`;
    const expectedContent = primerArtifacts.serializePrimerRowsCsv(
      primerArtifacts.buildPrimerArtifactRows(design.designPrimers, design.pcrPolymerase)
    );
    let rejectPicker!: (error: Error) => void;
    fsState.saveOverride = () =>
      new Promise<string | null>((_resolve, reject) => {
        rejectPicker = reject;
      });
    const create = vi.fn((_blob: Blob) => 'blob:captured-export');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      names.push(this.download);
    });
    render(<ExportSection design={design} primers={design.designPrimers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    Object.assign(design, { name: 'PRIVATE_NEWER_NAME' });
    const forward = design.designPrimers?.[0]?.forward;
    if (!forward) throw new Error('Expected the synthetic forward primer');
    Object.assign(forward, { sequence: 'CCCCCCCCCCCC' });
    rejectPicker(new Error('PRIVATE_DIALOG_FAILURE'));
    await waitFor(() => expect(names).toEqual([expectedName]));
    const blob = create.mock.calls[0][0];
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toBe(expectedContent);
    expect(text).not.toContain('CCCCCCCCCCCC');
  });

  it('cleans up a failed browser click and preserves a retryable request without a saved claim', async () => {
    const create = vi.fn(() => 'blob:failed-click');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('PRIVATE_CLICK_FAILURE');
    });
    fsState.saveOverride = async () => {
      throw new Error('PRIVATE_DIALOG_FAILURE');
    };
    const design = createDesign();
    render(<ExportSection design={design} primers={design.designPrimers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try Export CSV again');
    expect(workflowTelemetryMocks.fail).toHaveBeenCalledWith('unknown', {
      outcomeKind: 'export_browser_failed_after_dialog_failure',
    });
    expect(workflowTelemetryMocks.complete).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:failed-click');
    expect(fsState.writes).toEqual([]);
  });

  it('does not run browser fallback or rewrite a saved file when optional completion observation throws', async () => {
    const design = createDesign();
    fsState.saveResult = '/exports/saved.csv';
    workflowTelemetryMocks.complete.mockImplementationOnce(() => {
      throw new Error('PRIVATE_OBSERVER_FAILURE');
    });
    const create = vi.fn(() => 'blob:unexpected');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    render(<ExportSection design={design} primers={design.designPrimers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(workflowTelemetryMocks.complete).toHaveBeenCalledOnce());
    expect(fsState.files.has('/exports/saved.csv')).toBe(true);
    expect(fsState.writes).toEqual(['/exports/saved.csv']);
    expect(create).not.toHaveBeenCalled();
    expect(workflowTelemetryMocks.fail).not.toHaveBeenCalled();
  });

  it('keeps focus and table Copy outside file export and waits for clipboard acknowledgement', async () => {
    const design = createDesign();
    let acknowledge!: () => void;
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: write },
    });
    render(<ExportSection design={design} primers={design.designPrimers} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Export CSV' }));
    fireEvent.wheel(screen.getByRole('button', { name: 'Export CSV' }), { deltaY: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    expect(write).toHaveBeenCalledWith(
      primerArtifacts.serializePrimerRowsTsv(
        primerArtifacts.buildPrimerArtifactRows(design.designPrimers, design.pcrPolymerase)
      )
    );
    expect(screen.queryByText('Copied!')).toBeNull();
    expect(workflowTelemetryMocks.beginWorkflowAction).not.toHaveBeenCalled();
    expect(fsState.saveCalls).toEqual([]);
    expect(fsState.writes).toEqual([]);
    await act(async () => acknowledge());
    expect(screen.getByText('Copied!')).toBeVisible();
    expect(workflowTelemetryMocks.beginWorkflowAction).not.toHaveBeenCalled();
  });

  it('finalizes from the visible drawer control with a path-like design name into safe files, design state, sequence cache, and converts the open design tab', async () => {
    const design = { ...createDesign(), name: 'Accepted/design \\ draft' };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });
    const designTabId = useCanvasStore.getState().openTab('main', {
      type: 'design',
      entityId: design.id,
      label: design.name,
    });
    useSequenceStore.getState().setSequence('source-left', {
      id: 'source-left',
      name: 'Source left',
      sequence: 'TTTTATGCATGCGGGG',
      length: 16,
      annotations: [],
      circular: true,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));

    await waitFor(() => expect(screen.getByTestId('accepted-assembly-success')).toBeVisible());

    const pkgRoot = '/workspace/project/assemblies/Accepted-design-draft-accepted';
    const expectedProduct = `${pkgRoot}/Accepted-design-draft-accepted.gb`;
    const expectedSidecar = `${pkgRoot}/.forge/plasmid.json`;
    const nextDesign = useDesignStore.getState().designs[design.id];
    const versionId = nextDesign.acceptedAssemblyVersions?.[0].id;
    expect(versionId).toEqual(expect.any(String));
    const expectedPrimerCsv = `${pkgRoot}/contents/Accepted-design-draft-accepted.${versionId}.primers.csv`;
    const expectedPrimerFasta = `${pkgRoot}/contents/Accepted-design-draft-accepted.${versionId}.primers.fasta`;
    const constructId = nextDesign.constructId;
    if (!constructId) throw new Error('Finalized design did not retain its construct identity.');
    const sequence = useSequenceStore.getState().sequences[constructId];
    const canvasTabs = Object.values(useCanvasStore.getState().panels).flatMap(
      (panel) => panel.tabs
    );

    expect(fsState.files.has(expectedProduct)).toBe(true);
    expect(fsState.files.has(expectedSidecar)).toBe(true);
    expect(fsState.files.has(expectedPrimerCsv)).toBe(true);
    expect(fsState.files.has(expectedPrimerFasta)).toBe(true);
    expect(fsState.files.get(expectedPrimerCsv)).toContain('"left forward","AAAATGC"');
    expect(fsState.files.get(expectedPrimerFasta)).toContain('>left forward');
    expect(nextDesign.assemblyState).toBe('assembled');
    expect(nextDesign.acceptedAssemblyVersions).toHaveLength(1);
    expect(nextDesign.acceptedAssemblyVersions?.[0].artifacts).toMatchObject({
      productGenBankPath: expectedProduct,
      sidecarJsonPath: expectedSidecar,
      primerCsvPath: expectedPrimerCsv,
      primerFastaPath: expectedPrimerFasta,
    });
    expect(sequence?.sequence).toBe('ATGCGCTA');
    expect(sequence?.circular).toBe(true);
    expect(useWorkspaceStore.getState().selectedPath).toBe(expectedProduct);
    const productTab = canvasTabs.find((tab) => tab.entityId === constructId);
    expect(canvasTabs).toHaveLength(1);
    expect(productTab?.id).toBe(designTabId);
    expect(productTab).toMatchObject({
      type: 'sequence',
      entityId: constructId,
      label: design.name,
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: constructId,
        packageRoot: pkgRoot,
      },
    });
    expect(productTab?.label).not.toBe('Accepted-design-draft-accepted.gb');
    expect(useCanvasStore.getState().findTab('design', design.id)).toBeNull();
    expect(
      Object.values(useCanvasStore.getState().panels).some(
        (panel) => panel.activeTabId === productTab?.id
      )
    ).toBe(true);
    expect(operationMocks.beginToolOperation).toHaveBeenCalledWith({
      toolId: 'assembly',
      surface: 'tab',
      action: 'exported',
    });
    expect(operationMocks.complete).toHaveBeenCalledOnce();
    expect(operationMocks.fail).not.toHaveBeenCalled();
    expect(JSON.parse(fsState.files.get(expectedSidecar) ?? '{}')).toMatchObject({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      assembly: {
        accepted: {
          type: 'accepted_assembly',
          designId: design.id,
          construction: { method: 'gibson' },
          artifacts: {
            primerCsvPath: expectedPrimerCsv.slice(`${pkgRoot}/`.length),
            primerFastaPath: expectedPrimerFasta.slice(`${pkgRoot}/`.length),
          },
        },
      },
    });
  });

  it('lets the user choose a custom finalized product path and writes the paired sidecar next to it', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    expect(screen.getByTestId('assembly-save-location-picker')).toBeVisible();
    expect(screen.queryByTestId('choose-accepted-assembly-save-path')).toBeNull();

    fireEvent.click(screen.getByTestId('assembly-picker-folder-/workspace/project'));

    await waitFor(() =>
      expect(screen.getByTestId('reset-accepted-assembly-save-path')).toBeVisible()
    );
    expect(fsState.saveCalls).toEqual([]);

    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));

    await waitFor(() => expect(screen.getByTestId('accepted-assembly-success')).toBeVisible());

    expect(
      fsState.files.has('/workspace/project/Accepted-design-accepted/Accepted-design-accepted.gb')
    ).toBe(true);
    expect(
      fsState.files.has('/workspace/project/Accepted-design-accepted/.forge/plasmid.json')
    ).toBe(true);
    expect(useWorkspaceStore.getState().selectedPath).toBe(
      '/workspace/project/Accepted-design-accepted/Accepted-design-accepted.gb'
    );
  });

  it('shows and locks the existing legacy package destination instead of a duplicate path', async () => {
    const design = createDesign();
    const packageRoot = '/workspace/project/puc19-araC-accepted';
    const productPath = `${packageRoot}/puc19-araC-accepted.gb`;
    fsState.catalogFiles = [
      {
        id: 'catalog-file-legacy',
        entity_id: design.id,
        workspace_id: 1,
        path: packageRoot,
        relative_path: 'puc19-araC-accepted',
        file_kind: 'waypoint-plasmid',
        content_hash: null,
        object_uuid: 'legacy-object',
        size_bytes: null,
        modified_at: null,
        status: 'current',
        last_seen_at: 1,
        missing_since: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    fsState.files.set(productPath, 'LOCUS       puc19-araC-accepted  8 bp    DNA\n//\n');
    fsState.files.set(
      `${packageRoot}/.forge/plasmid.json`,
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: '55f6f120-fbf5-4773-9b6b-31ab94aacacd',
        name: 'puc19-araC',
        product: { file: 'puc19-araC-accepted.gb' },
        assembly: { accepted: { designId: design.id } },
      })
    );
    useDesignStore.setState({ designs: { [design.id]: design }, activeDesignId: design.id });

    render(<ExportSection design={design} primers={[]} />);

    expect(screen.getByText('Checking for an existing sequence package...')).toBeVisible();
    expect(screen.queryByTestId('assembly-save-location-picker')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('accepted-assembly-existing-package')).toHaveTextContent(
        'Updates the existing accepted sequence package.'
      )
    );
    expect(screen.queryByTestId('assembly-save-location-picker')).toBeNull();
    expect(screen.queryByTestId('assembly-save-location-new-folder')).toBeNull();
    expect(screen.queryByTestId('reset-accepted-assembly-save-path')).toBeNull();
  });

  it('does not write anything when a newly selected DNAForge destination is abandoned', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const view = render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();
    fireEvent.click(screen.getByTestId('assembly-picker-folder-/workspace/project'));
    await waitFor(() =>
      expect(screen.getByTestId('reset-accepted-assembly-save-path')).toBeVisible()
    );

    view.unmount();

    expect(fsState.writes).toEqual([]);
    expect(fsState.renames).toEqual([]);
  });

  it('rejects a file-backed draft target in another workspace before writing a package', async () => {
    const design = createDesign();
    fsState.files.set(
      '/workspace/project/Accepted design.wpdesign.json',
      JSON.stringify({
        schema: 'waypoint.design.v1',
        kind: 'assembly-design',
        id: design.id,
        name: design.name,
        design,
      })
    );
    fsState.catalogFiles = [
      {
        id: 'draft-file',
        entity_id: design.id,
        workspace_id: 1,
        path: '/workspace/project/Accepted design.wpdesign.json',
        relative_path: 'Accepted design.wpdesign.json',
        file_kind: 'waypoint-design',
        content_hash: null,
        object_uuid: null,
        size_bytes: 100,
        modified_at: 1,
        status: 'current',
        last_seen_at: 1,
        missing_since: null,
        created_at: 1,
        updated_at: 1,
      },
    ];
    useWorkspaceStore.setState({
      folders: [
        { path: '/workspace/project', name: 'Project', addedAt: 1 },
        { path: '/workspace/other', name: 'Other', addedAt: 2 },
      ],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();
    fireEvent.click(screen.getByTestId('assembly-picker-folder-/workspace/other'));
    await waitFor(() =>
      expect(screen.getByTestId('reset-accepted-assembly-save-path')).toBeVisible()
    );
    expect(fsState.saveCalls).toEqual([]);
    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));

    await waitFor(() => expect(screen.getByTestId('accepted-assembly-error')).toBeVisible());
    expect(screen.getByTestId('accepted-assembly-error')).toHaveTextContent(
      userMessage('assembly.outsideProject')
    );
    expect(fsState.writes).toEqual([]);
    expect(
      [...fsState.files.keys()].some((path) =>
        path.startsWith('/workspace/other/Accepted-design-accepted')
      )
    ).toBe(false);
  });

  it('refuses edits while artifact files are written and records the accepted assembly version', async () => {
    const design = createDesign();
    let attemptedDuringWrite = false;
    fsState.onWriteTextFile = () => {
      if (attemptedDuringWrite) return;
      attemptedDuringWrite = true;
      expect(() =>
        useDesignStore.setState((state) => ({
          designs: {
            ...state.designs,
            [design.id]: {
              ...state.designs[design.id],
              name: 'Accepted design edited during finalize',
              version: state.designs[design.id].version + 1,
            },
          },
        }))
      ).toThrow(/being finalized/);
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));

    await waitFor(() => expect(screen.getByTestId('accepted-assembly-success')).toBeVisible());

    const pkgRoot2 = '/workspace/project/assemblies/Accepted-design-accepted';
    const expectedProduct = `${pkgRoot2}/Accepted-design-accepted.gb`;
    const nextDesign = useDesignStore.getState().designs[design.id];
    expect(attemptedDuringWrite).toBe(true);
    expect(fsState.files.has(expectedProduct)).toBe(true);
    expect(nextDesign.name).toBe(design.name);
    expect(nextDesign.acceptedAssemblyVersions).toHaveLength(1);
    expect(nextDesign.acceptedAssemblyVersions?.[0]).toMatchObject({
      lifecycleState: 'written',
      artifacts: {
        productGenBankPath: expectedProduct,
        primerCsvPath: `${pkgRoot2}/contents/Accepted-design-accepted.${nextDesign.acceptedAssemblyVersions?.[0].id}.primers.csv`,
        primerFastaPath: `${pkgRoot2}/contents/Accepted-design-accepted.${nextDesign.acceptedAssemblyVersions?.[0].id}.primers.fasta`,
      },
    });
  });

  it('records a failed accepted assembly write without promoting the draft to assembled', async () => {
    const design = createDesign();
    fsState.onWriteTextFile = (path) => {
      if (path.endsWith('.primers.csv')) {
        throw Object.assign(new Error('simulated primer write failure'), { code: 'ENOSPC' });
      }
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));

    await waitFor(() => expect(screen.getByTestId('accepted-assembly-error')).toBeVisible());

    const nextDesign = useDesignStore.getState().designs[design.id];
    expect(screen.getByTestId('accepted-assembly-error')).toHaveTextContent(
      userMessage('assembly.failed')
    );
    expect(nextDesign.assemblyState).toBe('ready');
    expect(nextDesign.status).toBe('computed');
    expect(nextDesign.activeAcceptedAssemblyVersionId).toBeNull();
    expect(nextDesign.acceptedAssemblyVersions).toHaveLength(1);
    expect(nextDesign.acceptedAssemblyVersions?.[0].lifecycleState).toBe('write_failed');
    expect(useDesignRecoveryStore.getState().records[design.id]).toMatchObject({
      pending: true,
      durable: true,
      design: { id: design.id, name: nextDesign.name },
    });
    expect(operationMocks.fail).toHaveBeenCalledOnce();
    expect(operationMocks.fail).toHaveBeenCalledWith(
      'filesystem',
      undefined,
      undefined,
      undefined,
      'filesystem_error'
    );
    expect(operationMocks.complete).not.toHaveBeenCalled();
  });

  it('cancels export telemetry when the user declines product replacement', async () => {
    const design = createDesign();
    finalizationPreviewMocks.prepareOverride = async () => {
      throw new productIntegrityMocks.ReplaceProductConfirmationRequired({
        constructId: 'construct-existing',
        expectedGenBankChecksum: 'expected',
        actualGenBankChecksum: 'changed',
      });
    };
    confirmationMocks.confirmDialog.mockResolvedValue(false);
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();
    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));

    await waitFor(() => expect(operationMocks.cancel).toHaveBeenCalledOnce());
    expect(operationMocks.complete).not.toHaveBeenCalled();
    expect(operationMocks.fail).not.toHaveBeenCalled();
    expect(confirmationMocks.confirmDialog).toHaveBeenCalledOnce();
  });

  it('keeps the written plasmid when git history cannot be recorded', async () => {
    const design = createDesign();
    primerProjectionMocks.commitResult = 'failed';
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();
    fireEvent.click(screen.getByTestId('finalize-accepted-assembly'));

    await waitFor(() => expect(screen.getByTestId('accepted-assembly-success')).toBeVisible());

    expect(operationMocks.complete).toHaveBeenCalledOnce();
    expect(operationMocks.fail).not.toHaveBeenCalled();
    expect(useDesignStore.getState().designs[design.id].assemblyState).toBe('assembled');
  });

  it('keeps the embedded picker and default target inside a mounted DNAForge workspace', async () => {
    const design = createDesign();
    useWorkspaceStore.setState({
      folders: [{ path: '/mounted/folder', name: 'Mounted', addedAt: 1 }],
      activeWorkspaceFile: '/saved/workspaces/constructs.waypoint-workspace',
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    expect(screen.getByTestId('assembly-picker-folder-/mounted/folder')).toBeVisible();
    expect(screen.queryByTestId('assembly-picker-folder-/saved/workspaces')).toBeNull();
    expect(screen.queryByTestId('accepted-assembly-save-path')).not.toBeInTheDocument();
    expect(fsState.saveCalls).toEqual([]);
  });

  it('does not restack a heading or sidecar lecture under Finalize and Export', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    expect(screen.queryByText('Finalize assembly')).toBeNull();
    expect(screen.queryByText(/construction metadata sidecar/i)).toBeNull();
    expect(screen.queryByText('Save location')).toBeNull();
    expect(screen.queryByText(/Choose a folder in an open DNAForge workspace/i)).toBeNull();
    expect(screen.getByTestId('assembly-save-location-picker')).toBeVisible();
    expect(screen.getByTestId('finalize-accepted-assembly')).toBeVisible();
    expect(screen.queryByTestId('graduate-design-button')).toBeNull();
    expect(screen.queryByText('Graduate to Sequence')).toBeNull();
  });

  it('does not list generated implementation file paths in Finalize and Export', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    expect(screen.queryByTestId('accepted-assembly-save-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accepted-assembly-sidecar-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accepted-assembly-primer-csv-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accepted-assembly-primer-fasta-path')).not.toBeInTheDocument();
    expect(screen.queryByText('Metadata')).not.toBeInTheDocument();
    expect(screen.queryByText('Primers CSV')).not.toBeInTheDocument();
    expect(screen.queryByText('Primers FASTA')).not.toBeInTheDocument();
  });

  it('puts New folder on the same action row as Finalize', async () => {
    const design = createDesign();
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    const newFolder = screen.getByTestId('assembly-save-location-new-folder');
    const finalize = screen.getByTestId('finalize-accepted-assembly');
    expect(newFolder.parentElement).toBe(finalize.parentElement);
    expect(screen.queryByTestId('graduate-design-button')).toBeNull();
    expect(screen.getByTestId('assembly-save-location-picker').contains(newFolder)).toBe(false);

    fireEvent.click(newFolder);
    expect(saveLocationPickerMocks.newFolder).toHaveBeenCalledWith('/workspace/project/assemblies');
  });

  it.each(['Draft', 'Update'] as const)(
    'points to %s when the assembly is not ready',
    async (action) => {
      const design = {
        ...createDesign(),
        assemblyState: 'drafting' as const,
        designPrimers: action === 'Update' ? createDesign().designPrimers : [],
      };
      useDesignStore.setState({
        designs: { [design.id]: design },
        activeDesignId: design.id,
      });

      render(<ExportSection design={design} primers={[]} />);
      await waitForUnboundDestination();

      expect(screen.getByTestId('finalize-accepted-assembly')).toBeDisabled();
      expect(screen.getByText(`Click ${action} before finalizing.`)).toBeVisible();
      expect(operationMocks.beginToolOperation).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'defaults to the assembly owner regardless of project order (reversed: %s)',
    async (reverse) => {
      const folders = [
        { path: '/workspace/other', name: 'Other', addedAt: 1 },
        { path: '/workspace/owner', name: 'Owner', addedAt: 2 },
        { path: '/workspace/reference', name: 'Reference', addedAt: 3, pinned: true },
      ];
      useWorkspaceStore.setState({ folders: reverse ? folders.toReversed() : folders });
      render(<ExportSection design={createDesign()} primers={[]} projectRoot="/workspace/owner" />);
      await waitForUnboundDestination();
      expect(screen.getByTestId('assembly-save-location-picker')).toHaveAttribute(
        'data-selected-dir',
        '/workspace/owner/assemblies'
      );
      expect(screen.queryByTestId('assembly-picker-folder-/workspace/reference')).toBeNull();
    }
  );

  it('does not silently choose another project when the assembly owner is unavailable', async () => {
    render(
      <ExportSection design={createDesign()} primers={[]} projectRoot="/workspace/unmounted" />
    );
    await waitForUnboundDestination();
    expect(screen.getByTestId('assembly-save-location-picker')).toHaveAttribute(
      'data-selected-dir',
      ''
    );
    expect(screen.getByTestId('finalize-accepted-assembly')).toBeDisabled();
    expect(screen.getByText('Choose a project before finalizing.')).toBeVisible();
  });

  it('blocks finalization without duplicating a part-owned Golden Gate issue', async () => {
    const design: SequenceDesign = {
      ...createDesign(),
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      validationErrors: [],
      regions: [
        {
          ...createDesign().regions[0],
          id: 'bsmBI-rd',
          sourceSequenceName: 'BsmBI RD',
          sourceType: 'rd',
          ggType: 'insert',
          rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
          rdSourceEnzyme: 'BsmBI',
          rdSourceEnzymeName: 'BsmBI',
        },
        createDesign().regions[1],
      ],
    };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    expect(screen.getByTestId('finalize-accepted-assembly')).toBeDisabled();
    expect(screen.getByTestId('accepted-assembly-finalize-card')).not.toHaveTextContent(
      'Incompatible RD enzyme'
    );
    expect(screen.getByTestId('accepted-assembly-finalize-card')).not.toHaveTextContent(
      'cannot be used in a BsaI Golden Gate reaction'
    );
    expect(
      screen.getByText('Review the parts and junctions above before finalizing.')
    ).toBeVisible();
  });

  it('explains that empty schema parts must be filled before finalizing', async () => {
    const design = createDesign();
    design.regions = design.regions.map((part) => ({ ...part, sequence: '', isPlaceholder: true }));
    design.designPrimers = [];
    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();
    expect(screen.getByTestId('finalize-accepted-assembly')).toBeDisabled();
    expect(screen.getByText('Fill the empty parts before finalizing.')).toBeVisible();
  });

  it('shows Golden Gate overhang validation in the finalize card', async () => {
    const design: SequenceDesign = {
      ...createDesign(),
      assemblyMethod: 'goldengate',
      goldenGateConfig: { enzyme: 'BsaI' },
      goldenGateJunctions: [
        {
          junctionIndex: 0,
          junctionPosition: 4,
          overhangStart: 2,
          overhangEnd: 6,
          offset: 0,
          overhang: 'AATG',
          source: { type: 'pcr-designed' },
          isValid: true,
        },
        {
          junctionIndex: 1,
          junctionPosition: 8,
          overhangStart: 6,
          overhangEnd: 10,
          offset: 0,
          overhang: 'GCTA',
          source: { type: 'pcr-designed' },
          isValid: true,
        },
      ],
    };

    render(<ExportSection design={design} primers={[]} />);
    await waitForUnboundDestination();

    expect(screen.getByTestId('accepted-assembly-overhang-checks')).toHaveTextContent(
      'All overhangs unique'
    );
    expect(screen.getByTestId('accepted-assembly-overhang-checks')).toHaveTextContent(
      'No palindromes'
    );
  });
});

async function waitForUnboundDestination(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('assembly-save-location-picker')).toBeVisible());
}

function createDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'Accepted design',
    topology: 'circular',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 4,
        sourceEnd: 8,
        sequence: 'ATGC',
        annotations: [],
        sourceType: 'pcr',
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 0,
        sourceEnd: 4,
        sequence: 'GCTA',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [],
    version: 4,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [
      {
        fragmentIndex: 0,
        forward: {
          id: 'left-forward',
          name: 'left forward',
          sequence: 'AAAATGC',
          pbs: { start: 0, end: 4, sequence: 'ATGC' },
          overhang: { length: 3, sequence: 'AAA', tailLength: 3 },
          direction: 'forward',
          fragmentIndex: 0,
          junctionIndex: 1,
          tm: 12,
        },
        reverse: {
          id: 'left-reverse',
          name: 'left reverse',
          sequence: 'TTTGCAT',
          pbs: { start: 4, end: 8, sequence: 'GCAT' },
          overhang: { length: 3, sequence: 'TTT', tailLength: 3 },
          direction: 'reverse',
          fragmentIndex: 0,
          junctionIndex: 0,
          tm: 12,
        },
      },
    ],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}
