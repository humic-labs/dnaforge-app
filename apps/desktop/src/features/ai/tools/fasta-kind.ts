import { z } from 'zod';
import { platform } from '../../../platform';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { fastaKindClassificationSchema, fastaKindSchema } from '../../../shared/fasta-kind';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { resolveWorkspaceEntry } from './workspace-entry';

const fastaPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .describe('Existing FASTA path qualified by its project name or admitted absolute root.');

export const inspectFastaKindSchema = z.object({ path: fastaPathSchema }).strict();
export const classifyFastaSchema = z
  .object({
    path: fastaPathSchema,
    kind: fastaKindSchema.describe(
      'sequence declares nucleotide FASTA; protein declares amino-acid FASTA.'
    ),
    expectedRevision: fastaKindClassificationSchema.shape.expectedRevision.describe(
      'Exact opaque revision returned by inspect_fasta_kind for this file; pass it unchanged.'
    ),
  })
  .strict();

export const INSPECT_FASTA_KIND_DESCRIPTION =
  'Read native kind authority for an existing FASTA in an open project. Returns a declared sequence or protein, or a legacy read-only state that may need classification. Includes entity and binding identities, source fingerprint and the opaque revision required by classify_fasta. With multiple projects open, qualify the path by its exact project name or admitted absolute root.';
export const CLASSIFY_FASTA_DESCRIPTION =
  'Explicitly declare an existing FASTA as sequence (nucleotide) or protein through its native catalog owner. First call inspect_fasta_kind and pass its exact current revision unchanged. Preserves file bytes and entity/binding identity while recording kind history. Refuses changed sources or bindings, conflicting canonical declarations and read-only or inactive projects. Classification is a normal authorized write and requires no additional user confirmation.';

function fastaCommandFailure(error: unknown, submitted: boolean, canceled = false) {
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode =
    /^(?:Error invoking remote method 'db:(?:getFastaKindAuthority|classifyFasta)': )?(?:(?:Error|WorkspaceWriteAdmissionError): )?(FASTA_KIND_[A-Z_]+|WORKSPACE_READ_ONLY|WORKSPACE_INACTIVE):/u.exec(
      message
    )?.[1];
  const code = nativeCode ?? (canceled && !submitted ? 'CANCELED' : 'FASTA_KIND_COMMAND_FAILED');
  return toolFailure({
    code,
    error: message,
    retriable: code === 'CANCELED' || code === 'FASTA_KIND_STALE',
    stateChanged: submitted && !nativeCode ? 'unknown' : false,
    partialEffects: [],
  });
}

export function createInspectFastaKindTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: INSPECT_FASTA_KIND_DESCRIPTION,
    inputSchema: inspectFastaKindSchema,
    execute: async ({ path }, { abortSignal }) => {
      try {
        abortSignal?.throwIfAborted();
        const target = resolveWorkspaceEntry(folders, path, false);
        return toolSuccess({
          ...(await platform().db.getFastaKindAuthority({
            path: target.absolutePath,
            workspaceRoot: target.folder.path,
          })),
        });
      } catch (error) {
        return fastaCommandFailure(error, false, abortSignal?.aborted);
      }
    },
  });
}

export function createClassifyFastaTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: CLASSIFY_FASTA_DESCRIPTION,
    inputSchema: classifyFastaSchema,
    execute: async ({ path, kind, expectedRevision }, { abortSignal }) => {
      let submitted = false;
      try {
        abortSignal?.throwIfAborted();
        const target = resolveWorkspaceEntry(folders, path, false);
        abortSignal?.throwIfAborted();
        submitted = true;
        const declared = await platform().db.classifyFasta({
          path: target.absolutePath,
          workspaceRoot: target.folder.path,
          kind,
          expectedRevision,
        });
        return toolSuccess({
          ...declared,
          ...(abortSignal?.aborted ? { stopRequested: true } : {}),
        });
      } catch (error) {
        return fastaCommandFailure(error, submitted, abortSignal?.aborted);
      }
    },
  });
}
