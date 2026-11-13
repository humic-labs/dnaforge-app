import { z } from 'zod';
import { jsonObjectSchema } from '../../../shared/json-value';
import { COMMAND_IDS, COMMAND_SCOPES, type CommandId, type CommandScope } from '../../../commands/types';
import { FEATURE_KINDS } from '@waypoint/genome-data/annotation-catalog';
import { sequenceTrackBindingSchema, sequenceTrackLayoutSchema } from './sequence-track-command-schema';
import { tableInspectionOutputSchema } from './document-edit-output-schemas';

const count = z.number().int().nonnegative();
const ok = { ok: z.literal(true) };
const entry = {
  path: z.string(),
  type: z.enum(['directory', 'file']),
  size: count,
  contentHash: z.string().nullable(),
  revision: z.string(),
};
const trashEntry = z.object({
  id: z.string(), originalPath: z.string(), type: entry.type, size: count,
  trashedAt: z.string(), revision: z.string(), deletionStarted: z.boolean(),
});
export const workspaceFilesOutputSchema = z.union([
  z.object({
    ...ok, ...entry, canTrash: z.boolean().optional(),
    changed: z.literal(true).optional(), stopRequested: z.literal(true).optional(), note: z.string().optional(),
  }),
  z.object({ ...ok, kind: z.literal('list'), entries: z.array(trashEntry),
    errors: z.array(z.object({ entryId: z.string(), error: z.string() })), nextOffset: count.nullable() }),
  z.object({ ...ok, kind: z.literal('trash'), changed: z.literal(true), entry: trashEntry, warnings: z.array(z.string()) }),
  z.object({ ...ok, kind: z.literal('restore'), changed: z.literal(true), entryId: z.string(), path: z.string(), warnings: z.array(z.string()) }),
  z.object({ ...ok, kind: z.literal('purge'), changed: z.literal(true), entryId: z.string(), warnings: z.array(z.string()) }),
]);
export const fileDocumentOutputSchema = z.object({
  ...ok, path: z.string(), type: z.enum(['text', 'csv', 'tsv']), revision: z.string(),
  ready: z.boolean(), readOnly: z.boolean(), dirty: z.boolean(),
  canUndo: z.boolean().optional(), canRedo: z.boolean().optional(), text: z.string().optional(),
  length: count.optional(), nextOffset: count.nullable().optional(), table: tableInspectionOutputSchema.optional(),
  applied: z.literal(true).optional(), saved: z.literal(true).optional(),
});
const transition = z.object({
  fromWorkspaceId: z.string().nullable(),
  toWorkspaceId: z.string().nullable(),
});
export const workspaceProjectsOutputSchema = z.union([
  z.object({
    ...ok,
    projects: z.array(z.object({
      projectId: z.string(), name: z.string(), path: z.string(),
      state: z.enum(['active', 'archived', 'trashed', 'unmanaged']),
      mounted: z.boolean(), readOnly: z.boolean(), revision: z.string(),
    })),
    total: count, nextOffset: count.nullable(),
  }),
  z.object({
    ...ok, opened: z.literal(true),
    mounted: z.array(z.object({ name: z.string(), path: z.string() })),
    sessionRoutingChanged: z.literal(true), workspaceTransition: transition,
  }),
  z.object({
    ...ok, projectId: z.string(), opened: z.literal(true),
    sessionRoutingChanged: z.literal(true), workspaceTransition: transition,
  }),
  z.object({
    ...ok, projectId: z.string(), applied: z.literal(true),
    operation: z.enum(['rename', 'close', 'archive', 'trash', 'restore']),
    sessionRoutingChanged: z.boolean(), workspaceTransition: transition,
  }),
]);
const layout: z.ZodTypeAny = z.lazy(() => z.union([
  z.object({ type: z.literal('panel'), panelId: z.string() }),
  z.object({ type: z.literal('split'), direction: z.enum(['horizontal', 'vertical']),
    children: z.array(layout), sizes: z.array(z.number()) }),
]));
const annotationSource = z.object({
  id: z.string(), label: z.string(), evidence: z.enum(['curated', 'measured', 'computed']),
  evidenceLabel: z.string(),
  availability: z.union([
    z.object({ status: z.literal('available') }),
    z.object({ status: z.literal('unavailable'), reason: z.string() }),
  ]),
  citation: z.string().nullable(), url: z.string().nullable(), doi: z.string().nullable(), datasetVersion: z.string().nullable(),
  license: z.object({ spdx: z.string().nullable(), attribution: z.string(), evidenceUrl: z.string().nullable() }),
});
const visualization = z.object({ id: z.string(), label: z.string() });
const annotationTracks = z.object({
  ...ok, status: z.literal('found'), ownerTabId: z.string(), revision: z.string(), applied: z.literal(true).optional(),
  layout: sequenceTrackLayoutSchema.nullable(),
  assembly: z.object({ accession: z.string(), lengthBp: count, displayName: z.string() }).nullable(),
  drawing: z.union([
    z.object({ phase: z.enum(['idle', 'map-circular', 'view-transformed', 'waiting-for-map', 'active']) }),
    z.object({ phase: z.literal('error'), message: z.string(), detail: z.string().nullable() }),
  ]),
  tracks: z.array(z.object({
    binding: sequenceTrackBindingSchema, label: z.string(), kindLabel: z.string(),
    source: annotationSource.nullable(), visualization: visualization.nullable(),
    resolution: z.union([
      z.object({ status: z.enum(['hidden', 'loading']) }),
      z.object({ status: z.literal('not-drawn'), reason: z.string() }),
      z.object({ status: z.literal('ready'), recordCount: count, totalBeforeFilter: count }),
      z.object({ status: z.literal('error'), message: z.string(), detail: z.string().nullable() }),
    ]),
  })),
  choices: z.array(z.object({ kind: z.enum(FEATURE_KINDS), label: z.string(), sources: z.array(annotationSource),
    visualizations: z.array(visualization.extend({ description: z.string() })) })),
});
export const appViewsOutputSchema = z.union([
  annotationTracks,
  z.object({ ...ok, views: z.array(z.object({ viewId: z.string(), name: z.string(), revision: z.string() })),
    total: count, nextOffset: count.nullable(), errors: z.array(z.object({ name: z.string(), message: z.string() })) }),
  z.object({ ...ok, viewId: z.string(), tabId: z.string(), opened: z.literal(true) }),
  z.object({ ...ok, tabId: z.string(), revision: z.string(), document: jsonObjectSchema,
    savedRevision: z.string().nullable(), path: z.string().nullable(), workspaceRoot: z.string().nullable(), dirty: z.boolean() }),
  z.object({ ...ok, viewId: z.string(), name: z.string(), saved: z.literal(true), dirty: z.boolean(),
    revision: z.string(), path: z.string(), warning: z.string().optional() }),
  z.object({ ...ok, dispatched: z.literal(true),
    command: z.enum(Object.values(COMMAND_IDS) as [CommandId, ...CommandId[]]), handled: z.literal(true),
    blocked: z.boolean(), scope: z.enum(Object.values(COMMAND_SCOPES) as [CommandScope, ...CommandScope[]]).nullable() }),
  z.object({ ...ok, focusedPanelId: z.string().nullable(), layout,
    panels: z.array(z.object({ id: z.string(), activeTabId: z.string().nullable(),
      tabs: z.array(z.object({ id: z.string(), type: z.string(), label: z.string(),
        entityId: z.string().optional(), dirty: z.boolean(), readOnly: z.boolean() })) })) }),
  z.object({ ...ok, panelId: z.string() }),
  z.object({ ...ok, applied: z.literal(true) }),
]);
