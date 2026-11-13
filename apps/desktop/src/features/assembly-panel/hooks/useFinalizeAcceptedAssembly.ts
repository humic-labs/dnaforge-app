import {
  FinalizationPreconditionError,
  isFinalizationFilesystemError,
} from '../../assembly/public/finalization-error';
import { useDesignStore } from '../../design/public/store';
import type { ToolErrorReasonCode } from '../../../shared/tool-error-reasons';
import { userMessage, toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  acceptedAssemblyProductPathInDirectory,
  acceptedAssemblyWriteTargetFromProductPath,
  defaultAcceptedAssemblyProductPath,
  workspaceFoldersToAcceptedAssemblyMap,
} from '../../assembly/public/accepted-service';
import {
  resolveAcceptedAssemblyWritePaths,
  type AcceptedAssemblyResolvedWritePaths,
} from '../../assembly/public/accepted-writer';
import { useCanvasStore } from '../../canvas/public/store';
import type { SequenceDesign } from '../../design/public/types';
import { useSequenceStore } from '../../sequence/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  deriveAssemblyIssues,
  issueBlocksGate,
} from '../../assembly/public/issues/assembly-issues';
import { beginToolOperation } from '../../../lib/analytics-operation';
import type { ToolUsageErrorClass } from '../../../lib/analytics-events';
import { confirmDialog } from '../../../components/confirm-dialog-store';
import {
  prepareFinalizationCandidate,
  resolveBoundAcceptedPackageForDesign,
  type BoundAcceptedPackage,
} from '../../assembly/public/accepted-finalization-preview';
import { ReplaceProductConfirmationRequired } from '../../assembly/public/accepted-product-integrity';
import {
  AcceptedAssemblyProjectionError,
  finalizeAcceptedAssemblyWorkflow,
} from '../../assembly/public/accepted-finalization-workflow';
import {
  resolveExplicitProjectRoot,
  soleWritableProjectRoot,
  writableProjectRoots,
} from '../../../shared/project-root-selection';
import { observeAssemblyRefusal } from '../../assembly/public/journey-telemetry';
import { assemblyDraftControls } from '../assembly-draft-controls';

export type FinalizeAcceptedAssemblyStatus =
  | { state: 'idle' }
  | { state: 'running' }
  | {
      state: 'success';
      productPath: string;
      sidecarPath: string;
      primerCsvPath: string;
      primerFastaPath: string;
    }
  | { state: 'error'; message: UserMessage; recovery?: 'draft' | 'destination' };

type FinalizationDestinationState =
  | { state: 'loading' }
  | { state: 'unbound' }
  | { state: 'bound'; package: BoundAcceptedPackage }
  | { state: 'error'; message: UserMessage };

export function useFinalizeAcceptedAssembly(design: SequenceDesign, projectRoot?: string | null) {
  const folders = useWorkspaceStore((state) => state.folders);
  const [status, setStatus] = useState<FinalizeAcceptedAssemblyStatus>({ state: 'idle' });
  const [customProductPath, setCustomProductPath] = useState<string | null>(null);
  const [destination, setDestination] = useState<FinalizationDestinationState>({
    state: 'loading',
  });
  useEffect(() => {
    let canceled = false;
    setDestination({ state: 'loading' });
    void resolveBoundAcceptedPackageForDesign(design, folders)
      .then((boundPackage) => {
        if (canceled) return;
        setDestination(
          boundPackage ? { state: 'bound', package: boundPackage } : { state: 'unbound' }
        );
      })
      .catch((error: unknown) => {
        if (canceled) return;
        setDestination({
          state: 'error',
          message: toUserMessage(error, 'assembly.failed'),
        });
      });
    return () => {
      canceled = true;
    };
  }, [design, folders]);
  const assemblyIssues = useMemo(() => deriveAssemblyIssues({ design }), [design]);
  const finalizeBlockers = useMemo(
    () => assemblyIssues.filter((issue) => issueBlocksGate(issue, 'finalize')),
    [assemblyIssues]
  );
  const errorCount = finalizeBlockers.length;
  const warningCount = assemblyIssues.filter((issue) => issue.severity === 'warning').length;
  const ownerProject = projectRoot
    ? resolveExplicitProjectRoot(writableProjectRoots(folders), projectRoot)
    : soleWritableProjectRoot(folders);
  const defaultSaveBaseDirectory = ownerProject?.path;
  const defaultProductPath = defaultSaveBaseDirectory
    ? defaultAcceptedAssemblyProductPath(design, defaultSaveBaseDirectory)
    : null;
  const boundPackage = destination.state === 'bound' ? destination.package : null;
  const targetProductPath =
    destination.state === 'loading' || destination.state === 'error'
      ? null
      : (boundPackage?.productPath ?? customProductPath ?? defaultProductPath);
  const workspaceFolderMap = useMemo(
    () => workspaceFoldersToAcceptedAssemblyMap(folders),
    [folders]
  );
  const artifactPaths = useMemo<AcceptedAssemblyResolvedWritePaths | null>(() => {
    if (!targetProductPath) return null;
    try {
      return resolveAcceptedAssemblyWritePaths(
        acceptedAssemblyWriteTargetFromProductPath(targetProductPath, {
          overwrite: boundPackage !== null || customProductPath !== null,
          parentIsExistingPackage: boundPackage !== null,
        }),
        workspaceFolderMap
      );
    } catch {
      return null;
    }
  }, [boundPackage, customProductPath, targetProductPath, workspaceFolderMap]);
  const resolvedTargetPath = artifactPaths?.productGenBankPath ?? targetProductPath;
  const canFinalize =
    Boolean(targetProductPath) &&
    destination.state !== 'loading' &&
    destination.state !== 'error' &&
    finalizeBlockers.length === 0 &&
    (design.assemblyState === 'ready' || design.assemblyState === 'assembled') &&
    design.regions.length >= 2;

  const disabledReason = useMemo(() => {
    if (destination.state === 'loading') return 'Checking for an existing sequence package...';
    if (destination.state === 'error') return destination.message;
    if (!targetProductPath) return 'Choose a project before finalizing.';
    if (design.regions.length < 2) return 'Add at least two parts before finalizing.';
    if (finalizeBlockers.some((issue) => issue.kind === 'assembly-empty-part')) {
      return 'Fill the empty parts before finalizing.';
    }
    if (
      finalizeBlockers.length > 0 &&
      finalizeBlockers.every(
        (issue) =>
          issue.scope.type !== 'assembly' &&
          issue.scope.type !== 'digest-preview' &&
          issue.scope.type !== 'export'
      )
    ) {
      return 'Review the parts and junctions above before finalizing.';
    }
    if (finalizeBlockers.length === 1) return finalizeBlockers[0].shortMessage;
    if (finalizeBlockers.length > 1) {
      return `${finalizeBlockers.length} issues blocking finalization`;
    }
    if (design.assemblyState !== 'ready' && design.assemblyState !== 'assembled') {
      return `Click ${assemblyDraftControls(design).label} before finalizing.`;
    }
    return null;
  }, [design, destination, finalizeBlockers, targetProductPath]);

  const saveDirectory = targetProductPath ? parentDirectory(targetProductPath) : '';

  const selectSaveDirectory = useCallback(
    (directory: string) => {
      if (boundPackage) return;
      setCustomProductPath(acceptedAssemblyProductPathInDirectory(design, directory));
      setStatus({ state: 'idle' });
    },
    [boundPackage, design]
  );

  const resetSavePath = useCallback(() => {
    setCustomProductPath(null);
    setStatus({ state: 'idle' });
  }, []);

  const finalize = useCallback(async () => {
    if (!targetProductPath || !canFinalize) {
      observeAssemblyRefusal({
        designId: design.id,
        operationId: crypto.randomUUID(),
        action: 'export',
        reason: 'validation',
        inputRequired:
          design.regions.length < 2 ||
          finalizeBlockers.some((issue) => issue.kind === 'assembly-empty-part'),
      });
      setStatus({ state: 'error', message: toUserMessage(disabledReason, 'assembly.failed') });
      return;
    }

    const initialVersion = design.version;
    const operation = beginToolOperation({
      toolId: 'assembly',
      surface: 'tab',
      action: 'exported',
    });
    let failureClass: ToolUsageErrorClass = 'validation';
    setStatus({ state: 'running' });
    try {
      const candidate = await prepareFinalizationCandidateWithReplaceConfirm({
        designId: design.id,
        expectedDesignVersion: initialVersion,
        targetProductPath,
        overwrite: customProductPath !== null,
        acceptedBy: 'local-user',
      });
      if (!candidate) {
        setStatus({ state: 'idle' });
        operation.cancel(undefined, {
          outcomeKind: 'replacement_declined',
          valueDelivered: false,
          usableResult: false,
        });
        return;
      }
      failureClass = 'compute';
      const result = await finalizeAcceptedAssemblyWorkflow({
        candidate,
        actor: 'local-user',
        notify: true,
        telemetryActionId: operation.operationId,
      });
      failureClass = 'projection';
      const productSequence = useSequenceStore.getState().sequences[result.constructId];
      if (!productSequence)
        throw new Error('Finalized product was not projected into sequence state.');
      useWorkspaceStore.getState().revealPath(result.productPath);
      const canvas = useCanvasStore.getState();
      const embedded = Object.entries(canvas.panels).flatMap(([panelId, panel]) =>
        panel.tabs
          .filter((tab) => tab.type === 'sequence' && tab.assemblyEditDesignId === design.id)
          .map((tab) => ({ panelId, tabId: tab.id }))
      )[0];
      if (embedded) {
        canvas.updateTab(embedded.panelId, embedded.tabId, {
          assemblyEditDesignId: undefined,
          entityId: result.constructId,
          sequenceDocument: result.sequenceDocument,
          label:
            productSequence.name || result.productPath.split(/[\\/]/).pop() || result.productPath,
          isDirty: false,
        });
      } else if (canvas.findTab('design', design.id)) {
        canvas.promoteTabToSequence({
          fromType: 'design',
          fromEntityId: design.id,
          sequenceEntityId: result.constructId,
          sequenceDocument: result.sequenceDocument,
          label:
            productSequence.name || result.productPath.split(/[\\/]/).pop() || result.productPath,
        });
      }

      setStatus({
        state: 'success',
        productPath: result.productPath,
        sidecarPath: result.metaPath,
        primerCsvPath: result.primerCsvPath,
        primerFastaPath: result.primerFastaPath,
      });
      operation.complete(undefined, {
        status: 'saved',
        artifactCorrelationId: result.constructId,
        resultCount: 1,
        valueDelivered: false,
        usableResult: true,
      });
    } catch (error) {
      let reasonCode: ToolErrorReasonCode =
        failureClass === 'validation' ? 'precondition_failed' : 'export_failed';
      let recovery: 'draft' | 'destination' | undefined;
      let message = toUserMessage(error, 'assembly.failed');
      if (error instanceof FinalizationPreconditionError) {
        failureClass = 'validation';
        reasonCode = error.reason;
        if (error.reason === 'stale_design' || error.reason === 'draft_required') {
          recovery = 'draft';
          message = userMessage('assembly.exportDraftChanged');
        } else if (error.reason === 'output_exists') {
          recovery = 'destination';
          message = userMessage('assembly.exportOutputExists');
        }
      } else if (
        error instanceof AcceptedAssemblyProjectionError ||
        failureClass === 'projection'
      ) {
        failureClass = 'projection';
        reasonCode = 'projection_failed';
      } else if (isFinalizationFilesystemError(error)) {
        failureClass = 'filesystem';
        reasonCode = 'filesystem_error';
      }
      operation.fail(failureClass, undefined, undefined, undefined, reasonCode);
      setStatus({ state: 'error', message, recovery });
    }
  }, [canFinalize, customProductPath, design, disabledReason, finalizeBlockers, targetProductPath]);

  const redraft = useCallback(() => {
    setStatus({ state: 'idle' });
    useDesignStore.getState().draftAssembly(design.id);
  }, [design.id]);

  return {
    redraft,
    canFinalize,
    disabledReason,
    errorCount,
    issues: assemblyIssues,
    finalizeBlockers,
    warningCount,
    productPath: resolvedTargetPath,
    artifactPaths,
    isCustomPath: boundPackage === null && customProductPath !== null,
    isExistingPackage: boundPackage !== null,
    destinationState: destination.state,
    initialSaveDirectory: saveDirectory || ownerProject?.path || '',
    saveDirectory,
    selectSaveDirectory,
    resetSavePath,
    finalize,
    status,
  };
}

async function prepareFinalizationCandidateWithReplaceConfirm(
  input: Parameters<typeof prepareFinalizationCandidate>[0]
) {
  try {
    return await prepareFinalizationCandidate(input);
  } catch (error) {
    if (!(error instanceof ReplaceProductConfirmationRequired)) throw error;
    const confirmed = await confirmDialog({
      title: userMessage('dialog.replace-plasmid-product'),
      message: userMessage('assembly.replaceProduct'),
      confirmLabel: userMessage('dialog.replace-product'),
      tone: 'danger',
      safeDefault: true,
    });
    if (!confirmed) return null;
    return prepareFinalizationCandidate({ ...input, overwrite: true, replaceProduct: true });
  }
}

function parentDirectory(path: string): string {
  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slashIndex > 0 ? path.slice(0, slashIndex) : '';
}
