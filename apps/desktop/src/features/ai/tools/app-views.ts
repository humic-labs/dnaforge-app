import { isTabDirty } from '../../canvas/public/artifact-document-lifecycle';
export { appViewsOutputSchema } from './workspace-edit-output-schemas';
import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { useCanvasStore } from '../../canvas/public/store';
import { authorizedProjectTabs, projectAuthorizedCanvas, sameTabResource } from '../../canvas/public/project-authorized-canvas';
import { useSequenceStore } from '../../sequence/public/store';
import { getMountedCommandRegistry } from '../../../commands/mounted-command-registry';
import { COMMAND_IDS } from '../../../commands/types';
import { getTrackViewControl } from '../../sequence/public/track-view-control';
import {
  inspectSequenceAnnotationTracks,
  updateSequenceAnnotationTracks,
  type SequenceAnnotationTracksCommand,
} from '../../sequence/public/annotation-catalog-commands';
import { contentFingerprint } from '../../../shared/content-fingerprint';
import { sequenceTrackCommandSchema } from './sequence-track-command-schema';
import type { AgentProjectScope } from '../../../shared/agent-project-scope';
import { listSavedTrackViews } from '../../sequence/public/track-view-library';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { findContainingPathBoundary, pathIsAtOrUnder } from '../../../shared/path-boundary';
import { resolveMultiRootPath } from './path-utils';
import {
  resolveExplicitProjectRoot,
  soleWritableProjectRoot,
} from '../../../shared/project-root-selection';

export const SHELL_NAVIGATION_COMMANDS = {
  files: COMMAND_IDS.appShowExplorer,
  search: COMMAND_IDS.workspaceSearch,
  settings: COMMAND_IDS.appOpenSettings,
  'new-chat': COMMAND_IDS.appNewChat,
  'command-input': COMMAND_IDS.appFocusCommandInput,
  'toggle-sidebar': COMMAND_IDS.appToggleSidebar,
} as const;

const savedViewFields = {
  tabId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\\/]/u.test(value), 'Use a view name without path separators.'),
  expectedRevision: z.string().min(1),
  destinationProject: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
};

export const appViewsSchema = z
  .object({
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('inspect'), tabId: z.string().min(1).optional() }).strict(),
      z.object({ kind: z.literal('inspect-tracks'), tabId: z.string().min(1) }).strict(),
      z.object({
        kind: z.literal('configure-tracks'),
        tabId: z.string().min(1),
        expectedRevision: z.string().min(1),
        command: sequenceTrackCommandSchema,
      }).strict(),
      z
        .object({
          kind: z.literal('list'),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      z.object({ kind: z.literal('open'), viewId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('save'), ...savedViewFields }).strict(),
      z.object({ kind: z.literal('rename'), ...savedViewFields }).strict(),
      z.object({ kind: z.literal('duplicate'), ...savedViewFields }).strict(),
      z
        .object({
          kind: z.literal('navigate'),
          target: z.enum([
            'files',
            'search',
            'settings',
            'new-chat',
            'command-input',
            'toggle-sidebar',
          ]),
          settingsFocus: z
            .enum([
              'api-keys',
              'assistant',
              'account',
              'privacy',
              'migrations',
              'primer-tm',
              'organizations',
            ])
            .optional(),
        })
        .strict(),
      z.object({ kind: z.literal('activate'), tabId: z.string() }).strict(),
      z.object({ kind: z.literal('close'), tabId: z.string() }).strict(),
      z
        .object({
          kind: z.literal('move'),
          tabId: z.string(),
          panelId: z.string(),
          index: z.number().int().min(0).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('split'),
          panelId: z.string(),
          direction: z.enum(['horizontal', 'vertical']),
        })
        .strict(),
      z
        .object({ kind: z.literal('merge'), sourcePanelId: z.string(), targetPanelId: z.string() })
        .strict(),
      z.object({ kind: z.literal('join-all') }).strict(),
      z.object({ kind: z.literal('reopen-last-closed') }).strict(),
    ]),
  })
  .strict();
export function createAppViewsTool(folders: readonly WorkspaceFolder[] = [], projectScope?: AgentProjectScope) {
  return resultTool({
    description:
      'Inspect and arrange DNAForge tabs/panels. inspect-tracks reads a sequence tab’s annotation catalog, sources, styles and revision; configure-tracks applies typed track changes through the human Tracks panel owner with expectedRevision. Inspect with tabId reads a saved Track View and its revision; list and open discover/reopen saved Track Views. Save, rename and duplicate use the human view save owner and require expectedRevision. New saves require an exact writable destinationProject when several projects are mounted; optional path is relative to that project. Scientific source and layout settings are preserved. Activate, move, split, merge, join, close and reopen control the canvas. navigate uses human shell commands. Dirty documents refuse close. App pane changes do not move the native desktop window.',
    inputSchema: appViewsSchema,
    execute: async ({ operation }) => {
      let store = useCanvasStore.getState();
      let attempted = false;
      const fail = (code: string, error: string) =>
        toolFailure({
          code,
          error,
          retriable: false,
          stateChanged: attempted ? 'unknown' : false,
          partialEffects: [],
        });
      const restricted = projectScope?.kind === 'project-roots';
      const canvas = await projectAuthorizedCanvas(store, folders, projectScope);
      store = useCanvasStore.getState();
      const targetId = 'tabId' in operation ? operation.tabId : undefined;
      const expectedTab = targetId
        ? Object.values(canvas.panels).flatMap((panel) => panel.tabs).find((tab) => tab.id === targetId)
        : undefined;
      const verifyTarget = () => {
        if (!restricted || !targetId) return null;
        if (!expectedTab)
          return fail('OUTSIDE_WORKSPACE', 'This view is outside the caller project access.');
        const current = Object.values(useCanvasStore.getState().panels)
          .flatMap((panel) => panel.tabs).find((tab) => tab.id === targetId);
        return current && sameTabResource(expectedTab, current)
          ? null
          : fail('STALE_CANVAS', 'This tab changed while checking project access. Inspect the canvas again.');
      };
      const changedTarget = verifyTarget();
      if (changedTarget) return changedTarget;
      if (operation.kind === 'inspect-tracks' || operation.kind === 'configure-tracks') {
        try {
        const tab = Object.values(store.panels)
          .flatMap((panel) => panel.tabs)
          .find((candidate) => candidate.id === operation.tabId);
        const document = tab?.sequenceDocument;
        let ownerPath = tab?.trackView?.workspaceRoot ?? tab?.trackView?.path ??
          (document?.kind === 'managed-sequence' ? document.packageRoot :
            document?.kind === 'import-source-sequence' ? document.sourcePath : null);
        if (!ownerPath && tab) {
            const { getCatalogEntity, getWorkspaceRootById } = await import('../../../db/workspace-catalog');
          const entity = await getCatalogEntity(tab.entityId);
          if (entity) ownerPath = await getWorkspaceRootById(entity.workspace_id);
        }
        const changedTrackTarget = verifyTarget();
        if (changedTrackTarget) return changedTrackTarget;
        if ((ownerPath && !folders.some((folder) => pathIsAtOrUnder(ownerPath!, folder.path))) ||
          (!ownerPath && projectScope?.kind === 'project-roots'))
          return fail('OUTSIDE_WORKSPACE', 'This sequence view is outside the caller project access.');
        const inspect = () => {
          const state = inspectSequenceAnnotationTracks(operation.tabId);
          return {
            ...state,
            revision: `sequence-tracks-v1:${contentFingerprint(JSON.stringify({
              tabId: operation.tabId,
              documentId: tab?.entityId,
              layout: state.status === 'found' ? state.layout : null,
              assembly: state.status === 'found' ? state.assembly?.accession : null,
            }))}`,
          };
        };
        const current = inspect();
        if (current.status !== 'found')
          return fail('SEQUENCE_VIEW_NOT_FOUND', 'Inspect a currently open sequence tab.');
        if (operation.kind === 'inspect-tracks') return toolSuccess(current);
        if (operation.expectedRevision !== current.revision)
          return fail('STALE_VIEW', 'The annotation tracks changed. Inspect them again before editing.');
        if (!current.assembly)
          return fail('ANNOTATION_CATALOG_UNAVAILABLE', 'Wait for a supported sequence annotation catalog to load.');
        if (operation.command.kind === 'set-layout' && operation.command.layout.assembly !== current.assembly.accession)
          return fail('WRONG_TRACK_ASSEMBLY', 'Choose tracks from the assembly returned by inspect-tracks.');
        attempted = true;
        const result = updateSequenceAnnotationTracks({
          ownerTabId: operation.tabId,
          command: operation.command as SequenceAnnotationTracksCommand,
        });
        if (result.status === 'missing') {
          attempted = false;
          return fail('SEQUENCE_VIEW_NOT_FOUND', 'That sequence tab has closed.');
        }
        if (result.status === 'invalid') {
          attempted = false;
          return fail('INVALID_TRACK_CONFIGURATION', result.issues.map((issue) => issue.message).join('\n'));
        }
        return toolSuccess({ ...inspect(), applied: true });
        } catch (error) {
          return fail('TRACK_OPERATION_FAILED', error instanceof Error ? error.message : String(error));
        }
      }
      if (operation.kind === 'list' || operation.kind === 'open') {
        try {
          const result = await listSavedTrackViews();
          const views = result.views.filter(
            (view) =>
              folders.some((folder) => pathIsAtOrUnder(view.workspaceRoot ?? view.path, folder.path))
          );
          if (operation.kind === 'list')
            return toolSuccess({
              views: views
                .slice(operation.offset, operation.offset + operation.limit)
                .map((view) => ({
                  viewId: view.document.id,
                  name: view.document.name,
                  revision: view.revision,
                })),
              total: views.length,
              nextOffset:
                operation.offset + operation.limit < views.length
                  ? operation.offset + operation.limit
                  : null,
              errors: result.errors,
            });
          if (!views.some((view) => view.document.id === operation.viewId))
            return fail('VIEW_NOT_FOUND', 'List saved views for a current identity.');
          attempted = true;
          const { openTrackView } = await import('../../sequence/public/open-track-view');
          const tabId = await openTrackView(operation.viewId);
          return toolSuccess({ viewId: operation.viewId, tabId, opened: true });
        } catch (error) {
          return fail(
            'VIEW_OPERATION_FAILED',
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      if (
        operation.kind === 'save' ||
        operation.kind === 'rename' ||
        operation.kind === 'duplicate' ||
        (operation.kind === 'inspect' && operation.tabId)
      ) {
        try {
          const tabId = operation.tabId!;
          const control = getTrackViewControl(tabId);
          if (!control)
            return fail(
              'VIEW_NOT_READY',
              'Open the view and wait for its reference to finish loading.'
            );
          const state = control.inspect();
          if (
            ((state.workspaceRoot || state.path) &&
            !folders.some((folder) => pathIsAtOrUnder((state.workspaceRoot ?? state.path)!, folder.path))) ||
            (!state.workspaceRoot && !state.path && projectScope?.kind === 'project-roots')
          )
            return fail('OUTSIDE_WORKSPACE', 'This saved view belongs to another project.');
          if (operation.kind === 'inspect') return toolSuccess({ tabId, ...state });
          if (state.revision !== operation.expectedRevision)
            return fail('STALE_VIEW', 'The view changed. Inspect it again before saving.');
          const existing =
            operation.kind !== 'duplicate' && state.path
              ? findContainingPathBoundary(folders, state.path)
              : null;
          const project = operation.destinationProject
            ? resolveExplicitProjectRoot(
                folders.filter((folder) => !folder.pinned),
                operation.destinationProject
              )
            : (existing ?? soleWritableProjectRoot(folders));
          if (state.path && operation.kind !== 'duplicate' && !existing)
            return fail(
              'OUTSIDE_WORKSPACE',
              'Duplicate this saved view into a writable project before changing it.'
            );
          if (!project || project.pinned)
            return fail(
              'PROJECT_REQUIRED',
              'Choose the exact writable destinationProject from get_workspace.'
            );
          if (
            operation.kind === 'rename' &&
            (!state.path || operation.path || operation.destinationProject)
          )
            return fail(
              'INVALID_RENAME',
              'Rename an existing view in its current project; use duplicate to choose another destination.'
            );
          if (
            operation.kind === 'save' &&
            state.path &&
            (operation.path || operation.destinationProject)
          )
            return fail(
              'INVALID_DESTINATION',
              'Use duplicate to save an existing view at another destination.'
            );
          const destination =
            existing && !operation.path
              ? { workspaceRoot: existing.path, path: state.path! }
              : {
                  workspaceRoot: project.path,
                  path: resolveMultiRootPath(
                    [project],
                    operation.path ?? `${operation.name}.dnaforge-track-view.json`
                  ).absolutePath,
                };
          attempted = true;
          const result = await control.save({
            name: operation.name,
            mode: operation.kind === 'duplicate' ? 'copy' : operation.kind,
            expectedRevision: operation.expectedRevision,
            destination,
          });
          if (!result.ok) return fail('VIEW_SAVE_FAILED', result.error);
          return toolSuccess({
            viewId: result.saved.document.id,
            name: result.saved.document.name,
            saved: true,
            dirty: result.dirty,
            revision: result.saved.revision,
            path: result.saved.path,
            warning: result.warning,
          });
        } catch (error) {
          return fail(
            'VIEW_OPERATION_FAILED',
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      if (operation.kind === 'navigate') {
        if (operation.settingsFocus && operation.target !== 'settings')
          return fail('INVALID_NAVIGATION', 'settingsFocus applies only to Settings.');
        const registry = getMountedCommandRegistry();
        if (!registry) return fail('APP_NOT_READY', 'The app command owner is not mounted.');
        const receipt = registry.dispatchCommand(SHELL_NAVIGATION_COMMANDS[operation.target], {
          source: 'agent',
          payload: operation.target === 'settings' ? { focus: operation.settingsFocus } : undefined,
        });
        if (!receipt.handled)
          return fail(
            receipt.blocked ? 'COMMAND_BLOCKED' : 'COMMAND_UNAVAILABLE',
            receipt.blocked
              ? 'Close the active modal, menu or input interaction first.'
              : 'This command has no active handler.'
          );
        return toolSuccess({ dispatched: true, ...receipt });
      }
      if (operation.kind === 'inspect')
        return toolSuccess({
          focusedPanelId: canvas.focusedPanelId,
          layout: canvas.layout,
          panels: Object.values(canvas.panels).map((panel) => ({
            id: panel.id,
            activeTabId: panel.activeTabId,
            tabs: panel.tabs.map((tab) => ({
              id: tab.id,
              type: tab.type,
              label: tab.label,
              entityId: tab.entityId,
              dirty: isTabDirty(tab),
              readOnly: Boolean(tab.readOnly),
            })),
          })),
        });
      if (restricted) {
        const ownsPanel = (id: string) =>
          store.panels[id]?.tabs.every((tab) =>
            canvas.panels[id]?.tabs.some((allowed) => sameTabResource(allowed, tab))
          ) ?? false;
        if (
          ('panelId' in operation && !ownsPanel(operation.panelId)) ||
          (operation.kind === 'split' && !ownsPanel(operation.panelId)) ||
          (operation.kind === 'merge' && (!ownsPanel(operation.sourcePanelId) || !ownsPanel(operation.targetPanelId))) ||
          (operation.kind === 'join-all' && !Object.keys(store.panels).every(ownsPanel))
        )
          return fail('OUTSIDE_WORKSPACE', 'This panel is outside the caller project access.');
        if (operation.kind === 'reopen-last-closed') {
          const closed = store.recentlyClosed?.at(-1);
          if (closed) {
            const allowed = await authorizedProjectTabs([closed.tab], folders, projectScope);
            store = useCanvasStore.getState();
            const current = store.recentlyClosed?.at(-1);
            if (!current || current.panelId !== closed.panelId || !sameTabResource(closed.tab, current.tab))
              return fail('STALE_CANVAS', 'The closed tab changed while checking project access. Inspect the canvas again.');
            if (allowed.length === 0)
              return fail('OUTSIDE_WORKSPACE', 'This view is outside the caller project access.');
          }
        }
      }
      if ('panelId' in operation && !store.panels[operation.panelId])
        return fail('PANEL_NOT_FOUND', 'Inspect the canvas for current panel IDs.');
      if ('tabId' in operation) {
        const owner = Object.entries(store.panels).find(([, panel]) =>
          panel.tabs.some((tab) => tab.id === operation.tabId)
        );
        if (!owner) return fail('TAB_NOT_FOUND', 'That tab has closed. Inspect the canvas again.');
        const [panelId, panel] = owner;
        const tab = panel.tabs.find((tab) => tab.id === operation.tabId)!;
        if (operation.kind === 'close') {
          if (
            isTabDirty(tab) ||
            (tab.type === 'sequence' && useSequenceStore.getState().isDirty(tab.entityId))
          )
            return fail('DOCUMENT_DIRTY', 'Save or discard this document before closing its tab.');
          store.closeTab(panelId, tab.id);
        } else if (operation.kind === 'activate') {
          store.setActiveTab(panelId, tab.id);
          store.focusPanel(panelId);
        } else store.moveTabAtIndex(panelId, operation.panelId, tab.id, operation.index ?? null);
      } else if (operation.kind === 'split') {
        return toolSuccess({ panelId: store.splitPanel(operation.panelId, operation.direction) });
      } else if (operation.kind === 'merge') {
        if (
          !store.panels[operation.sourcePanelId] ||
          !store.panels[operation.targetPanelId] ||
          operation.sourcePanelId === operation.targetPanelId
        )
          return fail('INVALID_PANELS', 'Select two different current panel IDs.');
        store.mergePanels(operation.sourcePanelId, operation.targetPanelId);
      } else if (operation.kind === 'join-all') store.joinAllPanels();
      else store.reopenLastClosedTab();
      return toolSuccess({ applied: true });
    },
  });
}
