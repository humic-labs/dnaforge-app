import {
  type UserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
  toUserMessage,
} from '@waypoint/user-messages';

import { platform } from '../../../platform';
import { useToastStore } from '../../../stores/toast-store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { requestRegistryEntity } from '../../lims/public/registry-presentation';
import { openSelectedDocument } from '../../document-opening/public/open-selected-document';
import type { DocumentOpenResult } from '../../canvas/public/document-presentation';
import type { TabType } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { getTabTypeForFile } from '../../../utils/fileTypes';
import type { WorkspaceFolderRef } from '../../../shared/resolve-entity-path';
import { resolveFileByObjectUuid } from '../../../db/resolve-by-object-uuid';
import { resolveFileByContentHash } from '../../../db/resolve-by-content-hash';
import { resolveProjectRoot } from '../../../db/project-roots';
import { resolveSequencePackageRootForProductPath } from '../../sequence/public/sequence-package-product';
import { planReferenceResolution } from './plan-reference-resolution';
import {
  entityReferenceRoute,
  openSequenceReference,
  type ContainedReference,
  type ReferenceOpenDetail,
  type ReferenceRouteContext,
} from './entity-reference-routes';
import {
  claimReferenceIntent,
  dispatchReferenceEvent,
  type ReferenceFailure,
  type ReferenceIntent,
} from './reference-workflow';

export type { ReferenceOpenDetail } from './entity-reference-routes';

function isReferenceDetail(value: unknown): value is ReferenceOpenDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const key of [
    'entityType',
    'entityId',
    'label',
    'path',
    'objectUuid',
    'contentHash',
    'owningRoot',
    'projectId',
  ]) {
    const field: unknown = Reflect.get(value, key);
    if (field !== undefined && field !== null && typeof field !== 'string') return false;
  }
  const action: unknown = Reflect.get(value, 'action');
  return action === undefined || action === 'open' || action === 'reveal';
}

export function installEntityReferenceHandler({
  folders,
  handleViewChange,
}: {
  folders: readonly WorkspaceFolderRef[];
  handleViewChange: (view: 'files' | 'lims') => void;
}): () => void {
  let active = true;
  const controller = new AbortController();
  let primerRequestId = 0;
  const pending = new Set<ReferenceIntent>();
  const current = (intent: ReferenceIntent) => active && !intent.finished;
  const refuse = (intent: ReferenceIntent, reason: ReferenceFailure, message: UserMessage) => {
    if (!current(intent)) return;
    useToastStore.getState().addToast(message, { definition: 'document-open-refused' });
    intent.finish({ kind: 'failure', reason });
  };
  const documentResult = (
    intent: ReferenceIntent,
    result: DocumentOpenResult,
    expected?: { type: TabType; entityId: string }
  ) => {
    if (!current(intent)) return;
    if (result.status === 'presented') {
      const { panelId, tabId } = result;
      const tab = useCanvasStore
        .getState()
        .panels[panelId]?.tabs.find((candidate) => candidate.id === tabId);
      if (
        !tab ||
        tab.type !== result.tabType ||
        (expected && (tab.type !== expected.type || tab.entityId !== expected.entityId))
      ) {
        refuse(
          intent,
          'target_mismatch',
          userMessage(
            'link.refusal.the-reference-did-not-reach-its-intended-document-check-its-target-and-try-again'
          )
        );
        return;
      }
      if (tab.loadStatus === 'missing') result = { ...result, content: 'missing' };
      else if (tab.loadStatus === 'error' || tab.loadStatus === 'indexed-error')
        result = { ...result, content: 'error' };
    }
    if (
      result.status === 'presented' &&
      (result.content === 'missing' || result.content === 'error')
    ) {
      useToastStore
        .getState()
        .addToast(
          userMessage(
            'notice.the-referenced-document-could-not-be-loaded-check-its-location-and-try'
          ),
          { definition: 'document-open-refused' }
        );
    } else if ('message' in result) {
      useToastStore.getState().addToast(toUserMessage(result, 'operation.failed'), {
        definition: 'document-open-refused',
      });
    }
    intent.finish({ kind: 'document', result });
  };
  const registry = (intent: ReferenceIntent, entityId: string | null, label: string) => {
    if (!current(intent)) return;
    handleViewChange('lims');
    requestRegistryEntity(entityId, label, (result) => {
      if (!current(intent)) return;
      if (result.kind === 'record' && result.entityId === entityId)
        intent.finish({ kind: 'registry_record' });
      else if (result.kind === 'search' && entityId === null)
        intent.finish({ kind: 'registry_search' });
      else if (result.kind === 'superseded') intent.finish({ kind: 'superseded' });
      else if (result.kind === 'cancelled') intent.finish({ kind: 'cancelled' });
      else
        intent.finish({
          kind: 'failure',
          reason:
            result.kind === 'record' || result.kind === 'mismatch'
              ? 'target_mismatch'
              : 'target_missing',
        });
    });
  };
  const openSelected = async (
    intent: ReferenceIntent,
    ...args: Parameters<typeof openSelectedDocument>
  ) => {
    const result = intent.placement
      ? await openSelectedDocument(args[0], args[1], args[2], args[3], intent.placement)
      : await openSelectedDocument(...args);
    if (!current(intent)) return;
    if (result.status === 'presented') documentResult(intent, result);
    else intent.finish({ kind: 'document', result });
  };
  const openContained = async (input: ContainedReference, intent: ReferenceIntent) => {
    const contained = await platform().fs.validateWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      path: input.absolutePath,
      artifactNoun: 'reference',
    });
    if (!current(intent)) return;
    if (!contained) {
      refuse(
        intent,
        'refused',
        userMessageWithValues('link.refusal.refused-to-open-value0-outside-its-project', {
          value0: userMessageValue(input.label),
        })
      );
      return;
    }
    const route = entityReferenceRoute(input.entityType);
    if (input.action === 'reveal') {
      const packageRoot = route.revealsPackageRoot
        ? await resolveSequencePackageRootForProductPath(input.absolutePath).catch(() => null)
        : null;
      if (!current(intent)) return;
      handleViewChange('files');
      useWorkspaceStore.getState().revealPath(packageRoot ?? input.absolutePath);
      intent.finish({ kind: 'reveal_requested' });
      return;
    }
    if (route.containedOpen === 'file') {
      await openSelected(
        intent,
        input.absolutePath,
        getTabTypeForFile(input.absolutePath),
        undefined,
        controller.signal
      );
    } else {
      documentResult(
        intent,
        await openSequenceReference({
          filePath: input.absolutePath,
          label: input.label,
          sourceSurface: 'mention',
          signal: controller.signal,
          strategy: intent.placement,
        })
      );
    }
  };
  const forward = (detail: ReferenceOpenDetail, intent: ReferenceIntent) => {
    if (current(intent)) dispatchReferenceEvent(detail, intent);
  };
  const routeContext: ReferenceRouteContext = {
    folders,
    signal: controller.signal,
    handleViewChange,
    current,
    refuse: (intent, reason, message) => refuse(intent, reason, toUserMessage(message)),
    documentResult,
    registry,
    openSelected,
    openContained,
    claimPrimerRequest: () => {
      const requestId = ++primerRequestId;
      return () => requestId === primerRequestId;
    },
  };
  const open = async (detail: ReferenceOpenDetail, intent: ReferenceIntent) => {
    const entityId = detail.entityId;
    const action = detail.action === 'reveal' ? 'reveal' : 'open';
    const route = entityReferenceRoute(detail.entityType);
    const nonPinnedRoots = folders.filter((folder) => !folder.pinned);
    const projectRoot = detail.projectId
      ? await resolveProjectRoot(detail.projectId).catch(() => null)
      : null;
    if (!current(intent)) return;
    const owningRoot =
      projectRoot ??
      detail.owningRoot ??
      (nonPinnedRoots.length === 1 ? nonPinnedRoots[0].path : null);
    if (route.beforeLocation && entityId) {
      await route.beforeLocation({ detail, intent, entityId, owningRoot, action }, routeContext);
      return;
    }
    if (detail.objectUuid && owningRoot) {
      let found;
      try {
        found = await resolveFileByObjectUuid(detail.objectUuid, owningRoot);
      } catch {
        found = null;
      }
      if (!current(intent)) return;
      if (found) {
        await openContained(
          {
            absolutePath: found.absolutePath,
            workspaceRoot: owningRoot,
            entityType: detail.entityType,
            label: detail.label || found.absolutePath.split(/[\\/]/).pop() || 'Sequence',
            action,
          },
          intent
        );
        return;
      }
      forward({ ...detail, objectUuid: null }, intent);
      return;
    }
    if (detail.contentHash && owningRoot && route.matchesContentHash) {
      let found;
      try {
        found = await resolveFileByContentHash(detail.contentHash, owningRoot);
      } catch {
        found = null;
      }
      if (!current(intent)) return;
      if (found) {
        await openContained(
          {
            absolutePath: found.absolutePath,
            workspaceRoot: owningRoot,
            entityType: detail.entityType,
            label: detail.label || found.absolutePath.split(/[\\/]/).pop() || 'Sequence',
            action,
          },
          intent
        );
        return;
      }
      forward({ ...detail, objectUuid: null, contentHash: null }, intent);
      return;
    }
    if (detail.path && owningRoot && (route.matchesPath === 'always' || action === 'reveal')) {
      const label = detail.label || detail.path.split(/[\\/]/).pop() || 'Sequence';
      const plan = planReferenceResolution(
        { kind: 'legacy-path', path: detail.path },
        { owningRoot, workspaceScopeKey: '' }
      );
      if (plan.kind !== 'resolve-path') {
        refuse(
          intent,
          'refused',
          userMessageWithValues('link.refusal.refused-to-open-value0-outside-its-project', {
            value0: userMessageValue(label),
          })
        );
        return;
      }
      await openContained(
        {
          absolutePath: plan.absolutePath,
          workspaceRoot: owningRoot,
          entityType: detail.entityType,
          label,
          action,
        },
        intent
      );
      return;
    }
    if (!entityId) {
      refuse(
        intent,
        !owningRoot && (detail.objectUuid || detail.contentHash)
          ? 'missing_owner'
          : 'target_missing',
        userMessage(
          'link.refusal.the-reference-has-no-available-target-check-its-project-and-try-again'
        )
      );
      return;
    }
    if (!route.byId) {
      refuse(
        intent,
        'unsupported',
        userMessage('link.refusal.this-reference-does-not-have-a-supported-destination')
      );
      return;
    }
    await route.byId({ detail, intent, entityId, owningRoot, action }, routeContext);
  };
  const handler = (event: Event) => {
    const intent = claimReferenceIntent(event);
    if (!intent) return;
    if (!current(intent)) return;
    for (const item of pending) if (item.finished) pending.delete(item);
    pending.add(intent);
    let detail: unknown;
    try {
      detail = event instanceof CustomEvent ? event.detail : undefined;
    } catch {
      detail = undefined;
    }
    try {
      if (!isReferenceDetail(detail)) {
        refuse(
          intent,
          'unsupported',
          userMessage('link.refusal.this-reference-is-not-valid-check-its-target-and-try-again')
        );
        return;
      }
      void open(detail, intent).catch(() => {
        refuse(
          intent,
          'open_failed',
          userMessage('link.refusal.project-reference-unavailable-check-its-project-and-try-again')
        );
      });
    } catch {
      refuse(
        intent,
        'open_failed',
        userMessage('link.refusal.project-reference-unavailable-check-its-project-and-try-again')
      );
    }
  };
  window.addEventListener('waypoint:open-entity', handler);
  return () => {
    active = false;
    primerRequestId += 1;
    controller.abort();
    window.removeEventListener('waypoint:open-entity', handler);
    for (const intent of pending) intent.finish({ kind: 'cancelled' });
    pending.clear();
  };
}
