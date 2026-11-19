import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../presentation/PresentationSurface';
import {
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
  toUserMessage,
} from '@waypoint/user-messages';
import { Button, UI_MODAL_LAYER_CLASS } from './ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { platform } from '../platform';
import { findWorkspaceRootForPath } from '../db/workspace-catalog';
import { useToastStore } from '../stores/toast-store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useCanvasStore } from '../features/canvas/store';
import { ImportDestinationPicker } from '../features/import-wizard/ImportDestinationPicker';
import type { ImportDestination } from '../features/workspace-loader/resolve-import-destination';
import { useQuickLookImportStore } from '../stores/quick-look-import-store';
import { isPathInsideBoundary } from '../shared/path-boundary';
import { syncPreviewTabs, releasePresentedPreview } from '../lib/preview-tab-packages';
import { promotePreviewTab } from '../features/external-preview/promote-preview-tab';

export interface QuickLookDestinationCommit {
  readonly workspaceRoot: string;
  readonly createdNewWorkspace: boolean;
  readonly createdWorkspaceName: string | null;
  readonly revealPath: string;
}

export interface QuickLookImportHostProps {
  readonly onDestinationCommit: (commit: QuickLookDestinationCommit) => Promise<void>;
}

async function listSubfolders(path: string): Promise<{ path: string; name: string }[]> {
  const entries = await platform().fs.readDir(path);
  return entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith('.'))
    .map((entry) => ({ path: `${path}/${entry.name}`, name: entry.name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function workspaceNameFor(sourceFileName: string): string {
  const lastDot = sourceFileName.lastIndexOf('.');
  const stem = lastDot > 0 ? sourceFileName.slice(0, lastDot) : sourceFileName;
  return stem.trim() || 'Imported sequence';
}

export function QuickLookImportHost({
  onDestinationCommit,
}: QuickLookImportHostProps): JSX.Element | null {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const request = useQuickLookImportStore((state) => state.request);
  const initiatingTabId = useQuickLookImportStore((state) => state.tabId);
  const requestId = useQuickLookImportStore((state) => state.requestId);
  const promoting = useQuickLookImportStore((state) => state.phase === 'promoting');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = (): void => useQuickLookImportStore.getState().close(requestId);
  const durablePromotion = useQuickLookImportStore((state) => state.durablePromotion);
  const rememberPromotion = useQuickLookImportStore((state) => state.rememberPromotion);
  const finish = useQuickLookImportStore((state) => state.finish);
  const folders = useWorkspaceStore((state) => state.folders);
  const roots = useMemo(
    () =>
      folders
        .filter((folder) => !folder.pinned)
        .map((folder) => ({ path: folder.path, name: folder.name })),
    [folders]
  );
  const [destination, setDestination] = useState<ImportDestination>({
    kind: 'new-workspace',
  });
  const [hasChosenDestination, setHasChosenDestination] = useState(false);

  useEffect(() => {
    setDestination({ kind: 'new-workspace' });
    setHasChosenDestination(false);
  }, [requestId]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || promoting) return;
      event.preventDefault();
      close();
    };
    presentationEvents.add(document, 'keydown', onKeyDown);
    return () => presentationEvents.remove(document, 'keydown', onKeyDown);
  }, [close, promoting, request, presentationEvents]);

  if (!request) return null;

  const selectDestination = (next: ImportDestination): void => {
    if (next.kind === 'registry') return;
    setDestination(next);
    setHasChosenDestination(true);
  };

  const promote = async (): Promise<void> => {
    if (
      (!hasChosenDestination && !durablePromotion) ||
      destination.kind === 'registry' ||
      promoting
    ) {
      return;
    }
    if (!useQuickLookImportStore.getState().begin(requestId)) return;
    const current = (): boolean =>
      mounted.current &&
      useQuickLookImportStore.getState().requestId === requestId &&
      useQuickLookImportStore.getState().request === request;
    const failed = (): void => {
      if (current()) useQuickLookImportStore.getState().fail(requestId);
    };
    let durableDestPath: string | null = null;
    let receipt:
      | Awaited<ReturnType<ReturnType<typeof platform>['fileAssociations']['adoptPreview']>>
      | undefined;
    try {
      await syncPreviewTabs();
      receipt = await platform().fileAssociations.adoptPreview({ receipt: request });
      const rememberedResult =
        durablePromotion?.sourcePath === request.sourcePath &&
        durablePromotion.contentHash === request.contentHash
          ? durablePromotion.result
          : null;
      const result =
        rememberedResult ??
        (await platform().fileAssociations.savePreview({
          receipt,
          destination:
            destination.kind === 'new-workspace'
              ? { kind: 'new-workspace', name: workspaceNameFor(request.sourceFileName) }
              : { kind: 'existing-workspace', rootPath: destination.rootPath },
        }));
      if (!rememberedResult) rememberPromotion(request, result, requestId);
      if (!current()) return;
      const canvas = useCanvasStore.getState();
      const sourceTab = Object.entries(canvas.panels)
        .flatMap(([panelId, panel]) => panel.tabs.map((tab) => ({ panelId, tab })))
        .find(
          ({ tab }) =>
            (!initiatingTabId || tab.id === initiatingTabId) &&
            tab.type === 'sequence' &&
            tab.quickLookSource?.sourcePath === request.sourcePath &&
            tab.quickLookSource.contentHash === request.contentHash
        );
      if (!sourceTab?.tab.sequenceDocument) {
        throw new Error(
          'The Quick Look tab is no longer open. The imported package was preserved.'
        );
      }
      const selectedSourceRecord = request.records.find((record) =>
        sourceTab.tab.sequenceDocument?.kind === 'managed-sequence'
          ? isPathInsideBoundary(record.productPath, sourceTab.tab.sequenceDocument.packageRoot)
          : false
      );
      const selectedPromotedRecord = selectedSourceRecord
        ? result.records.find((record) => record.recordId === selectedSourceRecord.recordId)
        : result.records[0];
      const destPath = selectedPromotedRecord?.destPath ?? result.destPath;
      durableDestPath = destPath;
      const workspaceRoot = result.createdNewWorkspace
        ? result.workspaceRoot
        : (findWorkspaceRootForPath(folders, destPath) ??
          findWorkspaceRootForPath(folders, result.workspaceRoot) ??
          result.workspaceRoot);

      await onDestinationCommit({
        workspaceRoot,
        createdNewWorkspace: result.createdNewWorkspace,
        createdWorkspaceName: result.createdWorkspaceName,
        revealPath: destPath,
      });

      if (!current()) return;
      await promotePreviewTab(receipt, result, sourceTab.tab.id);
      if (!current()) return;
      finish(requestId);
      useToastStore.getState().addToast(
        request.records.length === 1
          ? userMessageWithValues('notice.imported-value-to-edit', {
              value0: userMessageValue(request.sourceFileName),
            })
          : userMessageWithValues('notice.imported-all-value-records-from-value-to-edit', {
              value0: userMessageValue(request.records.length),
              value1: userMessageValue(request.sourceFileName),
            }),
        { definition: 'quick-look-import-host-imported-all-3-records-from-example-to-edit' }
      );
    } catch (error) {
      if (!current()) return;
      failed();
      if (durableDestPath) {
        useToastStore.getState().addToast(
          userMessageWithValues('document.importedOpenFailed', {
            name: userMessageValue(userEntityLabel(request.sourceFileName)),
            path: userMessageValue(durableDestPath),
          }),
          {
            definition:
              'quick-look-import-host-imported-example-to-example-file-but-dnaforge-could-not-open-the-destinatio',
          }
        );
      } else {
        useToastStore.getState().addToast(toUserMessage(error, 'operation.failed'), {
          definition: 'quick-look-import-host-promote',
        });
      }
    } finally {
      if (receipt)
        await releasePresentedPreview(receipt).catch((error: unknown) =>
          console.error('[preview release]', error)
        );
      const state = useQuickLookImportStore.getState();
      if (!mounted.current && state.requestId === requestId && state.phase === 'promoting') {
        state.fail(requestId);
      }
    }
  };

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} flex items-center justify-center bg-black/40 p-4`}
      data-testid="quick-look-import-backdrop"
      onMouseDown={() => {
        if (!promoting) close();
      }}
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="quick-look-import-title"
          data-testid="quick-look-import-dialog"
          className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-lg border border-border bg-bg-subtle p-4 shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2 id="quick-look-import-title" className="text-base font-semibold text-fg">
            Import to Edit
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Choose where DNAForge should create{' '}
            {request.records.length === 1
              ? 'the editable package for '
              : `${request.records.length} editable sequence packages for `}
            <span className="font-medium text-fg">{request.sourceFileName}</span>.
          </p>
          {durablePromotion ? (
            <div
              className="mt-4 rounded border border-border bg-bg-muted p-3 text-sm text-fg"
              data-testid="quick-look-import-saved"
            >
              The package is saved. Retry opening its destination; DNAForge will not import or copy
              it again.
            </div>
          ) : (
            <div className="mt-4 min-h-0 flex-1">
              <ImportDestinationPicker
                roots={roots}
                selected={destination}
                onSelect={selectDestination}
                listSubfolders={listSubfolders}
                showRegistry={false}
              />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              data-testid="quick-look-import-cancel"
              disabled={promoting}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="quick-look-import-confirm"
              disabled={(!hasChosenDestination && !durablePromotion) || promoting}
              onClick={() => void promote()}
              variant="primary"
            >
              {promoting ? 'Importing…' : durablePromotion ? 'Open Destination' : 'Import'}
            </Button>
          </div>
        </div>
      </PresentationScopeContext.Provider>
    </div>
  );
}
