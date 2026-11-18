import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, DragEvent, ReactNode } from 'react';
import { CheckIcon, CopyIcon, OpenExternalIcon, SpinnerIcon } from '../../components/icons/glyphs';
import { platform } from '../../platform';
import type {
  BenchlingMigrationLinkedItemRecoveryLocationKind,
  BenchlingMigrationRunView,
} from '../../shared/benchling-migration-ipc';
import type {
  LinkedItemRecoveryProgress,
  ValidationLinkedItemRecoveryEvidence,
} from '../../shared/benchling-migration';
import { BenchlingExportTutorial } from './BenchlingExportTutorial';

type AddExports = (sourcePaths?: string[]) => Promise<unknown> | void;
type OpenLocation = (
  kind: BenchlingMigrationLinkedItemRecoveryLocationKind,
  sourceId: string
) => Promise<unknown> | void;

const ACTIVE_STATES = new Set([
  'copying',
  'parsing',
  'awaiting_conflict_resolution',
  'reconciling',
  'validating',
]);
const COPY_CONFIRM_RESET_MS = 1500;

export type LinkedItemRecoveryAutomationAdapter = Readonly<{
  kind: 'linked_item_export_automation';
  Panel: ComponentType<{ runId: string }>;
}>;

export function LinkedItemRecoveryPanel({
  run,
  evidence,
  pending,
  onAddExports,
  onOpenLocation,
  automation,
}: {
  run: BenchlingMigrationRunView;
  evidence: ValidationLinkedItemRecoveryEvidence;
  pending: boolean;
  onAddExports: AddExports;
  onOpenLocation: OpenLocation;
  automation?: LinkedItemRecoveryAutomationAdapter;
}) {
  const [dragActive, setDragActive] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [copiedFolderId, setCopiedFolderId] = useState<string | null>(null);
  const [copyErrorFolderId, setCopyErrorFolderId] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progress = run.linkedItemRecovery ?? null;
  const active = progress !== null && ACTIVE_STATES.has(progress.state);
  const failed = progress?.state === 'failed';
  const lastAttempt = evidence.attempts[evidence.attempts.length - 1];
  const lastAttemptRejectedEveryFile =
    lastAttempt !== undefined &&
    lastAttempt.selectedFileCount > 0 &&
    lastAttempt.rejectedFileCount === lastAttempt.selectedFileCount;
  const recoveryAvailable = run.state === 'ready_to_unlock' || run.state === 'unlocked';
  const lockedForRecovery = run.state === 'ready_to_unlock';
  const canAdd = recoveryAvailable && !active && !pending;
  const complete = evidence.remainingUniqueObjectCount === 0;
  const AutomationPanel = automation?.Panel ?? null;

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    []
  );

  useEffect(() => {
    setCopiedFolderId(null);
    setCopyErrorFolderId(null);
  }, [run.id]);

  const copyFolderName = useCallback((folderId: string, folderName: string) => {
    const fail = () => {
      setCopiedFolderId(null);
      setCopyErrorFolderId(folderId);
    };
    const confirm = () => {
      setCopiedFolderId(folderId);
      setCopyErrorFolderId(null);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(
        () => setCopiedFolderId((current) => (current === folderId ? null : current)),
        COPY_CONFIRM_RESET_MS
      );
    };
    setCopyErrorFolderId(null);
    const clipboard = navigator.clipboard;
    const writeText = clipboard?.writeText;
    if (!clipboard || !writeText) {
      fail();
      return;
    }
    try {
      void writeText.call(clipboard, folderName).then(confirm, fail);
    } catch {
      fail();
    }
  }, []);

  const resetDrag = useCallback(() => {
    dragDepth.current = 0;
    setDragActive(false);
  }, []);

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }, []);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = canAdd ? 'copy' : 'none';
    },
    [canAdd]
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      resetDrag();
      setDropError(null);
      if (!canAdd) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        setDropError(
          userMessage('failure.that-drop-did-not-contain-an-export-use-the-button-below-instead')
        );
        return;
      }
      const sourcePaths = files.map((file) => platform().workspace.getPathForFile(file));
      if (sourcePaths.some((sourcePath) => !sourcePath)) {
        setDropError(
          userMessage('failure.could-not-read-one-file-s-location-use-the-button-below-instead')
        );
        return;
      }
      void Promise.resolve(onAddExports([...new Set(sourcePaths)])).catch((cause: unknown) => {
        setDropError(toUserMessage(cause, 'failure.could-not-add-those-linked-item-exports'));
      });
    },
    [canAdd, onAddExports, resetDrag]
  );

  return (
    <section
      data-testid="benchling-migration-linked-item-recovery"
      className={`overflow-hidden rounded-xl border bg-bg ${
        complete ? 'border-success/35' : 'border-border'
      }`}
    >
      {complete ? (
        <div className="flex items-start gap-3 bg-success/[0.045] px-4 py-4 sm:px-5">
          <span
            className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-success/10 text-success"
            aria-hidden="true"
          >
            <CheckIcon size={14} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-fg">
              {evidence.uniqueTargetCount === 1
                ? 'The linked item was added'
                : `All ${evidence.uniqueTargetCount} linked items were added`}
            </h3>
            <p className="mt-1 text-xs text-fg-muted">
              {evidence.repairedRelationshipCount} native relationship
              {evidence.repairedRelationshipCount === 1 ? ' was' : 's were'} added.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4 px-4 py-4 sm:px-5">
          <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
            <h3 className="col-start-1 row-start-1 text-sm font-semibold text-fg">
              Import linked items
            </h3>
          </div>

          {AutomationPanel ? <AutomationPanel runId={run.id} /> : null}

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div>
                <h4 className="text-xs font-semibold text-fg">Prepare one HTML export</h4>
                <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
                  Keep this export open while DNAForge guides you through the folders to include.
                </p>
              </div>
              <BenchlingExportTutorial layout="header" />
            </div>
            <ol className="divide-y divide-border border-y border-border text-[11px] leading-relaxed text-fg-muted">
              <Instruction number={1} title="Open Data Export">
                Click your profile icon in the bottom-left, then choose <strong>Data Export</strong>
                .
              </Instruction>
              <Instruction number={2} title="Choose All Items and HTML" required>
                Remain on <strong>All Items</strong> and select <strong>HTML</strong>.
              </Instruction>
            </ol>
            <div>
              <h4 className="text-xs font-semibold text-fg">
                Add these folders to your Benchling export
              </h4>
              <div className="mt-1 space-y-1 text-[11px] leading-relaxed text-fg-muted">
                <p>
                  Use <strong>Add locations</strong> in Benchling to search for each folder below.
                </p>
                <p>
                  If several folders have the same name, use <strong>Find correct folder</strong> in
                  DNAForge to open the right one and check its parent.
                </p>
              </div>
            </div>
            <div data-testid="benchling-migration-recovery-folder-list">
              <div className="border-t border-border">
                {evidence.folders.map((folder, index) => (
                  <RecoveryFolderCard
                    key={folder.sourceId}
                    index={index + 1}
                    folderCount={evidence.folderCount}
                    folder={folder}
                    searchName={folder.name}
                    copied={copiedFolderId === folder.sourceId}
                    copyFailed={copyErrorFolderId === folder.sourceId}
                    onCopyName={copyFolderName}
                    onOpenLocation={onOpenLocation}
                  />
                ))}
              </div>
            </div>
            <ol className="border-y border-border text-[11px] leading-relaxed text-fg-muted">
              <Instruction number={3} title="Click the Export button">
                In Benchling, click <strong>Export</strong>.
              </Instruction>
            </ol>
          </div>
          <div className="space-y-3">
            <ol className="border-y border-border text-[11px] leading-relaxed text-fg-muted">
              <Instruction number={4} title="Add the HTML export">
                When Benchling finishes, add the downloaded ZIP or its unzipped folder here.
              </Instruction>
            </ol>
            {recoveryAvailable ? (
              <div
                data-testid="benchling-migration-linked-export-dropzone"
                data-drag-active={dragActive ? 'true' : 'false'}
                onDragEnter={onDragEnter}
                onDragLeave={onDragLeave}
                onDragOver={onDragOver}
                onDrop={onDrop}
                className={`flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors ${
                  dragActive && canAdd
                    ? 'border-accent bg-accent/5'
                    : 'border-border bg-bg-subtle/40'
                }`}
              >
                {active || pending ? (
                  <>
                    <span className="flex items-center gap-2 text-xs font-medium text-fg">
                      <SpinnerIcon className="h-3.5 w-3.5" />{' '}
                      {linkedItemRecoveryProgressLabel(progress, run.localBundleMode)}
                    </span>
                    {progress ? (
                      <LinkedItemRecoveryMeasuredProgress
                        progress={progress}
                        localBundleMode={run.localBundleMode}
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="text-xs font-medium text-fg">Drop your Benchling export here</p>
                    <button
                      type="button"
                      data-testid="benchling-migration-choose-linked-exports"
                      disabled={!canAdd}
                      onClick={() => void onAddExports()}
                      className="mt-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Choose files or folders…
                    </button>
                  </>
                )}
              </div>
            ) : null}

            {failed ? (
              <p
                role="alert"
                className="rounded border border-error/40 bg-error/5 px-3 py-2 text-xs text-error"
              >
                {progress?.errorMessage != null
                  ? toUserMessage(
                      progress?.errorMessage,
                      'failure.dnaforge-could-not-finish-reading-those-exports'
                    )
                  : userMessage('failure.dnaforge-could-not-finish-reading-those-exports')}{' '}
                Choose the exports again, or add a corrected ZIP or folder.
              </p>
            ) : null}
            {!active && !failed && lastAttempt?.outcome === 'failed' ? (
              <p className="rounded border border-warning/40 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-fg-muted">
                {lastAttemptRejectedEveryFile ? (
                  <>
                    DNAForge could not read that export. Choose it again. If it fails again,
                    download a new copy from Benchling.
                  </>
                ) : (
                  <>
                    DNAForge imported the supported entities in that ZIP, but none matched the
                    linked items that are still missing. You can add another export or open the
                    notebook with the remaining placeholders. Before you try again, confirm that the
                    export included the folders listed above.
                  </>
                )}
              </p>
            ) : null}
            {dropError ? (
              <p
                role="alert"
                data-testid="benchling-migration-linked-export-drop-error"
                className="text-xs text-error"
              >
                {toUserMessage(dropError, 'operation.failed')}
              </p>
            ) : null}
            {lockedForRecovery && (active || failed) ? (
              <p className="text-[11px] leading-relaxed text-fg-subtle">
                Finish or retry this ZIP batch before opening the notebook.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function RecoveryFolderCard({
  index,
  folderCount,
  folder,
  searchName,
  copied,
  copyFailed,
  onCopyName,
  onOpenLocation,
}: {
  index: number;
  folderCount: number;
  folder: ValidationLinkedItemRecoveryEvidence['folders'][number];
  searchName: string;
  copied: boolean;
  copyFailed: boolean;
  onCopyName: (folderId: string, folderName: string) => void;
  onOpenLocation: OpenLocation;
}) {
  return (
    <article className="border-b border-border py-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2">
        <div className="min-w-0">
          <span className="sr-only">
            Folder {index} of {folderCount}
          </span>
          <h4 className="break-words text-xs font-semibold text-fg" title={searchName}>
            {searchName}
          </h4>
        </div>
        <span className="text-[10px] text-fg-muted">
          {folder.targetCount} linked item{folder.targetCount === 1 ? '' : 's'}
        </span>
        <div className="col-span-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onCopyName(folder.sourceId, searchName)}
            className="inline-flex items-center gap-1.5 rounded border border-accent/35 bg-accent/[0.05] px-2.5 py-1.5 text-[11px] font-medium text-accent hover:bg-accent/10"
            aria-label={`Copy folder name: ${searchName}`}
          >
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            {copied ? 'Copied' : copyFailed ? 'Copy failed' : 'Copy name'}
          </button>
          <button
            type="button"
            onClick={() => void onOpenLocation('folder', folder.sourceId)}
            className="inline-flex items-center gap-1.5 rounded border border-border bg-bg px-2.5 py-1.5 text-[11px] font-medium text-fg-muted wp-interactive hover:text-accent"
          >
            Find correct folder <OpenExternalIcon size={12} />
          </button>
        </div>
        {copyFailed ? (
          <p role="status" className="col-span-2 text-[10px] text-error">
            Could not copy. Select the folder name above and copy it manually.
          </p>
        ) : null}
      </div>
    </article>
  );
}

function Instruction({
  number,
  title,
  children,
  required = false,
}: {
  number: number;
  title: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-3">
      <span
        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
          required ? 'bg-warning/10 text-warning' : 'bg-accent/10 text-accent'
        }`}
      >
        {number}
      </span>
      <div>
        <div className="text-xs font-semibold text-fg">{title}</div>
        <p className={`mt-0.5 ${required ? 'font-medium text-warning' : ''}`}>{children}</p>
      </div>
    </li>
  );
}

export function linkedItemRecoveryProgressLabel(
  progress: LinkedItemRecoveryProgress | null,
  localBundleMode?: BenchlingMigrationRunView['localBundleMode']
): string {
  if (localBundleMode === 'external_zip' && progress?.state === 'copying')
    return 'Verifying ZIP files (Step 1 of 7)';
  if (progress?.work?.kind === 'copy_bytes') return 'Copying Benchling export (Step 1 of 7)';
  if (progress?.work?.kind === 'read_and_classify_objects')
    return 'Reading and classifying objects (Step 2 of 7)';
  if (progress?.work?.kind === 'write_objects')
    return progress.state === 'parsing'
      ? 'Preparing source objects (Step 2 of 7)'
      : 'Converting and writing native objects (Step 4 of 7)';
  if (progress?.work?.kind === 'resolve_links') return 'Resolving links (Step 3 of 7)';
  if (progress?.work?.kind === 'validate_saved_objects')
    return 'Checking saved objects (Step 5 of 7)';
  if (progress?.work?.kind === 'validate_objects') return 'Checking every object (Step 5 of 7)';
  if (progress?.work?.kind === 'persist_source_files') return 'Saving source files (Step 6 of 7)';
  if (progress?.work?.kind === 'validate_source_files')
    return 'Checking saved source files (Step 6 of 7)';
  if (progress?.work?.kind === 'finalize_workspace') return 'Finishing project (Step 7 of 7)';
  switch (progress?.state) {
    case 'copying':
      return 'Copying ZIP files (Step 1 of 7)';
    case 'parsing':
      return 'Reading linked items (Step 2 of 7)';
    case 'awaiting_conflict_resolution':
      return 'Waiting for your version choice';
    case 'reconciling':
      return 'Repairing notebook links (Step 3 of 7)';
    case 'validating':
      return 'Checking recovered items (Step 5 of 7)';
    default:
      return 'Processing ZIP files (Step 1 of 7)';
  }
}

export function LinkedItemRecoveryMeasuredProgress({
  progress,
  localBundleMode,
}: {
  progress: LinkedItemRecoveryProgress;
  localBundleMode?: BenchlingMigrationRunView['localBundleMode'];
}) {
  const detail = measuredProgressDetail(progress);
  const percentage = measuredPercentage(progress);
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-1.5">
      {percentage !== null ? (
        <div
          role="progressbar"
          aria-label={linkedItemRecoveryProgressLabel(progress, localBundleMode)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          className="h-1.5 w-full overflow-hidden rounded-full bg-border"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${percentage}%` }}
          />
        </div>
      ) : null}
      {detail ? <span className="text-[11px] text-fg-subtle">{detail}</span> : null}
    </div>
  );
}

function measuredPercentage(progress: LinkedItemRecoveryProgress): number | null {
  const work = progress.work;
  if (!work || !Number.isFinite(work.total) || work.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((work.completed / work.total) * 100)));
}

function measuredProgressDetail(progress: LinkedItemRecoveryProgress): string | null {
  const work = progress.work;
  if (work?.kind === 'copy_bytes') {
    return `${formatBytes(work.completed)} of ${formatBytes(work.total)} copied`;
  }
  if (work?.kind === 'read_and_classify_objects') {
    return `${formatCount(work.completed)} of ${formatCount(work.total)} objects read`;
  }
  if (work?.kind === 'write_objects') {
    if (progress.state === 'parsing')
      return `${formatCount(work.completed)} of ${formatCount(work.total)} source objects prepared`;
    return `${formatCount(work.completed)} of ${formatCount(work.total)} native objects written`;
  }
  if (work?.kind === 'resolve_links') {
    return `${formatCount(work.completed)} of ${formatCount(work.total)} links resolved`;
  }
  if (work?.kind === 'validate_saved_objects') {
    return `${formatCount(work.completed)} of ${formatCount(work.total)} saved objects checked`;
  }
  if (work?.kind === 'validate_objects') {
    return `${formatCount(work.completed)} of ${formatCount(work.total)} objects checked`;
  }
  if (work?.kind === 'persist_source_files') {
    return `${formatCount(work.completed)} of ${formatCount(work.total)} source files saved`;
  }
  if (work?.kind === 'validate_source_files') {
    return `${formatCount(work.completed)} of ${formatCount(work.total)} saved source files checked`;
  }
  if (work?.kind === 'finalize_workspace') return 'Saving the validated project';
  return progress.selectedFileCount > 1
    ? `${progress.processedFileCount} of ${progress.selectedFileCount} ZIP files read`
    : null;
}

function formatBytes(bytes: number): string {
  const bounded = Math.max(0, bytes);
  if (bounded >= 1_000_000_000) return `${formatDecimal(bounded / 1_000_000_000)} GB`;
  if (bounded >= 1_000_000) return `${formatDecimal(bounded / 1_000_000)} MB`;
  if (bounded >= 1_000) return `${formatDecimal(bounded / 1_000)} KB`;
  return `${Math.floor(bounded)} B`;
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.max(0, value));
}
