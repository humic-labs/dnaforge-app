import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool } from './paper-tool-result';
import { z } from 'zod';

import { platform } from '../../../platform';
import { scientificPackageKindForMetaPath } from '../../../shared/scientific-package';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  parseScientificDocument,
  reviseProtocolStepWithHistory,
  serializeScientificDocument,
} from '../../scientific-document/public/model';
import { saveNativeScientificPackage } from '../../scientific-document/public/native-package';
import { resolveMultiRootPath } from './path-utils';

export const reviseProtocolStepSchema = z
  .object({
    path: z.string().min(1).describe('Protocol path relative to the open project.'),
    stepId: z.string().min(1).describe('Stable protocol step ID.'),
    title: z.string().min(1).max(200).optional().describe('Replacement step title.'),
    contentText: z
      .string()
      .max(100_000)
      .optional()
      .describe('Replacement step instructions as plain text.'),
  })
  .strict();

export type ReviseProtocolStepInput = z.infer<typeof reviseProtocolStepSchema>;

export function createReviseProtocolStepTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Revise one step in a native DNAForge protocol. The write is workspace-scoped, ' +
      'records reversible before/after snapshots, and removes exact source claims when ' +
      'the sourced instructions change. Use open_protocol_review to show the native ' +
      'protocol beside its literal source PDF and the chat.',
    inputSchema: reviseProtocolStepSchema,
    execute: async ({ path, stepId, title, contentText }: ReviseProtocolStepInput) =>
      runPaperTool('REVISE_PROTOCOL_STEP_FAILED', async (effects) => {
        if (title === undefined && contentText === undefined) {
          throw new Error('Provide a replacement title or replacement step content.');
        }
        const resolved = resolveMultiRootPath(folders, path);
        const original = await platform().fs.readTextFile(resolved.absolutePath);
        const parsed = parseScientificDocument(resolved.absolutePath, original);
        if (parsed.kind !== 'protocol') throw new Error('The target is not a native protocol.');

        const { document, revisionId } = await reviseProtocolStepWithHistory(
          parsed,
          stepId,
          {
            ...(title !== undefined ? { title } : {}),
            ...(contentText !== undefined ? { contentText } : {}),
          },
          { actor: 'agent', at: new Date().toISOString() }
        );
        const serialized = serializeScientificDocument(document);
        effects.attemptedMutation();
        if (scientificPackageKindForMetaPath(resolved.absolutePath) === 'protocol') {
          await saveNativeScientificPackage({
            workspaceRoot: resolved.folder.path,
            metaPath: resolved.absolutePath,
            document,
            expectedText: original,
          });
        } else {
          await platform().fs.writeWorkspaceTextFileAtomic({
            workspaceRoot: resolved.folder.path,
            path: resolved.absolutePath,
            content: serialized,
            mode: 'replace',
            expectedContentHash: await sha256Hex(original),
            artifactNoun: 'protocol',
          });
        }
        effects.changed({ kind: 'protocol-step-revised', path: resolved.relativePath, stepId });
        const revised = document.steps.find((step) => step.id === stepId);
        if (!revised) throw new Error(`Protocol step ${stepId} disappeared after revision.`);
        return {
          path: resolved.relativePath,
          stepId,
          revisionId,
          title: revised.title,
          contentText: revised.text,
          sourceStatus: revised.sourceStatus,
          sourceSpanCount: revised.sourceSpans.length,
        };
      }),
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export { reviseProtocolStepOutputSchema } from './paper-output-schemas';
