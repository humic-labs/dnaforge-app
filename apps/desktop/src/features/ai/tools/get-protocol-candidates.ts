import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool } from './paper-tool-result';
import { z } from 'zod';

import { getCatalogFilesUnderPath } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { parseScientificDocument } from '../../scientific-document/public/model';

export const getProtocolCandidatesSchema = z
  .object({
    candidateSetId: z.string().min(1).max(200).optional(),
    sourceSha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export type GetProtocolCandidatesInput = z.infer<typeof getProtocolCandidatesSchema>;

export function createGetProtocolCandidatesTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'List compact paper-derived Protocol candidates by candidate-set or exact source hash. ' +
      'Returns titles, status, source kinds, draft revision, steps, gaps, and package paths ' +
      'without returning full captured source text.',
    inputSchema: getProtocolCandidatesSchema,
    execute: async (input: GetProtocolCandidatesInput) =>
      runPaperTool('GET_PROTOCOL_CANDIDATES_FAILED', async () => {
        const paths = new Map<string, string>();
        for (const folder of folders) {
          const bindings = await getCatalogFilesUnderPath(folder.path);
          for (const binding of bindings) {
            if (binding.file_kind !== 'waypoint-protocol' || binding.status !== 'current') continue;
            paths.set(binding.path, binding.relative_path ?? binding.path);
          }
        }

        const candidates = [];
        for (const [path, relativePath] of paths) {
          const document = parseScientificDocument(path, await platform().fs.readTextFile(path));
          if (document.kind !== 'protocol' || !document.paperProtocol) continue;
          const workflow = document.paperProtocol;
          const sourceHashes = [...new Set(workflow.sources.map((source) => source.sha256))].sort();
          if (input.candidateSetId && workflow.candidate.candidateSetId !== input.candidateSetId) {
            continue;
          }
          if (input.sourceSha256 && !sourceHashes.includes(input.sourceSha256)) continue;
          candidates.push({
            protocolPath: relativePath,
            title: document.title,
            candidateSetId: workflow.candidate.candidateSetId,
            candidateId: workflow.candidate.candidateId,
            ordinal: workflow.candidate.ordinal,
            status: workflow.candidate.status,
            sourceKinds: [...new Set(workflow.sources.map((source) => source.kind))].sort(),
            sourceHashes,
            draftRevision: workflow.draft.revision,
            draftState: workflow.draft.state,
            stepCount: document.steps.length,
            gapCount: workflow.gaps.length,
          });
        }
        candidates.sort(
          (left, right) =>
            left.candidateSetId.localeCompare(right.candidateSetId) ||
            left.ordinal - right.ordinal ||
            left.title.localeCompare(right.title)
        );
        return { candidates };
      }),
  });
}

export { getProtocolCandidatesOutputSchema } from './paper-output-schemas';
