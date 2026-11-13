   
                                                                         
  
                                                                     
                                                                       
                               
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { sequenceReadFailure } from './sequence-tool-failure';
import { z } from 'zod';
import { platform } from '../../../platform';
import { gitShowHead, isGitRepo } from '../../workspace/public/git';
import { extractRawSequence, parseGenBankFull } from '@waypoint/sequence-utils';
import {
  computeSequenceDiff,
  computeAnnotationDiff,
} from '../../sequence/public/diff/sequence-diff';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import { loadSequenceDocumentBiologyFile } from './path-utils';
import { sequenceResourceUri } from './get-sequence';

export const getSequenceChangesSchema = z
  .object({
    documentId: z
      .string()
      .min(1)
      .describe(
        'Stable package/catalog sequence document ID or waypoint://sequence/{documentId} URI.'
      ),
  })
  .strict();

export function createGetSequenceChangesTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Get sequence-level changes for a sequence document compared to the last git commit. ' +
      'Shows insertions, deletions, mutations at the base level, plus annotation changes ' +
      '(added, removed, modified). Physical sequence file paths are not accepted.',
    inputSchema: getSequenceChangesSchema as z.ZodTypeAny,
    execute: async ({ documentId: inputDocumentId }: z.infer<typeof getSequenceChangesSchema>) => {
      try {
        const loaded = await loadSequenceDocumentBiologyFile(inputDocumentId, folders);
        const folder = findContainingPathBoundary(folders, loaded.sourcePath);
        if (!folder) {
          return {
            documentId: loaded.documentId,
            resourceUri: sequenceResourceUri(loaded.documentId),
            ...sequenceReadFailure(
              'SEQUENCE_OUTSIDE_PROJECT',
              'The sequence source is not inside an open project.'
            ),
          };
        }

                                 
        const isRepo = await isGitRepo(folder.path);
        if (!isRepo) {
          return {
            documentId: loaded.documentId,
            resourceUri: sequenceResourceUri(loaded.documentId),
            ...sequenceReadFailure(
              'GIT_REPOSITORY_REQUIRED',
              'Project is not a git repository. Initialize git to track sequence changes.'
            ),
          };
        }

                           
        const headContent = await gitShowHead(loaded.sourcePath, folder.path);
        if (!headContent) {
          return toolSuccess({
            documentId: loaded.documentId,
            resourceUri: sequenceResourceUri(loaded.documentId),
            status: 'untracked',
            message: 'The sequence document is not yet committed. No changes to compare.',
          });
        }

                            
        const currentContent = await platform().fs.readTextFile(loaded.sourcePath);

                            
        const oldSeq = extractRawSequence(headContent);
        const newSeq = extractRawSequence(currentContent);

                                
        const seqDiff = await computeSequenceDiff(oldSeq, newSeq);

                                  
        const oldParsed = parseGenBankFull(headContent);
        const newParsed = parseGenBankFull(currentContent);
        const annDiff = computeAnnotationDiff(oldParsed.annotations, newParsed.annotations);

        return toolSuccess({
          documentId: loaded.documentId,
          resourceUri: sequenceResourceUri(loaded.documentId),
          sequenceChanges: {
            insertions: seqDiff.insertions,
            deletions: seqDiff.deletions,
            mutations: seqDiff.mutations,
            insertedBp: seqDiff.insertedBp,
            deletedBp: seqDiff.deletedBp,
          },
          annotationChanges: {
            added: annDiff.added,
            removed: annDiff.removed,
            modified: annDiff.modified,
          },
          details: seqDiff.changes.slice(0, 20).map((c) => ({
            type: c.type,
            position: c.position,
            length: c.length,
            ...(c.oldBases ? { oldBases: c.oldBases } : {}),
            ...(c.newBases ? { newBases: c.newBases } : {}),
          })),
          annotationDetails: annDiff.changes.slice(0, 20),
        });
      } catch (err) {
        return {
          documentId: inputDocumentId,
          resourceUri: sequenceResourceUri(inputDocumentId),
          ...sequenceReadFailure(
            'SEQUENCE_DIFF_FAILED',
            `Failed to compute sequence changes: ${err instanceof Error ? err.message : String(err)}`
          ),
        };
      }
    },
  });
}
