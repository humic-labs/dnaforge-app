import { trackRendererEvent } from '../../lib/analytics';
import { observeWorkflowAction } from '../../lib/workflow-telemetry';
import { useCanvasStore } from '../canvas/public/store';
import { useSequenceStore } from './store';
import { observeSequenceSavedReopen } from './sequence-activity';
import { cancelUnclaimedIndexedGenomeOpens } from './indexed-genome-lifecycle-telemetry';
import type {
  SafeFileSizeBucket,
  SafeFileTypeCategory,
  SafeOperationErrorClass,
  SafeSourceSurface,
} from '@waypoint/analytics-policy';

export type FileOpenSourceSurface = SafeSourceSurface;
export type FileTypeCategory = SafeFileTypeCategory;
export type FileSizeBucket = SafeFileSizeBucket;

interface PendingFileOpenInput {
  documentId?: string;
  filePath: string;
  tabId: string;
  fileTypeCategory: FileTypeCategory;
  sourceSurface: FileOpenSourceSurface;
  sizeBucket: FileSizeBucket;
  fileSizeBytes: number;
  importOperationId?: string;
  importOperationIds?: Iterable<string>;
}

interface PendingFileOpen extends Omit<
  PendingFileOpenInput,
  'importOperationId' | 'importOperationIds'
> {
  importOperationIds: Set<string>;
}

const pendingByDocument = new Map<string, PendingFileOpen>();

useCanvasStore.subscribe((state) => {
  const tabExists = (tabId: string) =>
    Object.values(state.panels).some((panel) => panel.tabs.some((tab) => tab.id === tabId));
  cancelUnclaimedIndexedGenomeOpens(tabExists);
  for (const [documentId, pending] of pendingByDocument) {
    if (!tabExists(pending.tabId)) pendingByDocument.delete(documentId);
  }
});

export function registerPendingFileOpen(input: PendingFileOpenInput): void {
  const documentId = input.documentId ?? input.filePath;
  const existing = pendingByDocument.get(documentId);
  const importOperationIds =
    input.importOperationIds instanceof Set
      ? input.importOperationIds
      : new Set(input.importOperationIds);
  if (existing?.tabId === input.tabId) {
    for (const operationId of existing.importOperationIds) importOperationIds.add(operationId);
  }
  if (input.importOperationId) importOperationIds.add(input.importOperationId);
  if (input.importOperationIds) {
    for (const operationId of input.importOperationIds) importOperationIds.add(operationId);
  }
  pendingByDocument.set(documentId, {
    documentId,
    filePath: input.filePath,
    tabId: input.tabId,
    fileTypeCategory: input.fileTypeCategory,
    sourceSurface: input.sourceSurface,
    sizeBucket: input.sizeBucket,
    fileSizeBytes: input.fileSizeBytes,
    importOperationIds,
  });
}

export function attachImportOperationToPendingFileOpen(input: {
  documentId?: string;
  filePath: string;
  importOperationId: string;
  sourceSurface: FileOpenSourceSurface;
}): void {
  const documentId = input.documentId ?? input.filePath;
  const pending = pendingByDocument.get(documentId);
  if (!pending) return;
  pending.importOperationIds.add(input.importOperationId);
  pendingByDocument.set(documentId, {
    ...pending,
    sourceSurface: input.sourceSurface,
  });
}

function commitPendingFileOpen(documentId: string): boolean {
  const pending = pendingByDocument.get(documentId);
  if (!pending) return false;
  const tabStillExists = Object.values(useCanvasStore.getState().panels).some((panel) =>
    panel.tabs.some((tab) => tab.id === pending.tabId)
  );
  if (!tabStillExists) return false;

  pendingByDocument.delete(documentId);
  safeTrackFileOpenEvent('file_opened', {
    feature_area: 'file',
    file_type_category: pending.fileTypeCategory,
    source_surface: pending.sourceSurface,
    size_bucket: pending.sizeBucket,
    file_size_bytes: pending.fileSizeBytes,
  });
  safeObserveVisibleContentOpen();
  const loaded = useSequenceStore.getState().sequences[documentId];
  if (loaded) void observeSequenceSavedReopen(documentId, pending.filePath, loaded);
  return true;
}

export function commitVisibleFileOpen(documentId: string): boolean {
  if (!useSequenceStore.getState().sequences[documentId]) return false;
  return commitPendingFileOpen(documentId);
}

function safeTrackFileOpenEvent(event: string, properties: Record<string, unknown>): void {
  try {
    trackRendererEvent(event, properties);
  } catch {
    return;
  }
}

function safeObserveVisibleContentOpen(): void {
  try {
    observeWorkflowAction({ workflow: 'content', action: 'open', status: 'viewed' });
  } catch {}
}

export function trackFileOpenFailure(input: {
  filePath: string;
  sourceSurface: FileOpenSourceSurface;
  sizeBucket: FileSizeBucket;
  errorClass: SafeOperationErrorClass;
  importOperationIds?: Iterable<string>;
}): void {
  safeTrackFileOpenEvent('file_open_failed', {
    feature_area: 'file',
    file_type_category: fileTypeCategory(input.filePath),
    source_surface: input.sourceSurface,
    size_bucket: input.sizeBucket,
    error_class: input.errorClass,
  });

  for (const importOperationId of new Set(input.importOperationIds)) {
    safeTrackFileOpenEvent('import_failed', {
      feature_area: 'import',
      source_system_type: 'file',
      failure_stage:
        input.errorClass === 'parse_failed'
          ? 'parse'
          : input.errorClass === 'validation'
            ? 'validate'
            : 'unknown',
      error_class: input.errorClass,
      operation_id: importOperationId,
    });
  }
}

export function failPendingFileOpen(documentId: string, errorClass: SafeOperationErrorClass): void {
  const pending = pendingByDocument.get(documentId);
  if (!pending) return;
  pendingByDocument.delete(documentId);

  trackFileOpenFailure({
    filePath: pending.filePath,
    sourceSurface: pending.sourceSurface,
    sizeBucket: pending.sizeBucket,
    errorClass,
    importOperationIds: pending.importOperationIds,
  });
}

export function dropPendingFileOpen(documentId: string): void {
  pendingByDocument.delete(documentId);
}

export function fileTypeCategory(filePath: string): FileTypeCategory {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['gb', 'gbk', 'gbff', 'genbank', 'dna'].includes(extension)) return 'dna';
  if (['faa', 'pep', 'protein'].includes(extension)) return 'protein';
  if (['fa', 'fasta', 'fna', 'fastq', 'fq', 'ab1'].includes(extension)) return 'sequence';
  if (['csv', 'tsv', 'xls', 'xlsx'].includes(extension)) return 'spreadsheet';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'tif', 'tiff'].includes(extension)) return 'image';
  if (['txt', 'md', 'rtf'].includes(extension)) return 'text';
  return 'unknown';
}

export function fileSizeBucket(sizeBytes: number): FileSizeBucket {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'unknown';
  if (sizeBytes === 0) return '0';
  if (sizeBytes < 10 * 1024) return '1_10kb';
  if (sizeBytes < 100 * 1024) return '10_100kb';
  if (sizeBytes < 1024 * 1024) return '100kb_1mb';
  if (sizeBytes < 10 * 1024 * 1024) return '1_10mb';
  return '10mb_plus';
}

export function __resetFileOpenTelemetryForTests(): void {
  pendingByDocument.clear();
}

export function __pendingFileOpenCountForTests(): number {
  return pendingByDocument.size;
}
