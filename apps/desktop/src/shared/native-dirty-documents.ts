import {
  fileDocumentInspectSchema,
  type FileDocumentRequest,
  type FileDocumentSnapshot,
} from './file-document';
import type { NativeDirtyDocument } from './native-document-drafts';

export interface NativeDirtySettlementRequest {
  action: 'save' | 'discard';
}
export interface NativeDirtySettlementResult {
  action: 'save' | 'discard';
  settled: string[];
  failures: Array<{ documentId: string | null; path?: string; error: string }>;
  remaining: NativeDirtyDocument[];
}

export async function settleNativeDirtyDocuments(
  request: NativeDirtySettlementRequest,
  owner: {
    listDirty(): Promise<NativeDirtyDocument[]>;
    execute(request: FileDocumentRequest): Promise<FileDocumentSnapshot>;
    beforeList?(): Promise<void>;
  }
): Promise<NativeDirtySettlementResult> {
  if (request.action !== 'save' && request.action !== 'discard')
    throw new Error('Unsupported dirty-document disposition.');
  const result: NativeDirtySettlementResult = {
    action: request.action,
    settled: [],
    failures: [],
    remaining: [],
  };
  try {
    await owner.beforeList?.();
  } catch (error) {
    result.failures.push({
      documentId: null,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      result.remaining = await owner.listDirty();
    } catch (inventoryError) {
      result.failures.push({
        documentId: null,
        error: `Dirty inventory unavailable: ${inventoryError instanceof Error ? inventoryError.message : String(inventoryError)}`,
      });
    }
    return result;
  }
  const inventory = await owner.listDirty();
  const seen = new Map<string, NativeDirtyDocument>();
  const ambiguous = new Set<string>();
  for (const item of inventory) {
    const duplicate = seen.get(item.documentId);
    if (
      duplicate &&
      (duplicate.path !== item.path || duplicate.workspaceRoot !== item.workspaceRoot)
    ) {
      result.failures.push({
        documentId: item.documentId,
        path: item.path,
        error: 'The dirty document has ambiguous native ownership.',
      });
      ambiguous.add(item.documentId);
      continue;
    }
    if (duplicate) continue;
    seen.set(item.documentId, item);
  }
  for (const item of seen.values()) {
    if (ambiguous.has(item.documentId)) continue;
    try {
      const current = await owner.execute({
        target: item.target,
        projection: 'inspection',
        operation: fileDocumentInspectSchema.parse({ kind: 'inspect' }),
      });
      if (request.action === 'save' && current.recoveryId)
        throw new Error(
          'RECOVERY_DECISION_REQUIRED: Inspect and explicitly restore or discard the retained recovery before saving.'
        );
      if (!current.dirty && !current.saving && !current.recoveryId) continue;
      if (!current.ready && request.action === 'save')
        throw new Error(
          current.reason ?? 'The document requires inspection before it can be saved.'
        );
      if (request.action === 'save' && current.readOnly)
        throw new Error('The dirty document is read-only.');
      if (!current.capabilities.includes(request.action))
        throw new Error(`The native ${current.type} owner does not support ${request.action}.`);
      const settled = await owner.execute({
        target: item.target,
        projection: 'inspection',
        expectedRevision: current.revision,
        operation: { kind: request.action },
      });
      if (settled.dirty || settled.saving || settled.recoveryId)
        throw new Error('The document still has unresolved unsaved work after the operation.');
      result.settled.push(item.documentId);
    } catch (error) {
      result.failures.push({
        documentId: item.documentId,
        path: item.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.remaining = await owner.listDirty();
  return result;
}
