import {
  recordPaperReferenceTraceOutputSchema,
  getPaperReferenceGraphOutputSchema,
} from './paper-output-schemas';
import {
  ApiResponseParseError,
  isApiError,
  postPaperReferenceGraphQueryExternalPaperReferenceGraphQueryPost,
  postPaperReferenceGraphRecordExternalPaperReferenceGraphRecordPost,
  type PaperGraphEvidenceModel,
  type PaperGraphIdentifierModel,
  type PaperGraphSourceModel,
  type PaperGraphTraceModel,
} from '@waypoint/api-client';
import { resultTool } from '../../agent-bridge/public/tool-result';
import { runPaperTool } from './paper-tool-result';
import { z } from 'zod';

import { platform } from '../../../platform';
import { getCurrentWorkspaceScope, type WorkspaceFolder } from '../../../stores/workspaceStore';
import { extractCurrentPdfFilePages, type ExtractedPdfBlock } from '../../pdf/public/extract';
import { capturePaperSourceText } from './capture-paper-source';
import { getUserFolders, resolveMultiRootPath, type ResolvedMultiRootPath } from './path-utils';
import { resolveSidecarApiClient } from './sidecar-client';

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relationshipSchema = z.enum(['identifies_as', 'cites', 'uses_method_from', 'supplement_to']);
const identifierSchema = z
  .object({
    scheme: z.enum(['pmid', 'pmcid', 'doi']),
    value: z.string().min(1).max(255),
  })
  .strict();
const traceSchema = z
  .object({
    relationship: relationshipSchema,
    target: identifierSchema,
    evidenceBlockIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  })
  .strict();
const capturedTextSourceSchema = z
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
    sha256: sha256Schema,
    capturedAt: z.string().min(1),
    originalUrl: z.string().url().max(2_000),
    canonicalUrl: z.string().url().max(2_000),
    text: z.string().min(1),
  })
  .strict();
const paperSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pdf'),
      path: z.string().min(1).max(500),
      title: z.string().min(1).max(200).optional(),
    })
    .strict(),
  capturedTextSourceSchema,
]);

export const recordPaperReferenceTraceSchema = z
  .object({
    source: paperSourceSchema.describe(
      'A PDF in the current project or the exact source object returned by capture_paper_url.'
    ),
    traces: z
      .array(traceSchema)
      .min(1)
      .max(100)
      .describe('Relationships supported by exact identifier-bearing source blocks.'),
  })
  .strict();

export const getPaperReferenceGraphSchema = z
  .object({
    pdfPath: z.string().min(1).max(500).optional(),
    sourceSha256: sha256Schema.optional(),
    depth: z.number().int().min(1).max(2).default(1),
    maxNodes: z.number().int().min(1).max(100).default(100),
  })
  .strict()
  .refine((input) => Boolean(input.pdfPath) !== Boolean(input.sourceSha256), {
    message: 'Provide exactly one of pdfPath or sourceSha256.',
  });

type RecordPaperReferenceTraceInput = z.infer<typeof recordPaperReferenceTraceSchema>;
type GetPaperReferenceGraphInput = z.infer<typeof getPaperReferenceGraphSchema>;
type NormalizedIdentifier = z.infer<typeof identifierSchema>;

export function createRecordPaperReferenceTraceTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Record evidence-backed publication identifiers and reference relationships for one local paper. ' +
      'Use only exact block IDs returned by read_pdf or capture_paper_url. The app re-reads the source, ' +
      'derives the quote and locator, and rejects identifiers absent from the selected evidence. This ' +
      'does not fetch cited papers or infer missing relationships.',
    inputSchema: recordPaperReferenceTraceSchema,
    execute: async (
      rawInput: RecordPaperReferenceTraceInput,
      context: { abortSignal?: AbortSignal; grantedCapabilities?: readonly string[] }
    ) =>
      runPaperTool('RECORD_PAPER_REFERENCE_TRACE_FAILED', async (effects) => {
        const input = recordPaperReferenceTraceSchema.parse(rawInput);
        const workspaceId = requireWorkspaceScope();
        const prepared =
          input.source.kind === 'pdf'
            ? await preparePdfRecord(folders, input.source, input.traces)
            : await prepareCapturedTextRecord(input.source, input.traces);

        const apiClient = await resolveSidecarApiClient('record_paper_reference_trace');
        try {
          effects.attemptedMutation();
          const response = await postPaperReferenceGraphRecordExternalPaperReferenceGraphRecordPost(
            {
              workspace_id: workspaceId,
              source_sha256: prepared.sourceSha256,
              source: prepared.source,
              traces: prepared.traces,
              granted_capabilities: [...(context.grantedCapabilities ?? [])],
            },
            apiClient.options({ signal: context.abortSignal })
          );
          return recordPaperReferenceTraceOutputSchema.omit({ ok: true }).parse(response.data);
        } catch (error) {
          throw paperGraphApiError('record', error);
        }
      }),
  });
}

export function createGetPaperReferenceGraphTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Read a bounded project-local neighborhood of paper sources and their recorded PMID, PMCID, ' +
      'or DOI relationships. This reads only the local trace index and never fetches publication data.',
    inputSchema: getPaperReferenceGraphSchema,
    execute: async (
      rawInput: GetPaperReferenceGraphInput,
      context: { abortSignal?: AbortSignal; grantedCapabilities?: readonly string[] }
    ) =>
      runPaperTool('GET_PAPER_REFERENCE_GRAPH_FAILED', async () => {
        const input = getPaperReferenceGraphSchema.parse(rawInput);
        const workspaceId = requireWorkspaceScope();
        let sourceSha256 = input.sourceSha256;
        if (input.pdfPath) {
          const pdf = resolveMultiRootPath(folders, input.pdfPath);
          requirePdfPath(pdf.absolutePath);
          sourceSha256 = normalizeSha256(await platform().fs.sha256File(pdf.absolutePath));
        }
        if (!sourceSha256) throw new Error('Paper graph source identity is missing.');

        const apiClient = await resolveSidecarApiClient('get_paper_reference_graph');
        try {
          const response = await postPaperReferenceGraphQueryExternalPaperReferenceGraphQueryPost(
            {
              workspace_id: workspaceId,
              source_sha256: sourceSha256,
              depth: input.depth,
              max_nodes: input.maxNodes,
              granted_capabilities: [...(context.grantedCapabilities ?? [])],
            },
            apiClient.options({ signal: context.abortSignal })
          );
          return getPaperReferenceGraphOutputSchema.omit({ ok: true }).parse(response.data);
        } catch (error) {
          throw paperGraphApiError('query', error);
        }
      }),
  });
}

async function preparePdfRecord(
  folders: WorkspaceFolder[],
  source: Extract<RecordPaperReferenceTraceInput['source'], { kind: 'pdf' }>,
  traces: RecordPaperReferenceTraceInput['traces']
): Promise<PreparedRecord> {
  const pdf = resolveMultiRootPath(folders, source.path);
  requirePdfPath(pdf.absolutePath);
  const requestedPages = [
    ...new Set(traces.flatMap((trace) => trace.evidenceBlockIds.map(pageFromBlockId))),
  ].sort((left, right) => left - right);
  if (requestedPages.length > 50) {
    throw new Error('A paper reference trace batch may cite at most 50 PDF pages.');
  }

  const extracted = await extractCurrentPdfFilePages(pdf.absolutePath, {
    pages: requestedPages,
    maxCharacters: 1_000_000,
  });
  if (extracted.truncated) {
    throw new Error('The cited PDF pages exceed the safe extraction limit. Use fewer pages.');
  }
  const blocks = new Map(
    extracted.pages.flatMap((page) => page.blocks.map((block) => [block.blockId, block]))
  );
  return {
    sourceSha256: normalizeSha256(extracted.sourceSha256),
    source: {
      kind: 'pdf',
      path: sourceWorkspacePath(folders, pdf),
      title: source.title,
      media_type: 'application/pdf',
    },
    traces: traces.map((trace) => preparePdfTrace(trace, blocks)),
  };
}

async function prepareCapturedTextRecord(
  source: z.infer<typeof capturedTextSourceSchema>,
  traces: RecordPaperReferenceTraceInput['traces']
): Promise<PreparedRecord> {
  const captured = await capturePaperSourceText({
    originalUrl: source.originalUrl,
    canonicalUrl: source.canonicalUrl,
    mediaType: source.mediaType,
    capturedText: source.text,
    capturedAt: source.capturedAt,
    expectedSha256: source.sha256,
    title: source.title,
  });
  if (captured.source.sourceId !== source.sourceId) {
    throw new Error('Captured source ID does not match its current content hash.');
  }
  const blocks = new Map(captured.blocks.map((block) => [block.blockId, block]));
  return {
    sourceSha256: captured.source.sha256,
    source: {
      kind: 'captured_text',
      title: captured.source.title,
      media_type: captured.source.mediaType,
    },
    traces: traces.map((trace) => {
      const target = normalizeIdentifier(trace.target);
      const selected = trace.evidenceBlockIds.map((blockId) => {
        const block = blocks.get(blockId);
        if (!block) {
          throw new Error(`Captured text evidence block was not found: ${blockId}`);
        }
        return block;
      });
      const start = Math.min(...selected.map((block) => block.start));
      const end = Math.max(...selected.map((block) => block.end));
      const quote = captured.source.text.slice(start, end);
      requireIdentifierInEvidence(target, quote);
      requireBoundedQuote(quote);
      return {
        relationship: trace.relationship,
        target,
        evidence: {
          block_ids: trace.evidenceBlockIds,
          quote,
          locator: { kind: 'text_span', start, end },
        },
      };
    }),
  };
}

function preparePdfTrace(
  trace: RecordPaperReferenceTraceInput['traces'][number],
  blocks: Map<string, ExtractedPdfBlock>
): PaperGraphTraceModel {
  const target = normalizeIdentifier(trace.target);
  const selected = trace.evidenceBlockIds.map((blockId) => {
    const block = blocks.get(blockId);
    if (!block) throw new Error(`PDF evidence block was not found in the current file: ${blockId}`);
    return block;
  });
  const pages = new Set(selected.map((block) => block.page));
  if (pages.size !== 1) {
    throw new Error('One paper reference trace must use evidence from one PDF page.');
  }
  const quote = selected.map((block) => block.text).join(' ');
  requireIdentifierInEvidence(target, quote);
  requireBoundedQuote(quote);
  const page = selected[0]?.page;
  if (!page) throw new Error('Paper reference trace has no PDF evidence page.');
  const evidence: PaperGraphEvidenceModel = {
    block_ids: trace.evidenceBlockIds,
    quote,
    locator: {
      kind: 'pdf_rects',
      page,
      rects: selected.map((block) => block.rect),
    },
  };
  return { relationship: trace.relationship, target, evidence };
}

function normalizeIdentifier(identifier: z.infer<typeof identifierSchema>): NormalizedIdentifier {
  const scheme = identifier.scheme;
  let value = identifier.value.trim();
  if (scheme === 'pmid') {
    if (!/^[1-9][0-9]{0,11}$/u.test(value)) {
      throw new Error('PMID must be a positive decimal identifier.');
    }
  } else if (scheme === 'pmcid') {
    value = value.toUpperCase();
    if (!/^PMC[1-9][0-9]{0,11}$/u.test(value)) {
      throw new Error('PMCID must use the form PMC followed by positive digits.');
    }
  } else {
    value = value
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
      .replace(/^doi:\s*/iu, '')
      .toLowerCase();
    // eslint-disable-next-line no-control-regex -- DOI identifiers cannot contain control characters.
    if (!/^10\.[0-9]{4,9}\/[^\s\u0000-\u001f\u007f]+$/u.test(value)) {
      throw new Error('DOI must be a bare 10.<registrant>/<suffix> identifier.');
    }
  }
  return { scheme, value };
}

function requireIdentifierInEvidence(identifier: PaperGraphIdentifierModel, quote: string): void {
  if (identifier.scheme === 'doi') {
    if (containsBoundedDoi(quote, identifier.value)) return;
  } else {
    const escaped = escapeRegExp(identifier.value);
    const pattern =
      identifier.scheme === 'pmid'
        ? new RegExp(`(?:^|[^0-9])${escaped}(?![0-9])`, 'u')
        : new RegExp(`(?:^|[^A-Z0-9])${escaped}(?![A-Z0-9])`, 'iu');
    if (pattern.test(quote)) return;
  }
  throw new Error(
    `Selected evidence does not contain ${identifier.scheme.toUpperCase()} ${identifier.value}.`
  );
}

function containsBoundedDoi(quote: string, doi: string): boolean {
  const lowerQuote = quote.toLowerCase();
  let from = 0;
  while (from < lowerQuote.length) {
    const index = lowerQuote.indexOf(doi, from);
    if (index < 0) return false;
    const before = index === 0 ? '' : lowerQuote[index - 1];
    const after = lowerQuote[index + doi.length] ?? '';
    if ((!before || !/[0-9]/u.test(before)) && (!after || /[\s)\]}>.,;:'"]/u.test(after))) {
      return true;
    }
    from = index + 1;
  }
  return false;
}

function pageFromBlockId(blockId: string): number {
  const match = /^p([1-9]\d*)-b[1-9]\d*$/u.exec(blockId);
  if (!match) throw new Error(`Invalid PDF block ID: ${blockId}`);
  return Number(match[1]);
}

function requireWorkspaceScope(): string {
  const workspaceId = getCurrentWorkspaceScope();
  if (!workspaceId) {
    throw new Error('A project must be open before using the local paper reference graph.');
  }
  return workspaceId;
}

function requirePdfPath(path: string): void {
  if (!path.toLowerCase().endsWith('.pdf')) throw new Error('The source path must end with .pdf.');
}

function sourceWorkspacePath(folders: WorkspaceFolder[], resolved: ResolvedMultiRootPath): string {
  return getUserFolders(folders).length > 1
    ? `${resolved.folder.name}/${resolved.relativePath}`
    : resolved.relativePath;
}

function normalizeSha256(value: string): string {
  const digest = value.replace(/^sha256:/iu, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Paper source SHA-256 is invalid.');
  return `sha256:${digest}`;
}

function requireBoundedQuote(quote: string): void {
  if (!quote || quote.length > 50_000) {
    throw new Error('Paper reference evidence quote must contain 1 to 50,000 characters.');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function paperGraphApiError(operation: 'record' | 'query', error: unknown): Error {
  if (error instanceof ApiResponseParseError) {
    return new Error(
      `The paper reference graph could not ${operation} because the sidecar returned invalid data.`
    );
  }
  if (isApiError(error)) {
    return new Error(
      `The paper reference graph could not ${operation} the request (HTTP ${error.status}).`
    );
  }
  if (error instanceof Error) return error;
  return new Error(`The paper reference graph could not ${operation} the request.`);
}

type PreparedRecord = {
  sourceSha256: string;
  source: PaperGraphSourceModel;
  traces: PaperGraphTraceModel[];
};

export {
  recordPaperReferenceTraceOutputSchema,
  getPaperReferenceGraphOutputSchema,
} from './paper-output-schemas';
