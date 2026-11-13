import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool, type PaperToolEffects } from './paper-tool-result';
import { z } from 'zod';

import { platform } from '../../../platform';
import { scientificPackageKindForMetaPath } from '../../../shared/scientific-package';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  parseScientificDocument,
  type ScientificProtocolDocument,
} from '../../scientific-document/public/model';
import { saveNativeScientificPackage } from '../../scientific-document/public/native-package';
import {
  canonicalPaperProtocolReviewPayload,
  finalizePaperProtocolWorkflow,
  reopenPaperProtocolWorkflow,
  sha256PaperProtocolPayload,
  validatePaperProtocolSourceHashes,
  type PaperProtocolWorkflow,
} from '../../scientific-document/public/paper-protocol-model';
import { resolveMultiRootPath, resolveWorkspacePath } from './path-utils';

const PREVIEW_TTL_MS = 5 * 60 * 1_000;

const protocolPath = z.string().min(1).max(500).describe('Native Protocol package metadata path.');

export const previewFinalizePaperProtocolSchema = z
  .object({
    path: protocolPath,
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .describe('Exact draft revision currently shown to the user.'),
  })
  .strict();

export const finalizePaperProtocolSchema = z
  .object({
    path: protocolPath,
    expectedRevision: z.number().int().min(1).describe('Exact draft revision returned by preview.'),
    previewFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .describe('Unexpired fingerprint returned by preview_finalize_paper_protocol.'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .describe('Stable key for this exact acceptance intent. Exact retries are safe.'),
  })
  .strict();

export const reopenPaperProtocolSchema = z
  .object({
    path: protocolPath,
    acceptedVersionId: z.string().min(1).max(200),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .describe('Stable key for reopening this exact accepted version.'),
  })
  .strict();

export type PreviewFinalizePaperProtocolInput = z.infer<typeof previewFinalizePaperProtocolSchema>;
export type FinalizePaperProtocolInput = z.infer<typeof finalizePaperProtocolSchema>;
export type ReopenPaperProtocolInput = z.infer<typeof reopenPaperProtocolSchema>;

type PreparedProtocol = {
  original: string;
  document: ScientificProtocolDocument;
  relativePath: string;
  absolutePath: string;
  workspaceRoot: string;
  contentHash: string;
  sourceHashes: string[];
  signature: string;
};

type StoredPreview = {
  path: string;
  expectedRevision: number;
  signature: string;
  expiresAtMs: number;
};

const storedPreviews = new Map<string, StoredPreview>();

export function createPreviewFinalizePaperProtocolTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Preview paper-protocol acceptance without writing. Revalidates exact source identities ' +
      'and returns content identity, unresolved gaps, blockers, and a short-lived fingerprint. ' +
      'A gap is visible but is not itself a stale-evidence blocker.',
    inputSchema: previewFinalizePaperProtocolSchema,
    execute: async (input: PreviewFinalizePaperProtocolInput) =>
      runPaperTool('PREVIEW_FINALIZE_PAPER_PROTOCOL_FAILED', async () => {
        try {
          const prepared = await prepareProtocol(folders, input.path, input.expectedRevision, true);
          const expiresAtMs = Date.now() + PREVIEW_TTL_MS;
          const previewFingerprint = await sha256PaperProtocolPayload({
            signature: prepared.signature,
            expiresAt: new Date(expiresAtMs).toISOString(),
          });
          storedPreviews.set(previewFingerprint, {
            path: prepared.absolutePath,
            expectedRevision: input.expectedRevision,
            signature: prepared.signature,
            expiresAtMs,
          });
          return {
            canFinalize: true,
            path: prepared.relativePath,
            expectedRevision: input.expectedRevision,
            contentHash: prepared.contentHash,
            sourceHashes: prepared.sourceHashes,
            unresolvedGaps: prepared.document.paperProtocol?.gaps ?? [],
            previewFingerprint,
            previewExpiresAt: new Date(expiresAtMs).toISOString(),
            blockers: [],
          };
        } catch (error) {
          return {
            canFinalize: false,
            path: input.path,
            expectedRevision: input.expectedRevision,
            unresolvedGaps: [],
            blockers: [
              {
                code: 'preview_rejected',
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      }),
  });
}

export function createFinalizePaperProtocolTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Finalize exactly the previously previewed paper-derived native Protocol after explicit ' +
      'user confirmation. Requires the exact revision, an unexpired fingerprint, and an ' +
      'idempotency key. Revalidates source bytes immediately before the atomic package save.',
    inputSchema: finalizePaperProtocolSchema,
    execute: async (input: FinalizePaperProtocolInput) =>
      runPaperTool('FINALIZE_PAPER_PROTOCOL_FAILED', async (effects) => {
        const prepared = await prepareProtocol(folders, input.path, input.expectedRevision, false);
        const workflow = requiredPaperWorkflow(prepared.document);

        if (workflow.draft.state === 'finalized') {
          return persistFinalization(prepared, input, effects);
        }

        const preview = storedPreviews.get(input.previewFingerprint);
        if (!preview || preview.expiresAtMs < Date.now()) {
          storedPreviews.delete(input.previewFingerprint);
          throw new Error(
            'Finalization preview is missing or expired. Preview the protocol again.'
          );
        }
        if (
          preview.path !== prepared.absolutePath ||
          preview.expectedRevision !== input.expectedRevision ||
          preview.signature !== prepared.signature
        ) {
          throw new Error(
            'Protocol content, source bytes, path, or revision changed after preview. Preview again.'
          );
        }

        return persistFinalization(prepared, input, effects);
      }),
  });
}

export function createReopenPaperProtocolTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Reopen the exact latest accepted paper Protocol as the next editable draft. The accepted ' +
      'snapshot remains append-only, and exact retries with the same idempotency key are safe.',
    inputSchema: reopenPaperProtocolSchema,
    execute: async (input: ReopenPaperProtocolInput) =>
      runPaperTool('REOPEN_PAPER_PROTOCOL_FAILED', async (effects) => {
        const resolved = resolveNativeProtocolPath(folders, input.path);
        const original = await platform().fs.readTextFile(resolved.absolutePath);
        const parsed = parseScientificDocument(resolved.absolutePath, original);
        if (parsed.kind !== 'protocol' || !parsed.paperProtocol) {
          throw new Error('The target is not a paper-derived Protocol.');
        }
        const reopened = await reopenPaperProtocolWorkflow(parsed.raw, {
          acceptedVersionId: input.acceptedVersionId,
          idempotencyKey: input.idempotencyKey,
        });
        if (!reopened.replayed) {
          const document = parseScientificDocument(
            resolved.absolutePath,
            JSON.stringify(reopened.raw)
          );
          if (document.kind !== 'protocol') throw new Error('Reopened document is not a Protocol.');
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
          state: 'draft' as const,
          acceptedVersionId: input.acceptedVersionId,
          draftRevision: reopened.draftRevision,
          replayed: reopened.replayed,
        };
      }),
  });
}

async function prepareProtocol(
  folders: WorkspaceFolder[],
  path: string,
  expectedRevision: number,
  requireDraft: boolean
): Promise<PreparedProtocol> {
  const resolved = resolveNativeProtocolPath(folders, path);
  const original = await platform().fs.readTextFile(resolved.absolutePath);
  const document = parseScientificDocument(resolved.absolutePath, original);
  if (document.kind !== 'protocol' || !document.paperProtocol) {
    throw new Error('The target is not a paper-derived Protocol draft.');
  }
  const workflow = document.paperProtocol;
  if (workflow.candidate.status !== 'selected') {
    throw new Error('Only a user-selected paper protocol candidate can be finalized.');
  }
  if (workflow.draft.revision !== expectedRevision) {
    throw new Error(
      `Paper protocol draft revision changed: expected ${expectedRevision}, found ${workflow.draft.revision}.`
    );
  }
  if (requireDraft && workflow.draft.state !== 'draft') {
    throw new Error(
      'The paper protocol is already finalized. Reopen it before another acceptance.'
    );
  }
  await validateCurrentSourceHashes(workflow, resolved.folder.path);
  const contentHash = await sha256PaperProtocolPayload(
    canonicalPaperProtocolReviewPayload(document.raw)
  );
  const sourceHashes = [...new Set(workflow.sources.map((source) => source.sha256))].sort();
  const signature = await sha256PaperProtocolPayload({
    path: resolved.absolutePath,
    expectedRevision,
    contentHash,
    sourceHashes,
  });
  return {
    original,
    document,
    relativePath: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    workspaceRoot: resolved.folder.path,
    contentHash,
    sourceHashes,
    signature,
  };
}

async function persistFinalization(
  prepared: PreparedProtocol,
  input: FinalizePaperProtocolInput,
  effects: PaperToolEffects
) {
  const finalized = await finalizePaperProtocolWorkflow(prepared.document.raw, {
    expectedRevision: input.expectedRevision,
    finalizedAt: new Date().toISOString(),
    idempotencyKey: input.idempotencyKey,
    previewFingerprint: input.previewFingerprint,
  });
  if (!finalized.replayed) {
    const document = parseScientificDocument(prepared.absolutePath, JSON.stringify(finalized.raw));
    if (document.kind !== 'protocol') throw new Error('Finalized document is not a Protocol.');
    effects.attemptedMutation();
    await saveNativeScientificPackage({
      workspaceRoot: prepared.workspaceRoot,
      metaPath: prepared.absolutePath,
      document,
      expectedText: prepared.original,
    });
  }
  return {
    path: prepared.relativePath,
    state: 'finalized' as const,
    draftRevision: finalized.acceptedVersion.draftRevision,
    acceptedVersionId: finalized.acceptedVersion.acceptedVersionId,
    contentHash: finalized.acceptedVersion.contentHash,
    sourceHashes: finalized.acceptedVersion.sourceHashes,
    unresolvedGapCount: requiredPaperWorkflow(prepared.document).gaps.length,
    replayed: finalized.replayed,
  };
}

async function validateCurrentSourceHashes(
  workflow: PaperProtocolWorkflow,
  workspaceRoot: string
): Promise<void> {
  await validatePaperProtocolSourceHashes(workflow);
  if (workflow.draft.state === 'finalized') return;
  for (const source of workflow.sources) {
    if (source.kind !== 'pdf') continue;
    const sourcePath = resolveWorkspacePath(workspaceRoot, source.workspacePath);
    const actualHash = normalizeSha256(await platform().fs.sha256File(sourcePath));
    if (actualHash !== source.sha256) {
      throw new Error(`PDF hash does not match the reviewed source ${source.sourceId}.`);
    }
  }
}

function resolveNativeProtocolPath(folders: WorkspaceFolder[], path: string) {
  const resolved = resolveMultiRootPath(folders, path);
  if (scientificPackageKindForMetaPath(resolved.absolutePath) !== 'protocol') {
    throw new Error('Paper protocol finalization requires a native Protocol package.');
  }
  return resolved;
}

function requiredPaperWorkflow(document: ScientificProtocolDocument): PaperProtocolWorkflow {
  if (!document.paperProtocol) throw new Error('The target is not a paper-derived Protocol.');
  return document.paperProtocol;
}

function normalizeSha256(value: string): string {
  const digest = value.replace(/^sha256:/iu, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Source PDF hash is invalid.');
  return `sha256:${digest}`;
}

export function clearPaperProtocolFinalizationPreviewsForTests(): void {
  storedPreviews.clear();
}

export {
  previewFinalizePaperProtocolOutputSchema,
  finalizePaperProtocolOutputSchema,
  reopenPaperProtocolOutputSchema,
} from './paper-output-schemas';
