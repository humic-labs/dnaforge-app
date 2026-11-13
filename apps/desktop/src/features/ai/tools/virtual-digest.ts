   
                                                                               
                                                 
  
                                                                              
                                                                              
  
                                              
  
                                                                        
                                                                           
                                                       
                                                                             
                                                                           
                                                                      
                
                                                                           
                                                                               
                                                                         
                                                                               
                                                                            
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  computeVirtualDigestAsync,
  throwIfVirtualDigestAborted,
  toDigestSourceAnnotations,
  VirtualDigestLimitError,
  type VirtualDigestFragment,
  type VirtualDigestResult,
} from '../../assembly-panel/public/hooks/useVirtualDigest';
import { canonicalGoldenGateEnzymeName, loadAllEnzymes } from '@waypoint/sequence-utils';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import { loadSequenceDocumentBiologyFile } from './path-utils';
import { sequenceResourceUri } from './get-sequence';

   
                                                                            
                                                                            
                                                                           
                                                                        
   
export const DIGEST_SNAPSHOT_VERSION = 2;

   
                                                                              
                                                                              
                                                                             
   
export const MAX_DIGEST_SOURCE_BASES = 1_000_000;
export const MAX_DIGEST_FRAGMENTS = 500;
export const MAX_DIGEST_ENZYMES = 50;

export const virtualDigestSchema = z
  .object({
    documentId: z
      .string()
      .min(1)
      .describe('Stable sequence document ID or waypoint://sequence/{documentId} URI.'),
    enzymes: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_DIGEST_ENZYMES)
      .describe(
        'Restriction enzyme names, e.g. ["BsaI"] or ["EcoRI","BamHI"]. Golden Gate ' +
          'classification (insert/backbone/unusable) is only computed for a SINGLE Type IIS ' +
          'enzyme — a two-enzyme digest returns ggType "rd" for every fragment.'
      ),
  })
  .strict();

type VirtualDigestInput = z.infer<typeof virtualDigestSchema>;

export function resolveDigestTopology(parsed: {
  format: string;
  sequence: { circular?: boolean };
  content?: string;
}): { circular: boolean; topologyAssumed: boolean } {
  return {
                                                                              
                                                                           
    circular: parsed.sequence.circular === true,
    topologyAssumed: !digestTopologyWasDeclared(parsed),
  };
}

function digestTopologyWasDeclared(parsed: { format: string; content?: string }): boolean {
  if (!parsed.content || parsed.format === 'fasta') return false;
  if (parsed.format === 'genbank') {
    const locus = parsed.content.split(/\r?\n/).find((line) => line.startsWith('LOCUS'));
    return locus !== undefined && /\b(?:linear|circular)\b/i.test(locus);
  }
  if (parsed.format === 'gff3') {
    return /^##dna-indexer-topology\b.*\b(?:linear|circular)\s*$/im.test(parsed.content);
  }
  return false;
}

   
                                                                               
                                                                       
                                                                    
   
export function resolveDigestEnzymes(
  requestedNames: readonly string[],
  catalog: readonly RestrictionEnzyme[]
): { resolvedEnzymes: RestrictionEnzyme[]; unknown: string[] } {
  const byName = new Map(catalog.map((enzyme) => [enzyme.name.toLowerCase(), enzyme]));
  const seenCanonical = new Set<string>();
  const seenUnknown = new Set<string>();
  const resolvedEnzymes: RestrictionEnzyme[] = [];
  const unknown: string[] = [];

  for (const requestedName of requestedNames) {
    const requestedKey = requestedName.toLowerCase();
    const match = byName.get(requestedKey);
    if (!match) {
      if (!seenUnknown.has(requestedKey)) {
        seenUnknown.add(requestedKey);
        unknown.push(requestedName);
      }
      continue;
    }
    const canonicalKey = (canonicalGoldenGateEnzymeName(match.name) ?? match.name).toLowerCase();
    if (seenCanonical.has(canonicalKey)) continue;
    seenCanonical.add(canonicalKey);
    resolvedEnzymes.push(match);
  }

  return { resolvedEnzymes, unknown };
}

                                                                                 
function contentFingerprint(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

export function buildDigestSnapshotId(params: {
  sequence: string;
  circular: boolean;
  enzymeNames: string[];
  sourceDocumentId: string;
  annotations: unknown;
}): string {
  const enzymes = [...params.enzymeNames].sort().join(',');
  return [
    `v${DIGEST_SNAPSHOT_VERSION}`,
    contentFingerprint(params.sequence),
    params.sequence.length,
    params.circular ? 'circ' : 'lin',
    contentFingerprint(enzymes),
    contentFingerprint(params.sourceDocumentId),
    contentFingerprint(stableSnapshotValue(params.annotations)),
  ].join('-');
}

function stableSnapshotValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSnapshotValue(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSnapshotValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildFragmentCandidateId(
  snapshotId: string,
  fragment: Pick<VirtualDigestFragment, 'startPosition' | 'endPosition' | 'length'>
): string {
  return `${snapshotId}:${fragment.startPosition}-${fragment.endPosition}:${fragment.length}`;
}

function projectEnd(end: VirtualDigestFragment['upstream']) {
  return {
    overhang: end.sequence,
    enzymeName: end.enzymeName,
    enzymeNames: end.enzymeNames,
    sitePosition: end.sitePosition,
    siteOrientation: end.siteOrientation,
                                                       
    rdEnd: end.rdEnd
      ? {
          overhang: end.rdEnd.overhang ?? null,
          overhangType: end.rdEnd.overhangType ?? null,
          recognitionSequence: end.rdEnd.recognitionSequence ?? null,
          recognitionStart: end.rdEnd.recognitionStart ?? null,
          recognitionEnd: end.rdEnd.recognitionEnd ?? null,
          cutPositionTop: end.rdEnd.cutPositionTop ?? null,
          cutPositionBottom: end.rdEnd.cutPositionBottom ?? null,
          strand: end.rdEnd.strand ?? null,
          retainedScarSequence: end.rdEnd.retainedScarSequence ?? null,
        }
      : null,
  };
}

export function projectDigestFragments(result: VirtualDigestResult, snapshotId: string) {
  return result.fragments.map((fragment) => ({
    fragmentIndex: fragment.index,
    fragmentCandidateId: buildFragmentCandidateId(snapshotId, fragment),
                                                                      
                                                                                
                                                                                
    startPosition: fragment.startPosition,
    endPosition: fragment.endPosition,
    start1: fragment.startPosition + 1,
    end1: fragment.endPosition,
    length: fragment.length,
    wrapsOrigin: fragment.wrapsOrigin,
    ggType: fragment.ggType,
    upstream: projectEnd(fragment.upstream),
    downstream: projectEnd(fragment.downstream),
    annotations: fragment.annotations,
    primaryAnnotation: fragment.primaryAnnotation ?? null,
                                                                                
                                                                              
    internalSites: fragment.internalSites,
    hasInternalSites: fragment.hasInternalSites,
  }));
}

export function createVirtualDigestTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Run a virtual restriction digest on a sequence file and return the resulting fragments. ' +
      'Read-only. Each fragment reports its coordinates in BOTH 0-indexed half-open ' +
      '(startPosition/endPosition) and 1-indexed inclusive (start1/end1) form, its cut-side ' +
      'oriented ends (rdEnd, including 5′/3′/blunt overhangType and the recognition strand), ' +
      'its Golden Gate classification (insert / backbone / unusable / rd), and whether it ' +
      'contains an INTERNAL recognition site — a fragment with hasInternalSites is re-cut by ' +
      'the reaction and cannot be used as a Golden Gate part. Quote the returned digestSnapshotId ' +
      'and fragmentCandidateId back to add_digest_fragment; do not address a fragment by ordinal ' +
      'alone. ggType is only classified for a SINGLE Type IIS enzyme.',
    inputSchema: virtualDigestSchema as z.ZodTypeAny,
    execute: async (
      { documentId: inputDocumentId, enzymes }: VirtualDigestInput,
      context?: { abortSignal?: AbortSignal }
    ) =>
      runDesignTool('VIRTUAL_DIGEST_FAILED', async (effects) => {
        const base = {
          documentId: inputDocumentId,
          resourceUri: sequenceResourceUri(inputDocumentId),
        };

        try {
          throwIfVirtualDigestAborted(context?.abortSignal);
          const loaded = await loadSequenceDocumentBiologyFile(inputDocumentId, folders);
          const parsed = loaded.biology;
          base.documentId = loaded.documentId;
          base.resourceUri = sequenceResourceUri(loaded.documentId);
          throwIfVirtualDigestAborted(context?.abortSignal);

          const sequence = parsed.sequence.sequence;
          if (!sequence || sequence.length === 0) {
            return designToolFailure(
              'VIRTUAL_DIGEST_FAILED',
              { ...base, error: 'EMPTY_SEQUENCE', message: 'That file contains no bases.' },
              effects
            );
          }
          if (sequence.length > MAX_DIGEST_SOURCE_BASES) {
            return designToolFailure(
              'VIRTUAL_DIGEST_FAILED',
              {
                ...base,
                error: 'SOURCE_TOO_LARGE_FOR_DESIGN',
                message:
                  `That sequence is ${sequence.length.toLocaleString()} bp. Digest fragments embed ` +
                  `their source bases into the design, which is persisted as a single blob, so ` +
                  `sources above ${MAX_DIGEST_SOURCE_BASES.toLocaleString()} bp are refused.`,
                length: sequence.length,
                limit: MAX_DIGEST_SOURCE_BASES,
              },
              effects
            );
          }

          const catalog = await loadAllEnzymes();
          throwIfVirtualDigestAborted(context?.abortSignal);
          const { resolvedEnzymes, unknown } = resolveDigestEnzymes(enzymes, catalog);
          if (unknown.length > 0) {
                                                                           
                                                                               
            return designToolFailure(
              'VIRTUAL_DIGEST_FAILED',
              {
                ...base,
                error: 'UNKNOWN_ENZYME',
                message: `Not in the restriction-enzyme catalog: ${unknown.join(', ')}.`,
                unknownEnzymes: unknown,
                didYouMean: catalog
                  .map((enzyme) => enzyme.name)
                  .filter((name) =>
                    unknown.some((needle) =>
                      name.toLowerCase().startsWith(needle.slice(0, 3).toLowerCase())
                    )
                  )
                  .slice(0, 10),
              },
              effects
            );
          }

          const { circular, topologyAssumed } = resolveDigestTopology(parsed);
          const result = await computeVirtualDigestAsync(
            sequence,
            resolvedEnzymes,
            toDigestSourceAnnotations(parsed.sequence.annotations),
            {
              circular,
              maxFragments: MAX_DIGEST_FRAGMENTS,
              abortSignal: context?.abortSignal,
            }
          );
          throwIfVirtualDigestAborted(context?.abortSignal);

          const enzymeNames = resolvedEnzymes.map((enzyme) => enzyme.name);
          const digestSnapshotId = buildDigestSnapshotId({
            sequence,
            circular,
            enzymeNames,
            sourceDocumentId: loaded.documentId,
            annotations: parsed.sequence.annotations,
          });

          return toolSuccess({
            ...base,
            digestSnapshotId,
            sequenceName: parsed.sequence.name ?? null,
            sequenceLength: sequence.length,
                                                                                
                                                                                 
                                                                                  
                                                     
            topology: circular ? 'circular' : 'linear',
                                                                                
                                                                              
                                                                                 
                                                                               
            topologyAssumed,
            enzymeNames,
            digestKind: result.digestKind,
            cutSiteCount: result.cutSiteCount,
            overhangLength: result.overhangLength,
                                                                             
                                                          
            ggStatus: result.ggStatus,
            warning: result.warning ?? null,
            diagnostics: result.diagnostics,
            fragmentCount: result.fragments.length,
            fragments: projectDigestFragments(result, digestSnapshotId),
          });
        } catch (error) {
          if ((error as Error).name === 'AbortError' || context?.abortSignal?.aborted) {
            throwIfVirtualDigestAborted(context?.abortSignal);
            throw error;
          }
          if (error instanceof VirtualDigestLimitError) {
            return designToolFailure(
              'VIRTUAL_DIGEST_FAILED',
              {
                ...base,
                error: 'TOO_MANY_FRAGMENTS',
                message:
                  `That digest produces at least ${error.fragmentCount} fragments, above the ` +
                  `${error.limit} limit. Use a rarer cutter.`,
                fragmentCount: error.fragmentCount,
                limit: error.limit,
              },
              effects
            );
          }
          const message = error instanceof Error ? error.message : String(error);
          if (/enzyme/i.test(message) && /catalog|load|fetch/i.test(message)) {
            return designToolFailure(
              'VIRTUAL_DIGEST_FAILED',
              { ...base, error: 'ENZYME_CATALOG_UNAVAILABLE', message },
              effects
            );
          }
          return designToolFailure(
            'VIRTUAL_DIGEST_FAILED',
            { ...base, error: 'EXECUTION_FAILED', message: `Virtual digest failed: ${message}` },
            effects
          );
        }
      }),
  });
}

export const virtualDigestTool = createVirtualDigestTool([]);
