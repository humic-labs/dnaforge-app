import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool } from './paper-tool-result';
import { z } from 'zod';

import { platform } from '../../../platform';
import { scientificPackageKindForMetaPath } from '../../../shared/scientific-package';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { parseScientificDocument } from '../../scientific-document/public/model';
import { saveNativeScientificPackage } from '../../scientific-document/public/native-package';
import { selectPaperProtocolCandidateWorkflow } from '../../scientific-document/public/paper-protocol-model';
import { resolveMultiRootPath } from './path-utils';

export const selectProtocolCandidateSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(500)
      .describe('Exact native Protocol package metadata path returned for this candidate.'),
    expectedCandidateId: z.string().min(1).max(200).describe('Exact candidate ID the user chose.'),
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .describe('Exact draft revision the user reviewed before choosing this candidate.'),
  })
  .strict();

export type SelectProtocolCandidateInput = z.infer<typeof selectProtocolCandidateSchema>;

export function createSelectProtocolCandidateTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Mark one exact proposed paper-derived Protocol candidate as user-selected. Requires the ' +
      'candidate ID and reviewed draft revision, persists through the native package/catalog ' +
      'boundary, and returns the new revision required for finalization preview.',
    inputSchema: selectProtocolCandidateSchema,
    execute: async (input: SelectProtocolCandidateInput) =>
      runPaperTool('SELECT_PROTOCOL_CANDIDATE_FAILED', async (effects) => {
        const resolved = resolveMultiRootPath(folders, input.path);
        if (scientificPackageKindForMetaPath(resolved.absolutePath) !== 'protocol') {
          throw new Error('Candidate selection requires a native Protocol package metadata path.');
        }
        const original = await platform().fs.readTextFile(resolved.absolutePath);
        const parsed = parseScientificDocument(resolved.absolutePath, original);
        if (parsed.kind !== 'protocol' || !parsed.paperProtocol) {
          throw new Error('The target is not a paper-derived Protocol candidate.');
        }
        const selected = selectPaperProtocolCandidateWorkflow(parsed.raw, input);
        if (!selected.replayed) {
          const document = parseScientificDocument(
            resolved.absolutePath,
            JSON.stringify(selected.raw)
          );
          if (document.kind !== 'protocol') {
            throw new Error('Selected candidate did not produce a native Protocol.');
          }
          effects.attemptedMutation();
          await saveNativeScientificPackage({
            workspaceRoot: resolved.folder.path,
            metaPath: resolved.absolutePath,
            document,
            expectedText: original,
          });
        }
        return {
          path: resolved.relativePath,
          candidateSetId: parsed.paperProtocol.candidate.candidateSetId,
          candidateId: parsed.paperProtocol.candidate.candidateId,
          candidateStatus: 'selected' as const,
          draftRevision: selected.draftRevision,
          replayed: selected.replayed,
        };
      }),
  });
}

export { selectProtocolCandidateOutputSchema } from './paper-output-schemas';
