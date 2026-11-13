import {
  userEntityLabel,
  userMessage,
  userMessageWithValues,
  type UserMessage,
} from '@waypoint/user-messages';
import { inferCatalogFileKind } from '../../../shared/catalog-file-kind';
import { platform } from '../../../platform';
import { usePageStore } from '../store';
import { openDocument } from '../../document-opening/public/open-document';
import type { openSelectedDocument } from '../../document-opening/public/open-selected-document';
import type { OpenSequenceFileOptions } from '../../sequence/public/openSequenceFile';
import type { DocumentOpenResult } from '../../canvas/public/document-presentation';
import type { TabType } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { getTabTypeForFile } from '../../../utils/fileTypes';
import {
  isAbsolutePath,
  looksLikeWorkspacePath,
  parseSequenceDbId,
  resolveWorkspaceEntityPath,
  workspacePathCandidates,
  type WorkspaceFolderRef,
} from '../../../shared/resolve-entity-path';
import { findPrimerRegistryEntityId } from '../../../db/primer-reference-search';
import { getCanonicalOligoEntity } from '../../primers/public/primer-references';
import { planReferenceResolution } from './plan-reference-resolution';
import { resolvePageReference } from './resolve-page-reference';
import { getSequenceWithPath } from '../../../db';
import { resolveWorkspaceScope } from '../../../db/workspace-catalog';
import {
  resolveExactNativeCatalogDestination,
  resolveNativeCatalogDestination,
} from '../../../services/native-catalog-destination';
import { resolveMigrationSequenceDestinationPath } from '../../../services/legacy-migration-sequence-destination';
import { isLimsEntityOpened, openLimsEntity } from '../../lims/public/open-entity';
import { waitForWorkspaceReconcileIdle } from '../../../services/workspace-reconcile-lifecycle';
import type { ReferenceFailure, ReferenceIntent } from './reference-workflow';
import {
  PROJECT_REFERENCE_ENTITY_TYPES,
  type ProjectReferenceEntityType,
} from '../../../db/project-reference-search';

export interface ReferenceOpenDetail {
  entityType?: string | null;
  entityId?: string | null;
  label?: string | null;
  path?: string | null;
  objectUuid?: string | null;
  contentHash?: string | null;
  owningRoot?: string | null;
  projectId?: string | null;
  action?: 'open' | 'reveal';
}

export interface ContainedReference {
  absolutePath: string;
  workspaceRoot: string;
  entityType: string | null | undefined;
  label: string;
  action: 'open' | 'reveal';
}

export interface ReferenceRouteContext {
  readonly folders: readonly WorkspaceFolderRef[];
  readonly signal: AbortSignal;
  readonly handleViewChange: (view: 'files' | 'lims') => void;
  readonly current: (intent: ReferenceIntent) => boolean;
  readonly refuse: (
    intent: ReferenceIntent,
    reason: ReferenceFailure,
    message: UserMessage
  ) => void;
  readonly documentResult: (
    intent: ReferenceIntent,
    result: DocumentOpenResult,
    expected?: { type: TabType; entityId: string }
  ) => void;
  readonly registry: (intent: ReferenceIntent, entityId: string | null, label: string) => void;
  readonly openSelected: (
    intent: ReferenceIntent,
    ...args: Parameters<typeof openSelectedDocument>
  ) => Promise<void>;
  readonly openContained: (input: ContainedReference, intent: ReferenceIntent) => Promise<void>;
  readonly claimPrimerRequest: () => () => boolean;
}

export interface ReferenceRouteRequest {
  readonly detail: ReferenceOpenDetail;
  readonly intent: ReferenceIntent;
  readonly entityId: string;
  readonly owningRoot: string | null;
  readonly action: 'open' | 'reveal';
}

type ReferenceRouteStep = (
  request: ReferenceRouteRequest,
  ctx: ReferenceRouteContext
) => Promise<void>;

export interface EntityReferenceRoute {
  readonly beforeLocation?: ReferenceRouteStep;
  readonly matchesContentHash: boolean;
  readonly matchesPath: 'always' | 'reveal-only';
  readonly byId?: ReferenceRouteStep;
  readonly containedOpen: 'sequence' | 'file';
  readonly revealsPackageRoot: boolean;
}

export function openSequenceReference({
  filePath,
  label,
  strategy,
  sourceSurface,
  signal,
}: OpenSequenceFileOptions) {
  return openDocument({
    target: { kind: 'file', path: filePath, tabType: 'sequence' },
    label,
    placement: strategy,
    source: sourceSurface,
    signal,
  });
}

const openPrimer: ReferenceRouteStep = async ({ detail, intent, entityId }, ctx) => {
  const isLatest = ctx.claimPrimerRequest();
  let registryEntityId: string | null;
  try {
    registryEntityId = await findPrimerRegistryEntityId(entityId);
  } catch {
    registryEntityId = null;
  }
  if (!ctx.current(intent)) return;
  if (!isLatest()) {
    intent.finish({ kind: 'superseded' });
    return;
  }
  ctx.registry(intent, registryEntityId, detail.label ?? entityId);
};

async function presentRegistryEntity(
  ctx: ReferenceRouteContext,
  intent: ReferenceIntent,
  entityId: string,
  label: string
): Promise<void> {
  const previousIds = new Set(
    Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
      panel.tabs.map((tab) => tab.id)
    )
  );
  const result = await openLimsEntity({
    entityId,
    strategy: intent.placement ?? { kind: 'focused' },
  });
  if (!ctx.current(intent)) return;
  if (isLimsEntityOpened(result)) {
    if (result.target.entityId !== entityId) {
      ctx.refuse(intent, 'target_mismatch', userMessage('reference.recordWrongTarget'));
      return;
    }
    const panel = Object.values(useCanvasStore.getState().panels).find((item) =>
      item.tabs.some((tab) => tab.id === result.tabId)
    );
    const tab = panel?.tabs.find((item) => item.id === result.tabId);
    if (!tab || !panel) {
      ctx.refuse(intent, 'target_mismatch', userMessage('reference.recordNotPresented'));
      return;
    }
    ctx.documentResult(
      intent,
      {
        status: 'presented',
        tabId: tab.id,
        panelId: panel.id,
        tabType: tab.type,
        disposition: previousIds.has(tab.id) ? 'reused' : 'created',
        content:
          tab.loadStatus === 'missing'
            ? 'missing'
            : tab.loadStatus === 'error' || tab.loadStatus === 'indexed-error'
              ? 'error'
              : 'loading',
      },
      result.status === 'opened_protein'
        ? { type: 'protein', entityId: result.target.entityId }
        : result.status === 'opened_notebook'
          ? { type: 'page', entityId: result.target.entityId }
          : undefined
    );
    return;
  }
  if (result.status === 'unsupported') {
    ctx.registry(intent, entityId, label);
    return;
  }
  ctx.refuse(
    intent,
    result.status === 'not_found' ? 'target_missing' : 'open_failed',
    userMessage(
      result.status === 'not_found' ? 'reference.recordNotFound' : 'reference.recordOpenFailed'
    )
  );
  return;
}

const openRegistryEntity: ReferenceRouteStep = async ({ intent, entityId }, ctx) => {
  const entity = (
    await platform().lims.queryEntities({ id: entityId, includeArchived: true, limit: 1 })
  )[0];
  if (!ctx.current(intent)) return;
  if (!entity || entity.tombstone || entity.archivedAt !== null) {
    ctx.refuse(intent, 'target_missing', userMessage('reference.recordUnavailable'));
    return;
  }
  await presentRegistryEntity(ctx, intent, entity.id, entity.name);
};

const openRegistryOligo: ReferenceRouteStep = async ({ intent, entityId }, ctx) => {
  try {
    const entity = await getCanonicalOligoEntity(entityId);
    if (ctx.current(intent)) ctx.registry(intent, entity.id, entity.name);
  } catch {
    ctx.refuse(intent, 'target_missing', userMessage('reference.oligoUnavailable'));
  }
};

function openNativeCatalog(exact: boolean): ReferenceRouteStep {
  return async ({ detail, intent, entityId, owningRoot }, ctx) => {
    if (!owningRoot) {
      ctx.refuse(
        intent,
        'missing_owner',
        userMessageWithValues('reference.projectOwnerMissing', {
          label: userEntityLabel(detail.label),
        })
      );
      return;
    }
    const target = exact
      ? await resolveExactNativeCatalogDestination({ workspaceRoot: owningRoot, entityId })
      : await resolveNativeCatalogDestination({
          workspaceRoot: owningRoot,
          rawId: entityId,
          readTextFileSlice: platform().fs.readTextFileSlice,
        });
    if (!ctx.current(intent)) return;
    if (!target) {
      ctx.refuse(intent, 'target_missing', userMessage('reference.projectUnavailable'));
      return;
    }
    if (target.locator.kind === 'workspace_page') {
      const page = await usePageStore.getState().fetchPage(target.locator.pageId);
      if (!ctx.current(intent)) return;
      if (!page) {
        ctx.refuse(intent, 'target_missing', userMessage('reference.notebookUnavailable'));
        return;
      }
      ctx.handleViewChange('files');
      const result = await openDocument({
        target: { kind: 'record', tabType: 'page', entityId: target.locator.pageId },
        label: target.title,
        placement: intent.placement ?? { kind: 'smart' },
        source: exact ? 'search' : 'mention',
        signal: ctx.signal,
      });
      ctx.documentResult(intent, result, { type: 'page', entityId: target.locator.pageId });
      return;
    }
    if (target.locator.kind === 'lims_entity') {
      await presentRegistryEntity(ctx, intent, target.locator.entityId, target.title);
      return;
    }
    ctx.handleViewChange('files');
    if (target.locator.kind === 'legacy_fasta') {
      await ctx.openSelected(
        intent,
        target.locator.absolutePath,
        target.locator.authority.legacyReadView,
        target.title,
        ctx.signal
      );
      return;
    }
    if (
      target.source === 'legacy_index' &&
      inferCatalogFileKind(target.locator.absolutePath) === 'fasta' &&
      (target.locator.tabType === 'sequence' || target.locator.tabType === 'protein')
    ) {
      ctx.documentResult(
        intent,
        await openDocument({
          target: {
            kind: 'legacy-migration-file',
            workspaceRoot: owningRoot,
            targetId: target.rawId,
          },
          placement: intent.placement ?? { kind: 'focused' },
          signal: ctx.signal,
          source: exact ? 'search' : 'mention',
        })
      );
      return;
    }
    if (target.locator.tabType === 'sequence') {
      const sequencePath =
        target.source === 'legacy_index'
          ? await resolveMigrationSequenceDestinationPath({
              fs: platform().fs,
              indexedPath: target.locator.absolutePath,
              workspaceRoot: owningRoot,
            })
          : target.locator.absolutePath;
      if (!ctx.current(intent)) return;
      ctx.documentResult(
        intent,
        await openSequenceReference({
          filePath: sequencePath,
          label: target.title,
          strategy: intent.placement ?? { kind: 'focused' },
          sourceSurface: exact ? 'search' : 'mention',
          signal: ctx.signal,
        })
      );
      return;
    }
    await ctx.openSelected(
      intent,
      target.locator.absolutePath,
      target.locator.tabType,
      target.title,
      ctx.signal
    );
  };
}

const openRegistryRecord: ReferenceRouteStep = async ({ detail, intent, entityId }, ctx) => {
  await presentRegistryEntity(ctx, intent, entityId, detail.label || entityId);
};

const openPageById: ReferenceRouteStep = async ({ detail, intent, entityId, owningRoot }, ctx) => {
  const label = detail.label || 'Page';
  const openRoots = ctx.folders.filter((folder) => !folder.pinned).map((folder) => folder.path);
  if (owningRoot) await waitForWorkspaceReconcileIdle(owningRoot);
  const [scope, scopes] = await Promise.all([
    owningRoot ? resolveWorkspaceScope(owningRoot).catch(() => null) : Promise.resolve(null),
    Promise.all(openRoots.map((root) => resolveWorkspaceScope(root).catch(() => null))),
  ]);
  if (!ctx.current(intent)) return;
  const resolution = resolvePageReference({
    referencedId: entityId,
    owningScope: scope,
    pageIds: Object.keys(usePageStore.getState().pages),
    mountedScopes: scopes.filter((value): value is string => Boolean(value)),
  });
  if (resolution.kind === 'resolved') {
    ctx.documentResult(
      intent,
      await openDocument({
        target: { kind: 'record', tabType: 'page', entityId: resolution.pageId },
        label,
        placement: intent.placement ?? { kind: 'smart' },
        source: 'mention',
        signal: ctx.signal,
      }),
      { type: 'page', entityId: resolution.pageId }
    );
    return;
  }
  if (resolution.kind === 'not-found' && detail.path && owningRoot) {
    const plan = planReferenceResolution(
      { kind: 'legacy-path', path: detail.path },
      { owningRoot, workspaceScopeKey: scope ?? '' }
    );
    if (plan.kind === 'resolve-path') {
      await ctx.openSelected(intent, plan.absolutePath, 'page', label, ctx.signal);
      return;
    }
  }
  ctx.refuse(
    intent,
    resolution.kind === 'ambiguous' ? 'ambiguous' : 'target_missing',
    resolution.kind === 'ambiguous'
      ? userMessageWithValues('reference.projectAmbiguous', { label: userEntityLabel(label) })
      : userMessageWithValues('reference.projectEntryMissing', { label: userEntityLabel(label) })
  );
};

function openWorkspaceFileById(opensAs: 'sequence' | 'file'): ReferenceRouteStep {
  return async ({ detail, intent, entityId, owningRoot, action }, ctx) => {
    if (opensAs === 'sequence') {
      const dbId = parseSequenceDbId(entityId);
      if (dbId != null) {
        const sequence = await getSequenceWithPath(dbId);
        if (!ctx.current(intent)) return;
        if (!sequence?.file_path) {
          ctx.refuse(
            intent,
            'target_missing',
            userMessageWithValues('reference.registryEntryMissing', {
              label: userEntityLabel(detail.label),
            })
          );
          return;
        }
        ctx.documentResult(
          intent,
          await openSequenceReference({
            filePath: sequence.file_path,
            label: detail.label || sequence.name,
            sourceSurface: 'mention',
            signal: ctx.signal,
          })
        );
        return;
      }
    }
    const legacyPath =
      !detail.path && looksLikeWorkspacePath(entityId) && !isAbsolutePath(entityId)
        ? entityId
        : null;
    const portable = detail.path && !isAbsolutePath(detail.path) ? detail.path : legacyPath;
    if (portable) {
      const candidates = workspacePathCandidates(portable, ctx.folders, owningRoot);
      const present: Array<{ path: string; root: string }> = [];
      const candidateRoots = owningRoot
        ? [owningRoot]
        : ctx.folders.filter((folder) => !folder.pinned).map((folder) => folder.path);
      for (const candidate of candidates) {
        try {
          if (!(await platform().fs.exists(candidate))) continue;
          for (const root of candidateRoots) {
            if (
              await platform().fs.validateWorkspacePath({
                workspaceRoot: root,
                path: candidate,
                artifactNoun: 'reference',
              })
            ) {
              present.push({ path: candidate, root });
              break;
            }
          }
        } catch (error) {
          void error;
        }
        if (!ctx.current(intent)) return;
      }
      if (!ctx.current(intent)) return;
      if (present.length === 0) {
        ctx.refuse(
          intent,
          'target_missing',
          userMessageWithValues('reference.projectEntryMissing', {
            label: userEntityLabel(detail.label || portable),
          })
        );
        return;
      }
      if (present.length > 1 && !owningRoot) {
        ctx.refuse(
          intent,
          'ambiguous',
          userMessageWithValues('reference.projectEntryDuplicated', {
            label: userEntityLabel(detail.label || portable),
          })
        );
        return;
      }
      const resolved = present[0];
      await ctx.openContained(
        {
          absolutePath: resolved.path,
          workspaceRoot: resolved.root,
          entityType: detail.entityType,
          label: detail.label || resolved.path.split(/[\\/]/).pop() || 'Sequence',
          action,
        },
        intent
      );
      return;
    }
    const path = resolveWorkspaceEntityPath(entityId, ctx.folders);
    if (!path) {
      ctx.refuse(
        intent,
        'target_missing',
        userMessageWithValues('reference.entryNotFound', { label: userEntityLabel(detail.label) })
      );
      return;
    }
    if (opensAs === 'sequence') {
      ctx.documentResult(
        intent,
        await openSequenceReference({
          filePath: path,
          label: detail.label || path.split(/[\\/]/).pop() || 'Sequence',
          sourceSurface: 'mention',
          signal: ctx.signal,
        })
      );
      return;
    }
    await ctx.openSelected(intent, path, getTabTypeForFile(path), undefined, ctx.signal);
  };
}

export const UNKNOWN_ENTITY_REFERENCE_ROUTE: EntityReferenceRoute = {
  matchesContentHash: true,
  matchesPath: 'always',
  containedOpen: 'sequence',
  revealsPackageRoot: false,
};

const PROJECT_FILE_ROUTE: EntityReferenceRoute = {
  ...UNKNOWN_ENTITY_REFERENCE_ROUTE,
  byId: openWorkspaceFileById('file'),
  containedOpen: 'file',
};

const PROJECT_FILE_ROUTES = Object.fromEntries(
  PROJECT_REFERENCE_ENTITY_TYPES.map((type) => [type, PROJECT_FILE_ROUTE])
) as Record<ProjectReferenceEntityType, EntityReferenceRoute>;

export const REFERENCE_ENTITY_TYPES = [
  'registry-entity',
  'registry-oligo',
  'primer',
  'native-catalog',
  'native-catalog-exact',
  'registry',
  'page',
  'sequence',
  ...PROJECT_REFERENCE_ENTITY_TYPES,
] as const;

export type ReferenceEntityType = (typeof REFERENCE_ENTITY_TYPES)[number];

export const ENTITY_REFERENCE_ROUTES = {
  'registry-entity': { ...UNKNOWN_ENTITY_REFERENCE_ROUTE, beforeLocation: openRegistryEntity },
  'registry-oligo': { ...UNKNOWN_ENTITY_REFERENCE_ROUTE, beforeLocation: openRegistryOligo },
  primer: { ...UNKNOWN_ENTITY_REFERENCE_ROUTE, beforeLocation: openPrimer },
  'native-catalog': { ...UNKNOWN_ENTITY_REFERENCE_ROUTE, beforeLocation: openNativeCatalog(false) },
  'native-catalog-exact': {
    ...UNKNOWN_ENTITY_REFERENCE_ROUTE,
    beforeLocation: openNativeCatalog(true),
  },
  page: {
    ...UNKNOWN_ENTITY_REFERENCE_ROUTE,
    matchesContentHash: false,
    matchesPath: 'reveal-only',
    byId: openPageById,
  },
  sequence: {
    ...UNKNOWN_ENTITY_REFERENCE_ROUTE,
    byId: openWorkspaceFileById('sequence'),
    revealsPackageRoot: true,
  },
  registry: { ...UNKNOWN_ENTITY_REFERENCE_ROUTE, beforeLocation: openRegistryRecord },
  ...PROJECT_FILE_ROUTES,
} as const satisfies Record<ReferenceEntityType, EntityReferenceRoute>;

function isReferenceEntityType(value: string): value is ReferenceEntityType {
  return (REFERENCE_ENTITY_TYPES as readonly string[]).includes(value);
}

export function entityReferenceRoute(entityType: string | null | undefined): EntityReferenceRoute {
  return entityType && isReferenceEntityType(entityType)
    ? ENTITY_REFERENCE_ROUTES[entityType]
    : UNKNOWN_ENTITY_REFERENCE_ROUTE;
}
