import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool } from './paper-tool-result';
import { z } from 'zod';

import { scientificPackageMetaPath } from '../../../shared/scientific-package';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { parseScientificDocument } from '../../scientific-document/public/model';
import { createNativePaperProtocolPackage } from '../../scientific-document/public/native-package';
import { sha256PaperProtocolPayload } from '../../scientific-document/public/paper-protocol-model';
import { capturePaperSourceText } from './capture-paper-source';
import { resolveMultiRootPath } from './path-utils';

const capturedSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    kind: z.literal('captured_text'),
    title: z.string().min(1).max(200),
    mediaType: z.enum([
      'text/html',
      'text/plain',
      'application/xml',
      'text/xml',
      'application/jats+xml',
    ]),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    capturedAt: z.string().min(1),
    originalUrl: z.string().url().max(2_000),
    canonicalUrl: z.string().url().max(2_000),
    text: z.string().min(1),
  })
  .strict();

export const createProtocolCandidateSchema = z
  .object({
    outputPath: z
      .string()
      .min(1)
      .max(500)
      .describe('New project-relative Protocol package directory.'),
    title: z.string().min(1).max(200),
    overview: z.string().max(100_000).default(''),
    candidateOrdinal: z.number().int().min(1).max(200),
    candidateStatus: z.enum(['proposed', 'selected']).default('proposed'),
    source: capturedSourceSchema,
    steps: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            instructions: z.string().min(1).max(100_000),
            sourceStatus: z.enum(['source', 'resolved', 'hole']).default('source'),
            evidenceBlockIds: z
              .array(z.string().regex(/^text-b[1-9]\d*$/))
              .min(1)
              .max(100),
          })
          .strict()
      )
      .min(1)
      .max(200),
  })
  .strict();

export type CreateProtocolCandidateInput = z.infer<typeof createProtocolCandidateSchema>;

export function createProtocolCandidateTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Create one native Protocol candidate from exact captured paper text. The agent decides ' +
      'how many protocols exist and calls this once per candidate; DNAForge validates source ' +
      'identity, evidence spans, candidate grouping, and package persistence.',
    inputSchema: createProtocolCandidateSchema,
    execute: async (input: CreateProtocolCandidateInput) =>
      runPaperTool('CREATE_PROTOCOL_CANDIDATE_FAILED', async (effects) => {
        const output = resolveMultiRootPath(folders, input.outputPath);
        if (output.relativePath.toLowerCase().endsWith('.dnaforge-protocol.json')) {
          throw new Error('outputPath must name a Protocol package directory.');
        }
        const captured = await capturePaperSourceText({
          originalUrl: input.source.originalUrl,
          canonicalUrl: input.source.canonicalUrl,
          mediaType: input.source.mediaType,
          capturedText: input.source.text,
          capturedAt: input.source.capturedAt,
          expectedSha256: input.source.sha256,
          title: input.source.title,
        });
        if (captured.source.sourceId !== input.source.sourceId) {
          throw new Error('Captured source ID does not match its exact content hash.');
        }
        const blocks = new Map(captured.blocks.map((block) => [block.blockId, block]));
        const candidateSetHash = await sha256PaperProtocolPayload([captured.source.sha256]);
        const candidateSetId = `paper-set-${digest(candidateSetHash).slice(0, 24)}`;
        const candidateHash = await sha256PaperProtocolPayload({
          candidateSetId,
          ordinal: input.candidateOrdinal,
          label: normalizeLabel(input.title),
        });
        const candidateId = `paper-candidate-${digest(candidateHash).slice(0, 24)}`;
        const stepIds = input.steps.map((_step, index) => `paper-step-${index + 1}`);
        const evidence = input.steps.flatMap((step, stepIndex) =>
          step.evidenceBlockIds.map((blockId, evidenceIndex) => {
            const block = blocks.get(blockId);
            if (!block) throw new Error(`Captured text evidence block was not found: ${blockId}`);
            return {
              evidenceId: `paper-evidence-${stepIndex + 1}-${evidenceIndex + 1}`,
              stepId: stepIds[stepIndex],
              sourceId: captured.source.sourceId,
              sourceSha256: captured.source.sha256,
              evidenceClass:
                step.sourceStatus === 'resolved'
                  ? ('resolved_reference' as const)
                  : ('direct' as const),
              quote: block.text,
              locator: { kind: 'text_span' as const, start: block.start, end: block.end },
            };
          })
        );
        const importedAt = new Date().toISOString();
        const raw = {
          schema: 'dnaforge.protocol.v1',
          kind: 'protocol',
          id: `paper-protocol-${digest(candidateHash).slice(0, 24)}`,
          title: input.title,
          editable: true,
          overview: tipTapText(input.overview),
          steps: input.steps.map((step, index) => ({
            id: stepIds[index],
            sourceStepId: `captured-step-${index + 1}`,
            ordinal: index + 1,
            title: step.title,
            content: tipTapText(step.instructions),
          })),
          inputs: [],
          outputs: [],
          links: [],
          version: {
            sourceVersionId: captured.source.sha256,
            pinnedVersionHash: candidateHash,
            immutable: true,
            importedAt,
          },
          provenance: {
            immutableSource: true,
            provider: 'captured-web',
            sourceObjectId: captured.source.sourceId,
            stableSourceId: captured.source.sourceId,
            sourceUrl: captured.source.originalUrl,
            capturedAt: captured.source.capturedAt,
          },
          paperProtocol: {
            schema: 'dnaforge.paper-protocol.v1',
            candidate: {
              candidateSetId,
              candidateId,
              ordinal: input.candidateOrdinal,
              label: input.title,
              status: input.candidateStatus,
            },
            draft: { revision: 1, state: 'draft', reopenedFromAcceptedVersionId: null },
            sources: [captured.source],
            evidence,
            gaps: input.steps.flatMap((step, index) =>
              step.sourceStatus === 'hole'
                ? [
                    {
                      gapId: `paper-gap-${index + 1}`,
                      stepId: stepIds[index],
                      missing:
                        'The captured source points to procedural details that were unavailable.',
                      attemptedResolution: [
                        'Recorded the captured passage without inventing missing details.',
                      ],
                    },
                  ]
                : []
            ),
            acceptedVersions: [],
          },
        };
        const relativeMetaPath = scientificPackageMetaPath(output.relativePath, 'protocol');
        const metaPath = `${output.folder.path.replace(/[/\\]+$/u, '')}/${relativeMetaPath}`;
        const document = parseScientificDocument(metaPath, JSON.stringify(raw));
        if (document.kind !== 'protocol') throw new Error('Candidate did not produce a Protocol.');
        effects.attemptedMutation();
        const created = await createNativePaperProtocolPackage({
          workspaceRoot: output.folder.path,
          packagePath: output.relativePath,
          document,
        });
        return {
          protocolPath: relativeMetaPath,
          candidateSetId,
          candidateId,
          candidateOrdinal: input.candidateOrdinal,
          candidateStatus: input.candidateStatus,
          sourceSha256: captured.source.sha256,
          stepCount: input.steps.length,
          gapCount: document.paperProtocol?.gaps.length ?? 0,
          entityId: created.entityId,
        };
      }),
  });
}

function tipTapText(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function digest(value: string): string {
  return value.slice('sha256:'.length);
}

export { createProtocolCandidateOutputSchema } from './paper-output-schemas';
