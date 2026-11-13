   
                                           
  
                                                                        
                                                                    
                                                                            
                                                  
   

import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import {
  backtranslate,
  translateCodon,
  SUPPORTED_BACKTRANSLATE_HOSTS,
  BACKTRANSLATE_HOST_LABELS,
} from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { queryLimsEntities } from '../../lims/public/operations';
import { resolveAminoAcidSequence } from '../../lims/public/protein-sequence';
import type { AminoAcidSequenceRef } from '../../../shared/lims';

export const backtranslateSchema = z
  .object({
    refId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'LIMS entity id of a registered protein. Provide refId (a registered protein) OR ' +
          'sequence (raw amino acids) — exactly one.'
      ),
    sequence: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Raw amino-acid sequence to backtranslate directly, when no registered protein ' +
          'exists. Provide sequence (raw amino acids) OR refId (a registered protein) — exactly one.'
      ),
    host: z
      .enum(SUPPORTED_BACKTRANSLATE_HOSTS)
      .describe(
        'Target host for codon-usage optimization. Supported hosts: ' +
          `${SUPPORTED_BACKTRANSLATE_HOSTS.map((h) => `${h} (${BACKTRANSLATE_HOST_LABELS[h]})`).join(', ')}.`
      ),
  })
  .strict();

function verbatimTranslate(dna: string): string {
  let protein = '';
  for (let i = 0; i < dna.length; i += 3) {
    protein += translateCodon(dna.slice(i, i + 3));
  }
  return protein;
}

function failure(error: string) {
  return toolFailure({
    code: 'BACKTRANSLATION_FAILED',
    error,
    retriable: false,
    stateChanged: false,
    partialEffects: [],
  });
}

export function createBacktranslateTool(_folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Backtranslate an amino-acid sequence into a codon-optimized DNA sequence for a ' +
      'specific host organism. Provide EITHER a registered protein (refId) OR a raw amino-acid ' +
      'sequence. Picks the single highest-frequency codon per residue from published ' +
      'codon-usage tables; returns the DNA plus a verification field (translating it back ' +
      'reproduces the original amino-acid sequence) so the result is never trusted unverified.',
    inputSchema: backtranslateSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof backtranslateSchema>) => {
      try {
        const hasRefId = Boolean(input.refId);
        const hasSequence = Boolean(input.sequence);
        if (hasRefId === hasSequence) {
          return failure('Provide exactly one of refId or sequence, not both and not neither.');
        }

        let aminoAcidSequence: string;
        if (input.refId) {
          const entities = await queryLimsEntities({ id: input.refId, limit: 1 });
          const entity = entities[0];
          if (!entity) return failure(`No LIMS entity found for refId "${input.refId}".`);
          if (entity.kind !== 'protein') {
            return failure(`Entity "${input.refId}" is a "${entity.kind}", not a protein.`);
          }
          const ref = entity.fields.sequence as AminoAcidSequenceRef | undefined;
          if (!ref) return failure(`Protein "${input.refId}" has no sequence field.`);
          const resolved = await resolveAminoAcidSequence(ref);
          if (resolved.status !== 'loaded') {
            return failure(
              `Protein "${input.refId}"'s sequence could not be resolved (${resolved.status}).`
            );
          }
          aminoAcidSequence = resolved.bases;
        } else {
          aminoAcidSequence = input.sequence!;
        }

        let dnaSequence: string;
        try {
          dnaSequence = backtranslate(aminoAcidSequence, input.host);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }

                                                                                  
                                                                                    
                                                                                   
                                                                           
        const normalizedInput = aminoAcidSequence.replace(/\s/g, '').toUpperCase();
        const verified = verbatimTranslate(dnaSequence) === normalizedInput;

        return toolSuccess({
          refId: input.refId,
          host: input.host,
          aminoAcidSequence,
          dnaSequence,
          dnaLengthBp: dnaSequence.length,
          verified,
        });
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
