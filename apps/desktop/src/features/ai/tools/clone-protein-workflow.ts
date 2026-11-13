import {
  selectInspectionProteinProduct,
  waitForInspectionProteinProduct,
} from '../../structure-drawer/public/inspection-allele';
import { managedOperations } from '../../../services/managed-operations';
import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { platform } from '../../../platform';
import { isPathInsideBoundary } from '../../../shared/path-boundary';
import {
  loadSequenceDocumentBiologyFile,
  getUserFolders,
  resolveMultiRootPath,
} from './path-utils';
import { useVerificationStore } from '../../alignment-manager/public/store';
import { openTabInCanvas } from './open-tab';
import { useCanvasStore } from '../../canvas/public/store';
import { inspectMutationProtein } from '../../alignment-manager/public/inspect-mutation-protein';
import { getWorkspaceResidueSelectionsStore } from '../../structure-drawer/public/state/selected-codon-registry';
import { structureInspectionId } from '../../structure-drawer/public/structure-inspection';

export const analyzeCloneSchema = z
  .object({
    documentId: z
      .string()
      .min(1)
      .describe('Stable reference sequence document ID from get_workspace or import_sequence.'),
    queryPaths: z
      .array(z.string().min(1))
      .min(1)
      .max(64)
      .describe(
        'Single assembled clone or Sanger sequence files inside the open project. This tool does not accept raw-read populations.'
      ),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export const getCloneAnalysisSchema = z
  .object({
    documentId: z.string().min(1),
    sessionId: z.string().min(1),
    operationId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Admitted managed alignment job to attach to this prepared session. Omit when reading an already attached analysis.'
      ),
  })
  .strict();
export const inspectSequenceVariantSchema = z
  .object({
    documentId: z.string().min(1),
    sessionId: z.string().min(1),
    trackId: z.string().min(1),
    mutationId: z.string().min(1),
    proteinProduct: z
      .enum(['reference', 'allele'])
      .optional()
      .describe(
        'Use reference (default) to show a mutation or measurement on existing reference coordinates. Allele selects the altered sequence and requires its own structure or prediction; it does not combine all clone changes.'
      ),
  })
  .strict();

async function openReview(documentId: string, folders: WorkspaceFolder[]) {
  const opened = await openTabInCanvas(
    { type: 'sequence', entityId: documentId, label: 'Sequence analysis' },
    folders
  );
  if (opened.error) throw new Error(opened.error);
  const canvas = useCanvasStore.getState();
  const tab = canvas.findTab('sequence', documentId);
  if (!tab) throw new Error('The reference sequence did not open.');
  canvas.setTabViewState(tab.panelId, tab.tabId, { alignmentReviewRequestId: crypto.randomUUID() });
}
function failure(error: unknown, changed: boolean) {
  return toolFailure({
    code: 'CLONE_PROTEIN_WORKFLOW_FAILED',
    error: error instanceof Error ? error.message : String(error),
    retriable: false,
    stateChanged: changed ? 'unknown' : false,
    partialEffects: changed ? ['alignment-review-started'] : [],
  });
}

export function createAnalyzeCloneTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Align assembled clone or Sanger sequence files to an imported reference using the same durable, circular-aware workflow as the Alignments drawer. Opens the review, starts the durable analysis and returns its identity promptly. Use get_clone_analysis to observe completion and obtain actual track/mutation identities for inspect_sequence_variant. Inputs are never edited. Does not treat a multi-read FASTQ population as one clone.',
    inputSchema: analyzeCloneSchema,
    execute: async ({ documentId, queryPaths, name }) => {
      let changed = false;
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
        const referenceFile = await platform().fs.stat(loaded.sourcePath);
        const paths: string[] = [];
        for (const path of queryPaths) {
          const resolved = resolveMultiRootPath(getUserFolders(folders), path);
          const [file, root] = await Promise.all([
            platform().fs.stat(resolved.absolutePath),
            platform().fs.stat(resolved.folder.path),
          ]);
          if (!file.isFile || !isPathInsideBoundary(file.canonicalPath, root.canonicalPath))
            throw new Error('Each clone file must remain inside its open project.');
          if (file.canonicalPath === referenceFile.canonicalPath)
            throw new Error(
              'The reference document and a clone query resolve to the same source file. Choose the intended reference document from get_workspace or import_sequence, then compare the distinct clone file. A self-comparison cannot verify the clone against that reference.'
            );
          paths.push(file.canonicalPath);
        }
        const store = useVerificationStore.getState();
        store.registerReferenceSource(loaded.documentId, loaded.sourcePath);
        if (!store.verificationState[loaded.documentId]) await store.loadSidecar(loaded.documentId);
        await openReview(loaded.documentId, folders);
        const sessionId = store.createSession(loaded.documentId, {
          name,
          mode: 'one-per-clone',
          queryPaths: paths,
        });
        changed = true;
        const input = await store.prepareSessionAlignments(loaded.documentId, sessionId, paths);
        return toolSuccess({ documentId: loaded.documentId, sessionId, input });
      } catch (error) {
        return failure(error, changed);
      }
    },
  });
}

export function createInspectSequenceVariantTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Inspect one actual saved clone mutation beside its reference and mutation list. Validates source freshness, opens the linked protein pane, selects the reference codon and resolves a structure without reopening a picker. Use mutation inspection actions from get_clone_analysis. Waits up to 20 seconds for native readiness; repeat if still loading. Read mol_get_state before applying measurements. Unsupported or ambiguous mappings return a reason, never invented coordinates.',
    inputSchema: inspectSequenceVariantSchema,
    execute: async (
      { documentId, sessionId, trackId, mutationId, proteinProduct },
      { abortSignal }
    ) => {
      let changed = false;
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
        const store = useVerificationStore.getState();
        store.registerReferenceSource(loaded.documentId, loaded.sourcePath);
        if (!store.verificationState[loaded.documentId]) await store.loadSidecar(loaded.documentId);
        await store.checkStaleness(loaded.documentId);
        const current = useVerificationStore.getState();
        if (
          !current.referenceFileChecksums[loaded.documentId] ||
          current.staleReferences[loaded.documentId] ||
          current.staleSessionIds[loaded.documentId]?.includes(sessionId)
        )
          throw new Error(
            'The alignment is stale or lacks verified reference bytes. Run the alignment again.'
          );
        const session = current.verificationState[loaded.documentId]?.sessions.find(
          (item) => item.id === sessionId
        );
        const track = session?.tracks.find((item) => item.id === trackId);
        const mutation = track?.mutations.find((item) => item.id === mutationId);
        if (!track || !mutation || track.failedToRealign)
          throw new Error('No fresh mutation matches these analysis identities.');
        await openReview(loaded.documentId, folders);
        current.setActiveSession(loaded.documentId, sessionId);
        current.setSessionViewPreferences(loaded.documentId, sessionId, {
          selectedTrackId: trackId,
        });
        changed = true;
        const deadline = Date.now() + 10_000;
        while (!getWorkspaceResidueSelectionsStore(loaded.documentId) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        const error = inspectMutationProtein({
          sequence: loaded.biology.sequence,
          documentId: loaded.documentId,
          mutation,
          track,
        });
        if (error) throw new Error(error);
        if (proteinProduct === 'allele')
          selectInspectionProteinProduct(loaded.documentId, 'allele');
        const protein = await waitForInspectionProteinProduct(loaded.documentId, abortSignal);
        return toolSuccess({
          ...protein,
          documentId: loaded.documentId,
          inspectionId: structureInspectionId(loaded.documentId),
          mutationId,
          position: mutation.position,
          status: protein.structureStatus,
        });
      } catch (error) {
        return failure(error, changed);
      }
    },
  });
}

async function waitForCloneAnalysis(documentId: string, sessionId: string, signal?: AbortSignal) {
  const current = () =>
    useVerificationStore
      .getState()
      .verificationState[documentId]?.sessions.find((session) => session.id === sessionId);
  if (signal?.aborted)
    throw new Error('Stopped waiting for clone analysis. The job remains available in Jobs.');
  if (current()?.alignmentOperation?.status !== 'active') return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(new Error('Stopped waiting for clone analysis. The job remains available in Jobs.'));
    const timeout = setTimeout(() => finish(), 20_000);
    const observe = () => {
      if (current()?.alignmentOperation?.status !== 'active') finish();
    };
    unsubscribe = useVerificationStore.subscribe(observe);
    signal?.addEventListener('abort', abort, { once: true });
    observe();
  });
}

export function createGetCloneAnalysisTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Read a clone-analysis job and its actual completed mutation list. Waits up to 20 seconds for durable results. If status remains active, call get_clone_analysis again with the same identities until terminal; do not abandon the requested workflow merely because computation is pending. Failed or pending jobs are not mutation evidence. Use returned track and mutation identities with inspect_sequence_variant.',
    inputSchema: getCloneAnalysisSchema,
    execute: async ({ documentId, sessionId, operationId }, { abortSignal }) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(documentId, folders);
        const store = useVerificationStore.getState();
        store.registerReferenceSource(loaded.documentId, loaded.sourcePath);
        if (!store.verificationState[loaded.documentId]) await store.loadSidecar(loaded.documentId);
        if (operationId) {
          const operation = await managedOperations.getOperation(operationId);
          let admitted!: () => void;
          const admission = new Promise<void>((resolve) => {
            admitted = resolve;
          });
          const materialization = store.adoptSessionAlignmentOperation(
            loaded.documentId,
            sessionId,
            operation,
            admitted
          );
          void materialization.catch((error) =>
            console.error('[get_clone_analysis] Alignment failed', error)
          );
          await Promise.race([admission, materialization]);
        }
        await waitForCloneAnalysis(loaded.documentId, sessionId, abortSignal);
        const session = useVerificationStore
          .getState()
          .verificationState[loaded.documentId]?.sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error('No saved clone analysis matches this session.');
        const reference = {
          documentId: loaded.documentId,
          name: loaded.name ?? loaded.biology.sequence.name,
          length: loaded.biology.sequence.length,
          circular: loaded.biology.sequence.circular === true,
        };
        const status = session.alignmentOperation?.status ?? 'not-started';
        if (status !== 'succeeded')
          return toolSuccess({
            documentId: loaded.documentId,
            reference,
            sessionId,
            status,
            operationId: session.alignmentOperation?.id,
            tracks: [],
            message:
              status === 'active'
                ? 'The alignment is still running. Call get_clone_analysis again with these same identities to wait for the result. Do not restart the analysis or ask the user to resubmit. No completed mutation evidence is available yet.'
                : 'The analysis did not complete successfully. No mutation evidence is available; inspect this operation in Jobs for its terminal outcome.',
          });
        await store.checkStaleness(loaded.documentId);
        const current = useVerificationStore.getState();
        if (
          current.staleReferences[loaded.documentId] ||
          current.staleSessionIds[loaded.documentId]?.includes(sessionId) ||
          session.tracks.some((track) => track.failedToRealign)
        )
          throw new Error('This analysis is stale. Run the alignment again.');
        return toolSuccess({
          documentId: loaded.documentId,
          reference,
          sessionId,
          status,
          operationId: session.alignmentOperation?.id,
          message:
            'For the requested mutation, call its inspection.tool with inspection.arguments. This opens the linked protein and resolves matching structures from the encoded sequence, including existing predictions. mol_list_structures lists only already-open viewers; an empty list or an empty protein-name search does not establish that this protein has no structure. Read mol_get_state after inspection, then apply the requested measurement and save the view.',
          tracks: session.tracks.map((track) => ({
            id: track.id,
            label: track.label,
            identity: track.alignment.identity,
            status: track.status,
            mutationCount: track.mutations.length,
            mutations: track.mutations.slice(0, 1000).map((mutation) => ({
              ...mutation,
              inspection: {
                tool: 'inspect_sequence_variant',
                arguments: {
                  documentId: loaded.documentId,
                  sessionId,
                  trackId: track.id,
                  mutationId: mutation.id,
                  proteinProduct: 'reference',
                },
              },
            })),
            mutationsTruncated: track.mutations.length > 1000,
          })),
        });
      } catch (error) {
        return failure(error, false);
      }
    },
  });
}
