import type { ParsedWorkspaceArtifact } from '../../db/workspace-artifacts';
import { useDesignStore } from './store';
import { presentDocument } from '../canvas/public/present-document';
import {
  cancelledDocumentOpen,
  type DocumentOpenResult,
  type OpenStrategy,
} from '../canvas/public/document-presentation';
import { registerPendingReadableContent } from '../../lib/readable-content-telemetry';

export function openDesignDocument(input: {
  artifact: Extract<ParsedWorkspaceArtifact, { kind: 'assembly-design' }>;
  entityId: string;
  label: string;
  placement?: OpenStrategy;
  signal?: AbortSignal;
}): DocumentOpenResult {
  if (input.signal?.aborted) return cancelledDocumentOpen();
  if (!input.artifact.design && !useDesignStore.getState().designs[input.entityId]) {
    return {
      status: 'failed',
      message: `Design "${input.artifact.name || input.label}" is not available on this installation.`,
    };
  }
  if (input.artifact.design)
    useDesignStore.getState().upsertDesignFromArtifact(input.artifact.design);
  const result = presentDocument(
    {
      type: 'design',
      entityId: input.entityId,
      label:
        useDesignStore.getState().designs[input.entityId]?.name ||
        input.artifact.name ||
        input.label,
    },
    input.placement,
    'ready'
  );
  if (result.status === 'presented')
    registerPendingReadableContent({ contentKey: input.entityId, tabId: result.tabId });
  return result;
}
