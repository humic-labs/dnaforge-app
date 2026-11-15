import {
  startNgsReadAnalysisOperationOperationsNgsReadAnalysisPost,
  type NgsReadAnalysisRequest,
} from '@waypoint/api-client';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { managedOperations } from '../../services/managed-operations';
import { sha256Hex } from '../structure-drawer/public/api/protein-identity';
import { ngsReadEvidenceSchema } from './ngs-read-evidence';
import { callSchema, persistVariantAnalysis } from './variant-analysis';
import { useCanvasStore } from '../canvas/public/store';

export async function startNgsReadAnalysis(input: NgsReadAnalysisRequest, referencePath?: string) {
  return managedOperations.startRegisteredOperation(
    async ({ apiClient, scopeId, submissionKey, acceptedWorkspaceInput, expectedAccountId }) => {
      const response = await startNgsReadAnalysisOperationOperationsNgsReadAnalysisPost(
        {
          submission_key: submissionKey,
          subject: {
            scope_id: scopeId,
            ...(acceptedWorkspaceInput ? { accepted_workspace_input: acceptedWorkspaceInput } : {}),
          },
          input,
        },
        apiClient.options(
          acceptedWorkspaceInput
            ? { headers: { 'X-DNAForge-Account-ID': expectedAccountId! } }
            : undefined
        )
      );
      if (response.status !== 202) throw new Error(response.data.detail.message);
      if (response.data.kind !== 'ngs-read-analysis' || response.data.subject.scope_id !== scopeId)
        throw new Error('Invalid raw-read operation identity.');
      return response.data;
    },
    undefined,
    referencePath
      ? [
          { key: 'reads', path: input.readPath },
          { key: 'reference', path: referencePath },
        ]
      : []
  );
}
export function retainNgsReadOperation(documentId: string, operationId: string, name: string) {
  const canvas = useCanvasStore.getState(),
    found = canvas.findTab('sequence', documentId);
  if (!found) throw new Error('Open the reference to review this raw-read analysis.');
  canvas.setTabViewState(found.panelId, found.tabId, {
    ngsReadOperation: { operationId, name },
    alignmentReviewRequestId: crypto.randomUUID(),
  });
}
export async function importNgsReadAnalysis(
  operationId: string,
  documentId: string,
  sequence: AnnotatedSequence,
  name: string
) {
  const operation = await managedOperations.getOperation(operationId);
  if (operation.kind !== 'ngs-read-analysis')
    throw new Error('This job did not analyze raw reads.');
  if (operation.state !== 'succeeded')
    throw new Error(operation.error?.message ?? `Raw-read analysis is ${operation.state}.`);
  const envelope = await managedOperations.getResult(operationId);
  if (
    envelope.kind !== 'ngs-read-analysis' ||
    envelope.operation_id !== operationId ||
    envelope.status !== 'available'
  )
    throw new Error('No completed raw-read evidence is available.');
  const evidence = ngsReadEvidenceSchema.parse(envelope.result);
  const calls = callSchema
    .array()
    .max(5000)
    .parse((envelope.result as { calls?: unknown })?.calls);
  if (
    evidence.inputRevision !== operation.subject.input_revision ||
    evidence.documentId !== documentId ||
    evidence.settings.documentId !== documentId ||
    evidence.referenceSha256 !== sha256Hex(sequence.sequence.toUpperCase()) ||
    evidence.settings.referenceSequence !== sequence.sequence.toUpperCase() ||
    evidence.settings.isCircular !== !!sequence.circular ||
    evidence.coverage.length !== sequence.sequence.length ||
    evidence.totalReads !== evidence.mappedReads + evidence.unmappedReads ||
    evidence.mappingQualityReads > evidence.mappedReads
  )
    throw new Error(
      'The raw-read result does not match this reference revision or complete input record count.'
    );
  const imported = await persistVariantAnalysis(
    {
      kind: 'sequence-variant-analysis',
      version: 1,
      documentId,
      name,
      sourceLabel: evidence.sourceLabel,
      sourceIdentity: `${evidence.inputRevision}:reads-sha256:${evidence.sourceSha256}`,
      referenceSha256: evidence.referenceSha256,
      chrom: 'reference',
      sample: evidence.sourceLabel,
      countBasis: evidence.countBasis,
      calls,
      createdAt: Date.now(),
      readEvidence: { ...evidence, operationId },
    },
    operationId
  );
  return imported;
}
