import type {
  AppendProjectMemoryEventInput,
  ProjectMemorySnapshot,
} from '../../db/project-memory-owner';
import type {
  FileDocumentClientFlush,
  FileDocumentClientFlushAck,
} from '../file-document-client-sync';
import type { LegacyFileDraft, LegacyFileDraftRetention } from '../file-document-legacy-recovery';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../file-document';
import type { TableDocumentCommand, TableDocumentCommandResult } from '../table-document-command';
import type { SequenceDocumentRequest, SequenceDocumentSnapshot } from '../sequence-document';
import type { NativeDirtyDocument } from '../native-document-drafts';
import type {
  NativeDirtySettlementRequest,
  NativeDirtySettlementResult,
} from '../native-dirty-documents';
import type { LegacySequenceDraft, LegacySequenceDraftRetention } from '../sequence-document';
import type { AdmittedTextFileReadRequest } from '../admitted-file-read';
import type { TextFileAtomicWriteInput } from '../text-file-atomic';
import type {
  SequenceDocumentHistoryInput,
  SequenceDocumentHistoryResult,
  SequenceDocumentSaveInput,
  SequenceDocumentSaveResult,
} from '../sequence-edit-lineage';
import type {
  AcceptedAssemblyRevisionPublicationRequest,
  AcceptedAssemblyRevisionPublicationResult,
  SequenceMetadataRevisionRequest,
  SequenceMetadataRevisionResult,
  SequenceRestoreApplyRequest,
  SequenceRestoreApplyResult,
  SequenceRestorePreviewRequest,
  SequenceRestorePreviewResult,
  SequenceUserAttachmentMutationRequest,
  SequenceUserAttachmentMutationResult,
} from '../sequence-package-revision';
import type {
  ActivateSequenceEvidenceRunRequest,
  AppendSequenceEvidenceStateRequest,
  AppendSequenceEvidenceStateResult,
  CompleteSequenceEvidenceRunRequest,
  CompleteSequenceEvidenceRunResult,
  FailSequenceEvidenceRunRequest,
  PrepareSequenceEvidenceRunRequest,
  PrepareSequenceEvidenceRunResult,
} from '../sequence-package-evidence';
import type { WorkspacePathValidationInput } from '../workspace-file-atomic';
import type { FilesystemStat } from '../filesystem-stat';
import { defineGroup, invoke, event } from './contract';

export const fsContract = defineGroup('fs', {
  appendProjectMemoryEvent: invoke<[input: AppendProjectMemoryEventInput], ProjectMemorySnapshot>(),
  listDirtyDocuments: invoke<[], NativeDirtyDocument[]>(),
  settleDirtyDocuments: invoke<
    [request: NativeDirtySettlementRequest],
    NativeDirtySettlementResult
  >(),
  onDirtyDocumentsChanged: event<[]>().channel('fs:dirtyDocumentsChanged'),
  sequenceDocument: invoke<[request: SequenceDocumentRequest], SequenceDocumentSnapshot>(),
  isSequenceDocumentAvailable: invoke<[documentId: string], boolean>(),
  retainLegacySequenceDraft: invoke<[draft: LegacySequenceDraft], LegacySequenceDraftRetention>(),
  completeLegacySequenceDraftMigration: invoke<[pendingIds: readonly string[]], void>(),
  subscribeSequenceDocuments: event<[snapshot: SequenceDocumentSnapshot]>().channel(
    'fs:sequenceDocumentChanged'
  ),
  onFileDocumentFlush: event<[request: FileDocumentClientFlush]>().channel('fs:fileDocumentFlush'),
  acknowledgeFileDocumentFlush: invoke<[ack: FileDocumentClientFlushAck], boolean>(),
  completeLegacyFileDraftMigration: invoke<[pendingPaths: readonly string[]], void>(),
  retainLegacyFileDraft: invoke<[draft: LegacyFileDraft], LegacyFileDraftRetention>(),
  assertFileDocumentsClean: invoke<[path: string], void>(),
  fileDocument: invoke<[request: FileDocumentRequest], FileDocumentSnapshot>(),
  tableDocument: invoke<[command: TableDocumentCommand], TableDocumentCommandResult>(),
  subscribeFileDocuments:
    event<[snapshot: FileDocumentSnapshot]>().channel('fs:fileDocumentChanged'),
  beginWorkspaceMutation: invoke<
    [workspaceRoot: string, parentToken?: string, waitForAvailability?: boolean],
    string
  >(),
  endWorkspaceMutation: invoke<[token: string], void>(),
  canonicalPath: invoke<[path: string], string>(),
  readTextFile: invoke<[path: string], string>(),
  readAdmittedTextFile: invoke<[input: AdmittedTextFileReadRequest], string>(),
  readTextFileSlice: invoke<
    [path: string, maxBytes: number],
    { text: string; bytesRead: number }
  >(),
  readFile: invoke<[path: string], Uint8Array>(),
  readFileBounded: invoke<[path: string, maxBytes: number], Uint8Array>(),
  sha256File: invoke<[path: string], string>(),
  writeTextFile: invoke<
    [path: string, content: string, options?: { append?: boolean }, mutationToken?: string],
    void
  >(),
  writeTextFileAtomic: invoke<[input: TextFileAtomicWriteInput], void>(),
  saveSequenceDocument: invoke<[input: SequenceDocumentSaveInput], SequenceDocumentSaveResult>(),
  commitSequenceDocumentHistory: invoke<
    [input: SequenceDocumentHistoryInput],
    SequenceDocumentHistoryResult
  >(),
  publishSequenceMetadataRevision: invoke<
    [input: SequenceMetadataRevisionRequest],
    SequenceMetadataRevisionResult
  >(),
  recoverLegacySequenceMetadataTransaction: invoke<
    [packageRoot: string, mutationToken?: string],
    void
  >(),
  publishAcceptedAssemblyRevision: invoke<
    [input: AcceptedAssemblyRevisionPublicationRequest],
    AcceptedAssemblyRevisionPublicationResult
  >(),
  publishSequenceUserAttachmentMutation: invoke<
    [input: SequenceUserAttachmentMutationRequest],
    SequenceUserAttachmentMutationResult
  >(),
  previewSequenceRestore: invoke<
    [input: SequenceRestorePreviewRequest],
    SequenceRestorePreviewResult
  >(),
  applySequenceRestore: invoke<[input: SequenceRestoreApplyRequest], SequenceRestoreApplyResult>(),
  prepareSequenceEvidenceRun: invoke<
    [input: PrepareSequenceEvidenceRunRequest],
    PrepareSequenceEvidenceRunResult
  >(),
  activateSequenceEvidenceRun: invoke<[input: ActivateSequenceEvidenceRunRequest], void>(),
  completeSequenceEvidenceRun: invoke<
    [input: CompleteSequenceEvidenceRunRequest],
    CompleteSequenceEvidenceRunResult
  >(),
  failSequenceEvidenceRun: invoke<[input: FailSequenceEvidenceRunRequest], void>(),
  appendSequenceEvidenceState: invoke<
    [input: AppendSequenceEvidenceStateRequest],
    AppendSequenceEvidenceStateResult
  >(),
  validateWorkspacePath: invoke<[input: WorkspacePathValidationInput], boolean>(),
  contentHash: invoke<
    [
      input: {
        workspaceRoot: string;
        workspaceRelativePath: string;
      },
    ],
    string
  >(),
  readDir: invoke<[path: string], Array<{ name: string; isDirectory: boolean; isFile: boolean }>>(),
  mkdir: invoke<[path: string, options?: { recursive?: boolean }, mutationToken?: string], void>(),
  stat: invoke<[path: string], FilesystemStat>(),
  exists: invoke<[path: string], boolean>(),
  rename: invoke<[oldPath: string, newPath: string, mutationToken?: string], void>(),
  move: invoke<[sourcePath: string, destinationDir: string], { destPath: string }>(),
  watchFile: invoke<[path: string], void>(),
  unwatchFile: invoke<[path: string], void>(),
});
