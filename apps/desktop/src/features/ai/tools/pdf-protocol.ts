import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool } from './paper-tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { extractCurrentPdfFilePages, type ExtractedPdfBlock } from '../../pdf/public/extract';
import { parseScientificDocument } from '../../scientific-document/public/model';
import { createNativePaperProtocolPackage } from '../../scientific-document/public/native-package';
import { sha256PaperProtocolPayload } from '../../scientific-document/public/paper-protocol-model';
import { scientificPackageMetaPath } from '../../../shared/scientific-package';
import { normalizePath, resolveMultiRootPath } from './path-utils';

export const readPdfSchema = z
  .object({
    path: z.string().min(1).max(500).describe('Project path to a local PDF.'),
    pageStart: z.number().int().min(1).default(1).describe('First page to extract (1-based).'),
    pageEnd: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Last page to extract (inclusive, at most 20 requested pages per call). Values beyond the document are clamped to its final page.'
      ),
    maxCharacters: z
      .number()
      .int()
      .min(1_000)
      .max(100_000)
      .default(50_000)
      .describe('Maximum text characters returned by this call.'),
  })
  .strict();

export const createProtocolFromPdfSchema = z
  .object({
    pdfPath: z.string().min(1).max(500).describe('Project path to the source PDF.'),
    outputPath: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'New project-relative Protocol package directory, for example Protocols/Cell lysis.'
      ),
    title: z.string().min(1).max(200),
    overview: z.string().max(100_000).default(''),
    candidateOrdinal: z.number().int().min(1).max(200).default(1),
    candidateStatus: z.enum(['proposed', 'selected']).default('proposed'),
    remoteSource: z
      .object({
        originalUrl: z.string().url().max(2_000),
        canonicalUrl: z.string().url().max(2_000),
        capturedAt: z.string().refine(isExactUtcTimestamp),
        title: z.string().min(1).max(200),
      })
      .strict()
      .optional()
      .describe('Exact URL provenance returned by capture_paper_url for a downloaded PDF.'),
    steps: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            instructions: z.string().min(1).max(100_000),
            sourceStatus: z
              .enum(['source', 'resolved', 'hole'])
              .default('source')
              .describe(
                'Use hole when the cited PDF points to unavailable details; never fill those details by inference.'
              ),
            evidenceBlockIds: z
              .array(z.string().regex(/^p[1-9]\d*-b[1-9]\d*$/))
              .min(1)
              .max(100)
              .describe('Exact blockId values returned by read_pdf.'),
          })
          .strict()
      )
      .min(1)
      .max(200),
  })
  .strict();

export type ReadPdfInput = z.infer<typeof readPdfSchema>;
export type CreateProtocolFromPdfInput = z.infer<typeof createProtocolFromPdfSchema>;

function rawSha256(value: string): string {
  const digest = value.replace(/^sha256:/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('PDF content hash is invalid.');
  return digest;
}

function requirePdfPath(path: string): void {
  if (!path.toLowerCase().endsWith('.pdf')) throw new Error('The source path must end with .pdf.');
}

function pageRange(start: number, end: number): number[] {
  if (end < start) throw new Error('pageEnd must be greater than or equal to pageStart.');
  if (end - start + 1 > 20) throw new Error('read_pdf extracts at most 20 pages per call.');
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function createReadPdfTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Extract bounded semantic elements (headings, paragraphs, list items, captions, and tables) with normalized page rectangles from a literal project PDF. Each blockId is stable for these exact PDF bytes and can be passed to create_protocol_from_pdf; never invent rectangle coordinates.',
    inputSchema: readPdfSchema,
    execute: async ({ path, pageStart, pageEnd, maxCharacters }: ReadPdfInput) =>
      runPaperTool('READ_PDF_FAILED', async () => {
        const resolved = resolveMultiRootPath(folders, path);
        requirePdfPath(resolved.absolutePath);
        const extracted = await extractCurrentPdfFilePages(resolved.absolutePath, {
          pages: pageRange(pageStart, pageEnd ?? pageStart),
          maxCharacters,
          clampTrailingPages: true,
        });
        return {
          path: resolved.relativePath,
          sha256: rawSha256(extracted.sourceSha256),
          ...extracted,
        };
      }),
  });
}

function pageFromBlockId(blockId: string): number {
  const match = /^p([1-9]\d*)-b[1-9]\d*$/.exec(blockId);
  if (!match) throw new Error(`Invalid PDF block ID: ${blockId}`);
  return Number(match[1]);
}

function tipTapText(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
}

function blocksById(pages: Awaited<ReturnType<typeof extractCurrentPdfFilePages>>['pages']) {
  return new Map(pages.flatMap((page) => page.blocks.map((block) => [block.blockId, block])));
}

function evidenceForStep(
  stepIndex: number,
  stepId: string,
  blockIds: string[],
  blocks: Map<string, ExtractedPdfBlock>,
  sourceId: string,
  sourceSha256: string,
  evidenceClass: 'direct' | 'resolved_reference'
) {
  const selected = blockIds.map((blockId) => {
    const block = blocks.get(blockId);
    if (!block) throw new Error(`PDF evidence block was not found in the current file: ${blockId}`);
    return block;
  });
  const byPage = new Map<number, ExtractedPdfBlock[]>();
  for (const block of selected) {
    byPage.set(block.page, [...(byPage.get(block.page) ?? []), block]);
  }
  return [...byPage.entries()].map(([page, pageBlocks]) => ({
    evidenceId: `paper-evidence-${stepIndex + 1}-${page}`,
    stepId,
    sourceId,
    sourceSha256,
    evidenceClass,
    quote: pageBlocks.map((block) => block.text).join(' '),
    locator: {
      kind: 'pdf_rects' as const,
      page,
      rects: pageBlocks.map((block) => block.rect),
    },
  }));
}

export function createProtocolFromPdfTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Create a validated native DNAForge protocol from a local PDF and exact semantic read_pdf block IDs. The app reparses with its managed structured PDF provider, derives every highlight rectangle from the current PDF bytes, pins the PDF hash/page count/parser identity, and refuses unknown evidence IDs.',
    inputSchema: createProtocolFromPdfSchema,
    execute: async (input: CreateProtocolFromPdfInput) =>
      runPaperTool('CREATE_PROTOCOL_FROM_PDF_FAILED', async (effects) => {
        input = createProtocolFromPdfSchema.parse(input);
        const pdf = resolveMultiRootPath(folders, input.pdfPath);
        const output = resolveMultiRootPath(folders, input.outputPath);
        requirePdfPath(pdf.absolutePath);
        if (normalizePath(pdf.folder.path) !== normalizePath(output.folder.path)) {
          throw new Error(
            'The source PDF and Protocol package must be in the same mounted folder. ' +
              'Choose an outputPath in the PDF folder.'
          );
        }
        if (output.relativePath.toLowerCase().endsWith('.dnaforge-protocol.json')) {
          throw new Error(
            'outputPath must name a Protocol package directory, not a legacy JSON file.'
          );
        }

        const requestedPages = [
          ...new Set(input.steps.flatMap((step) => step.evidenceBlockIds.map(pageFromBlockId))),
        ];
        if (requestedPages.length > 50)
          throw new Error('A protocol may cite at most 50 PDF pages.');
        const extracted = await extractCurrentPdfFilePages(pdf.absolutePath, {
          pages: requestedPages,
          maxCharacters: 1_000_000,
        });
        const sha256 = rawSha256(extracted.sourceSha256);
        if (extracted.truncated) {
          throw new Error('The cited PDF pages exceed the safe extraction limit. Use fewer pages.');
        }
        const blocks = blocksById(extracted.pages);
        const sourceId = `pdf:${sha256.slice(0, 24)}`;
        const importedAt = input.remoteSource?.capturedAt ?? new Date().toISOString();
        const candidateSetId = `paper-set-${sha256.slice(0, 24)}`;
        const candidateHash = await sha256PaperProtocolPayload({
          candidateSetId,
          ordinal: input.candidateOrdinal,
          label: input.title.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US'),
        });
        const candidateDigest = rawSha256(candidateHash);
        const stepIds = input.steps.map((_step, index) => `paper-step-${index + 1}`);
        const sourceSha256 = `sha256:${sha256}`;
        const raw = {
          schema: 'dnaforge.protocol.v1',
          kind: 'protocol',
          id: `paper-protocol-${candidateDigest.slice(0, 24)}`,
          title: input.title,
          editable: true,
          overview: tipTapText(input.overview),
          steps: input.steps.map((step, index) => ({
            id: stepIds[index],
            ordinal: index + 1,
            title: step.title,
            content: tipTapText(step.instructions),
          })),
          inputs: [],
          outputs: [],
          links: [],
          version: {
            sourceVersionId: `sha256:${sha256}`,
            pinnedVersionHash: candidateHash,
            immutable: true,
            importedAt,
          },
          provenance: {
            immutableSource: true,
            provider: input.remoteSource ? 'paper-url-pdf' : 'local-pdf',
            sourceObjectId: sourceId,
            stableSourceId: sourceId,
            capturedAt: importedAt,
          },
          paperProtocol: {
            schema: 'dnaforge.paper-protocol.v1',
            candidate: {
              candidateSetId,
              candidateId: `paper-candidate-${candidateDigest.slice(0, 24)}`,
              ordinal: input.candidateOrdinal,
              label: input.title,
              status: input.candidateStatus,
            },
            draft: { revision: 1, state: 'draft', reopenedFromAcceptedVersionId: null },
            sources: [
              {
                sourceId,
                kind: 'pdf',
                title: input.remoteSource?.title ?? input.title,
                mediaType: 'application/pdf',
                sha256: sourceSha256,
                capturedAt: importedAt,
                workspacePath: pdf.relativePath,
                pageCount: extracted.pageCount,
                extraction: extracted.parser,
                ...(input.remoteSource
                  ? {
                      originalUrl: input.remoteSource.originalUrl,
                      canonicalUrl: input.remoteSource.canonicalUrl,
                    }
                  : {}),
              },
            ],
            evidence: input.steps.flatMap((step, index) =>
              evidenceForStep(
                index,
                stepIds[index],
                step.evidenceBlockIds,
                blocks,
                sourceId,
                sourceSha256,
                step.sourceStatus === 'resolved' ? 'resolved_reference' : 'direct'
              )
            ),
            gaps: input.steps.flatMap((step, index) =>
              step.sourceStatus === 'hole'
                ? [
                    {
                      gapId: `paper-gap-${index + 1}`,
                      stepId: stepIds[index],
                      missing:
                        'The cited source points to procedural details that were unavailable during extraction.',
                      attemptedResolution: [
                        'Recorded the cited PDF passage without inventing the missing details.',
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
        if (document.kind !== 'protocol')
          throw new Error('Paper extraction did not produce a Protocol.');
        effects.attemptedMutation();
        const created = await createNativePaperProtocolPackage({
          workspaceRoot: output.folder.path,
          packagePath: output.relativePath,
          document,
        });
        effects.changed({ kind: 'protocol-created', path: relativeMetaPath });
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('waypoint:workspace-files-changed', {
              detail: {
                path: created.metaPath,
                workspaceRoot: output.folder.path,
                revealPath: created.metaPath,
              },
            })
          );
        }
        return {
          pdfPath: pdf.relativePath,
          protocolPath: relativeMetaPath,
          sha256,
          pageCount: extracted.pageCount,
          stepCount: input.steps.length,
          candidateSetId,
          candidateId: `paper-candidate-${candidateDigest.slice(0, 24)}`,
          candidateOrdinal: input.candidateOrdinal,
          candidateStatus: input.candidateStatus,
        };
      }),
  });
}

function isExactUtcTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export { readPdfOutputSchema, createProtocolFromPdfOutputSchema } from './paper-output-schemas';
