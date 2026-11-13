import { presentDocument } from '../canvas/public/present-document';
import {
  cancelledDocumentOpen,
  type DocumentOpenResult,
} from '../canvas/public/document-presentation';
import { registerPendingReadableContent } from '../../lib/readable-content-telemetry';
import type {
  OpenDocumentRequest,
  OpenFileDocumentRequest,
} from '../document-opening/public/types';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import { registryRepresentationForEntity } from '../../shared/registry-entity-opening';
import { ENTITY_ARTIFACT_CURRENT_SCHEMA } from './entity-artifact';
import { getLimsRegistryPreview } from './operations';
import { loadSavedEntityRecord, readEntityArtifactFile } from './entity-record-document';

export async function openSavedEntityRecord(
  entityId: string,
  request: Pick<OpenDocumentRequest, 'placement' | 'signal'>
): Promise<DocumentOpenResult> {
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const loaded = await loadSavedEntityRecord(entityId, request.signal);
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const result = presentDocument(
    { type: 'record', entityId: loaded.artifact.id, label: loaded.artifact.name },
    request.placement
  );
  if (result.status === 'presented') {
    registerPendingReadableContent({ contentKey: entityId, tabId: result.tabId });
  }
  return result;
}

export async function openEntityArtifact(
  request: OpenFileDocumentRequest
): Promise<DocumentOpenResult> {
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const loaded = await readEntityArtifactFile(request.target.path, undefined, request.signal);
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const { artifact, importSource } = loaded;
  if (!importSource && artifact.schema === ENTITY_ARTIFACT_CURRENT_SCHEMA) {
    const preview = await getLimsRegistryPreview({ entityId: artifact.id });
    if (registryRepresentationForEntity(preview.entity).openTarget.kind === 'record_file') {
      const current = await loadSavedEntityRecord(artifact.id, request.signal);
      if (normalizePathForBoundary(current.path) !== normalizePathForBoundary(loaded.path)) {
        return {
          status: 'blocked',
          message:
            'This file is not the current saved record. Open its current file from the Registry.',
        };
      }
      if (request.signal?.aborted) return cancelledDocumentOpen();
      const result = presentDocument(
        { type: 'record', entityId: artifact.id, label: artifact.name },
        request.placement
      );
      if (result.status === 'presented')
        registerPendingReadableContent({ contentKey: artifact.id, tabId: result.tabId });
      return result;
    }
  }

  const tab =
    artifact.kind === 'protein' && !importSource
      ? { type: 'protein' as const, entityId: artifact.id, label: artifact.name }
      : { type: 'text' as const, entityId: request.target.path, label: request.label };
  const result = presentDocument(tab, request.placement);
  if (result.status === 'presented')
    registerPendingReadableContent({ contentKey: tab.entityId, tabId: result.tabId });
  return result;
}
