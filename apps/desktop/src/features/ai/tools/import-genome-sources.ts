import { z } from 'zod';
import { parseTrackAdmissionRequestV1, type TrackAdmissionRequestV1 } from '@waypoint/genome-data';

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
} from '../../sequence/public/attach-indexed-bigwig';
import {
  importGenomeSources,
  type GenomeSourceImportOutcome,
} from '../../sequence/public/import-genome-sources';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import { resultTool, toolFailure, toolSuccess, type ToolFailure } from '../../agent-bridge/public/tool-result';
import { findOpenIndexedTab, type IndexedTab } from './indexed-current-view';
import { hasNoUserWorkspace, NO_WORKSPACE_TOOL_MESSAGE, resolveMultiRootPath } from './path-utils';

const authRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'Opaque credential reference saved through the Add Data dialog or the recovery panel. Never a token.'
  );

const localFileLocator = z
  .object({
    kind: z.literal('local-file'),
    path: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .describe('Absolute path inside an open project, or a path relative to one.'),
  })
  .strict();

const httpLocator = z
  .object({
    kind: z.literal('http'),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .describe('Durable HTTP(S) URL without embedded credentials or signatures.'),
    authRef,
  })
  .strict();

const s3Locator = z
  .object({
    kind: z.literal('s3'),
    bucket: z.string().trim().min(1).max(255),
    key: z.string().trim().min(1).max(2_000),
    region: z.string().trim().min(1).max(64).optional(),
    requesterPays: z.boolean().optional(),
    authRef,
  })
  .strict();

const gcsLocator = z
  .object({
    kind: z.literal('gcs'),
    bucket: z.string().trim().min(1).max(255),
    object: z.string().trim().min(1).max(2_000),
    billingProject: z.string().trim().min(1).max(200).optional(),
    authRef,
  })
  .strict();

const htsgetLocator = z
  .object({
    kind: z.literal('htsget'),
    endpoint: z.string().trim().min(1).max(2_000),
    resourceId: z.string().trim().min(1).max(500),
    dataClass: z.enum(['reads', 'variants']),
    format: z.enum(['BAM', 'CRAM', 'VCF', 'BCF']).optional(),
    authRef,
  })
  .strict();

const ucscTrackLocator = z
  .object({
    kind: z.literal('ucsc-track'),
    sourceKind: z.enum(['ucsc-native', 'ucsc-hub']),
    genome: z.string().trim().min(1).max(200),
    track: z.string().trim().min(1).max(200),
    hubUrl: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

const assetLocator = z.discriminatedUnion('kind', [
  localFileLocator,
  httpLocator,
  s3Locator,
  gcsLocator,
  htsgetLocator,
]);

const sourceLocator = z.discriminatedUnion('kind', [
  localFileLocator,
  httpLocator,
  s3Locator,
  gcsLocator,
  htsgetLocator,
  ucscTrackLocator,
]);

const sourceSpecSchema = z
  .object({
    source: sourceLocator.describe('Where the data lives.'),
    index: assetLocator
      .optional()
      .describe('Companion index (.bai/.crai/.csi/.tbi). Required for remote reads and calls.'),
    reference: assetLocator
      .optional()
      .describe('Indexed reference FASTA a CRAM decodes against. Required for a local CRAM.'),
    formatId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Format id when the source name does not reveal it: bam, cram, vcf, bcf, bigwig, bigbed, bed, gff3, gtf, genepred, refflat, narrowpeak, broadpeak.'
      ),
    scientificKind: z
      .enum(['transcript', 'interval', 'quantitative', 'peak', 'repeat', 'reads', 'variants'])
      .optional()
      .describe('How the data is read scientifically when the format alone is ambiguous.'),
    label: z.string().trim().min(1).max(200).optional().describe('Lane label.'),
  })
  .strict();

export const importGenomeSourcesSchema = z
  .object({
    sources: z
      .array(sourceSpecSchema)
      .min(1)
      .max(16)
      .describe('Sources to add, in lane order. Each one gets its own outcome.'),
    tabId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Indexed genome tab to add to. Defaults to the focused indexed genome tab.'),
  })
  .strict();

export type ImportGenomeSourcesInput = z.infer<typeof importGenomeSourcesSchema>;
type SourceSpec = z.infer<typeof sourceSpecSchema>;
type Locator = z.infer<typeof sourceLocator>;

export interface ImportGenomeSourceOutcomeView {
  readonly index: number;
  readonly label: string;
  readonly family: GenomeSourceImportOutcome['family'];
  readonly status: 'added' | 'duplicate' | 'failed';
  readonly trackId?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface ImportGenomeSourcesSuccess {
  readonly ok: true;
  readonly tabId: string;
  readonly assemblyId: string;
  readonly added: number;
  readonly duplicates: number;
  readonly failed: number;
  readonly outcomes: ReadonlyArray<ImportGenomeSourceOutcomeView>;
  readonly laneCount: number;
}

export type ImportGenomeSourcesResult = ImportGenomeSourcesSuccess | ToolFailure;

export function isRemoteGenomeSourceLocator(locator: { readonly kind: string }): boolean {
  return locator.kind !== 'local-file';
}

export function genomeSourceLocators(spec: {
  readonly source: Locator;
  readonly index?: Locator;
  readonly reference?: Locator;
}): ReadonlyArray<Locator> {
  return [spec.source, spec.index, spec.reference].filter((value): value is Locator =>
    Boolean(value)
  );
}

function groundLocator(
  locator: Locator,
  folders: WorkspaceFolder[]
): Extract<TrackAdmissionRequestV1['source'], { kind: Locator['kind'] }> {
  if (locator.kind !== 'local-file') return locator;
  return { kind: 'local-file', path: resolveMultiRootPath(folders, locator.path).absolutePath };
}

function requestFor(
  spec: SourceSpec,
  assemblyId: string,
  folders: WorkspaceFolder[]
): TrackAdmissionRequestV1 {
  const source = groundLocator(spec.source, folders);
  const index = spec.index ? groundLocator(spec.index, folders) : undefined;
  const reference = spec.reference ? groundLocator(spec.reference, folders) : undefined;
  if (index?.kind === 'ucsc-track' || reference?.kind === 'ucsc-track') {
    throw new Error('An index or reference cannot be a UCSC track.');
  }
  return parseTrackAdmissionRequestV1({
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId,
    source,
    ...(index ? { index } : {}),
    ...(reference ? { reference } : {}),
    ...(spec.formatId ? { formatId: spec.formatId } : {}),
    ...(spec.scientificKind ? { scientificKind: spec.scientificKind } : {}),
    ...(spec.label ? { label: spec.label } : {}),
    ingress: { kind: 'automation' },
  });
}

function targetTab(tabId: string | undefined): { panelId: string; tab: IndexedTab } | null {
  const store = useCanvasStore.getState();
  if (!tabId) return findOpenIndexedTab(store);
  for (const [panelId, panel] of Object.entries(store.panels)) {
    const tab = panel.tabs.find((candidate) => candidate.id === tabId);
    if (tab?.indexedGenome) return { panelId, tab: tab as IndexedTab };
  }
  return null;
}

function refusal(code: string, error: string): ToolFailure {
  return toolFailure({ code, error, retriable: false, stateChanged: false, partialEffects: [] });
}

function outcomeView(outcome: GenomeSourceImportOutcome, index: number): ImportGenomeSourceOutcomeView {
  return outcome.status === 'failed'
    ? {
        index,
        label: outcome.label,
        family: outcome.family,
        status: 'failed',
        code: outcome.code,
        message: outcome.message,
      }
    : {
        index,
        label: outcome.label,
        family: outcome.family,
        status: outcome.status,
        trackId: outcome.trackId,
      };
}

export function createImportGenomeSourcesTool(
  folders: WorkspaceFolder[],
  dependencies?: { readonly run?: typeof importGenomeSources }
) {
  const run = dependencies?.run ?? importGenomeSources;
  return resultTool({
    description:
      'Add one or more genomic data sources to the open indexed genome view: BAM/CRAM reads, ' +
      'VCF/BCF calls, BigWig signal, BigBed/BED/GFF intervals, from a local project file, an ' +
      'HTTP(S) URL, an S3 or GCS object, an htsget resource, or a UCSC or hub track. Credentialed ' +
      'sources name a saved credential reference, never a token. Each source is admitted against ' +
      'the open assembly and returns its own outcome: added, duplicate, or failed with a reason. ' +
      'A local CRAM must name its reference FASTA.',
    inputSchema: importGenomeSourcesSchema as z.ZodTypeAny,
    execute: async (
      input: ImportGenomeSourcesInput,
      options?: { abortSignal?: AbortSignal }
    ): Promise<ImportGenomeSourcesResult> => {
      if (options?.abortSignal?.aborted) {
        return refusal('CANCELLED', 'The genome source import was cancelled before it started.');
      }
      const found = targetTab(input.tabId);
      if (!found) {
        return refusal(
          'NO_INDEXED_VIEW',
          input.tabId ? `Tab ${input.tabId} is not an open indexed genome view.` : 'No indexed genome tab is open.'
        );
      }
      const usesLocalFiles = input.sources.some((spec) =>
        genomeSourceLocators(spec).some((locator) => locator.kind === 'local-file')
      );
      if (usesLocalFiles && hasNoUserWorkspace(folders)) {
        return refusal('NO_WORKSPACE', NO_WORKSPACE_TOOL_MESSAGE);
      }
      const assemblyId = assemblyIdFromIndexedGenome(found.tab.indexedGenome);
      const assemblyReferences = assemblyReferencesFromIndexedGenome(found.tab.indexedGenome);
      if (assemblyReferences.length === 0) {
        return refusal(
          'NO_ASSEMBLY_REFERENCES',
          'The open indexed genome has no chromosome identity to verify these sources.'
        );
      }
      const requests: TrackAdmissionRequestV1[] = [];
      for (const [index, spec] of input.sources.entries()) {
        try {
          requests.push(requestFor(spec, assemblyId, folders));
        } catch (error) {
          return refusal(
            'INVALID_SOURCE',
            `Source ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      const outcomes = await run({
        laneOwnerId: found.tab.id,
        assemblyId,
        assemblyDisplayName: found.tab.indexedGenome.assembly?.displayName ?? found.tab.label,
        assemblyReferences,
        requests,
        signal: options?.abortSignal,
        localAuthorityContext: 'workspace-grounded',
      });
      const views = outcomes.map(outcomeView);
      const added = views.filter((view) => view.status === 'added');
      const duplicates = views.filter((view) => view.status === 'duplicate').length;
      const failed = views.filter((view) => view.status === 'failed');
      const partialEffects = added.map((view) => `lane:${view.trackId ?? view.label}`);
      if (options?.abortSignal?.aborted) {
        return toolFailure({
          code: 'CANCELLED',
          error: `The genome source import was cancelled after ${added.length} of ${views.length} sources were added.`,
          retriable: true,
          stateChanged: added.length > 0,
          partialEffects,
          details: { outcomes: views },
        });
      }
      if (added.length === 0 && duplicates === 0) {
        return toolFailure({
          code: 'NO_SOURCES_ADDED',
          error: failed.map((view) => `${view.label}: ${view.message ?? view.code}`).join(' '),
          retriable: false,
          stateChanged: false,
          partialEffects: [],
          details: { outcomes: views },
        });
      }
      return toolSuccess({
        tabId: found.tab.id,
        assemblyId,
        added: added.length,
        duplicates,
        failed: failed.length,
        outcomes: views,
        laneCount: useLaneContractStore.getState().lanesForOwner(found.tab.id).length,
      });
    },
  });
}
