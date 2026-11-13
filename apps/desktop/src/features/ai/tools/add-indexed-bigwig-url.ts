import { indexedViewToolFailure } from './genome-tool-results';
   
                                                                           
                                                                              
                                                                       
   

import { resultTool, toolSuccess, type ToolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import {
  createTrackAdmissionRequestId,
  directTrackAdmissionRequest,
  trackAdmissionRequestLabel,
} from '@waypoint/genome-data';

import { useCanvasStore } from '../../canvas/public/store';
import {
  assemblyIdFromIndexedGenome,
  assemblyReferencesFromIndexedGenome,
} from '../../sequence/public/attach-indexed-bigwig';
import { attachTrackAdmissionRequest } from '../../sequence/public/attach-track-source';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import { findOpenIndexedTab } from './indexed-current-view';

export const addIndexedBigWigUrlSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .refine(isCredentialFreeHttpUrl, 'BigWig URL must be a credential-free HTTP(S) URL.')
      .describe(
        'Remote BigWig URL. Must be credential-free public HTTP or HTTPS; private network destinations are rejected during admission.'
      ),
    label: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Lane label. Defaults to the URL filename.'),
  })
  .strict();

export type AddIndexedBigWigUrlInput = z.infer<typeof addIndexedBigWigUrlSchema>;

export type AddIndexedBigWigUrlFailure = ToolFailure & {
  code: 'CANCELLED' | 'NO_INDEXED_VIEW' | 'NO_ASSEMBLY_REFERENCES' | 'ADMISSION_FAILED';
  message: string;
};

export type AddIndexedBigWigUrlSuccess = {
  ok: true;
  tabId: string;
  assemblyId: string;
  trackId: string;
  label: string;
  url: string;
  status: 'added' | 'duplicate';
  laneCount: number;
};

export type AddIndexedBigWigUrlResult = AddIndexedBigWigUrlSuccess | AddIndexedBigWigUrlFailure;

type AttachTrackAdmissionRequest = typeof attachTrackAdmissionRequest;

function isCredentialFreeHttpUrl(value: string): boolean {
  if (/[\0\r\n]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function createAddIndexedBigWigUrlTool(dependencies?: {
  attach?: AttachTrackAdmissionRequest;
}) {
  const attach = dependencies?.attach ?? attachTrackAdmissionRequest;
  return resultTool({
    description:
      'Admit a remote BigWig URL onto the currently open indexed genome view as a ' +
      'quantitative signal lane. The URL must be credential-free public HTTP(S); ' +
      'private network destinations are rejected during admission. Chromosome ' +
      'names and lengths in the file are checked against the open assembly. Returns ' +
      'success after the lane is attached, or status "duplicate" when that URL is ' +
      'already on the tab. Does not copy the file locally.',
    inputSchema: addIndexedBigWigUrlSchema as z.ZodTypeAny,
    execute: async (
      input: AddIndexedBigWigUrlInput,
      options?: { abortSignal?: AbortSignal }
    ): Promise<AddIndexedBigWigUrlResult> => {
      if (options?.abortSignal?.aborted) {
        return indexedViewToolFailure({
          error: 'CANCELLED',
          message: 'The indexed BigWig attach request was cancelled.',
        });
      }
      const found = findOpenIndexedTab(useCanvasStore.getState());
      if (!found) {
        return indexedViewToolFailure({
          error: 'NO_INDEXED_VIEW',
          message: 'No indexed genome tab is open.',
        });
      }
      const assemblyId = assemblyIdFromIndexedGenome(found.tab.indexedGenome);
      const assemblyReferences = assemblyReferencesFromIndexedGenome(found.tab.indexedGenome);
      if (assemblyReferences.length === 0) {
        return indexedViewToolFailure({
          error: 'NO_ASSEMBLY_REFERENCES',
          message: 'The open indexed genome has no chromosome identity to verify this track.',
        });
      }
      const request = directTrackAdmissionRequest({
        assemblyId,
        input: { kind: 'url', url: input.url },
        formatId: 'bigwig',
        ingress: 'automation',
        ...(input.label ? { label: input.label } : {}),
      });
      const label = trackAdmissionRequestLabel(request);
      const trackId = createTrackAdmissionRequestId(request);
      try {
        const attached = await attach({
          laneOwnerId: found.tab.id,
          assemblyId,
          assemblyReferences,
          request,
          signal: options?.abortSignal,
        });
                                                                       
                                                                               
                                      
        return toolSuccess({
          tabId: found.tab.id,
          assemblyId,
          trackId: attached.trackId,
          label: attached.label,
          url: input.url,
          status: attached.status,
          laneCount: useLaneContractStore.getState().lanesForOwner(found.tab.id).length,
        });
      } catch (error) {
        if (options?.abortSignal?.aborted) {
          return indexedViewToolFailure(
            { error: 'CANCELLED', message: 'The indexed BigWig attach request was cancelled.' },
            'unknown'
          );
        }
        return indexedViewToolFailure({
          error: 'ADMISSION_FAILED',
          message:
            error instanceof Error
              ? error.message
              : `Failed to admit ${label} (${trackId}, 'unknown').`,
        });
      }
    },
  });
}
