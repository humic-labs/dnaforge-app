import { z } from 'zod';

const count = z.number().int().nonnegative();
const designHeader = z.object({
  id: z.string(), name: z.string(), topology: z.enum(['circular', 'linear']),
  assemblyMethod: z.enum(['gibson', 'nebuilder', 'goldengate']),
  assemblyState: z.enum(['assembled', 'preflight', 'drafting', 'validating', 'ready', 'running']),
  status: z.enum(['draft', 'computed', 'assembled']).optional(), version: count,
  regionCount: count, homologyRegionCount: count, goldenGateJunctionCount: count,
  primerPairCount: count, validationErrorCount: count,
});
const sequenceSummary = z.object({
  documentId: z.string(), name: z.string().nullable(), length: count, circular: z.boolean(),
  annotationCount: count, primerCount: count, version: count, dirty: z.boolean(),
});
const tab = z.object({
  id: z.string(), type: z.string(), entityId: z.string(), label: z.string(),
  active: z.boolean(), isDirty: z.boolean(),
  loadStatus: z.enum(['loaded', 'pending', 'deferred-oversized', 'missing', 'error',
    'indexed-pending', 'indexed', 'indexed-error']).nullable(),
});
const openTab = z.object({id: z.string(), label: z.string(), panelId: z.string(), active: z.boolean()});
export const observeAppStateOutputSchema = z.object({
  ok: z.literal(true), schemaVersion: z.literal(1),
  workspace: z.object({activeWorkspaceFile: z.string().nullable(), focusedPanelId: z.string().nullable(),
    folderCount: count, folders: z.array(z.object({name: z.string(), path: z.string(), pinned: z.boolean()})),
    panelCount: count, tabCount: count}),
  panels: z.array(z.object({id: z.string(), activeTabId: z.string().nullable(), tabCount: count, tabs: z.array(tab)})),
  tabs: z.array(tab.extend({panelId: z.string()})),
  designs: z.object({count, activeDesignId: z.string().nullable(), items: z.array(designHeader)}),
  sequences: z.object({count, loadingDocumentIds: z.array(z.string()), items: z.array(sequenceSummary)}),
  structureLinks: z.object({count, items: z.array(z.object({structureId: z.string(), sequenceDocumentId: z.string(),
    cdsLabel: z.string(), cdsStart: count.optional(), cdsEnd: count.optional(),
    strand: z.union([z.literal(1), z.literal(-1)]).optional(), translationLength: count}))}),
  paperProtocolReview: z.object({displayMode: z.literal('linked-tabs'), protocolPath: z.string(),
    candidate: z.object({candidateSetId: z.string(), candidateId: z.string(), ordinal: count,
      label: z.string(), status: z.enum(['rejected', 'proposed', 'selected'])}),
    selectedStepId: z.string().nullable(), selectedEvidenceIds: z.array(z.string()),
    sourceRepresentations: z.array(z.enum(['pdf', 'captured_text'])), draftRevision: count,
    draftState: z.enum(['draft', 'finalized']), gapCount: count, dirty: z.boolean()}).nullable(),
  targets: z.object({
    label: z.object({label: z.string(), present: z.boolean(), count, active: z.boolean(),
      tabs: z.array(z.object({id: z.string(), type: z.string(), entityId: z.string(), panelId: z.string(), active: z.boolean()}))}).optional(),
    design: z.object({designId: z.string(), present: z.boolean(), design: designHeader.nullable(), openTabs: z.array(openTab)}).optional(),
    sequence: z.object({documentId: z.string(), present: z.boolean(), sequence: sequenceSummary.nullable(), openTabs: z.array(openTab)}).optional(),
  }),
});
