import { PrimerPublicationPendingError } from '../primers/public/primer-artifact-service';
import { openDocument } from '../document-opening/public/open-document';
import {
  openManagedSequenceDocument,
  openSequenceDocument,
  openSequenceFile,
  type OpenStrategy,
} from '../document-opening/public/compat';
import { managedSequenceRepository } from '../sequence/public/managed-sequence-repository';
import { resolveSequenceDocumentById } from '../sequence/public/sequence-document-repository';
import { useCanvasStore } from '../canvas/public/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { TabViewState } from '../canvas/public/types';
import { getLimsEntityById, resolveLimsEntityOpenTarget, type LimsOpenTarget } from './open-target';
import { resolveProteinEntityArtifactRevision } from '../proteins/public/save-protein-sequence';
import {
  getCatalogFilesForEntity,
  getWorkspaceRootById,
  getCurrentCatalogFileForEntity,
} from '../../db/workspace-catalog';
import { isSafeWorkspaceRelativePath, pathIsAtOrUnder } from '../../shared/path-boundary';
import { primerServices } from '../primers/public/primer-services';

async function openProteinTab(
  target: Extract<LimsOpenTarget, { kind: 'protein_sequence' }>,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await openDocument({
    target: { kind: 'record', tabType: 'protein', entityId: target.entityId },
    label: target.label,
    placement: { kind: 'smart' },
    ...(signal ? { signal } : {}),
  });
  if (signal?.aborted) return null;
  if (result.status !== 'presented')
    throw new Error('message' in result ? result.message : result.reason);
  return result.tabId;
}

let limsOpenNavSeq = 0;

function applyTabFocus(tabId: string, focus: TabViewState): void {
  const store = useCanvasStore.getState();
  for (const panel of Object.values(store.panels)) {
    if (panel.tabs.some((tab) => tab.id === tabId)) {
      store.setTabViewState(panel.id, tabId, {
        ...focus,
        sequenceNavigationRequestId: ++limsOpenNavSeq,
      });
      return;
    }
  }
}

export type OpenLimsEntityResult =
  | {
      status: 'opened_record';
      tabId: string;
      target: Extract<LimsOpenTarget, { kind: 'record_file' }>;
    }
  | {
      status: 'opened_primer';
      tabId: string;
      target: Extract<LimsOpenTarget, { kind: 'primer' }>;
    }
  | {
      status: 'opened_molecular_document';
      tabId: string;
      target: Extract<LimsOpenTarget, { kind: 'molecular_document' }>;
    }
  | {
      status: 'opened_record';
      tabId: string;
      target: Extract<LimsOpenTarget, { kind: 'record_detail' }>;
    }
  | {
      status: 'opened';
      tabId: string;
      target:
        | Extract<LimsOpenTarget, { kind: 'sequence_file' }>
        | Extract<LimsOpenTarget, { kind: 'managed_sequence' }>;
    }
  | {
      status: 'opened_protein';
      tabId: string;
      target: Extract<LimsOpenTarget, { kind: 'protein_sequence' }>;
    }
  | {
      status: 'opened_notebook';
      tabId: string;
      target: Extract<LimsOpenTarget, { kind: 'notebook' }>;
    }
  | {
      status: 'opened_track_view';
      tabId: string;
      target: Extract<LimsOpenTarget, { kind: 'track_view' }>;
    }
  | {
      status: 'not_found';
      target: Extract<LimsOpenTarget, { kind: 'missing_entity' }>;
      message: string;
    }
  | {
      status: 'unsupported';
      target: Exclude<
        LimsOpenTarget,
        {
          kind:
            | 'managed_sequence'
            | 'sequence_file'
            | 'protein_sequence'
            | 'notebook'
            | 'track_view'
            | 'primer'
            | 'record_file'
            | 'molecular_document'
            | 'missing_entity';
        }
      >;
      message: string;
    }
  | {
      status: 'not_opened';

      target: LimsOpenTarget | null;
      message: string;
    };

function cancelledLimsEntityOpen(target: LimsOpenTarget | null = null): OpenLimsEntityResult {
  return { status: 'not_opened', target, message: 'Opening cancelled.' };
}

export function isLimsEntityOpened(result: OpenLimsEntityResult): result is Extract<
  OpenLimsEntityResult,
  {
    status:
      | 'opened'
      | 'opened_protein'
      | 'opened_notebook'
      | 'opened_track_view'
      | 'opened_primer'
      | 'opened_record'
      | 'opened_molecular_document';
  }
> {
  return (
    result.status === 'opened' ||
    result.status === 'opened_record' ||
    result.status === 'opened_protein' ||
    result.status === 'opened_notebook' ||
    result.status === 'opened_track_view' ||
    result.status === 'opened_primer' ||
    result.status === 'opened_molecular_document'
  );
}

export async function openLimsEntity(input: {
  entityId: string;
  strategy?: OpenStrategy;
  signal?: AbortSignal;

  focus?: TabViewState;
}): Promise<OpenLimsEntityResult> {
  if (input.signal?.aborted) return cancelledLimsEntityOpen();
  const target = await resolveLimsEntityOpenTarget(input.entityId);
  if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
  const signalOptions = input.signal ? { signal: input.signal } : {};

  if (target.kind === 'molecular_document') {
    const file = await getCurrentCatalogFileForEntity(target.entityId);
    if (!file)
      return {
        status: 'not_opened',
        target,
        message: 'The molecular document file is unavailable.',
      };
    const result = await openDocument({
      target: { kind: 'file', path: file.path },
      label: target.label,
      placement: input.strategy,
    });
    if (result.status !== 'presented')
      return {
        status: 'not_opened',
        target,
        message: 'message' in result ? result.message : result.reason,
      };
    return { status: 'opened_molecular_document', tabId: result.tabId, target };
  }

  if (target.kind === 'missing_entity') {
    return {
      status: 'not_found',
      target,
      message: `LIMS entity not found: ${target.entityId}`,
    };
  }

  if (target.kind === 'record_file') {
    const result = await openDocument({
      target: { kind: 'record', tabType: 'record', entityId: target.entityId },
      label: target.label,
      placement: input.strategy ?? { kind: 'focused' },
      ...signalOptions,
    });
    if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
    return result.status === 'presented'
      ? { status: 'opened_record', tabId: result.tabId, target }
      : {
          status: 'not_opened',
          target,
          message: 'message' in result ? result.message : result.reason,
        };
  }

  if (target.kind === 'primer') {
    try {
      const bindings = (await getCatalogFilesForEntity(target.entityId)).filter(
        (file) => file.status === 'current' && file.file_kind === 'primer-artifact'
      );
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      if (bindings.length > 1)
        throw new Error('This primer has conflicting current file bindings.');
      const binding = bindings[0];
      const workspaceRoot = await getWorkspaceRootById(binding?.workspace_id ?? target.workspaceId);
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      if (!workspaceRoot) throw new Error('The project that owns this primer is unavailable.');
      if (!isSafeWorkspaceRelativePath(target.artifactRelativePath)) {
        throw new Error('This primer has an invalid saved file location.');
      }
      const separator = workspaceRoot.includes('\\') ? '\\' : '/';
      const artifactPath =
        binding?.path ??
        `${workspaceRoot.replace(/[\\/]+$/, '')}${separator}${target.artifactRelativePath.replace(/\//g, separator)}`;
      if (!pathIsAtOrUnder(artifactPath, workspaceRoot)) {
        throw new Error('The saved primer is outside its owning project.');
      }
      try {
        const loaded = await primerServices.persistence.readArtifactAtPath(
          artifactPath,
          workspaceRoot
        );
        if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
        if (
          loaded.artifact.registry.entityId !== target.entityId ||
          (binding && loaded.artifact.id !== binding.entity_id)
        )
          throw new Error('The saved primer identity does not match the selected Registry record.');
      } catch (error) {
        if (
          !(error instanceof PrimerPublicationPendingError) ||
          !binding ||
          error.pending.entityId !== target.entityId ||
          error.pending.entityId !== binding.entity_id ||
          error.pending.workspaceId !== binding.workspace_id ||
          !isSafeWorkspaceRelativePath(error.pending.relativePath) ||
          `${workspaceRoot.replace(/[\\/]+$/, '')}${separator}${error.pending.relativePath.replace(/\//g, separator)}` !==
            artifactPath
        )
          throw error;
      }
      const result = await openDocument({
        target: { kind: 'file', path: artifactPath, tabType: 'primer' },
        label: target.label,
        placement: input.strategy ?? { kind: 'focused' },
        ...signalOptions,
      });
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      return result.status === 'presented'
        ? { status: 'opened_primer', tabId: result.tabId, target }
        : {
            status: 'not_opened',
            target,
            message: 'message' in result ? result.message : result.reason,
          };
    } catch (error) {
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      return {
        status: 'not_opened',
        target,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (target.kind === 'record_detail') {
    const entity = await getLimsEntityById(target.entityId);
    if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
    const binding = entity ? await getCurrentCatalogFileForEntity(entity.id) : null;
    if (input.signal?.aborted) return cancelledLimsEntityOpen(target);

    if (entity?.workspaceId != null && binding?.workspace_id === entity.workspaceId) {
      const result = await openDocument({
        target: { kind: 'file', path: binding.path },
        label: target.label,
        placement: input.strategy ?? { kind: 'smart' },
        ...signalOptions,
      });
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      if (result.status === 'presented')
        return { status: 'opened_record', tabId: result.tabId, target };
      return {
        status: 'unsupported',
        target,
        message: 'message' in result ? result.message : result.reason,
      };
    }
  }

  if (target.kind === 'notebook') {
    const tabId = useCanvasStore
      .getState()
      .openWithSmartPlacement('page', target.entityId, target.label);
    return { status: 'opened_notebook', tabId, target };
  }

  if (target.kind === 'track_view') {
    const result = await openDocument({
      target: { kind: 'track-view', id: target.entityId },
      label: target.label,
      placement: input.strategy,
      ...signalOptions,
    });
    if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
    if (result.status !== 'presented') {
      return {
        status: 'not_opened',
        target,
        message: 'message' in result ? result.message : result.reason,
      };
    }
    return { status: 'opened_track_view', tabId: result.tabId, target };
  }

  if (target.kind === 'protein_sequence') {
    if (!target.filePath) {
      const entity = await getLimsEntityById(target.entityId);
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      if (!entity || entity.tombstone) {
        return {
          status: 'not_found',
          target: {
            kind: 'missing_entity',
            entityId: target.entityId,
            label: target.label,
            reason: 'not_found',
          },
          message: `LIMS entity not found: ${target.entityId}`,
        };
      }
      const resolution = await resolveProteinEntityArtifactRevision({
        entity,
        workspaceRoots: useWorkspaceStore.getState().folders.map((folder) => folder.path),
      });
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      if (resolution.status === 'missing-authority') {
        return {
          status: 'not_found',
          target: {
            kind: 'missing_entity',
            entityId: target.entityId,
            label: target.label,
            reason: 'not_found',
          },
          message: `LIMS entity not found: ${target.entityId}`,
        };
      }
    }
    const tabId = await openProteinTab(target, input.signal);
    if (!tabId || input.signal?.aborted) return cancelledLimsEntityOpen(target);
    return { status: 'opened_protein', tabId, target };
  }

  if (target.kind === 'managed_sequence') {
    let document = target.document;
    try {
      await managedSequenceRepository.resolve(document);
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
    } catch {
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);

      const recovered = await managedSequenceRepository.findById(
        document.packageId,
        useWorkspaceStore.getState().folders.map((folder) => folder.path)
      );
      if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
      if (!recovered) {
        return {
          status: 'not_opened',
          target,
          message: `Could not find the managed package for ${target.label}.`,
        };
      }
      document = recovered.ref;
    }

    const tabId = await openManagedSequenceDocument(document, {
      label: target.label,
      strategy: input.strategy ?? { kind: 'focused' },
      ...signalOptions,
    });
    if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
    if (!tabId) {
      return { status: 'not_opened', target, message: `Could not open ${target.label}.` };
    }
    if (input.focus) applyTabFocus(tabId, input.focus);
    return { status: 'opened', tabId, target };
  }

  if (target.kind !== 'sequence_file') {
    return {
      status: 'unsupported',
      target,
      message: detailTargetMessage(target),
    };
  }

  const resolvedDocument = await resolveSequenceDocumentById(
    target.documentId,
    useWorkspaceStore.getState().folders.map((folder) => folder.path)
  ).catch(() => null);
  if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
  let tabId: string | null;
  if (resolvedDocument) {
    tabId = await openSequenceDocument(resolvedDocument.ref, {
      label: target.label,
      strategy: input.strategy ?? { kind: 'focused' },
      ...signalOptions,
    });
  } else {
    const entity = await getLimsEntityById(target.entityId);
    if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
    const sequence = entity?.fields.sequence;
    if (
      !sequence ||
      typeof sequence !== 'object' ||
      (sequence as { mode?: unknown }).mode !== 'file' ||
      (sequence as { documentId?: unknown }).documentId !== target.documentId ||
      typeof (sequence as { relPath?: unknown }).relPath !== 'string'
    ) {
      return {
        status: 'not_opened',
        target,
        message: `Could not find the sequence document for ${target.label}.`,
      };
    }
    tabId = await openSequenceFile({
      filePath: (sequence as { relPath: string }).relPath,
      label: target.label,
      strategy: input.strategy ?? { kind: 'focused' },
      sourceSurface: 'menu',
      ...signalOptions,
    });
  }

  if (input.signal?.aborted) return cancelledLimsEntityOpen(target);
  if (!tabId) {
    return {
      status: 'not_opened',
      target,
      message: `Could not open ${target.label}.`,
    };
  }

  if (input.focus) applyTabFocus(tabId, input.focus);

  return {
    status: 'opened',
    tabId,
    target,
  };
}

function detailTargetMessage(
  target: Exclude<
    LimsOpenTarget,
    {
      kind:
        | 'sequence_file'
        | 'protein_sequence'
        | 'managed_sequence'
        | 'notebook'
        | 'track_view'
        | 'primer'
        | 'record_file'
        | 'molecular_document';
    }
  >
): string {
  if (target.kind === 'missing_entity') return `LIMS entity not found: ${target.entityId}`;
  if (target.reason === 'strain_evidence') {
    return `${target.label} is a strain record; the strain detail tab is not implemented yet.`;
  }
  if (target.reason === 'inline_sequence') {
    return `${target.label} is an inline sequence record; the inline LIMS detail tab is not implemented yet.`;
  }
  if (target.reason === 'unresolved_sequence') {
    return `${target.label} has no resolved sequence representation yet.`;
  }
  if (target.reason === 'organism_record') {
    return `${target.label} is an organism record; the organism detail tab is not implemented yet.`;
  }
  return `${target.label} has no primary openable representation yet.`;
}
