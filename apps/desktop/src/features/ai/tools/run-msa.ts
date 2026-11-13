   
                                     
  
                                                                             
                                                                            
                                                                            
          
  
                                                                            
                                                                               
                                                                            
                                                                       
                                                                     
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { sequenceReadFailure } from './sequence-tool-failure';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { queryLimsEntities } from '../../lims/public/operations';
import { resolveAminoAcidSequence } from '../../lims/public/protein-sequence';
import type { AminoAcidSequenceRef } from '../../../shared/lims';

export const runMsaSchema = z
  .object({
    proteinIds: z
      .array(z.string().min(1).max(256))
      .min(2)
      .max(128)
      .describe(
        'LIMS entity ids of 2+ registered protein entities to align via MAFFT ' +
          '(multiple sequence alignment).'
      ),
  })
  .strict();

interface ResolvedProtein {
  id: string;
  name: string;
  sequence: string;
}

type ProteinResolution = ResolvedProtein | { error: string };

async function resolveProtein(entityId: string): Promise<ProteinResolution> {
  const entities = await queryLimsEntities({ id: entityId, limit: 1 });
  const entity = entities[0];
  if (!entity) return { error: `No LIMS entity found for id "${entityId}".` };
  if (entity.kind !== 'protein') {
    return { error: `Entity "${entityId}" is a "${entity.kind}", not a protein.` };
  }
  const ref = entity.fields.sequence as AminoAcidSequenceRef | undefined;
  if (!ref) return { error: `Protein "${entityId}" has no sequence field.` };
  const resolved = await resolveAminoAcidSequence(ref);
  if (resolved.status !== 'loaded') {
    return {
      error: `Protein "${entityId}"'s sequence could not be resolved (${resolved.status}).`,
    };
  }
  return { id: entityId, name: entity.name, sequence: resolved.bases };
}

interface RunMsaToolOptions {
  subjectId?: string;
}

type PreparedRunMsa = {
  subject_id: string;
  input: {
    sequences: ResolvedProtein[];
    algorithm: 'auto';
    threads: 4;
    timeout_seconds: 600;
  };
};

export function projectRunMsaAuditResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Partial<PreparedRunMsa> & { error?: unknown };
  if (!value.input || !Array.isArray(value.input.sequences)) {
    return typeof value.error === 'string' ? { error: value.error } : {};
  }
  return {
    subject_id: value.subject_id,
    input: {
      sequence_count: value.input.sequences.length,
      sequences: value.input.sequences.map((record) => ({
        id: record.id,
        sequence_length: record.sequence.length,
      })),
      algorithm: value.input.algorithm,
      threads: value.input.threads,
      timeout_seconds: value.input.timeout_seconds,
    },
  };
}

export function createRunMsaTool(_folders: WorkspaceFolder[], options: RunMsaToolOptions = {}) {
  return resultTool({
    description:
      'Start a durable MAFFT multiple-sequence-alignment job for 2+ registered protein ' +
      'entities. Returns the managed operation immediately so it can be followed, stopped, ' +
      'or inspected from Jobs, the API, the CLI, or agent tools.',
    inputSchema: runMsaSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof runMsaSchema>) => {
      const uniqueIds = Array.from(new Set(input.proteinIds));
      if (uniqueIds.length < 2) {
        return sequenceReadFailure(
          'MSA_DISTINCT_PROTEINS_REQUIRED',
          'Provide at least 2 distinct registered protein entities to align.'
        );
      }

      const resolved: ResolvedProtein[] = [];
      for (const id of uniqueIds) {
        const result = await resolveProtein(id);
        if ('error' in result) return sequenceReadFailure('MSA_PROTEIN_UNAVAILABLE', result.error);
        resolved.push(result);
      }

      return toolSuccess({
        subject_id: options.subjectId ?? `msa:${crypto.randomUUID()}`,
        input: {
          sequences: resolved,
          algorithm: 'auto' as const,
          threads: 4 as const,
          timeout_seconds: 600 as const,
        },
      });
    },
  });
}
