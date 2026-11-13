import type { Tab, TabType, TabViewState } from '../canvas/public/types';
import type { OpenStrategy } from '../canvas/public/document-presentation';
import type { SequenceDocumentRef } from '../../shared/managed-sequence-document';
import type { OpenSequenceFileOptions } from '../sequence/public/openSequenceFile';

export type DocumentTarget =
  | { kind: 'file'; path: string; tabType?: TabType }
  | { kind: 'legacy-migration-file'; workspaceRoot: string; targetId: string }
  | { kind: 'track-view'; id: string }
  | { kind: 'sequence-document'; document: SequenceDocumentRef }
  | { kind: 'sequence-package'; path: string }
  | { kind: 'record'; tabType: Exclude<TabType, 'sequence'>; entityId: string };

export interface OpenDocumentRequest {
  target: DocumentTarget;
  label?: string;
  placement?: OpenStrategy;
  navigation?: TabViewState;
  signal?: AbortSignal;
  source?: OpenSequenceFileOptions['sourceSurface'];
  sequenceOptions?: Pick<
    OpenSequenceFileOptions,
    'readOnly' | 'skipOversizedPrompt' | 'presentation' | 'importOperationId'
  >;
  structureOptions?: { skipOversizedPrompt?: boolean; operationId?: string };
  view?: Pick<Tab, 'initialStructureAttrs' | 'pendingViewState' | 'predictionResult'>;
}

export interface OpenFileDocumentRequest extends Omit<OpenDocumentRequest, 'target' | 'label'> {
  target: Extract<DocumentTarget, { kind: 'file' }>;
  label: string;
}
